import { db } from '../lib/database.js';
import { User } from '../lib/types.js';
import { GameSource, UpdateType, CASINO_CONFIG } from '../constants.js';
import { safeLogger as logger } from '../lib/safe-logger.js';

interface UserRow {
  user_id: string;
  guild_id: string;
  username: string;
  balance: number;
  high_water_balance: number;
  beg_count: number;
  created_at: string;
  updated_at: string;
}

/**
 * WalletService handles all balance operations using SQLite via better-sqlite3.
 *
 * MULTI-GUILD SUPPORT:
 * - ALL methods require guildId parameter
 * - Users have separate balances per guild (composite key: user_id + guild_id)
 */
export class WalletService {
  private parseUserRow(row: UserRow): User {
    return {
      user_id: row.user_id,
      username: row.username,
      balance: row.balance,
      high_water_balance: row.high_water_balance,
      beg_count: row.beg_count,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  async getBalance(userId: string, guildId: string): Promise<number> {
    const row = db.prepare(
      'SELECT balance FROM users WHERE user_id = ? AND guild_id = ?'
    ).get(userId, guildId) as { balance: number } | undefined;

    if (!row) {
      await this.createUser(userId, guildId, 'Unknown');
      return CASINO_CONFIG.STARTING_BALANCE;
    }

    return row.balance;
  }

  async getUser(userId: string, guildId: string): Promise<User | null> {
    const row = db.prepare(
      'SELECT * FROM users WHERE user_id = ? AND guild_id = ?'
    ).get(userId, guildId) as UserRow | undefined;

    return row ? this.parseUserRow(row) : null;
  }

  async ensureUser(userId: string, guildId: string, username: string): Promise<User> {
    let user = await this.getUser(userId, guildId);

    if (!user) {
      user = await this.createUser(userId, guildId, username);
    } else if (user.username !== username) {
      await this.updateUsername(userId, guildId, username);
      user.username = username;
    }

    return user;
  }

  async registerGuild(guildId: string, guildName?: string): Promise<void> {
    if (guildName) {
      db.prepare(
        `INSERT INTO guild_settings (guild_id, guild_name)
         VALUES (?, ?)
         ON CONFLICT (guild_id) DO UPDATE SET guild_name = excluded.guild_name, updated_at = datetime('now')`
      ).run(guildId, guildName);
      logger.info(`Registered guild: ${guildId} (${guildName})`);
    } else {
      db.prepare(
        `INSERT INTO guild_settings (guild_id, guild_name)
         VALUES (?, 'Unknown Guild')
         ON CONFLICT (guild_id) DO NOTHING`
      ).run(guildId);
      logger.debug(`Ensured guild exists: ${guildId} (no name update)`);
    }
  }

  async ensureGuild(guildId: string, guildName?: string): Promise<void> {
    await this.registerGuild(guildId, guildName);
  }

  async createUser(userId: string, guildId: string, username: string): Promise<User> {
    const row = db.prepare(
      `INSERT INTO users (user_id, guild_id, username, balance, high_water_balance)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (user_id, guild_id) DO NOTHING
       RETURNING *`
    ).get(userId, guildId, username, CASINO_CONFIG.STARTING_BALANCE, CASINO_CONFIG.STARTING_BALANCE) as UserRow | undefined;

    if (row) {
      logger.info(`Created new user: ${userId} in guild ${guildId} (${username})`);
      return this.parseUserRow(row);
    }

    return (await this.getUser(userId, guildId))!;
  }

  async updateUsername(userId: string, guildId: string, username: string): Promise<void> {
    db.prepare(
      `UPDATE users SET username = ?, updated_at = datetime('now') WHERE user_id = ? AND guild_id = ?`
    ).run(username, userId, guildId);
  }

  async updateBalance(
    userId: string,
    guildId: string,
    amount: number,
    gameSource: GameSource,
    updateType: UpdateType,
    metadata: Record<string, any> = {}
  ): Promise<number> {
    const doUpdate = db.transaction(() => {
      // Ensure user exists
      db.prepare(
        `INSERT INTO users (user_id, guild_id, balance, username)
         VALUES (?, ?, ?, 'Unknown')
         ON CONFLICT (user_id, guild_id) DO NOTHING`
      ).run(userId, guildId, CASINO_CONFIG.STARTING_BALANCE);

      const user = db.prepare(
        'SELECT balance, high_water_balance FROM users WHERE user_id = ? AND guild_id = ?'
      ).get(userId, guildId) as { balance: number; high_water_balance: number };

      const newBalance = user.balance + amount;
      const newHighWater = Math.max(user.high_water_balance, newBalance);

      db.prepare(
        `UPDATE users
         SET balance = ?,
             high_water_balance = ?,
             updated_at = datetime('now')
         WHERE user_id = ? AND guild_id = ?`
      ).run(newBalance, newHighWater, userId, guildId);

      db.prepare(
        `INSERT INTO transactions (user_id, guild_id, amount, balance_after, game_source, update_type, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(userId, guildId, amount, newBalance, gameSource, updateType, JSON.stringify(metadata));

      return newBalance;
    });

    const newBalance = doUpdate() as number;

    logger.debug(
      `Wallet updated: ${userId} in guild ${guildId} ${amount >= 0 ? '+' : ''}${amount} -> ${newBalance} [${gameSource}:${updateType}]`
    );

    if (this.isResolvedUpdateType(updateType)) {
      const { container } = await import('@sapphire/framework');
      container.leaderboardService
        .updateRichestMemberForGuild(guildId)
        .catch((err: Error) => logger.error('Richest member update failed:', err));
    }

    return newBalance;
  }

  async hasSufficientBalance(userId: string, guildId: string, amount: number): Promise<boolean> {
    const balance = await this.getBalance(userId, guildId);
    return balance >= amount;
  }

  async placeBet(
    userId: string,
    guildId: string,
    betAmount: number,
    gameSource: GameSource,
    metadata: Record<string, any> = {}
  ): Promise<number> {
    if (betAmount <= 0) throw new Error('Bet amount must be positive');

    const balance = await this.getBalance(userId, guildId);
    if (balance < betAmount) throw new Error('Insufficient balance');

    return this.updateBalance(userId, guildId, -betAmount, gameSource, UpdateType.BET_PLACED, {
      bet_amount: betAmount,
      ...metadata,
    });
  }

  async awardWinnings(
    userId: string,
    guildId: string,
    winAmount: number,
    gameSource: GameSource,
    updateType: UpdateType,
    metadata: Record<string, any> = {}
  ): Promise<number> {
    if (winAmount <= 0) throw new Error('Win amount must be positive');

    return this.updateBalance(userId, guildId, winAmount, gameSource, updateType, {
      win_amount: winAmount,
      ...metadata,
    });
  }

  async logTransaction(
    userId: string,
    guildId: string,
    gameSource: GameSource,
    updateType: UpdateType,
    metadata: Record<string, any> = {}
  ): Promise<number> {
    const balance = await this.getBalance(userId, guildId);

    db.prepare(
      `INSERT INTO transactions (user_id, guild_id, amount, balance_after, game_source, update_type, metadata)
       VALUES (?, ?, 0, ?, ?, ?, ?)`
    ).run(userId, guildId, balance, gameSource, updateType, JSON.stringify(metadata));

    logger.debug(
      `Transaction logged: ${userId} in guild ${guildId} [${gameSource}:${updateType}] (no balance change)`
    );

    return balance;
  }

  async transferCoins(
    senderId: string,
    receiverId: string,
    guildId: string,
    amount: number
  ): Promise<{ senderBalance: number; receiverBalance: number }> {
    if (amount <= 0) throw new Error('Transfer amount must be positive');

    const doTransfer = db.transaction(() => {
      const sender = db.prepare(
        'SELECT balance FROM users WHERE user_id = ? AND guild_id = ?'
      ).get(senderId, guildId) as { balance: number } | undefined;

      if (!sender || sender.balance < amount) {
        throw new Error('Insufficient balance for transfer');
      }

      // Ensure receiver exists
      db.prepare(
        `INSERT INTO users (user_id, guild_id, balance, username)
         VALUES (?, ?, ?, 'Unknown')
         ON CONFLICT (user_id, guild_id) DO NOTHING`
      ).run(receiverId, guildId, CASINO_CONFIG.STARTING_BALANCE);

      // Deduct from sender
      const senderRow = db.prepare(
        `UPDATE users
         SET balance = balance - ?,
             updated_at = datetime('now')
         WHERE user_id = ? AND guild_id = ?
         RETURNING balance`
      ).get(amount, senderId, guildId) as { balance: number };

      db.prepare(
        `INSERT INTO transactions (user_id, guild_id, amount, balance_after, game_source, update_type, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        senderId, guildId, -amount, senderRow.balance,
        GameSource.LOAN, UpdateType.LOAN_SENT,
        JSON.stringify({ receiver_id: receiverId, amount })
      );

      // Add to receiver
      const receiverRow = db.prepare(
        `UPDATE users
         SET balance = balance + ?,
             high_water_balance = CASE WHEN high_water_balance > balance + ? THEN high_water_balance ELSE balance + ? END,
             updated_at = datetime('now')
         WHERE user_id = ? AND guild_id = ?
         RETURNING balance`
      ).get(amount, amount, amount, receiverId, guildId) as { balance: number };

      db.prepare(
        `INSERT INTO transactions (user_id, guild_id, amount, balance_after, game_source, update_type, metadata)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        receiverId, guildId, amount, receiverRow.balance,
        GameSource.LOAN, UpdateType.LOAN_RECEIVED,
        JSON.stringify({ sender_id: senderId, amount })
      );

      return { senderBalance: senderRow.balance, receiverBalance: receiverRow.balance };
    });

    const result = doTransfer() as { senderBalance: number; receiverBalance: number };

    logger.info(`Loan in guild ${guildId}: ${senderId} -> ${receiverId} (${amount} coins)`);

    const { container } = await import('@sapphire/framework');
    container.leaderboardService
      .updateRichestMemberForGuild(guildId)
      .catch((err: Error) => logger.error('Richest member update failed:', err));

    return result;
  }

  async getBalanceHistory(
    userId: string,
    guildId: string,
    limit: number = 100
  ): Promise<Array<{ balance: number; created_at: string }>> {
    const rows = db.prepare(
      `SELECT balance_after as balance, created_at
       FROM (
         SELECT balance_after, created_at
         FROM transactions
         WHERE user_id = ? AND guild_id = ?
           AND update_type NOT IN ('bet_placed', 'round_won')
         ORDER BY created_at DESC
         LIMIT ?
       ) AS recent
       ORDER BY created_at ASC`
    ).all(userId, guildId, limit) as Array<{ balance: number; created_at: string }>;

    return rows;
  }

  async getRecentTransactions(userId: string, guildId: string, limit: number = 10) {
    return db.prepare(
      `SELECT id, amount, balance_after, game_source, update_type, metadata, created_at
       FROM transactions
       WHERE user_id = ? AND guild_id = ?
       ORDER BY created_at DESC
       LIMIT ?`
    ).all(userId, guildId, limit) as Array<{
      id: number;
      amount: number;
      balance_after: number;
      game_source: string;
      update_type: string;
      metadata: string;
      created_at: string;
    }>;
  }

  async getBegCount(userId: string, guildId: string): Promise<number> {
    const row = db.prepare(
      'SELECT beg_count FROM users WHERE user_id = ? AND guild_id = ?'
    ).get(userId, guildId) as { beg_count: number } | undefined;

    return row?.beg_count ?? 0;
  }

  async incrementBegCount(userId: string, guildId: string): Promise<void> {
    db.prepare(
      `UPDATE users SET beg_count = beg_count + 1, updated_at = datetime('now') WHERE user_id = ? AND guild_id = ?`
    ).run(userId, guildId);
  }

  checkLoanRateLimit(lenderId: string, guildId: string, maxLoans: number, hours: number): boolean {
    const row = db.prepare(
      `SELECT COUNT(*) as loan_count
       FROM loan_rate_limits
       WHERE lender_id = ? AND guild_id = ? AND created_at > datetime('now', ?)`
    ).get(lenderId, guildId, `-${hours} hours`) as { loan_count: number };

    return row.loan_count < maxLoans;
  }

  recordLoanRateLimit(lenderId: string, guildId: string): void {
    db.prepare(
      'INSERT INTO loan_rate_limits (lender_id, guild_id) VALUES (?, ?)'
    ).run(lenderId, guildId);
  }

  getLoanCount(lenderId: string, guildId: string, hours: number): number {
    const row = db.prepare(
      `SELECT COUNT(*) as loan_count
       FROM loan_rate_limits
       WHERE lender_id = ? AND guild_id = ? AND created_at > datetime('now', ?)`
    ).get(lenderId, guildId, `-${hours} hours`) as { loan_count: number };

    return row.loan_count;
  }

  private isResolvedUpdateType(updateType: UpdateType): boolean {
    return updateType !== UpdateType.BET_PLACED && updateType !== UpdateType.ROUND_WON;
  }
}
