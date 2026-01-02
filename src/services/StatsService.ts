import { pool, parseBigInt } from '../lib/database.js';
import { GameStats, WrappedStats } from '../lib/types.js';
import { GameSource, UpdateType } from '../constants.js';
import { safeLogger as logger } from '../lib/safe-logger.js';

/**
 * Raw database row for game_stats table (BIGINTs are strings)
 */
interface GameStatsRow {
  id: string;
  user_id: string;
  guild_id: string;
  game_source: GameSource;
  played: number;
  wins: number;
  losses: number;
  current_win_streak: number;
  current_losing_streak: number;
  best_win_streak: number;
  worst_losing_streak: number;
  highest_bet: string;
  highest_payout: string;
  highest_loss: string;
  extra_stats: Record<string, any>;
  created_at: Date;
  updated_at: Date;
}

/**
 * StatsService handles game statistics tracking and aggregation
 *
 * MULTI-GUILD SUPPORT:
 * - ALL methods require guildId parameter
 * - Stats are tracked per-guild (same user in different guilds has separate stats)
 */
export class StatsService {
  /**
   * Convert raw database row to typed GameStats object
   */
  private parseGameStatsRow(row: GameStatsRow): GameStats {
    return {
      id: parseBigInt(row.id),
      user_id: row.user_id,
      game_source: row.game_source,
      played: row.played,
      wins: row.wins,
      losses: row.losses,
      current_win_streak: row.current_win_streak,
      current_losing_streak: row.current_losing_streak,
      best_win_streak: row.best_win_streak,
      worst_losing_streak: row.worst_losing_streak,
      highest_bet: parseBigInt(row.highest_bet),
      highest_payout: parseBigInt(row.highest_payout),
      highest_loss: parseBigInt(row.highest_loss),
      extra_stats: row.extra_stats,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  /**
   * Get statistics for a specific game and user in a specific guild
   *
   * @param userId - Discord user ID
   * @param guildId - Discord guild ID
   * @param gameSource - Game source
   */
  async getGameStats(userId: string, guildId: string, gameSource: GameSource): Promise<GameStats | null> {
    const client = await pool.connect();
    try {
      const result = await client.query<GameStatsRow>(
        `SELECT * FROM game_stats WHERE user_id = $1 AND guild_id = $2 AND game_source = $3`,
        [userId, guildId, gameSource]
      );

      if (result.rows.length === 0) {
        return null;
      }

      return this.parseGameStatsRow(result.rows[0]);
    } finally {
      client.release();
    }
  }

  /**
   * Get all game statistics for a user in a specific guild
   *
   * @param userId - Discord user ID
   * @param guildId - Discord guild ID
   */
  async getAllGameStats(userId: string, guildId: string): Promise<GameStats[]> {
    const client = await pool.connect();
    try {
      const result = await client.query<GameStatsRow>(
        `SELECT * FROM game_stats WHERE user_id = $1 AND guild_id = $2 ORDER BY played DESC`,
        [userId, guildId]
      );

      return result.rows.map(row => this.parseGameStatsRow(row));
    } finally {
      client.release();
    }
  }

  /**
   * Update game statistics after a game in a specific guild
   *
   * @param userId - Discord user ID
   * @param guildId - Discord guild ID
   * @param gameSource - Game source
   * @param won - Whether the user won
   * @param betAmount - Bet amount
   * @param payout - Payout amount
   * @param extraStats - Extra game-specific stats
   */
  async updateGameStats(
    userId: string,
    guildId: string,
    gameSource: GameSource,
    won: boolean,
    betAmount: number,
    payout: number,
    extraStats: Record<string, any> = {}
  ): Promise<void> {
    const client = await pool.connect();
    try {
      const currentStats = await this.getGameStats(userId, guildId, gameSource);

      if (!currentStats) {
        // Create initial stats
        await client.query(
          `INSERT INTO game_stats (
             user_id, guild_id, game_source, played, wins, losses,
             current_win_streak, current_losing_streak,
             best_win_streak, worst_losing_streak,
             highest_bet, highest_payout, highest_loss, extra_stats
           ) VALUES ($1, $2, $3, 1, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
          [
            userId,
            guildId,
            gameSource,
            won ? 1 : 0, // wins
            won ? 0 : 1, // losses
            won ? 1 : 0, // current_win_streak
            won ? 0 : 1, // current_losing_streak
            won ? 1 : 0, // best_win_streak
            won ? 0 : 1, // worst_losing_streak
            betAmount, // highest_bet
            won ? payout : 0, // highest_payout
            won ? 0 : betAmount, // highest_loss
            JSON.stringify(extraStats),
          ]
        );
      } else {
        // Update existing stats
        const newWinStreak = won ? currentStats.current_win_streak + 1 : 0;
        const newLoseStreak = won ? 0 : currentStats.current_losing_streak + 1;
        const bestWinStreak = Math.max(currentStats.best_win_streak, newWinStreak);
        const worstLoseStreak = Math.max(currentStats.worst_losing_streak, newLoseStreak);
        const highestBet = Math.max(currentStats.highest_bet, betAmount);
        const highestPayout = won ? Math.max(currentStats.highest_payout, payout) : currentStats.highest_payout;
        const highestLoss = won ? currentStats.highest_loss : Math.max(currentStats.highest_loss, betAmount);

        // Merge extra stats - increment counters instead of overwriting
        const mergedExtraStats = { ...currentStats.extra_stats };
        for (const [key, value] of Object.entries(extraStats)) {
          if (typeof value === 'number' && typeof mergedExtraStats[key] === 'number') {
            // Increment numeric values
            mergedExtraStats[key] = (mergedExtraStats[key] as number) + value;
          } else if (mergedExtraStats[key] === undefined) {
            // New stat - set it
            mergedExtraStats[key] = value;
          } else {
            // Overwrite non-numeric or mismatched types
            mergedExtraStats[key] = value;
          }
        }

        await client.query(
          `UPDATE game_stats
           SET played = played + 1,
               wins = wins + $4,
               losses = losses + $5,
               current_win_streak = $6,
               current_losing_streak = $7,
               best_win_streak = $8,
               worst_losing_streak = $9,
               highest_bet = $10,
               highest_payout = $11,
               highest_loss = $12,
               extra_stats = $13,
               updated_at = NOW()
           WHERE user_id = $1 AND guild_id = $2 AND game_source = $3`,
          [
            userId,
            guildId,
            gameSource,
            won ? 1 : 0,
            won ? 0 : 1,
            newWinStreak,
            newLoseStreak,
            bestWinStreak,
            worstLoseStreak,
            highestBet,
            highestPayout,
            highestLoss,
            JSON.stringify(mergedExtraStats),
          ]
        );
      }

      logger.debug(`Updated stats for ${userId} in guild ${guildId} in ${gameSource}: ${won ? 'WIN' : 'LOSS'}`);
    } finally {
      client.release();
    }
  }

  /**
   * Get wrapped stats (aggregated across all games) for a user in a specific guild
   *
   * @param userId - Discord user ID
   * @param guildId - Discord guild ID
   */
  async getWrappedStats(userId: string, guildId: string): Promise<WrappedStats> {
    const client = await pool.connect();
    try {
      // Aggregate stats across all games in this guild
      const statsResult = await client.query<{
        total_games_played: string;
        total_won: string;
        total_lost: string;
        best_streak: string;
        worst_streak: string;
      }>(
        `SELECT
           COALESCE(SUM(played), 0) as total_games_played,
           COALESCE(SUM(wins), 0) as total_won,
           COALESCE(SUM(losses), 0) as total_lost,
           COALESCE(MAX(best_win_streak), 0) as best_streak,
           COALESCE(MAX(worst_losing_streak), 0) as worst_streak
         FROM game_stats
         WHERE user_id = $1 AND guild_id = $2`,
        [userId, guildId]
      );

      // Get transaction totals for this guild
      const txResult = await client.query<{
        total_wagered: string;
        total_winnings: string;
      }>(
        `SELECT
           COALESCE(SUM(ABS(amount)) FILTER (WHERE amount < 0), 0) as total_wagered,
           COALESCE(SUM(amount) FILTER (WHERE amount > 0 AND game_source NOT IN ('loan', 'beg', 'admin')), 0) as total_winnings
         FROM transactions
         WHERE user_id = $1 AND guild_id = $2`,
        [userId, guildId]
      );

      // Get favorite game (most played) in this guild
      const favoriteResult = await client.query<{ game_source: GameSource }>(
        `SELECT game_source
         FROM game_stats
         WHERE user_id = $1 AND guild_id = $2
         ORDER BY played DESC
         LIMIT 1`,
        [userId, guildId]
      );

      // Get biggest win/loss from transactions in this guild
      const extremesResult = await client.query<{
        biggest_win: string;
        biggest_loss: string;
      }>(
        `SELECT
           COALESCE(MAX(amount), 0) as biggest_win,
           COALESCE(MIN(amount), 0) as biggest_loss
         FROM transactions
         WHERE user_id = $1 AND guild_id = $2 AND game_source NOT IN ('loan', 'beg', 'admin')`,
        [userId, guildId]
      );

      const stats = statsResult.rows[0];
      const tx = txResult.rows[0];
      const extremes = extremesResult.rows[0];

      const totalGamesPlayed = parseBigInt(stats.total_games_played);
      const totalWon = parseBigInt(stats.total_won);
      const totalLost = parseBigInt(stats.total_lost);
      const totalWagered = parseBigInt(tx.total_wagered);
      const totalWinnings = parseBigInt(tx.total_winnings);

      return {
        total_games_played: totalGamesPlayed,
        total_won: totalWon,
        total_lost: totalLost,
        total_wagered: totalWagered,
        total_winnings: totalWinnings,
        net_profit: totalWinnings - totalWagered,
        win_rate: totalGamesPlayed > 0 ? (totalWon / totalGamesPlayed) * 100 : 0,
        favorite_game: favoriteResult.rows[0]?.game_source || null,
        biggest_win: parseBigInt(extremes.biggest_win),
        biggest_loss: Math.abs(parseBigInt(extremes.biggest_loss)),
        current_streak: 0, // Would need to calculate from recent games
        best_streak: parseBigInt(stats.best_streak),
        worst_streak: parseBigInt(stats.worst_streak),
      };
    } finally {
      client.release();
    }
  }
}
