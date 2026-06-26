import { db } from '../lib/database.js';
import {
  VoiceSession,
  VoiceTimeStats,
  VoiceTimeLeaderboardEntry,
} from '../lib/types.js';
import { safeLogger as logger } from '../lib/safe-logger.js';

interface VoiceSessionRow {
  id: number;
  user_id: string;
  guild_id: string;
  channel_id: string;
  joined_at: string;
}

interface VoiceTimeAggregateRow {
  id: number;
  user_id: string;
  guild_id: string;
  total_seconds: number;
  weekly_seconds: number;
  weekly_updated_at: string;
  created_at: string;
  updated_at: string;
}

interface VoiceTimeLeaderboardRow {
  user_id: string;
  username: string;
  seconds: number;
  rank: number;
}

/**
 * VoiceTimeService handles voice channel time tracking.
 */
export class VoiceTimeService {
  private parseVoiceSessionRow(row: VoiceSessionRow): VoiceSession {
    return {
      id: row.id,
      user_id: row.user_id,
      guild_id: row.guild_id,
      channel_id: row.channel_id,
      joined_at: row.joined_at,
    };
  }

  async trackVoiceJoin(userId: string, guildId: string, channelId: string): Promise<void> {
    const doJoin = db.transaction(() => {
      const existingSession = db.prepare(
        'SELECT * FROM voice_sessions WHERE user_id = ? AND guild_id = ?'
      ).get(userId, guildId) as VoiceSessionRow | undefined;

      if (existingSession) {
        logger.debug(
          `User ${userId} switched from ${existingSession.channel_id} to ${channelId} in guild ${guildId}`
        );
        this.endSessionInTransaction(userId, guildId);
      }

      db.prepare(
        `INSERT INTO voice_sessions (user_id, guild_id, channel_id, joined_at)
         VALUES (?, ?, ?, datetime('now'))
         ON CONFLICT (user_id, guild_id) DO UPDATE
         SET channel_id = excluded.channel_id, joined_at = datetime('now')`
      ).run(userId, guildId, channelId);
    });

    try {
      doJoin();
      logger.debug(`Voice join tracked: user ${userId} joined channel ${channelId} in guild ${guildId}`);
    } catch (error) {
      logger.error(`Failed to track voice join for user ${userId} in guild ${guildId}:`, error);
      throw error;
    }
  }

  async trackVoiceLeave(userId: string, guildId: string): Promise<void> {
    const doLeave = db.transaction(() => {
      this.endSessionInTransaction(userId, guildId);
    });

    try {
      doLeave();
      logger.debug(`Voice leave tracked: user ${userId} in guild ${guildId}`);
    } catch (error) {
      logger.error(`Failed to track voice leave for user ${userId} in guild ${guildId}:`, error);
      throw error;
    }
  }

