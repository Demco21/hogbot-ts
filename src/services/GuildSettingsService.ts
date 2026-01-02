import { pool } from '../lib/database.js';
import { safeLogger as logger } from '../lib/safe-logger.js';
import { ChannelType, PermissionFlagsBits, Guild } from 'discord.js';

/**
 * Result of a beers channel rename operation
 */
export interface BeersRenameResult {
  success: boolean;
  newName?: string;
  error?: string;
}

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * GuildSettingsService manages per-guild configuration with in-memory caching
 *
 * This service handles:
 * - Richest member role ID storage and retrieval
 * - Guild initialization on first access
 * - In-memory caching for performance
 */
export class GuildSettingsService {
  // In-memory cache for richest member role IDs
  // Maps guild_id -> role_id (or null if disabled)
  private richestMemberRoleCache: Map<string, string | null> = new Map();

  // In-memory cache for casino channel IDs
  // Maps guild_id -> channel_id (or null if unrestricted)
  private casinoChannelCache: Map<string, string | null> = new Map();

  // Note: No cache for beers channel - only queried once per day in background job

  /**
   * Get richest member role ID for a guild
   * Returns null if the feature is disabled for this guild
   *
   * @param guildId - Discord guild ID
   * @returns Role ID or null if disabled
   */
  async getRichestMemberRoleId(guildId: string): Promise<string | null> {
    // Check cache first
    if (this.richestMemberRoleCache.has(guildId)) {
      return this.richestMemberRoleCache.get(guildId)!;
    }

    // Load from database
    const client = await pool.connect();
    try {
      const result = await client.query<{ richest_member_role_id: string | null }>(
        'SELECT richest_member_role_id FROM guild_settings WHERE guild_id = $1',
        [guildId]
      );

      if (result.rows.length === 0) {
        // Guild not initialized yet, return null (feature disabled)
        this.richestMemberRoleCache.set(guildId, null);
        return null;
      }

      // BIGINT is returned as string - convert to string if not null
      const roleId = result.rows[0].richest_member_role_id ? String(result.rows[0].richest_member_role_id) : null;
      this.richestMemberRoleCache.set(guildId, roleId);
      return roleId;
    } finally {
      client.release();
    }
  }

  /**
   * Set richest member role ID for a guild
   * Pass null to disable the feature
   *
   * @param guildId - Discord guild ID
   * @param roleId - Discord role ID (or null to disable)
   */
  async setRichestMemberRoleId(guildId: string, roleId: string | null): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query(
        `INSERT INTO guild_settings (guild_id, richest_member_role_id)
         VALUES ($1, $2)
         ON CONFLICT (guild_id) DO UPDATE
         SET richest_member_role_id = EXCLUDED.richest_member_role_id,
             updated_at = NOW()`,
        [guildId, roleId]
      );

      // Update cache
      this.richestMemberRoleCache.set(guildId, roleId);

