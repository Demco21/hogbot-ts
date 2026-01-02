import { pool, parseBigInt } from '../lib/database.js';
import {
  VoiceSession,
  VoiceTimeHistory,
  VoiceTimeAggregate,
  VoiceTimeStats,
  VoiceTimeLeaderboardEntry,
} from '../lib/types.js';
import { safeLogger as logger } from '../lib/safe-logger.js';

/**
 * Raw database rows (BIGINTs are strings before parsing)
 */
interface VoiceSessionRow {
  id: number;
  user_id: string;
  guild_id: string;
  channel_id: string;
  joined_at: Date;
}

interface VoiceTimeAggregateRow {
  id: number;
  user_id: string;
  guild_id: string;
  total_seconds: string;
  weekly_seconds: string;
  weekly_updated_at: Date;
  created_at: Date;
  updated_at: Date;
}

interface VoiceTimeLeaderboardRow {
  user_id: string;
  username: string;
  seconds: string;
  rank: number;
}

/**
 * VoiceTimeService handles voice channel time tracking
 *
 * Features:
 * - Track active voice sessions
 * - Calculate weekly and all-time totals
 * - Exclude AFK channels automatically
 * - Include active session time in calculations
 * - Handle edge cases: bot restarts, channel switches, user disconnects
 */
export class VoiceTimeService {
  /**
   * Parse voice session row
   */
  private parseVoiceSessionRow(row: VoiceSessionRow): VoiceSession {
    return {
      id: row.id,
      user_id: row.user_id,
      guild_id: row.guild_id,
      channel_id: row.channel_id,
      joined_at: row.joined_at,
    };
  }

  /**
   * Parse aggregate row
   */
  private parseAggregateRow(row: VoiceTimeAggregateRow): VoiceTimeAggregate {
    return {
      id: row.id,
      user_id: row.user_id,
      guild_id: row.guild_id,
      total_seconds: parseBigInt(row.total_seconds),
      weekly_seconds: parseBigInt(row.weekly_seconds),
      weekly_updated_at: row.weekly_updated_at,
      created_at: row.created_at,
      updated_at: row.updated_at,
    };
  }

  /**
   * Parse leaderboard row
   */
  private parseLeaderboardRow(row: VoiceTimeLeaderboardRow): VoiceTimeLeaderboardEntry {
    return {
      user_id: row.user_id,
      username: row.username,
      seconds: parseBigInt(row.seconds),
      rank: row.rank,
    };
  }

  /**
   * Track voice channel join
   * Creates or updates active session
   *
   * @param userId - Discord user ID
   * @param guildId - Discord guild ID
   * @param channelId - Voice channel ID
   */
  async trackVoiceJoin(userId: string, guildId: string, channelId: string): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Check if user already has an active session (edge case: channel switch without leave event)
      const existingSession = await client.query(
        'SELECT * FROM voice_sessions WHERE user_id = $1 AND guild_id = $2',
        [userId, guildId]
      );

      if (existingSession.rows.length > 0) {
        // User switched channels - end previous session first
        const oldChannelId = existingSession.rows[0].channel_id;
        logger.debug(`User ${userId} switched from ${oldChannelId} to ${channelId} in guild ${guildId}`);

        // End old session internally (don't use trackVoiceLeave to avoid recursion)
        await this.endSession(client, userId, guildId);
      }

      // Create new active session
      await client.query(
        `INSERT INTO voice_sessions (user_id, guild_id, channel_id, joined_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (user_id, guild_id) DO UPDATE
         SET channel_id = EXCLUDED.channel_id, joined_at = NOW()`,
        [userId, guildId, channelId]
      );

