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

      // Professional startup banner
      logger.info('═══════════════════════════════════════════════════════════');
      logger.info('                 🐖 HOGBOT 🐖                             ');
      logger.info('═══════════════════════════════════════════════════════════');
      logger.info(`Bot User:        ${client.user?.tag}`);
      logger.info(`Bot ID:          ${client.user?.id}`);
      logger.info(`Environment:     ${process.env.NODE_ENV || 'development'}`);
      logger.info(`Node Version:    ${process.version}`);
      logger.info(`Guilds:          ${client.guilds.cache.size}`);
      logger.info(`Commands:        ${client.stores.get('commands').size}`);
      logger.info('───────────────────────────────────────────────────────────');

      // List all guilds
      if (client.guilds.cache.size > 0) {
        logger.info('Connected Servers:');
        for (const [guildId, guild] of client.guilds.cache) {
          logger.info(`  • ${guild.name} (ID: ${guildId}) - ${guild.memberCount} members`);
        }
        logger.info('───────────────────────────────────────────────────────────');
      }

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

      logger.info(`Database:        ${registeredCount}/${client.guilds.cache.size} guilds registered`);
      logger.info('═══════════════════════════════════════════════════════════');
      logger.info('✅ HogBot is online and ready to serve!');
      logger.info('═══════════════════════════════════════════════════════════');
    } catch (error) {
      logger.error('Error in ready listener:', error);
    }
  }
}
