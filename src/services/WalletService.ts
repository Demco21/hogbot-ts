import { pool, parseBigInt } from '../lib/database.js';
import { User } from '../lib/types.js';
import { GameSource, UpdateType, CASINO_CONFIG } from '../constants.js';
import { safeLogger as logger } from '../lib/safe-logger.js';
import type { PoolClient } from 'pg';

/**
 * Raw database row for users table (BIGINTs are strings)
 */
interface UserRow {
  user_id: string;
  guild_id: string;
  username: string;
  balance: string;
  high_water_balance: string;
  beg_count: number;
  created_at: Date;
  updated_at: Date;
}

/**
 * WalletService handles all balance operations using the database
 * Uses application logic with SQL transactions for atomic updates
 *
 * MULTI-GUILD SUPPORT:
 * - ALL methods require guildId parameter
 * - Users have separate balances per guild (composite key: user_id + guild_id)
 * - Fire-and-forget richest member updates on resolved transactions
 */
export class WalletService {
  /**
   * Convert raw database row to typed User object
   */
  private parseUserRow(row: UserRow): User {
    return {
      user_id: row.user_id,
      username: row.username,
      balance: parseBigInt(row.balance),
      high_water_balance: parseBigInt(row.high_water_balance),
      beg_count: row.beg_count,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }
  /**
   * Get user's current balance for a specific guild
   * Creates user with starting balance if they don't exist in this guild
   *
   * @param userId - Discord user ID
   * @param guildId - Discord guild ID
   */
  async getBalance(userId: string, guildId: string): Promise<number> {
    const client = await pool.connect();
    try {
      const result = await client.query<{ balance: string }>(
        'SELECT balance FROM users WHERE user_id = $1 AND guild_id = $2',
        [userId, guildId]
      );

      if (result.rows.length === 0) {
        // User doesn't exist in this guild, create with starting balance
        await this.createUser(userId, guildId, 'Unknown');
        return CASINO_CONFIG.STARTING_BALANCE;
      }

      return parseBigInt(result.rows[0].balance);
    } finally {
      client.release();
    }
  }

  /**
   * Get full user record for a specific guild
   *
   * @param userId - Discord user ID
   * @param guildId - Discord guild ID
   */
  async getUser(userId: string, guildId: string): Promise<User | null> {
    const client = await pool.connect();
    try {
      const result = await client.query<UserRow>(
        'SELECT * FROM users WHERE user_id = $1 AND guild_id = $2',
        [userId, guildId]
      );

      if (result.rows.length === 0) {
        return null;
      }

      return this.parseUserRow(result.rows[0]);
    } finally {
      client.release();
    }
  }

  /**
   * Ensure user exists in database with current username
   * Creates user if they don't exist, updates username if it changed
   * This should be called at the start of every command to ensure proper username tracking
   * NOTE: This does NOT ensure guild exists - call ensureGuild() first in commands
   *
   * @param userId - Discord user ID
   * @param guildId - Discord guild ID
   * @param username - Current Discord username
   * @returns User record (always returns, never null)
   */
  async ensureUser(userId: string, guildId: string, username: string): Promise<User> {
    let user = await this.getUser(userId, guildId);

    if (!user) {
      // User doesn't exist, create them
      // IMPORTANT: Guild must exist before this is called
      user = await this.createUser(userId, guildId, username);
    } else if (user.username !== username) {
      // User exists but username changed, update it
      await this.updateUsername(userId, guildId, username);
      user.username = username; // Update the in-memory object
    }

    return user;
  }

  /**
   * Register a guild in guild_settings table
   * Creates guild entry if it doesn't exist (required for foreign key constraint)
   * Can be called from guildCreate listener or lazily on first user interaction
   *
   * @param guildId - Discord guild ID
   * @param guildName - Discord guild name (optional)
   */
  async registerGuild(guildId: string, guildName?: string): Promise<void> {
    const client = await pool.connect();
    try {
      if (guildName) {
        // We have a guild name - insert or update it
        await client.query(
          `INSERT INTO guild_settings (guild_id, guild_name)
           VALUES ($1, $2)
           ON CONFLICT (guild_id) DO UPDATE SET guild_name = EXCLUDED.guild_name`,
          [guildId, guildName]
        );
        logger.info(`Registered guild: ${guildId} (${guildName})`);
      } else {
        // No guild name provided - only ensure guild exists, DON'T overwrite existing name
        await client.query(
          `INSERT INTO guild_settings (guild_id, guild_name)
           VALUES ($1, 'Unknown Guild')
           ON CONFLICT (guild_id) DO NOTHING`,
          [guildId]
        );
        logger.debug(`Ensured guild exists: ${guildId} (no name update)`);
      }
    } finally {
      client.release();
    }
  }

  /**
   * Ensure guild exists in database with current name
   * Updates guild name to fix "Unknown Guild" entries and keep names up-to-date
   * This should be called at the start of every command
   *
   * @param guildId - Discord guild ID
   * @param guildName - Current Discord guild name (optional but recommended)
   */
  async ensureGuild(guildId: string, guildName?: string): Promise<void> {
    await this.registerGuild(guildId, guildName);
  }

  /**
   * Create a new user with starting balance in a specific guild
   * IMPORTANT: Guild must already exist in guild_settings (call ensureGuild first)
   *
   * @param userId - Discord user ID
   * @param guildId - Discord guild ID
   * @param username - Discord username
   */
  async createUser(userId: string, guildId: string, username: string): Promise<User> {
    const client = await pool.connect();
    try {
      const result = await client.query<UserRow>(
        `INSERT INTO users (user_id, guild_id, username, balance, high_water_balance)
         VALUES ($1, $2, $3, $4, $4)
         ON CONFLICT (user_id, guild_id) DO NOTHING
         RETURNING *`,
        [userId, guildId, username, CASINO_CONFIG.STARTING_BALANCE]
      );

      if (result.rows.length > 0) {
        logger.info(`Created new user: ${userId} in guild ${guildId} (${username})`);
        return this.parseUserRow(result.rows[0]);
      }

      // User already existed in this guild, fetch and return
      return (await this.getUser(userId, guildId))!;
    } finally {
      client.release();
    }
  }

  /**
   * Update username for an existing user in a specific guild
   *
   * @param userId - Discord user ID
   * @param guildId - Discord guild ID
   * @param username - New username
   */
  async updateUsername(userId: string, guildId: string, username: string): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query(
        'UPDATE users SET username = $1, updated_at = NOW() WHERE user_id = $2 AND guild_id = $3',
        [username, userId, guildId]
      );
    } finally {
      client.release();
    }
  }

  /**
   * Update user balance atomically with transaction logging
   * Uses application logic with SQL transactions for atomicity
   *
   * IMPORTANT: Triggers fire-and-forget richest member update on resolved transactions
   *
   * @param userId - Discord user ID
   * @param guildId - Discord guild ID (REQUIRED)
   * @param amount - Amount to add/subtract (negative for deductions)
   * @param gameSource - Source of the transaction
   * @param updateType - Type of update for tracking
   * @param metadata - Additional data to store with transaction
   * @returns New balance after update
   */
  async updateBalance(
    userId: string,
    guildId: string,
    amount: number,
    gameSource: GameSource,
    updateType: UpdateType,
    metadata: Record<string, any> = {}
  ): Promise<number> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // 1. Ensure user exists in this guild (upsert pattern - create if new)
      await client.query(
        `INSERT INTO users (user_id, guild_id, balance, username)
         VALUES ($1, $2, $3, 'Unknown')
         ON CONFLICT (user_id, guild_id) DO NOTHING`,
        [userId, guildId, CASINO_CONFIG.STARTING_BALANCE]
      );

      // 2. Update user balance and high water balance atomically
      const balanceResult = await client.query<{ balance: string }>(
        `UPDATE users
         SET balance = balance + $1,
             high_water_balance = GREATEST(high_water_balance, balance + $1),
             updated_at = NOW()
         WHERE user_id = $2 AND guild_id = $3
         RETURNING balance`,
        [amount, userId, guildId]
      );

      const newBalance = parseInt(balanceResult.rows[0].balance, 10);

      // 3. Insert transaction record for auditing
      await client.query(
        `INSERT INTO transactions (user_id, guild_id, amount, balance_after, game_source, update_type, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [userId, guildId, amount, newBalance, gameSource, updateType, JSON.stringify(metadata)]
      );

      await client.query('COMMIT');

      logger.debug(
        `Wallet updated: ${userId} in guild ${guildId} ${amount >= 0 ? '+' : ''}${amount} -> ${newBalance} [${gameSource}:${updateType}]`
      );

      // 4. Fire-and-forget richest member update (only on resolved transactions)
      if (this.isResolvedUpdateType(updateType)) {
        // Import at method level to avoid circular dependency issues
        const { container } = await import('@sapphire/framework');
        container.leaderboardService
          .updateRichestMemberForGuild(guildId)
          .catch((err) => logger.error('Richest member update failed:', err));
      }

      return newBalance;
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error(`Failed to update wallet for ${userId} in guild ${guildId}:`, error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Check if user has sufficient balance in a specific guild
   *
   * @param userId - Discord user ID
   * @param guildId - Discord guild ID
   * @param amount - Amount to check
   */
  async hasSufficientBalance(userId: string, guildId: string, amount: number): Promise<boolean> {
    const balance = await this.getBalance(userId, guildId);
    return balance >= amount;
  }

  /**
   * Place a bet (deduct from balance)
   *
   * @param userId - Discord user ID
   * @param guildId - Discord guild ID
   * @param betAmount - Bet amount to deduct
   * @param gameSource - Game source
   * @param metadata - Additional metadata
   * @returns New balance after bet
   */
  async placeBet(
    userId: string,
    guildId: string,
    betAmount: number,
    gameSource: GameSource,
    metadata: Record<string, any> = {}
  ): Promise<number> {
    if (betAmount <= 0) {
      throw new Error('Bet amount must be positive');
    }

    const balance = await this.getBalance(userId, guildId);
    if (balance < betAmount) {
      throw new Error('Insufficient balance');
    }

    return this.updateBalance(userId, guildId, -betAmount, gameSource, UpdateType.BET_PLACED, {
      bet_amount: betAmount,
      ...metadata,
    });
  }

  /**
   * Award winnings (add to balance)
   *
   * @param userId - Discord user ID
   * @param guildId - Discord guild ID
   * @param winAmount - Win amount to add
   * @param gameSource - Game source
   * @param updateType - Update type (BET_WON, ROUND_WON, etc.)
   * @param metadata - Additional metadata
   * @returns New balance after winnings
   */
  async awardWinnings(
    userId: string,
    guildId: string,
    winAmount: number,
    gameSource: GameSource,
    updateType: UpdateType,
    metadata: Record<string, any> = {}
  ): Promise<number> {
    if (winAmount <= 0) {
      throw new Error('Win amount must be positive');
    }

    return this.updateBalance(userId, guildId, winAmount, gameSource, updateType, {
      win_amount: winAmount,
      ...metadata,
    });
  }

  /**
   * Transfer coins from one user to another (for loan command)
   * Atomically deducts from sender and adds to receiver within the same guild
   *
   * @param senderId - Sender's Discord user ID
   * @param receiverId - Receiver's Discord user ID
   * @param guildId - Discord guild ID
   * @param amount - Amount to transfer
   */
  async transferCoins(
    senderId: string,
    receiverId: string,
    guildId: string,
    amount: number
  ): Promise<{ senderBalance: number; receiverBalance: number }> {
    if (amount <= 0) {
      throw new Error('Transfer amount must be positive');
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Check sender has sufficient balance
      const senderBalance = await this.getBalance(senderId, guildId);
      if (senderBalance < amount) {
        throw new Error('Insufficient balance for transfer');
      }

      // Ensure both users exist in this guild
      await client.query(
        `INSERT INTO users (user_id, guild_id, balance, username)
         VALUES ($1, $2, $3, 'Unknown')
         ON CONFLICT (user_id, guild_id) DO NOTHING`,
        [senderId, guildId, CASINO_CONFIG.STARTING_BALANCE]
      );
      await client.query(
        `INSERT INTO users (user_id, guild_id, balance, username)
         VALUES ($1, $2, $3, 'Unknown')
         ON CONFLICT (user_id, guild_id) DO NOTHING`,
        [receiverId, guildId, CASINO_CONFIG.STARTING_BALANCE]
      );

      // Deduct from sender
      const senderResult = await client.query<{ balance: string }>(
        `UPDATE users
         SET balance = balance + $1,
             high_water_balance = GREATEST(high_water_balance, balance + $1),
             updated_at = NOW()
         WHERE user_id = $2 AND guild_id = $3
         RETURNING balance`,
        [-amount, senderId, guildId]
      );
      const newSenderBalance = parseInt(senderResult.rows[0].balance, 10);

      // Log sender transaction
      await client.query(
        `INSERT INTO transactions (user_id, guild_id, amount, balance_after, game_source, update_type, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          senderId,
          guildId,
          -amount,
          newSenderBalance,
          GameSource.LOAN,
          UpdateType.LOAN_SENT,
          JSON.stringify({ receiver_id: receiverId, amount }),
        ]
      );

      // Add to receiver
      const receiverResult = await client.query<{ balance: string }>(
        `UPDATE users
         SET balance = balance + $1,
             high_water_balance = GREATEST(high_water_balance, balance + $1),
             updated_at = NOW()
         WHERE user_id = $2 AND guild_id = $3
         RETURNING balance`,
        [amount, receiverId, guildId]
      );
      const newReceiverBalance = parseInt(receiverResult.rows[0].balance, 10);

      // Log receiver transaction
      await client.query(
        `INSERT INTO transactions (user_id, guild_id, amount, balance_after, game_source, update_type, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [
          receiverId,
          guildId,
          amount,
          newReceiverBalance,
          GameSource.LOAN,
          UpdateType.LOAN_RECEIVED,
          JSON.stringify({ sender_id: senderId, amount }),
        ]
      );

      await client.query('COMMIT');

      logger.info(`Loan in guild ${guildId}: ${senderId} -> ${receiverId} (${amount} coins)`);

      // Fire-and-forget richest member updates for both users (LOAN_SENT and LOAN_RECEIVED are resolved types)
      const { container } = await import('@sapphire/framework');
      container.leaderboardService
        .updateRichestMemberForGuild(guildId)
        .catch((err) => logger.error('Richest member update failed:', err));

      return {
        senderBalance: newSenderBalance,
        receiverBalance: newReceiverBalance,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error(`Failed to transfer coins in guild ${guildId}:`, error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Get balance history for a user (for graphs)
   * Filters out 'bet_placed' and 'round_won' to match Python behavior
   *
   * @param userId - Discord user ID
   * @param guildId - Discord guild ID
   * @param limit - Number of history entries to return
   */
  async getBalanceHistory(
    userId: string,
    guildId: string,
    limit: number = 100
  ): Promise<Array<{ balance: number; created_at: Date }>> {
    const client = await pool.connect();
    try {
      // Query from transactions table, filtering out intermediate states
      // This matches Python's behavior of excluding BET_PLACED and ROUND_WON
      const result = await client.query(
        `SELECT balance_after as balance, created_at
         FROM (
           SELECT balance_after, created_at
           FROM transactions
           WHERE user_id = $1 AND guild_id = $2
             AND update_type NOT IN ('bet_placed', 'round_won')
           ORDER BY created_at DESC
           LIMIT $3
         ) AS recent
         ORDER BY created_at ASC`,
        [userId, guildId, limit]
      );

      return result.rows;
    } finally {
      client.release();
    }
  }

  /**
   * Get recent transactions for a user in a specific guild
   *
   * @param userId - Discord user ID
   * @param guildId - Discord guild ID
   * @param limit - Number of transactions to return
   */
  async getRecentTransactions(userId: string, guildId: string, limit: number = 10) {
    const client = await pool.connect();
    try {
      const result = await client.query(
        `SELECT id, amount, balance_after, game_source, update_type, metadata, created_at
         FROM transactions
         WHERE user_id = $1 AND guild_id = $2
         ORDER BY created_at DESC
         LIMIT $3`,
        [userId, guildId, limit]
      );

      return result.rows;
    } finally {
      client.release();
    }
  }

  /**
   * Get beg count for a user in a specific guild
   *
   * @param userId - Discord user ID
   * @param guildId - Discord guild ID
   */
  async getBegCount(userId: string, guildId: string): Promise<number> {
    const client = await pool.connect();
    try {
      const result = await client.query<{ beg_count: number }>(
        'SELECT beg_count FROM users WHERE user_id = $1 AND guild_id = $2',
        [userId, guildId]
      );

      return result.rows[0]?.beg_count || 0;
    } finally {
      client.release();
    }
  }

  /**
   * Increment beg count for a user in a specific guild
   *
   * @param userId - Discord user ID
   * @param guildId - Discord guild ID
   */
  async incrementBegCount(userId: string, guildId: string): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query(
        'UPDATE users SET beg_count = beg_count + 1, updated_at = NOW() WHERE user_id = $1 AND guild_id = $2',
        [userId, guildId]
      );
    } finally {
      client.release();
    }
  }

  /**
   * Filter intermediate transaction types (for richest member updates)
   * Only "resolved" transaction types should trigger richest member role updates
   *
   * @param updateType - Transaction update type
   * @returns True if this is a resolved transaction (should trigger richest member update)
   */
  private isResolvedUpdateType(updateType: UpdateType): boolean {
    // Exclude intermediate states:
    // - BET_PLACED: Bet deducted but game not resolved yet
    // - ROUND_WON: Partial win in multi-round game (e.g., Ride the Bus cashout mid-game)
    return updateType !== UpdateType.BET_PLACED && updateType !== UpdateType.ROUND_WON;
  }
}
