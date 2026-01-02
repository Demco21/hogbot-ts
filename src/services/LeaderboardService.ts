import { pool, parseBigInt } from '../lib/database.js';
import { LeaderboardEntry } from '../lib/types.js';
import { container } from '@sapphire/framework';
import { safeLogger as logger } from '../lib/safe-logger.js';
import type { Guild } from 'discord.js';

/**
 * Raw database row for leaderboard (balance is BIGINT string)
 */
interface LeaderboardRow {
  user_id: string;
  username: string;
  balance: string;
  rank: number;
}

/**
 * LeaderboardService handles rankings and richest member role management
 *
 * MULTI-GUILD SUPPORT:
 * - All methods require guildId parameter
 * - Each guild has independent leaderboard and richest member tracking
 * - Real-time richest member updates (no debouncing)
 * - Silent disable when richest member role not configured
 */
export class LeaderboardService {
  // Maps guild_id -> current richest user_id (for tracking changes)
  private guildRichestMembers: Map<string, string | null> = new Map();

  /**
   * Convert raw database row to typed LeaderboardEntry
   */
  private parseLeaderboardRow(row: LeaderboardRow): LeaderboardEntry {
    return {
      user_id: row.user_id,
      username: row.username,
      balance: parseBigInt(row.balance),
      rank: row.rank,
    };
  }

  /**
   * Get top N users by balance for a specific guild
   * @param guildId - Discord guild ID
   * @param limit - Number of users to return (default 10)
   */
  async getTopUsers(guildId: string, limit: number = 10): Promise<LeaderboardEntry[]> {
    const client = await pool.connect();
    try {
      const result = await client.query<LeaderboardRow>(
        `SELECT user_id, username, balance,
                ROW_NUMBER() OVER (ORDER BY balance DESC) as rank
         FROM users
         WHERE guild_id = $1 AND balance > 0
         ORDER BY balance DESC
         LIMIT $2`,
        [guildId, limit]
      );

      return result.rows.map(row => this.parseLeaderboardRow(row));
    } finally {
      client.release();
    }
  }

  /**
   * Get user's rank on the leaderboard for a specific guild
   * @param userId - Discord user ID
   * @param guildId - Discord guild ID
   */
  async getUserRank(userId: string, guildId: string): Promise<number | null> {
    const client = await pool.connect();
    try {
      const result = await client.query<{ rank: string }>(
        `SELECT rank FROM (
           SELECT user_id, ROW_NUMBER() OVER (ORDER BY balance DESC) as rank
           FROM users
           WHERE guild_id = $1 AND balance > 0
         ) ranked
         WHERE user_id = $2`,
        [guildId, userId]
      );

      if (result.rows.length === 0) {
        return null;
      }

      return parseInt(result.rows[0].rank, 10);
    } finally {
      client.release();
    }
  }

  /**
   * Get the current richest member (rank 1) for a specific guild
   * @param guildId - Discord guild ID
   */
  async getRichestMember(guildId: string): Promise<LeaderboardEntry | null> {
    const client = await pool.connect();
    try {
      const result = await client.query<LeaderboardRow>(
        `SELECT user_id, username, balance, 1 as rank
         FROM users
         WHERE guild_id = $1 AND balance > 0
         ORDER BY balance DESC
         LIMIT 1`,
        [guildId]
      );

      if (result.rows.length === 0) {
        return null;
      }

      return this.parseLeaderboardRow(result.rows[0]);
    } finally {
      client.release();
    }
  }