  /**
   * End active session and update aggregates — must be called inside a db.transaction() callback.
   */
  private endSessionInTransaction(userId: string, guildId: string): void {
    const session = db.prepare(
      'SELECT * FROM voice_sessions WHERE user_id = ? AND guild_id = ?'
    ).get(userId, guildId) as VoiceSessionRow | undefined;

    if (!session) {
      logger.debug(`No active session found for user ${userId} in guild ${guildId}`);
      return;
    }

    const joinedAt = new Date(session.joined_at + 'Z');
    const leftAt = new Date();
    const durationSeconds = Math.floor((leftAt.getTime() - joinedAt.getTime()) / 1000);
    // Use same 'YYYY-MM-DD HH:MM:SS' format as SQLite datetime('now') so date comparisons work
    const leftAtStr = leftAt.toISOString().replace('T', ' ').slice(0, 19);

    db.prepare(
      `INSERT INTO voice_time_history (user_id, guild_id, channel_id, duration_seconds, joined_at, left_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(userId, guildId, session.channel_id, durationSeconds, session.joined_at, leftAtStr);

    db.prepare(
      `INSERT INTO voice_time_aggregates (user_id, guild_id, total_seconds, weekly_seconds)
       VALUES (?, ?, ?, ?)
       ON CONFLICT (user_id, guild_id) DO UPDATE
       SET total_seconds = voice_time_aggregates.total_seconds + ?,
           weekly_seconds = voice_time_aggregates.weekly_seconds + ?,
           updated_at = datetime('now')`
    ).run(userId, guildId, durationSeconds, durationSeconds, durationSeconds, durationSeconds);

    db.prepare(
      'DELETE FROM voice_sessions WHERE user_id = ? AND guild_id = ?'
    ).run(userId, guildId);

    logger.debug(`Session ended: user ${userId} in guild ${guildId}, duration ${durationSeconds}s`);
  }

  async getUserStats(userId: string, guildId: string): Promise<VoiceTimeStats | null> {
    const aggregate = db.prepare(
      'SELECT * FROM voice_time_aggregates WHERE user_id = ? AND guild_id = ?'
    ).get(userId, guildId) as VoiceTimeAggregateRow | undefined;

    const activeSession = db.prepare(
      'SELECT * FROM voice_sessions WHERE user_id = ? AND guild_id = ?'
    ).get(userId, guildId) as VoiceSessionRow | undefined;

    let activeSessionSeconds = 0;
    if (activeSession) {
      activeSessionSeconds = Math.floor(
        (Date.now() - new Date(activeSession.joined_at + 'Z').getTime()) / 1000
      );
    }

    if (!aggregate && activeSessionSeconds === 0) return null;

    const totalSeconds = aggregate?.total_seconds ?? 0;
    const weeklySeconds = aggregate?.weekly_seconds ?? 0;

    const userRow = db.prepare(
      'SELECT username FROM users WHERE user_id = ? AND guild_id = ? LIMIT 1'
    ).get(userId, guildId) as { username: string } | undefined;
    const username = userRow?.username ?? 'Unknown';

    return {
      user_id: userId,
      username,
      total_seconds: totalSeconds + activeSessionSeconds,
      weekly_seconds: weeklySeconds + activeSessionSeconds,
      active_session_seconds: activeSessionSeconds,
    };
  }

  async getTopUsers(
    guildId: string,
    period: 'week' | 'alltime',
    limit: number = 10
  ): Promise<VoiceTimeLeaderboardEntry[]> {
    const secondsColumn = period === 'week' ? 'weekly_seconds' : 'total_seconds';

    const rows = db.prepare(
      `SELECT
         agg.user_id,
         COALESCE(u.username, 'Unknown') as username,
         agg.${secondsColumn} + COALESCE(
           CAST(strftime('%s', 'now') - strftime('%s', vs.joined_at) AS INTEGER),
           0
         ) as seconds,
         ROW_NUMBER() OVER (ORDER BY (agg.${secondsColumn} + COALESCE(
           CAST(strftime('%s', 'now') - strftime('%s', vs.joined_at) AS INTEGER),
           0
         )) DESC) as rank
       FROM voice_time_aggregates agg
       LEFT JOIN voice_sessions vs ON vs.user_id = agg.user_id AND vs.guild_id = agg.guild_id
       LEFT JOIN users u ON u.user_id = agg.user_id AND u.guild_id = agg.guild_id
       WHERE agg.guild_id = ? AND agg.${secondsColumn} > 0
       ORDER BY seconds DESC
       LIMIT ?`
    ).all(guildId, limit) as VoiceTimeLeaderboardRow[];

    return rows.map((row) => ({
      user_id: row.user_id,
      username: row.username,
      seconds: row.seconds,
      rank: row.rank,
    }));
  }

  async getActiveSession(userId: string, guildId: string): Promise<VoiceSession | null> {
    const row = db.prepare(
      'SELECT * FROM voice_sessions WHERE user_id = ? AND guild_id = ?'
    ).get(userId, guildId) as VoiceSessionRow | undefined;

    return row ? this.parseVoiceSessionRow(row) : null;
  }

  async recalculateWeeklyTotals(guildId: string): Promise<void> {
    const doRecalc = db.transaction(() => {
      db.prepare(
        `UPDATE voice_time_aggregates
         SET weekly_seconds = COALESCE((
           SELECT SUM(duration_seconds)
           FROM voice_time_history h
           WHERE h.user_id = voice_time_aggregates.user_id
             AND h.guild_id = voice_time_aggregates.guild_id
             AND h.left_at >= datetime('now', '-7 days')
         ), 0),
         weekly_updated_at = datetime('now'),
         updated_at = datetime('now')
         WHERE guild_id = ?`
      ).run(guildId);
    });

    try {
      doRecalc();
      logger.info(`Recalculated weekly totals for guild ${guildId}`);
    } catch (error) {
      logger.error(`Failed to recalculate weekly totals for guild ${guildId}:`, error);
      throw error;
    }
  }

  async cleanupStaleSessions(thresholdHours: number = 24): Promise<number> {
    const doCleanup = db.transaction(() => {
      const staleSessions = db.prepare(
        `SELECT * FROM voice_sessions WHERE joined_at < datetime('now', ?)`
      ).all(`-${thresholdHours} hours`) as VoiceSessionRow[];

      for (const session of staleSessions) {
        this.endSessionInTransaction(session.user_id, session.guild_id);
      }

      return staleSessions.length;
    });

    try {
      const cleanedCount = doCleanup() as number;
      if (cleanedCount > 0) {
        logger.info(`Cleaned up ${cleanedCount} stale voice sessions`);
      }
      return cleanedCount;
    } catch (error) {
      logger.error('Failed to cleanup stale voice sessions:', error);
      throw error;
    }
  }
}
