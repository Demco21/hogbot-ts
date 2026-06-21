import { db } from '../lib/database.js';
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
  created_at: string;
  updated_at: string;
}

interface GameSessionRow {
  session_id: number;
  user_id: string;
  guild_id: string;
  game_source: GameSource;
  status: 'active' | 'finished' | 'crashed';
  bet_amount: number;
  game_state: string;
  crash_reason: string | null;
  refund_amount: number | null;
  created_at: string;
  updated_at: string;
}

/**
 * Manages game session tracking and crash recovery.
 *
 * MULTI-GUILD SUPPORT:
 * - ALL methods require guildId parameter
 * - Game sessions are per-guild
 */
export class GameStateService {
  private parseSessionRow(row: GameSessionRow): GameSession {
    return {
      ...row,
      game_state: JSON.parse(row.game_state ?? '{}'),
    };
  }

  async checkAndRecoverCrashedGame(userId: string, guildId: string, gameSource: GameSource): Promise<boolean> {
    const row = db.prepare(
      `SELECT * FROM game_sessions
       WHERE user_id = ? AND guild_id = ? AND game_source = ? AND status = 'active'`
    ).get(userId, guildId, gameSource) as GameSessionRow | undefined;

    if (!row) return false;

    const activeGame = this.parseSessionRow(row);
    const timeoutMinutes = GAME_CRASH_THRESHOLD_MINUTES[gameSource];
    const timeoutMs = timeoutMinutes * 60 * 1000;
    const gameDuration = Date.now() - new Date(activeGame.created_at + 'Z').getTime();

    if (gameDuration < timeoutMs) return false;

    this.crashAndRefund(activeGame, timeoutMinutes);
    return true;
  }

  private crashAndRefund(activeGame: GameSession, timeoutMinutes: number): void {
    const crashReason = `Game timed out after ${timeoutMinutes} minutes`;
    const gameDurationSeconds = Math.floor(
      (Date.now() - new Date(activeGame.created_at + 'Z').getTime()) / 1000
    );

    const doCrash = db.transaction(() => {
      db.prepare(
        `INSERT INTO game_crash_history (
           user_id, guild_id, game_source, bet_amount, refund_amount,
           crash_reason, game_duration_seconds, game_state, game_started_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        activeGame.user_id,
        activeGame.guild_id,
        activeGame.game_source,
        activeGame.bet_amount,
        activeGame.bet_amount,
        crashReason,
        gameDurationSeconds,
        JSON.stringify(activeGame.game_state),
        activeGame.created_at
      );

      db.prepare(
        `UPDATE game_sessions
         SET status = 'crashed',
             crash_reason = ?,
             refund_amount = ?,
             updated_at = datetime('now')
         WHERE session_id = ?`
      ).run(crashReason, activeGame.bet_amount, activeGame.session_id);
    });

    doCrash();

    // Refund outside transaction so WalletService can run its own transaction
    container.walletService
      .updateBalance(
        activeGame.user_id,
        activeGame.guild_id,
        activeGame.bet_amount,
        activeGame.game_source,
        UpdateType.CRASH_REFUND,
        { session_id: activeGame.session_id, crash_reason: crashReason }
      )
      .catch((err: Error) => container.logger.error('Crash refund failed:', err));

    container.logger.warn(
      `Game crashed and refunded: user=${activeGame.user_id} guild=${activeGame.guild_id} ` +
        `game=${activeGame.game_source} bet=${activeGame.bet_amount} duration=${gameDurationSeconds}s`
    );
  }

  async startGame(
    userId: string,
    guildId: string,
    gameSource: GameSource,
    betAmount: number,
    gameState: Record<string, any> = {}
  ): Promise<void> {
    container.logger.info(
      `🎮 Starting game: ${gameSource} for user ${userId} in guild ${guildId} (bet: ${betAmount})`
    );

    const existing = db.prepare(
      `SELECT status FROM game_sessions WHERE user_id = ? AND guild_id = ? AND game_source = ?`
    ).get(userId, guildId, gameSource) as { status: string } | undefined;

    if (existing?.status === 'active') {
      throw new Error(`You already have an active ${gameSource} game. Finish it before starting a new one.`);
    }

    db.prepare(
      `INSERT INTO game_sessions (user_id, guild_id, game_source, status, bet_amount, game_state, created_at, updated_at)
       VALUES (?, ?, ?, 'active', ?, ?, datetime('now'), datetime('now'))
       ON CONFLICT (user_id, game_source, guild_id) DO UPDATE SET
         status = 'active',
         bet_amount = excluded.bet_amount,
         game_state = excluded.game_state,
         crash_reason = NULL,
         refund_amount = NULL,
         created_at = datetime('now'),
         updated_at = datetime('now')`
    ).run(userId, guildId, gameSource, betAmount, JSON.stringify(gameState));
  }

  async finishGame(userId: string, guildId: string, gameSource: GameSource): Promise<void> {
    const rows = db.prepare(
      `UPDATE game_sessions
       SET status = 'finished', updated_at = datetime('now')
       WHERE user_id = ? AND guild_id = ? AND game_source = ? AND status = 'active'
       RETURNING session_id`
    ).all(userId, guildId, gameSource) as { session_id: number }[];

    if (rows.length > 0) {
      container.logger.info(`✅ Finished game: ${gameSource} for user ${userId} in guild ${guildId}`);
    }
  }

  async hasActiveGame(userId: string, guildId: string, gameSource: GameSource): Promise<boolean> {
    const row = db.prepare(
      `SELECT 1 FROM game_sessions
       WHERE user_id = ? AND guild_id = ? AND game_source = ? AND status = 'active'`
    ).get(userId, guildId, gameSource);

    return row !== undefined;
  }

  async getActiveGame(userId: string, guildId: string, gameSource: GameSource): Promise<GameSession | null> {
    const row = db.prepare(
      `SELECT * FROM game_sessions
       WHERE user_id = ? AND guild_id = ? AND game_source = ? AND status = 'active'`
    ).get(userId, guildId, gameSource) as GameSessionRow | undefined;

    return row ? this.parseSessionRow(row) : null;
  }

  async pruneOldGames(daysToKeep: number = 7): Promise<number> {
    const rows = db.prepare(
      `DELETE FROM game_sessions
       WHERE status IN ('finished', 'crashed')
         AND updated_at < datetime('now', ?)
       RETURNING session_id`
    ).all(`-${daysToKeep} days`) as { session_id: number }[];

    const count = rows.length;
    if (count > 0) {
      container.logger.info(`Pruned ${count} old game sessions`);
    }
    return count;
  }
}
