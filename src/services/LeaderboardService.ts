import { db } from '../lib/database.js';
import { LeaderboardEntry } from '../lib/types.js';
import { container } from '@sapphire/framework';
import { safeLogger as logger } from '../lib/safe-logger.js';
import type { Guild } from 'discord.js';

interface LeaderboardRow {
  user_id: string;
  username: string;
  balance: number;
  rank: number;
}

/**
 * LeaderboardService handles rankings and richest member role management.
 *
 * MULTI-GUILD SUPPORT:
 * - All methods require guildId parameter
 */
export class LeaderboardService {
  private guildRichestMembers: Map<string, string | null> = new Map();

  private parseLeaderboardRow(row: LeaderboardRow): LeaderboardEntry {
    return {
      user_id: row.user_id,
      username: row.username,
      balance: row.balance,
      rank: row.rank,
    };
  }

  async getTopUsers(guildId: string, limit: number = 10): Promise<LeaderboardEntry[]> {
    const rows = db.prepare(
      `SELECT user_id, username, balance,
              ROW_NUMBER() OVER (ORDER BY balance DESC) as rank
       FROM users
       WHERE guild_id = ? AND balance > 0
       ORDER BY balance DESC
       LIMIT ?`
    ).all(guildId, limit) as LeaderboardRow[];

    return rows.map((row) => this.parseLeaderboardRow(row));
  }

  async getUserRank(userId: string, guildId: string): Promise<number | null> {
    const row = db.prepare(
      `SELECT rank FROM (
         SELECT user_id, ROW_NUMBER() OVER (ORDER BY balance DESC) as rank
         FROM users
         WHERE guild_id = ? AND balance > 0
       ) ranked
       WHERE user_id = ?`
    ).get(guildId, userId) as { rank: number } | undefined;

    return row?.rank ?? null;
  }

  async getRichestMember(guildId: string): Promise<LeaderboardEntry | null> {
    const row = db.prepare(
      `SELECT user_id, username, balance, 1 as rank
       FROM users
       WHERE guild_id = ? AND balance > 0
       ORDER BY balance DESC
       LIMIT 1`
    ).get(guildId) as LeaderboardRow | undefined;

    return row ? this.parseLeaderboardRow(row) : null;
  }

  async updateRichestMemberForGuild(guildId: string): Promise<void> {
    try {
      const roleId = await container.guildSettingsService.getRichestMemberRoleId(guildId);
      if (!roleId) return;

      const richest = await this.getRichestMember(guildId);
      if (!richest) {
        logger.debug(`No richest member found for guild ${guildId}`);
        return;
      }

      const richestUserId = String(richest.user_id);

      logger.debug(
        `Richest member check for guild ${guildId}: user_id=${richestUserId} (type: ${typeof richest.user_id}, converted: ${typeof richestUserId})`
      );

      const currentRichest = this.guildRichestMembers.get(guildId);
      if (currentRichest === richestUserId) {
        logger.debug(`Richest member unchanged for guild ${guildId}: ${richestUserId}`);
        return;
      }

      const guild = container.client.guilds.cache.get(guildId);
      if (!guild) {
        logger.warn(`Guild ${guildId} not found in cache`);
        return;
      }

      logger.debug(`Updating richest role: old=${currentRichest}, new=${richestUserId}`);

      await this.updateRichestRole(guild, guildId, roleId, currentRichest, richestUserId);

      this.guildRichestMembers.set(guildId, richestUserId);

      logger.info(
        `Richest member updated for guild ${guildId}: ${richest.username} (${richest.balance} coins)`
      );
    } catch (error) {
      logger.error(`Failed to update richest member for guild ${guildId}:`, error);
    }
  }

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
      await container.guildSettingsService.setRichestMemberRoleId(guildId, null);
      return;
    }

    try {
      if (previousUserId && previousUserId !== newUserId) {
        const previousMember = await guild.members.fetch(previousUserId).catch((err) => {
          logger.debug(`Could not fetch previous richest ${previousUserId} in guild ${guildId}:`, err.message);
          return null;
        });
        if (previousMember?.roles.cache.has(role.id)) {
          await previousMember.roles.remove(role);
          logger.info(`Removed richest role from ${previousUserId} in guild ${guildId}`);
        }
      } else if (!previousUserId) {
        // Bot restarted — in-memory state is gone. Strip the role from anyone who isn't the new richest.
        const membersWithRole = role.members;
        for (const [memberId, member] of membersWithRole) {
          if (memberId !== newUserId) {
            await member.roles.remove(role).catch((err) => {
              logger.warn(`Failed to remove stale richest role from ${memberId} in guild ${guildId}:`, err.message);
            });
            logger.info(`Removed stale richest role from ${memberId} in guild ${guildId}`);
          }
        }
      }

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
    }
  }

  async initializeAllGuilds(): Promise<void> {
    const guilds = container.client.guilds.cache;

    logger.info(`Initializing richest member tracking for ${guilds.size} guilds...`);

    for (const [guildId, guild] of guilds) {
      try {
        await container.guildSettingsService.initializeGuild(guildId, guild.name);
        await this.updateRichestMemberForGuild(guildId);
      } catch (error) {
        logger.error(`Failed to initialize richest member for guild ${guildId}:`, error);
      }
    }

    logger.info('Richest member tracking initialized for all guilds');
  }
}
