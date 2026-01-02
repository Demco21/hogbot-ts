import { Listener } from '@sapphire/framework';
import { ApplyOptions } from '@sapphire/decorators';
import { Guild } from 'discord.js';
import { safeLogger as logger } from '../lib/safe-logger.js';

/**
 * GuildDelete listener - Fires when the bot leaves/is removed from a server
 *
 * Note: We do NOT delete guild data from the database to preserve historical data.
 * If the bot is re-invited, users will retain their balances and stats.
 * To manually clean up a guild, delete from guild_settings (CASCADE will clean up related data).
 */
@ApplyOptions<Listener.Options>({
  event: 'guildDelete',
})
export class GuildDeleteListener extends Listener {
  public override async run(guild: Guild) {
    try {
      logger.info(
        `Bot left/removed from guild: ${guild.name} (${guild.id}) - Data preserved for potential re-invite`
      );

      // Optional: Mark guild as inactive in database (future enhancement)
      // await this.container.walletService.markGuildInactive(guild.id);
    } catch (error) {
      logger.error(`Error handling guildDelete for ${guild.id}:`, error);
    }
  }
}
