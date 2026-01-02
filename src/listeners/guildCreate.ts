import { Listener } from '@sapphire/framework';
import { ApplyOptions } from '@sapphire/decorators';
import { Guild, EmbedBuilder } from 'discord.js';
import { safeLogger as logger } from '../lib/safe-logger.js';

/**
 * GuildCreate listener - Fires when the bot joins a new server
 * Registers the guild in the database and optionally sends a welcome message
 */
@ApplyOptions<Listener.Options>({
  event: 'guildCreate',
})
export class GuildCreateListener extends Listener {
  public override async run(guild: Guild) {
    try {
      // Register guild in database
      await this.container.walletService.registerGuild(guild.id, guild.name);

      logger.info(`Bot joined guild: ${guild.name} (${guild.id}) - ${guild.memberCount} members`);

      // Optional: Send welcome message to system channel or owner
      await this.sendWelcomeMessage(guild);
    } catch (error) {
      logger.error(`Error handling guildCreate for ${guild.id}:`, error);
    }
  }

  /**
   * Send a welcome message to the guild (system channel or owner DM)
   */
  private async sendWelcomeMessage(guild: Guild) {
    try {
      const embed = new EmbedBuilder()
        .setColor(0x00ff00)
        .setTitle('🎰 HogBot Casino Joined!')
        .setDescription(
          'Thanks for inviting HogBot to your server!\n\n' +
            '**Getting Started:**\n' +
            '• Use `/mywallet` to check your balance\n' +
            '• Use `/beg` if you run out of coins\n' +
            '• Try casino games: `/blackjack`, `/slots`, `/ceelo`, `/ridethebus`\n' +
            '• Check `/leaderboard` to see the richest members\n\n' +
            '**Need Help?**\n' +
            'All users start with 10,000 coins. Good luck! 🍀'
        )
        .setFooter({ text: 'HogBot Casino - Have fun and gamble responsibly!' })
        .setTimestamp();

      // Try to send to system channel first
      if (guild.systemChannel && guild.systemChannel.permissionsFor(guild.members.me!)?.has('SendMessages')) {
        await guild.systemChannel.send({ embeds: [embed] });
        logger.info(`Sent welcome message to system channel in ${guild.name}`);
        return;
      }

      // Fallback: Try to DM the guild owner
      const owner = await guild.fetchOwner();
      if (owner) {
        try {
          await owner.send({ embeds: [embed] });
          logger.info(`Sent welcome DM to owner of ${guild.name}`);
        } catch (dmError) {
          logger.warn(`Could not send welcome DM to owner of ${guild.name}:`, dmError);
        }
      }
    } catch (error) {
      logger.warn(`Could not send welcome message for ${guild.name}:`, error);
      // Non-critical error - don't throw
    }
  }
}