      logger.info(`Updated richest member role for guild ${guildId}: ${roleId ?? 'disabled'}`);
    } finally {
      client.release();
    }
  }

  /**
   * Initialize guild settings (upsert pattern)
   * Creates guild_settings entry if it doesn't exist
   *
   * @param guildId - Discord guild ID
   * @param guildName - Guild name for reference
   */
  async initializeGuild(guildId: string, guildName: string): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query(
        `INSERT INTO guild_settings (guild_id, guild_name)
         VALUES ($1, $2)
         ON CONFLICT (guild_id) DO UPDATE
         SET guild_name = EXCLUDED.guild_name,
             updated_at = NOW()`,
        [guildId, guildName]
      );

      logger.info(`Initialized guild settings for ${guildName} (${guildId})`);
    } finally {
      client.release();
    }
  }

  /**
   * Clear cache (useful for testing or debugging)
   */
  clearCache(): void {
    this.richestMemberRoleCache.clear();
    this.casinoChannelCache.clear();
    logger.debug('Cleared guild settings cache');
  }

  /**
   * Get all guilds with richest member feature enabled
   * @returns Array of guild IDs
   */
  async getGuildsWithRichestMemberEnabled(): Promise<string[]> {
    const client = await pool.connect();
    try {
      const result = await client.query<{ guild_id: string }>(
        `SELECT guild_id FROM guild_settings
         WHERE richest_member_role_id IS NOT NULL`
      );

      return result.rows.map(row => row.guild_id);
    } finally {
      client.release();
    }
  }

  /**
   * Get casino channel ID for a guild
   * Returns null if not set (gambling allowed in all channels)
   * Uses cache for performance
   *
   * @param guildId - Discord guild ID
   * @returns Channel ID or null if not restricted
   */
  async getCasinoChannelId(guildId: string): Promise<string | null> {
    // Check cache first
    if (this.casinoChannelCache.has(guildId)) {
      return this.casinoChannelCache.get(guildId)!;
    }

    // Load from database
    const client = await pool.connect();
    try {
      const result = await client.query<{ casino_channel_id: string | null }>(
        'SELECT casino_channel_id FROM guild_settings WHERE guild_id = $1',
        [guildId]
      );

      if (result.rows.length === 0) {
        // Guild not initialized yet, return null (no restriction)
        this.casinoChannelCache.set(guildId, null);
        return null;
      }

      // BIGINT is returned as string - convert to string if not null
      const channelId = result.rows[0].casino_channel_id ? String(result.rows[0].casino_channel_id) : null;
      this.casinoChannelCache.set(guildId, channelId);
      return channelId;
    } finally {
      client.release();
    }
  }

  /**
   * Set casino channel ID for a guild
   * Pass null to allow gambling in all channels
   * Updates cache for immediate effect
   *
   * @param guildId - Discord guild ID
   * @param channelId - Discord channel ID (or null to disable restriction)
   */
  async setCasinoChannelId(guildId: string, channelId: string | null): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query(
        `INSERT INTO guild_settings (guild_id, casino_channel_id)
         VALUES ($1, $2)
         ON CONFLICT (guild_id) DO UPDATE
         SET casino_channel_id = EXCLUDED.casino_channel_id,
             updated_at = NOW()`,
        [guildId, channelId]
      );

      // Update cache
      this.casinoChannelCache.set(guildId, channelId);

      logger.info(`Updated casino channel for guild ${guildId}: ${channelId ?? 'unrestricted'}`);
    } finally {
      client.release();
    }
  }

  /**
   * Get beers channel ID for a guild
   * Returns null if the feature is disabled
   * No caching - only called once per day by background scheduler
   *
   * @param guildId - Discord guild ID
   * @returns Channel ID or null if disabled
   */
  async getBeersChannelId(guildId: string): Promise<string | null> {
    const client = await pool.connect();
    try {
      const result = await client.query<{ beers_channel_id: string | null }>(
        'SELECT beers_channel_id FROM guild_settings WHERE guild_id = $1',
        [guildId]
      );

      if (result.rows.length === 0) {
        return null;
      }

      return result.rows[0].beers_channel_id ? String(result.rows[0].beers_channel_id) : null;
    } finally {
      client.release();
    }
  }

  /**
   * Set beers channel ID for a guild
   * Pass null to disable the feature
   *
   * @param guildId - Discord guild ID
   * @param channelId - Discord channel ID (or null to disable)
   */
  async setBeersChannelId(guildId: string, channelId: string | null): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query(
        `INSERT INTO guild_settings (guild_id, beers_channel_id)
         VALUES ($1, $2)
         ON CONFLICT (guild_id) DO UPDATE
         SET beers_channel_id = EXCLUDED.beers_channel_id,
             updated_at = NOW()`,
        [guildId, channelId]
      );

      logger.info(`Updated beers channel for guild ${guildId}: ${channelId ?? 'disabled'}`);
    } finally {
      client.release();
    }
  }

  /**
   * Get beers channel timezone for a guild
   * Returns default timezone if not set
   * No caching - only called once per day by background scheduler
   *
   * @param guildId - Discord guild ID
   * @returns IANA timezone string (e.g., 'America/New_York')
   */
  async getBeersTimezone(guildId: string): Promise<string> {
    const client = await pool.connect();
    try {
      const result = await client.query<{ beers_timezone: string }>(
        'SELECT beers_timezone FROM guild_settings WHERE guild_id = $1',
        [guildId]
      );

      if (result.rows.length === 0) {
        return 'America/New_York'; // Default timezone
      }

      return result.rows[0].beers_timezone || 'America/New_York';
    } finally {
      client.release();
    }
  }

  /**
   * Set beers channel timezone for a guild
   *
   * @param guildId - Discord guild ID
   * @param timezone - IANA timezone string (e.g., 'America/New_York')
   */
  async setBeersTimezone(guildId: string, timezone: string): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query(
        `INSERT INTO guild_settings (guild_id, beers_timezone)
         VALUES ($1, $2)
         ON CONFLICT (guild_id) DO UPDATE
         SET beers_timezone = EXCLUDED.beers_timezone,
             updated_at = NOW()`,
        [guildId, timezone]
      );

      logger.info(`Updated beers timezone for guild ${guildId}: ${timezone}`);
    } finally {
      client.release();
    }
  }

  /**
   * Get all guilds with beers channel feature enabled
   * Used by the daily background scheduler
   *
   * @returns Array of objects with guildId, channelId, and timezone
   */
  async getGuildsWithBeersChannelEnabled(): Promise<Array<{ guildId: string; channelId: string; timezone: string }>> {
    const client = await pool.connect();
    try {
      const result = await client.query<{
        guild_id: string;
        beers_channel_id: string;
        beers_timezone: string;
      }>(
        `SELECT guild_id, beers_channel_id, beers_timezone
         FROM guild_settings
         WHERE beers_channel_id IS NOT NULL`
      );

      return result.rows.map(row => ({
        guildId: row.guild_id,
        channelId: row.beers_channel_id,
        timezone: row.beers_timezone || 'America/New_York',
      }));
    } finally {
      client.release();
    }
  }

  /**
   * Get all guild settings at once for display
   *
   * @param guildId - Discord guild ID
   * @returns Object with all settings
   */
  async getAllSettings(guildId: string): Promise<{
    richestMemberRoleId: string | null;
    casinoChannelId: string | null;
    beersChannelId: string | null;
    beersTimezone: string | null;
    guildName: string | null;
  }> {
    const client = await pool.connect();
    try {
      const result = await client.query<{
        richest_member_role_id: string | null;
        casino_channel_id: string | null;
        beers_channel_id: string | null;
        beers_timezone: string | null;
        guild_name: string | null;
      }>(
        `SELECT richest_member_role_id, casino_channel_id, beers_channel_id, beers_timezone, guild_name
         FROM guild_settings
         WHERE guild_id = $1`,
        [guildId]
      );

      if (result.rows.length === 0) {
        return {
          richestMemberRoleId: null,
          casinoChannelId: null,
          beersChannelId: null,
          beersTimezone: null,
          guildName: null,
        };
      }

      return {
        richestMemberRoleId: result.rows[0].richest_member_role_id,
        casinoChannelId: result.rows[0].casino_channel_id,
        beersChannelId: result.rows[0].beers_channel_id,
        beersTimezone: result.rows[0].beers_timezone,
        guildName: result.rows[0].guild_name,
      };
    } finally {
      client.release();
    }
  }

  /**
   * Rename a beers channel to reflect the current day
   * Shared logic used by both the scheduler and config command
   *
   * @param guild - Discord guild object
   * @param channelId - Voice channel ID to rename
   * @param timezone - IANA timezone string for determining current day
   * @returns Result object with success status and new name or error message
   */
  async renameBeersChannel(guild: Guild, channelId: string, timezone: string): Promise<BeersRenameResult> {
    try {
      const channel = guild.channels.cache.get(channelId);
      if (!channel) {
        return { success: false, error: 'Channel not found' };
      }

      if (channel.type !== ChannelType.GuildVoice) {
        return { success: false, error: 'Channel is not a voice channel' };
      }

      // Check bot permissions
      const botMember = guild.members.me;
      if (!botMember?.permissions.has(PermissionFlagsBits.ManageChannels)) {
        return { success: false, error: 'Bot lacks MANAGE_CHANNELS permission' };
      }

      // Get current day in the selected timezone
      const dayIndex = this.getCurrentDayInTimezone(timezone);
      const newName = `🍺 ${DAYS[dayIndex]} Beers`;

      // Only rename if name is different (avoid rate limits)
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

  /**
   * Get the current day of the week in a specific timezone
   * Returns 0 (Sunday) through 6 (Saturday)
   *
   * @param timezone - IANA timezone string (e.g., 'America/New_York')
   * @returns Day index (0-6)
   */
  private getCurrentDayInTimezone(timezone: string): number {
    const now = new Date();
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'long',
    });
    const dayName = formatter.format(now);
    return DAYS.indexOf(dayName);
  }
}
