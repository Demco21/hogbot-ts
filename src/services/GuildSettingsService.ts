import { db } from '../lib/database.js';
import { safeLogger as logger } from '../lib/safe-logger.js';
import { ChannelType, PermissionFlagsBits, Guild } from 'discord.js';

export interface BeersRenameResult {
  success: boolean;
  newName?: string;
  error?: string;
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * GuildSettingsService manages per-guild configuration with in-memory caching.
 */
export class GuildSettingsService {
  private richestMemberRoleCache: Map<string, string | null> = new Map();
  private casinoChannelCache: Map<string, string | null> = new Map();
  private aiAccessRoleCache: Map<string, string | null> = new Map();

  async getRichestMemberRoleId(guildId: string): Promise<string | null> {
    if (this.richestMemberRoleCache.has(guildId)) {
      return this.richestMemberRoleCache.get(guildId)!;
    }

    const row = db.prepare(
      'SELECT richest_member_role_id FROM guild_settings WHERE guild_id = ?'
    ).get(guildId) as { richest_member_role_id: string | null } | undefined;

    const roleId = row?.richest_member_role_id ?? null;
    this.richestMemberRoleCache.set(guildId, roleId);
    return roleId;
  }

  async setRichestMemberRoleId(guildId: string, roleId: string | null): Promise<void> {
    db.prepare(
      `INSERT INTO guild_settings (guild_id, richest_member_role_id)
       VALUES (?, ?)
       ON CONFLICT (guild_id) DO UPDATE
       SET richest_member_role_id = excluded.richest_member_role_id,
           updated_at = datetime('now')`
    ).run(guildId, roleId);

    this.richestMemberRoleCache.set(guildId, roleId);
    logger.info(`Updated richest member role for guild ${guildId}: ${roleId ?? 'disabled'}`);
  }

  async getAiAccessRoleId(guildId: string): Promise<string | null> {
    if (this.aiAccessRoleCache.has(guildId)) {
      return this.aiAccessRoleCache.get(guildId)!;
    }

    const row = db.prepare(
      'SELECT ai_access_role_id FROM guild_settings WHERE guild_id = ?'
    ).get(guildId) as { ai_access_role_id: string | null } | undefined;

    const roleId = row?.ai_access_role_id ?? null;
    this.aiAccessRoleCache.set(guildId, roleId);
    return roleId;
  }

  async setAiAccessRoleId(guildId: string, roleId: string | null): Promise<void> {
    db.prepare(
      `INSERT INTO guild_settings (guild_id, ai_access_role_id)
       VALUES (?, ?)
       ON CONFLICT (guild_id) DO UPDATE
       SET ai_access_role_id = excluded.ai_access_role_id,
           updated_at = datetime('now')`
    ).run(guildId, roleId);

    this.aiAccessRoleCache.set(guildId, roleId);
    logger.info(`Updated HogAI access role for guild ${guildId}: ${roleId ?? 'unset (unrestricted)'}`);
  }

  async initializeGuild(guildId: string, guildName: string): Promise<void> {
    db.prepare(
      `INSERT INTO guild_settings (guild_id, guild_name)
       VALUES (?, ?)
       ON CONFLICT (guild_id) DO UPDATE
       SET guild_name = excluded.guild_name,
           updated_at = datetime('now')`
    ).run(guildId, guildName);

    logger.info(`Initialized guild settings for ${guildName} (${guildId})`);
  }

  clearCache(): void {
    this.richestMemberRoleCache.clear();
    this.casinoChannelCache.clear();
    this.aiAccessRoleCache.clear();
    logger.debug('Cleared guild settings cache');
  }

  async getGuildsWithRichestMemberEnabled(): Promise<string[]> {
    const rows = db.prepare(
      `SELECT guild_id FROM guild_settings WHERE richest_member_role_id IS NOT NULL`
    ).all() as { guild_id: string }[];

    return rows.map((row) => row.guild_id);
  }

  async getCasinoChannelId(guildId: string): Promise<string | null> {
    if (this.casinoChannelCache.has(guildId)) {
      return this.casinoChannelCache.get(guildId)!;
    }

    const row = db.prepare(
      'SELECT casino_channel_id FROM guild_settings WHERE guild_id = ?'
    ).get(guildId) as { casino_channel_id: string | null } | undefined;

    const channelId = row?.casino_channel_id ?? null;
    this.casinoChannelCache.set(guildId, channelId);
    return channelId;
  }

  async setCasinoChannelId(guildId: string, channelId: string | null): Promise<void> {
    db.prepare(
      `INSERT INTO guild_settings (guild_id, casino_channel_id)
       VALUES (?, ?)
       ON CONFLICT (guild_id) DO UPDATE
       SET casino_channel_id = excluded.casino_channel_id,
           updated_at = datetime('now')`
    ).run(guildId, channelId);

    this.casinoChannelCache.set(guildId, channelId);
    logger.info(`Updated casino channel for guild ${guildId}: ${channelId ?? 'unrestricted'}`);
  }

