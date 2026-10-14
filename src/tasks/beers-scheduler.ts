import { container } from '@sapphire/framework';
import { getDayOfWeekInTimezone } from '../utils/date-utils.js';

// Track last known day for each guild to detect changes
const guildLastDay: Map<string, number> = new Map();

/**
 * Start the beers channel scheduler
 * Checks every minute for day changes and renames channels accordingly
 */
export function startBeersScheduler(): void {
  // Run every minute to check for day changes
  setInterval(
    async () => {
      try {
        await checkAndUpdateBeersChannels();
      } catch (error) {
        container.logger.error('Beers scheduler error:', error);
      }
    },
    60 * 1000
  ); // 60 seconds

  container.logger.info('🍺 Beers channel scheduler started (checks every minute)');
}

/**
 * Check all guilds with beers channel enabled and update if day changed
 */
async function checkAndUpdateBeersChannels(): Promise<void> {
  const guildsWithBeers = await container.guildSettingsService.getGuildsWithBeersChannelEnabled();

  for (const { guildId, channelId, timezone } of guildsWithBeers) {
    try {
      // Get current day in guild's timezone using service helper
      const currentDay = getDayOfWeekInTimezone(timezone);
      const lastDay = guildLastDay.get(guildId);

      // Day changed or first run
      if (lastDay === undefined || lastDay !== currentDay) {
        const guild = container.client.guilds.cache.get(guildId);
        if (!guild) {
          container.logger.warn(`Guild ${guildId} not found in cache, skipping beers channel update`);
          continue;
        }

        // Use service to rename channel
        const result = await container.guildSettingsService.renameBeersChannel(guild, channelId, timezone);

        if (result.success) {
          guildLastDay.set(guildId, currentDay);
        } else {
          throw new Error(result.error || 'Unknown error');
        }
      }
    } catch (error) {
      container.logger.error(`Error updating beers channel for guild ${guildId}:`, error);
      // Auto-disable and notify admin
      await handleBeersChannelError(guildId, channelId, error);
    }
  }
}

/**
 * Handle errors when renaming beers channel
 * Auto-disables the feature and notifies the guild owner
 */
async function handleBeersChannelError(
  guildId: string,
  channelId: string,
  error: unknown
): Promise<void> {
  // Disable the feature
  await container.guildSettingsService.setBeersChannelId(guildId, null);

  // Notify guild owner or admin
  const guild = container.client.guilds.cache.get(guildId);
  if (!guild) return;

  try {
    const owner = await guild.fetchOwner();
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';

    await owner.send({
      content:
        `⚠️ **Beers Channel Feature Disabled**\n\n` +
        `The automatic beers channel renaming feature has been disabled in **${guild.name}** due to an error:\n\n` +
        `\`\`\`${errorMessage}\`\`\`\n\n` +
        `Common causes:\n` +
        `• Channel was deleted\n` +
        `• Bot lacks MANAGE_CHANNELS permission\n` +
        `• Channel is no longer a voice channel\n\n` +
        `You can re-enable this feature using \`/config\` once the issue is resolved.`,
    });

    container.logger.info(`Notified guild owner of ${guild.name} about beers channel error`);
  } catch (dmError) {
    container.logger.warn(`Could not DM guild owner for ${guildId}:`, dmError);
  }
}
