import { Listener } from '@sapphire/framework';
import { ApplyOptions } from '@sapphire/decorators';
import { safeLogger as logger } from '../lib/safe-logger.js';

/**
 * Ready listener - Fires when the bot successfully connects to Discord
 * Registers all guilds the bot is currently in (handles existing guilds)
 */
@ApplyOptions<Listener.Options>({
  event: 'clientReady',
  once: true, // Only run once on startup
})
export class ReadyListener extends Listener {
  public override async run() {
    try {
      const { client } = this.container;
      logger.info(`Bot logged in as ${client.user?.tag}`);
      logger.info(`Connected to ${client.guilds.cache.size} guild(s)`);

      // Register all existing guilds in database
      // This handles cases where bot was already in guilds before this code was deployed
      let registeredCount = 0;
      for (const [guildId, guild] of client.guilds.cache) {
        try {
          await this.container.walletService.registerGuild(guildId, guild.name);
          registeredCount++;
        } catch (error) {
          logger.error(`Failed to register guild ${guild.name} (${guildId}):`, error);
        }
      }

      logger.info(`Registered ${registeredCount}/${client.guilds.cache.size} guilds in database`);
    } catch (error) {
      logger.error('Error in ready listener:', error);
    }
  }
}
