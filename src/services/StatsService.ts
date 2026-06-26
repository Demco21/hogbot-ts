import { db } from '../lib/database.js';
import { GameStats, WrappedStats } from '../lib/types.js';
import { GameSource } from '../constants.js';
import { safeLogger as logger } from '../lib/safe-logger.js';

interface GameStatsRow {
  id: number;
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
  highest_bet: number;
  highest_payout: number;
  highest_loss: number;
  extra_stats: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * StatsService handles game statistics tracking and aggregation.
 *
 * MULTI-GUILD SUPPORT:
 * - ALL methods require guildId parameter
 */
export class StatsService {
  private parseGameStatsRow(row: GameStatsRow): GameStats {
    return {
      id: row.id,
      user_id: row.user_id,
      game_source: row.game_source,
      played: row.played,
      wins: row.wins,
      losses: row.losses,
      current_win_streak: row.current_win_streak,
      current_losing_streak: row.current_losing_streak,
      best_win_streak: row.best_win_streak,
      worst_losing_streak: row.worst_losing_streak,
      highest_bet: row.highest_bet,
      highest_payout: row.highest_payout,
      highest_loss: row.highest_loss,
      extra_stats: row.extra_stats ? JSON.parse(row.extra_stats) : {},
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  async getGameStats(userId: string, guildId: string, gameSource: GameSource): Promise<GameStats | null> {
    const row = db.prepare(
      `SELECT * FROM game_stats WHERE user_id = ? AND guild_id = ? AND game_source = ?`
    ).get(userId, guildId, gameSource) as GameStatsRow | undefined;

    return row ? this.parseGameStatsRow(row) : null;
  }

  async getAllGameStats(userId: string, guildId: string): Promise<GameStats[]> {
    const rows = db.prepare(
      `SELECT * FROM game_stats WHERE user_id = ? AND guild_id = ? ORDER BY played DESC`
    ).all(userId, guildId) as GameStatsRow[];

    return rows.map((row) => this.parseGameStatsRow(row));
  }

  async updateGameStats(
    userId: string,
    guildId: string,
    gameSource: GameSource,
    won: boolean,
    betAmount: number,
    payout: number,
    extraStats: Record<string, any> = {}
  ): Promise<void> {
    const currentStats = await this.getGameStats(userId, guildId, gameSource);

    if (!currentStats) {
      db.prepare(
        `INSERT INTO game_stats (
           user_id, guild_id, game_source, played, wins, losses,
           current_win_streak, current_losing_streak,
           best_win_streak, worst_losing_streak,
           highest_bet, highest_payout, highest_loss, extra_stats
         ) VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        userId,
        guildId,
        gameSource,
        won ? 1 : 0,
        won ? 0 : 1,
        won ? 1 : 0,
        won ? 0 : 1,
        won ? 1 : 0,
        won ? 0 : 1,
        betAmount,
        won ? payout : 0,
        won ? 0 : betAmount,
        JSON.stringify(extraStats)
      );
    } else {
      const newWinStreak = won ? currentStats.current_win_streak + 1 : 0;
      const newLoseStreak = won ? 0 : currentStats.current_losing_streak + 1;
      const bestWinStreak = Math.max(currentStats.best_win_streak, newWinStreak);
      const worstLoseStreak = Math.max(currentStats.worst_losing_streak, newLoseStreak);
      const highestBet = Math.max(currentStats.highest_bet, betAmount);
      const highestPayout = won ? Math.max(currentStats.highest_payout, payout) : currentStats.highest_payout;
      const highestLoss = won ? currentStats.highest_loss : Math.max(currentStats.highest_loss, betAmount);

      const mergedExtraStats = { ...currentStats.extra_stats };
      for (const [key, value] of Object.entries(extraStats)) {
        if (typeof value === 'number' && typeof mergedExtraStats[key] === 'number') {
          mergedExtraStats[key] = (mergedExtraStats[key] as number) + value;
        } else if (mergedExtraStats[key] === undefined) {
          mergedExtraStats[key] = value;
        } else {
          mergedExtraStats[key] = value;
        }
      }

      db.prepare(
        `UPDATE game_stats
         SET played = played + 1,
             wins = wins + ?,
             losses = losses + ?,
             current_win_streak = ?,
             current_losing_streak = ?,
             best_win_streak = ?,
             worst_losing_streak = ?,
             highest_bet = ?,
             highest_payout = ?,
             highest_loss = ?,
             extra_stats = ?,
             updated_at = datetime('now')
         WHERE user_id = ? AND guild_id = ? AND game_source = ?`
      ).run(
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
        userId,
        guildId,
        gameSource
      );
    }

    logger.debug(`Updated stats for ${userId} in guild ${guildId} in ${gameSource}: ${won ? 'WIN' : 'LOSS'}`);
  }

  async updateExtraStatsOnly(
    userId: string,
    guildId: string,
    gameSource: GameSource,
    extraStats: Record<string, any> = {}
  ): Promise<void> {
    const currentStats = await this.getGameStats(userId, guildId, gameSource);

    if (!currentStats) {
      db.prepare(
        `INSERT INTO game_stats (
           user_id, guild_id, game_source, played, wins, losses,
           current_win_streak, current_losing_streak,
           best_win_streak, worst_losing_streak,
           highest_bet, highest_payout, highest_loss, extra_stats
         ) VALUES (?, ?, ?, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ?)`
      ).run(userId, guildId, gameSource, JSON.stringify(extraStats));
    } else {
      const mergedExtraStats = { ...currentStats.extra_stats };
      for (const [key, value] of Object.entries(extraStats)) {
        if (typeof value === 'number' && typeof mergedExtraStats[key] === 'number') {
          mergedExtraStats[key] = (mergedExtraStats[key] as number) + value;
        } else if (mergedExtraStats[key] === undefined) {
          mergedExtraStats[key] = value;
        } else {
          mergedExtraStats[key] = value;
        }
      }

      db.prepare(
        `UPDATE game_stats
         SET extra_stats = ?,
             updated_at = datetime('now')
         WHERE user_id = ? AND guild_id = ? AND game_source = ?`
      ).run(JSON.stringify(mergedExtraStats), userId, guildId, gameSource);
    }

    logger.debug(`Updated extra stats only for ${userId} in guild ${guildId} in ${gameSource}`);
  }

  async getWrappedStats(userId: string, guildId: string): Promise<WrappedStats> {
    const stats = db.prepare(
      `SELECT
         COALESCE(SUM(played), 0) as total_games_played,
         COALESCE(SUM(wins), 0) as total_won,
         COALESCE(SUM(losses), 0) as total_lost,
         COALESCE(MAX(best_win_streak), 0) as best_streak,
         COALESCE(MAX(worst_losing_streak), 0) as worst_streak
       FROM game_stats
       WHERE user_id = ? AND guild_id = ?`
    ).get(userId, guildId) as {
      total_games_played: number;
      total_won: number;
      total_lost: number;
      best_streak: number;
      worst_streak: number;
    };

    const tx = db.prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN amount < 0 THEN ABS(amount) ELSE 0 END), 0) as total_wagered,
         COALESCE(SUM(CASE WHEN amount > 0 AND game_source NOT IN ('loan', 'beg', 'admin') THEN amount ELSE 0 END), 0) as total_winnings
       FROM transactions
       WHERE user_id = ? AND guild_id = ?`
    ).get(userId, guildId) as { total_wagered: number; total_winnings: number };

    const favoriteRow = db.prepare(
      `SELECT game_source
       FROM game_stats
       WHERE user_id = ? AND guild_id = ?
       ORDER BY played DESC
       LIMIT 1`
    ).get(userId, guildId) as { game_source: GameSource } | undefined;

    const extremes = db.prepare(
      `SELECT
         COALESCE(MAX(amount), 0) as biggest_win,
         COALESCE(MIN(amount), 0) as biggest_loss
       FROM transactions
       WHERE user_id = ? AND guild_id = ? AND game_source NOT IN ('loan', 'beg', 'admin')`
    ).get(userId, guildId) as { biggest_win: number; biggest_loss: number };

    const totalGamesPlayed = stats.total_games_played;
    const totalWon = stats.total_won;

    return {
      total_games_played: totalGamesPlayed,
      total_won: totalWon,
      total_lost: stats.total_lost,
      total_wagered: tx.total_wagered,
      total_winnings: tx.total_winnings,
      net_profit: tx.total_winnings - tx.total_wagered,
      win_rate: totalGamesPlayed > 0 ? (totalWon / totalGamesPlayed) * 100 : 0,
      favorite_game: favoriteRow?.game_source ?? null,
      biggest_win: extremes.biggest_win,
      biggest_loss: Math.abs(extremes.biggest_loss),
      current_streak: 0,
      best_streak: stats.best_streak,
      worst_streak: stats.worst_streak,
    };
  }
}