  async getBeersChannelId(guildId: string): Promise<string | null> {
    const row = db.prepare(
      'SELECT beers_channel_id FROM guild_settings WHERE guild_id = ?'
    ).get(guildId) as { beers_channel_id: string | null } | undefined;

    return row?.beers_channel_id ?? null;
  }

  async setBeersChannelId(guildId: string, channelId: string | null): Promise<void> {
    db.prepare(
      `INSERT INTO guild_settings (guild_id, beers_channel_id)
       VALUES (?, ?)
       ON CONFLICT (guild_id) DO UPDATE
       SET beers_channel_id = excluded.beers_channel_id,
           updated_at = datetime('now')`
    ).run(guildId, channelId);

    logger.info(`Updated beers channel for guild ${guildId}: ${channelId ?? 'disabled'}`);
  }

  async getBeersTimezone(guildId: string): Promise<string> {
    const row = db.prepare(
      'SELECT beers_timezone FROM guild_settings WHERE guild_id = ?'
    ).get(guildId) as { beers_timezone: string } | undefined;

    return row?.beers_timezone || 'America/New_York';
  }

  async setBeersTimezone(guildId: string, timezone: string): Promise<void> {
    db.prepare(
      `INSERT INTO guild_settings (guild_id, beers_timezone)
       VALUES (?, ?)
       ON CONFLICT (guild_id) DO UPDATE
       SET beers_timezone = excluded.beers_timezone,
           updated_at = datetime('now')`
    ).run(guildId, timezone);

    logger.info(`Updated beers timezone for guild ${guildId}: ${timezone}`);
  }

  async getGuildsWithBeersChannelEnabled(): Promise<Array<{ guildId: string; channelId: string; timezone: string }>> {
    const rows = db.prepare(
      `SELECT guild_id, beers_channel_id, beers_timezone
       FROM guild_settings
       WHERE beers_channel_id IS NOT NULL`
    ).all() as { guild_id: string; beers_channel_id: string; beers_timezone: string }[];

    return rows.map((row) => ({
      guildId: row.guild_id,
      channelId: row.beers_channel_id,
      timezone: row.beers_timezone || 'America/New_York',
    }));
  }

  async getAllSettings(guildId: string): Promise<{
    richestMemberRoleId: string | null;
    casinoChannelId: string | null;
    beersChannelId: string | null;
    beersTimezone: string | null;
    guildName: string | null;
    aiAccessRoleId: string | null;
  }> {
    const row = db.prepare(
      `SELECT richest_member_role_id, casino_channel_id, beers_channel_id, beers_timezone, guild_name, ai_access_role_id
       FROM guild_settings
       WHERE guild_id = ?`
    ).get(guildId) as {
      richest_member_role_id: string | null;
      casino_channel_id: string | null;
      beers_channel_id: string | null;
      beers_timezone: string | null;
      guild_name: string | null;
      ai_access_role_id: string | null;
    } | undefined;

    if (!row) {
      return {
        richestMemberRoleId: null,
        casinoChannelId: null,
        beersChannelId: null,
        beersTimezone: null,
        guildName: null,
        aiAccessRoleId: null,
      };
    }

    return {
      richestMemberRoleId: row.richest_member_role_id,
      casinoChannelId: row.casino_channel_id,
      beersChannelId: row.beers_channel_id,
      beersTimezone: row.beers_timezone,
      guildName: row.guild_name,
      aiAccessRoleId: row.ai_access_role_id,
    };
  }

  async renameBeersChannel(guild: Guild, channelId: string, timezone: string): Promise<BeersRenameResult> {
    try {
      const channel = guild.channels.cache.get(channelId);
      if (!channel) return { success: false, error: 'Channel not found' };

      if (channel.type !== ChannelType.GuildVoice) {
        return { success: false, error: 'Channel is not a voice channel' };
      }

      const botMember = guild.members.me;
      if (!botMember?.permissions.has(PermissionFlagsBits.ManageChannels)) {
        return { success: false, error: 'Bot lacks MANAGE_CHANNELS permission' };
      }

      const dayIndex = this.getCurrentDayInTimezone(timezone);
      const newName = `🍺 ${DAYS[dayIndex]} Beers`;

      if (channel.name !== newName) {
        await channel.setName(newName);
        logger.info(`Renamed beers channel in ${guild.name}: ${newName}`);
      }

      return { success: true, newName };
    } catch (error) {
      logger.error('Error renaming beers channel:', error);
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return { success: false, error: errorMessage };
    }
  }

  private getCurrentDayInTimezone(timezone: string): number {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-US', { timeZone: timezone, weekday: 'long' });
    const dayName = formatter.format(now);
    return DAYS.indexOf(dayName);
  }
}
