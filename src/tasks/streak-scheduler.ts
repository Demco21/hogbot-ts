import { container } from '@sapphire/framework';
import { STREAK_CONFIG } from '../constants.js';

/**
 * Start the voice streak scheduler
 * Checks every minute whether a new streak day has started (STREAK_CONFIG.DAY_START_HOUR in
 * each guild's timezone) and, if so, runs that guild's daily streak rollover (resets
 * missed streaks, credits members still in voice). The rollover itself is idempotent per day, so extra checks are harmless.
 */
export function startStreakScheduler(): void {
  setInterval(async () => {
    try {
      await checkStreakRollovers();
    } catch (error) {
      container.logger.error('Voice streak scheduler error:', error);
    }
  }, STREAK_CONFIG.ROLLOVER_CHECK_INTERVAL_MS);

  container.logger.info('🔥 Voice streak scheduler started (checks every minute)');
}

async function checkStreakRollovers(): Promise<void> {
  const guilds = await container.guildSettingsService.getGuildsWithStreaksEnabled();

  for (const { guildId } of guilds) {
    const guild = container.client.guilds.cache.get(guildId);
    if (!guild) continue;

    try {
      await container.streakService.runRolloverIfDue(guild);
    } catch (error) {
      container.logger.error(`Error running voice streak rollover for guild ${guildId}:`, error);
    }
  }
}
