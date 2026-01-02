import { pool } from '../lib/database.js';
import { GameSource, GAME_CRASH_THRESHOLD_MINUTES, UpdateType } from '../constants.js';
import { container } from '@sapphire/framework';

export interface GameSession {
  session_id: number;
  user_id: string;
  guild_id: string;
  game_source: GameSource;
  status: 'active' | 'finished' | 'crashed';
  bet_amount: number;
  game_state: Record<string, any>;
  crash_reason: string | null;
  refund_amount: number | null;
  created_at: Date;
  updated_at: Date;
}

/**
 * Manages game session tracking and crash recovery
 * - Prevents users from starting multiple concurrent games per guild
 * - Automatic crash detection and refunds for timed-out games
 * - On-demand crash recovery when users try to start a new game
 *
 * MULTI-GUILD SUPPORT:
 * - ALL methods require guildId parameter
 * - Game sessions are per-guild (same user can have games in different guilds)
 */
export class GameStateService {
  /**
   * Check for crashed game and recover on-demand
   * Called at the start of every game command
   *
   * @param userId - Discord user ID
   * @param guildId - Discord guild ID
   * @param gameSource - Game source
   * @returns true if a game was crashed and recovered
   */
  async checkAndRecoverCrashedGame(userId: string, guildId: string, gameSource: GameSource): Promise<boolean> {
    const client = await pool.connect();
    try {
      // Find active game for this user/game in this guild
      const result = await client.query<GameSession>(
        `SELECT * FROM game_sessions
         WHERE user_id = $1 AND guild_id = $2 AND game_source = $3 AND status = 'active'`,
        [userId, guildId, gameSource]
      );

      if (result.rows.length === 0) {
        return false; // No active game
      }

      const activeGame = result.rows[0];

      // Check if game has timed out
      const timeoutMinutes = GAME_CRASH_THRESHOLD_MINUTES[gameSource];
      const timeoutMs = timeoutMinutes * 60 * 1000;
      const gameDuration = Date.now() - activeGame.created_at.getTime();

      if (gameDuration < timeoutMs) {
        return false; // Game still active, not timed out
      }

      // Crash the game and refund
      await this.crashAndRefund(client, activeGame, timeoutMinutes);
      return true;
    } finally {
      client.release();
    }
  }