  /**
   * Update richest member role for a specific guild (real-time, no debouncing)
   * This is called automatically by WalletService on balance changes (fire-and-forget)
   *
   * @param guildId - Discord guild ID
   */
  async updateRichestMemberForGuild(guildId: string): Promise<void> {
    try {
      // 1. Get role ID from GuildSettingsService (returns null if disabled)
      const roleId = await container.guildSettingsService.getRichestMemberRoleId(guildId);
      if (!roleId) {
        // Feature disabled for this guild, silent return
        return;
      }

      // 2. Get current richest member FOR THIS GUILD
      const richest = await this.getRichestMember(guildId);
      if (!richest) {
        logger.debug(`No richest member found for guild ${guildId}`);
        return;
      }

      // Convert user_id to string (database returns BIGINT as number)
      const richestUserId = String(richest.user_id);

      logger.debug(
        `Richest member check for guild ${guildId}: user_id=${richestUserId} (type: ${typeof richest.user_id}, converted: ${typeof richestUserId})`
      );

      // 3. Check if richest changed for this guild
      const currentRichest = this.guildRichestMembers.get(guildId);
      if (currentRichest === richestUserId) {
        // No change, skip update
        logger.debug(`Richest member unchanged for guild ${guildId}: ${richestUserId}`);
        return;
      }

      // 4. Get Discord guild
      const guild = container.client.guilds.cache.get(guildId);
      if (!guild) {
        logger.warn(`Guild ${guildId} not found in cache`);
        return;
      }

      logger.debug(`Updating richest role: old=${currentRichest}, new=${richestUserId}`);

      // 5. Update Discord role (remove from old, add to new)
      await this.updateRichestRole(guild, guildId, roleId, currentRichest, richestUserId);

      // 6. Update in-memory tracking
      this.guildRichestMembers.set(guildId, richestUserId);

      logger.info(
        `Richest member updated for guild ${guildId}: ${richest.username} (${richest.balance} coins)`
      );
    } catch (error) {
      logger.error(`Failed to update richest member for guild ${guildId}:`, error);
    }
  }

  /**
   * Update the richest member role in Discord
   * Handles edge cases: role not found, user left server, permission errors
   *
   * @param guild - Discord guild object
   * @param guildId - Guild ID (for logging)
   * @param roleId - Role ID to assign
   * @param previousUserId - Previous richest user (to remove role from)
   * @param newUserId - New richest user (to add role to)
   */
  private async updateRichestRole(
    guild: Guild,
    guildId: string,
    roleId: string,
    previousUserId: string | null | undefined,
    newUserId: string
  ): Promise<void> {
    const role = guild.roles.cache.get(roleId);
    if (!role) {
      logger.warn(`Richest member role ${roleId} not found in guild ${guildId}, disabling feature`);
      // Auto-disable feature by setting role to null
      await container.guildSettingsService.setRichestMemberRoleId(guildId, null);
      return;
    }

    try {
      // Remove role from previous richest
      if (previousUserId && previousUserId !== newUserId) {
        const previousMember = await guild.members.fetch(previousUserId).catch((err) => {
          logger.debug(`Could not fetch previous richest ${previousUserId} in guild ${guildId}:`, err.message);
          return null;
        });
        if (previousMember) {
          if (previousMember.roles.cache.has(role.id)) {
            await previousMember.roles.remove(role);
            logger.info(`Removed richest role from ${previousUserId} in guild ${guildId}`);
          }
        } else {
          logger.debug(`Previous richest user ${previousUserId} not found in guild ${guildId} (left server)`);
        }
      }

      // Add role to new richest
      const newMember = await guild.members.fetch(newUserId).catch((err) => {
        logger.error(`Failed to fetch member ${newUserId} in guild ${guildId}:`, err);
        return null;
      });
      if (newMember) {
        if (!newMember.roles.cache.has(role.id)) {
          await newMember.roles.add(role);
          logger.info(`Added richest role to ${newUserId} in guild ${guildId}`);
        } else {
          logger.debug(`User ${newUserId} already has richest role in guild ${guildId}`);
        }
      } else {
        logger.warn(`New richest user ${newUserId} not found in guild ${guildId} (left server or fetch failed)`);
      }
    } catch (error) {
      logger.error(`Failed to update richest role in guild ${guildId}:`, error);
      // Don't throw - this is fire-and-forget from WalletService
    }
  }

  /**
   * Initialize richest member tracking for all guilds on bot startup
   * Called during bot login to set up initial state
   */
  async initializeAllGuilds(): Promise<void> {
    const guilds = container.client.guilds.cache;

    logger.info(`Initializing richest member tracking for ${guilds.size} guilds...`);

    for (const [guildId, guild] of guilds) {
      try {
        // Initialize guild settings if not exists
        await container.guildSettingsService.initializeGuild(guildId, guild.name);

        // Update richest member for this guild (will check if feature is enabled)
        await this.updateRichestMemberForGuild(guildId);
      } catch (error) {
        logger.error(`Failed to initialize richest member for guild ${guildId}:`, error);
      }
    }

    logger.info('Richest member tracking initialized for all guilds');
  }
}