      await client.query('COMMIT');
      logger.debug(`Voice join tracked: user ${userId} joined channel ${channelId} in guild ${guildId}`);
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error(`Failed to track voice join for user ${userId} in guild ${guildId}:`, error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Track voice channel leave
   * Ends active session and records to history
   *
   * @param userId - Discord user ID
   * @param guildId - Discord guild ID
   */
  async trackVoiceLeave(userId: string, guildId: string): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await this.endSession(client, userId, guildId);
      await client.query('COMMIT');
      logger.debug(`Voice leave tracked: user ${userId} in guild ${guildId}`);
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error(`Failed to track voice leave for user ${userId} in guild ${guildId}:`, error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * End active session and update aggregates
   * Helper method used by both trackVoiceLeave and trackVoiceJoin (channel switch)
   *
   * @param client - PostgreSQL client (must be in transaction)
   * @param userId - Discord user ID
   * @param guildId - Discord guild ID
   */
  private async endSession(client: any, userId: string, guildId: string): Promise<void> {
    // Get active session
    const sessionResult = await client.query(
      'SELECT * FROM voice_sessions WHERE user_id = $1 AND guild_id = $2',
      [userId, guildId]
    );

    if (sessionResult.rows.length === 0) {
      logger.debug(`No active session found for user ${userId} in guild ${guildId}`);
      return;
    }

    const session = sessionResult.rows[0];
    const joinedAt = session.joined_at;
    const channelId = session.channel_id;
    const leftAt = new Date();
    const durationSeconds = Math.floor((leftAt.getTime() - joinedAt.getTime()) / 1000);

    // Insert into history
    await client.query(
      `INSERT INTO voice_time_history (user_id, guild_id, channel_id, duration_seconds, joined_at, left_at)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [userId, guildId, channelId, durationSeconds, joinedAt, leftAt]
    );

    // Update aggregates
    await client.query(
      `INSERT INTO voice_time_aggregates (user_id, guild_id, total_seconds, weekly_seconds)
       VALUES ($1, $2, $3, $3)
       ON CONFLICT (user_id, guild_id) DO UPDATE
       SET total_seconds = voice_time_aggregates.total_seconds + $3,
           weekly_seconds = voice_time_aggregates.weekly_seconds + $3,
           updated_at = NOW()`,
      [userId, guildId, durationSeconds]
    );

    // Delete active session
    await client.query(
      'DELETE FROM voice_sessions WHERE user_id = $1 AND guild_id = $2',
      [userId, guildId]
    );

    logger.debug(`Session ended: user ${userId} in guild ${guildId}, duration ${durationSeconds}s`);
  }

  /**
   * Get user's voice time stats (weekly + all-time + active session)
   *
   * @param userId - Discord user ID
   * @param guildId - Discord guild ID
   * @returns Voice time stats or null if no data
   */
  async getUserStats(userId: string, guildId: string): Promise<VoiceTimeStats | null> {
    const client = await pool.connect();
    try {
      // Get aggregates
      const aggregateResult = await client.query<VoiceTimeAggregateRow>(
        'SELECT * FROM voice_time_aggregates WHERE user_id = $1 AND guild_id = $2',
        [userId, guildId]
      );

      // Get active session (if any)
      const activeSessionResult = await client.query<VoiceSessionRow>(
        'SELECT * FROM voice_sessions WHERE user_id = $1 AND guild_id = $2',
        [userId, guildId]
      );

      // Calculate active session duration
      let activeSessionSeconds = 0;
      if (activeSessionResult.rows.length > 0) {
        const session = activeSessionResult.rows[0];
        const now = new Date();
        activeSessionSeconds = Math.floor((now.getTime() - session.joined_at.getTime()) / 1000);
      }

      // If no aggregate and no active session, return null
      if (aggregateResult.rows.length === 0 && activeSessionSeconds === 0) {
        return null;
      }

      const aggregate = aggregateResult.rows[0];
      const totalSeconds = aggregate ? parseBigInt(aggregate.total_seconds) : 0;
      const weeklySeconds = aggregate ? parseBigInt(aggregate.weekly_seconds) : 0;

      // Get username from users table
      const userResult = await client.query(
        'SELECT username FROM users WHERE user_id = $1 AND guild_id = $2 LIMIT 1',
        [userId, guildId]
      );
      const username = userResult.rows[0]?.username || 'Unknown';

      return {
        user_id: userId,
        username,
        total_seconds: totalSeconds + activeSessionSeconds,
        weekly_seconds: weeklySeconds + activeSessionSeconds,
        active_session_seconds: activeSessionSeconds,
      };
    } finally {
      client.release();
    }
  }

  /**
   * Get top N users by voice time for a specific period
   * Includes active session time in calculations
   *
   * @param guildId - Discord guild ID
   * @param period - 'week' or 'alltime'
   * @param limit - Number of users to return (default 10)
   */
  async getTopUsers(
    guildId: string,
    period: 'week' | 'alltime',
    limit: number = 10
  ): Promise<VoiceTimeLeaderboardEntry[]> {
    const client = await pool.connect();
    try {
      const secondsColumn = period === 'week' ? 'weekly_seconds' : 'total_seconds';

      // Query aggregates and join with users for usernames
      // Also LEFT JOIN active sessions to include active time
      const result = await client.query<VoiceTimeLeaderboardRow>(
        `SELECT
           agg.user_id,
           COALESCE(u.username, 'Unknown') as username,
           agg.${secondsColumn} + COALESCE(
             EXTRACT(EPOCH FROM (NOW() - vs.joined_at))::BIGINT,
             0
           ) as seconds,
           ROW_NUMBER() OVER (ORDER BY agg.${secondsColumn} + COALESCE(
             EXTRACT(EPOCH FROM (NOW() - vs.joined_at))::BIGINT,
             0
           ) DESC) as rank
         FROM voice_time_aggregates agg
         LEFT JOIN voice_sessions vs ON vs.user_id = agg.user_id AND vs.guild_id = agg.guild_id
         LEFT JOIN users u ON u.user_id = agg.user_id AND u.guild_id = agg.guild_id
         WHERE agg.guild_id = $1 AND agg.${secondsColumn} > 0
         ORDER BY seconds DESC
         LIMIT $2`,
        [guildId, limit]
      );

      return result.rows.map((row) => this.parseLeaderboardRow(row));
    } finally {
      client.release();
    }
  }

  /**
   * Get active session for a user (if any)
   *
   * @param userId - Discord user ID
   * @param guildId - Discord guild ID
   */
  async getActiveSession(userId: string, guildId: string): Promise<VoiceSession | null> {
    const client = await pool.connect();
    try {
      const result = await client.query<VoiceSessionRow>(
        'SELECT * FROM voice_sessions WHERE user_id = $1 AND guild_id = $2',
        [userId, guildId]
      );

      if (result.rows.length === 0) {
        return null;
      }

      return this.parseVoiceSessionRow(result.rows[0]);
    } finally {
      client.release();
    }
  }

  /**
   * Recalculate weekly totals for all users in a guild
   * Should be run periodically (daily cron job) to maintain rolling 7-day window
   *
   * This queries voice_time_history for sessions in the last 7 days and updates
   * the weekly_seconds in voice_time_aggregates
   *
   * @param guildId - Discord guild ID
   */
  async recalculateWeeklyTotals(guildId: string): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Calculate new weekly totals from history (last 7 days)
      await client.query(
        `UPDATE voice_time_aggregates agg
         SET weekly_seconds = COALESCE(
           (SELECT SUM(duration_seconds)
            FROM voice_time_history h
            WHERE h.user_id = agg.user_id
              AND h.guild_id = agg.guild_id
              AND h.left_at >= NOW() - INTERVAL '7 days'),
           0
         ),
         weekly_updated_at = NOW(),
         updated_at = NOW()
         WHERE agg.guild_id = $1`,
        [guildId]
      );

      await client.query('COMMIT');
      logger.info(`Recalculated weekly totals for guild ${guildId}`);
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error(`Failed to recalculate weekly totals for guild ${guildId}:`, error);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Cleanup stale active sessions (bot restart recovery)
   * Sessions older than threshold are ended automatically
   *
   * This should be called on bot startup to handle sessions that were
   * active when the bot went offline
   *
   * @param thresholdHours - Hours of inactivity before session is considered stale (default 24)
   */
  async cleanupStaleSessions(thresholdHours: number = 24): Promise<number> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Get all stale sessions
      const staleSessionsResult = await client.query<VoiceSessionRow>(
        `SELECT * FROM voice_sessions
         WHERE joined_at < NOW() - INTERVAL '${thresholdHours} hours'`
      );

      let cleanedCount = 0;

      for (const session of staleSessionsResult.rows) {
        await this.endSession(client, session.user_id, session.guild_id);
        cleanedCount++;
      }

      await client.query('COMMIT');

      if (cleanedCount > 0) {
        logger.info(`Cleaned up ${cleanedCount} stale voice sessions`);
      }

      return cleanedCount;
    } catch (error) {
      await client.query('ROLLBACK');
      logger.error('Failed to cleanup stale voice sessions:', error);
      throw error;
    } finally {
      client.release();
    }
  }
}