  /**
   * Internal: Crash a game and refund the player
   */
  private async crashAndRefund(
    client: any,
    activeGame: GameSession,
    timeoutMinutes: number
  ): Promise<void> {
    try {
      await client.query('BEGIN');

      const crashReason = `Game timed out after ${timeoutMinutes} minutes`;
      const gameDurationSeconds = Math.floor((Date.now() - activeGame.created_at.getTime()) / 1000);

      // 1. Log crash to crash history table
      await client.query(
        `INSERT INTO game_crash_history (
           user_id, guild_id, game_source, bet_amount, refund_amount,
           crash_reason, game_duration_seconds, game_state,
           game_started_at, crashed_at
         ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())`,
        [
          activeGame.user_id,
          activeGame.guild_id,
          activeGame.game_source,
          activeGame.bet_amount,
          activeGame.bet_amount, // 100% refund
          crashReason,
          gameDurationSeconds,
          JSON.stringify(activeGame.game_state),
          activeGame.created_at,
        ]
      );

      // 2. Mark game as crashed in game_sessions
      await client.query(
        `UPDATE game_sessions
         SET status = 'crashed',
             crash_reason = $1,
             refund_amount = $2,
             updated_at = NOW()
         WHERE session_id = $3`,
        [crashReason, activeGame.bet_amount, activeGame.session_id]
      );

      // 3. Refund the player (100%)
      await container.walletService.updateBalance(
        activeGame.user_id,
        activeGame.guild_id,
        activeGame.bet_amount,
        activeGame.game_source,
        UpdateType.CRASH_REFUND,
        {
          session_id: activeGame.session_id,
          crash_reason: crashReason,
        }
      );

      await client.query('COMMIT');

      // 4. Log the crash
      container.logger.warn(
        `Game crashed and refunded: user=${activeGame.user_id} guild=${activeGame.guild_id} ` +
          `game=${activeGame.game_source} bet=${activeGame.bet_amount} ` +
          `duration=${gameDurationSeconds}s`
      );
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  }

  /**
   * Start a new game - creates game_sessions record
   *
   * @param userId - Discord user ID
   * @param guildId - Discord guild ID
   * @param gameSource - Game source
   * @param betAmount - Bet amount
   * @param gameState - Initial game state
   * @throws Error if user already has an active game of this type in this guild
   */
  async startGame(
    userId: string,
    guildId: string,
    gameSource: GameSource,
    betAmount: number,
    gameState: Record<string, any> = {}
  ): Promise<void> {
    const client = await pool.connect();
    try {
      container.logger.info(
        `🎮 Starting game: ${gameSource} for user ${userId} in guild ${guildId} (bet: ${betAmount})`
      );

      // Check if user already has an ACTIVE game in this guild
      const existing = await client.query(
        `SELECT status FROM game_sessions WHERE user_id = $1 AND guild_id = $2 AND game_source = $3`,
        [userId, guildId, gameSource]
      );

      if (existing.rows.length > 0 && existing.rows[0].status === 'active') {
        throw new Error(`You already have an active ${gameSource} game. Finish it before starting a new one.`);
      }

      // UPSERT: Insert new or update existing finished/crashed game to active
      await client.query(
        `INSERT INTO game_sessions (user_id, guild_id, game_source, status, bet_amount, game_state, created_at, updated_at)
         VALUES ($1, $2, $3, 'active', $4, $5, NOW(), NOW())
         ON CONFLICT (user_id, game_source, guild_id)
         DO UPDATE SET
           status = 'active',
           bet_amount = $4,
           game_state = $5,
           crash_reason = NULL,
           refund_amount = NULL,
           created_at = NOW(),
           updated_at = NOW()`,
        [userId, guildId, gameSource, betAmount, JSON.stringify(gameState)]
      );
    } finally {
      client.release();
    }
  }

  /**
   * Mark a game as finished
   *
   * @param userId - Discord user ID
   * @param guildId - Discord guild ID
   * @param gameSource - Game source
   */
  async finishGame(userId: string, guildId: string, gameSource: GameSource): Promise<void> {
    const client = await pool.connect();
    try {
      const result = await client.query(
        `UPDATE game_sessions
         SET status = 'finished', updated_at = NOW()
         WHERE user_id = $1 AND guild_id = $2 AND game_source = $3 AND status = 'active'
         RETURNING session_id`,
        [userId, guildId, gameSource]
      );

      if (result.rowCount && result.rowCount > 0) {
        container.logger.info(`✅ Finished game: ${gameSource} for user ${userId} in guild ${guildId}`);
      }
    } finally {
      client.release();
    }
  }

  /**
   * Check if user has an active game in a specific guild
   *
   * @param userId - Discord user ID
   * @param guildId - Discord guild ID
   * @param gameSource - Game source
   */
  async hasActiveGame(userId: string, guildId: string, gameSource: GameSource): Promise<boolean> {
    const client = await pool.connect();
    try {
      const result = await client.query(
        `SELECT 1 FROM game_sessions
         WHERE user_id = $1 AND guild_id = $2 AND game_source = $3 AND status = 'active'`,
        [userId, guildId, gameSource]
      );
      return result.rows.length > 0;
    } finally {
      client.release();
    }
  }

  /**
   * Get active game info (for crash recovery) in a specific guild
   *
   * @param userId - Discord user ID
   * @param guildId - Discord guild ID
   * @param gameSource - Game source
   */
  async getActiveGame(userId: string, guildId: string, gameSource: GameSource): Promise<GameSession | null> {
    const client = await pool.connect();
    try {
      const result = await client.query<GameSession>(
        `SELECT * FROM game_sessions
         WHERE user_id = $1 AND guild_id = $2 AND game_source = $3 AND status = 'active'`,
        [userId, guildId, gameSource]
      );
      return result.rows[0] || null;
    } finally {
      client.release();
    }
  }

  /**
   * Delete old finished/crashed games (optional cleanup)
   * Can be called manually or via admin command
   */
  async pruneOldGames(daysToKeep: number = 7): Promise<number> {
    const client = await pool.connect();
    try {
      const result = await client.query(
        `DELETE FROM game_sessions
         WHERE status IN ('finished', 'crashed')
           AND updated_at < NOW() - INTERVAL '1 day' * $1
         RETURNING session_id`,
        [daysToKeep]
      );

      const count = result.rowCount || 0;
      if (count > 0) {
        container.logger.info(`Pruned ${count} old game sessions`);
      }
      return count;
    } finally {
      client.release();
    }
  }
}
