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
        .setColor(0xff6b35) // Casino orange/red color
        .setTitle('🎰 Welcome to Hogbot! 🎰')
        .setDescription(
          `Thanks for adding Hogbot to **${guild.name}**!\n\n` +
            '**🎮 Available Games:**\n' +
            '• `/blackjack` - Classic 21 card game\n' +
            '• `/slots` - Spin to win with progressive jackpot\n' +
            '• `/ridethebus` - Card color guessing game\n' +
            '• `/roll` - Simple dice roll betting\n\n' +
            '**💰 Wallet & Economy:**\n' +
            '• `/mywallet` - Check your balance and stats\n' +
            '• `/beg` - Get 500-1000 coins when broke (0 balance required)\n' +
            '• `/loan` - Send coins to another user (3 per hour)\n' +
            '• `/leaderboard` - See the richest members\n' +
            '• `/stats` - View your gambling statistics\n\n' +
            '**⚙️ Server Setup:**\n' +
            '• `/config` - Configure casino channel and richest role (Admin only)\n\n' +
            '**🚀 Getting Started:**\n' +
            'Everyone starts with **🪙 10,000 coins**. Good luck and gamble responsibly! 🍀'
        )
        .setFooter({ text: 'HogBot • Type / to see all commands' })
        .setTimestamp();

      // Try to send to system channel first
      if (guild.systemChannel) {
        try {
          // Check if bot member is available and has permissions
          const botMember = guild.members.me;
          if (botMember) {
            const permissions = guild.systemChannel.permissionsFor(botMember);
            if (permissions?.has('SendMessages') && permissions?.has('EmbedLinks')) {
              await guild.systemChannel.send({ embeds: [embed] });
              logger.info(`Sent welcome message to system channel in ${guild.name}`);
              return;
            }
          }
        } catch (channelError) {
          // System channel failed, try owner DM
          logger.debug(`Could not send to system channel in ${guild.name}:`, channelError);
        }
      }

      // Fallback: Try to DM the guild owner
      try {
        const owner = await guild.fetchOwner();
        if (owner) {
          await owner.send({ embeds: [embed] });
          logger.info(`Sent welcome DM to owner of ${guild.name}`);
          return;
        }
      } catch (dmError) {
        logger.warn(`Could not send welcome DM to owner of ${guild.name}:`, dmError);
      }

      // If both methods failed, log it
      logger.warn(
        `Could not send welcome message for ${guild.name}: No accessible system channel and owner DMs are closed. ` +
          `The bot is still functional - users can start using commands immediately.`
      );
    } catch (error) {
      logger.warn(`Could not send welcome message for ${guild.name}:`, error);
      // Non-critical error - don't throw
    }
  }
}
