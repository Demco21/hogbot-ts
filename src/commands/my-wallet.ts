import { Command } from '@sapphire/framework';
import { ApplyOptions } from '@sapphire/decorators';
import { EmbedBuilder, MessageFlags } from 'discord.js';
import { Config } from '../config.js';
import { EMBED_COLORS } from '../constants.js';
import { formatCoins } from '../utils/utils.js';

/**
 * MyWallet command - Shows the user's current balance
 */
@ApplyOptions<Command.Options>({
  name: 'mywallet',
  description: 'Check your current balance',
})
export class MyWalletCommand extends Command {
  public override registerApplicationCommands(registry: Command.Registry) {
    registry.registerChatInputCommand(
      (builder) => builder.setName(this.name).setDescription(this.description),
      // Production: Always register globally for instant multi-guild support
      // Development: Register to specific guild for instant testing
      process.env.NODE_ENV === 'production'
        ? {} // Global registration
        : Config.discord.guildId
          ? { guildIds: [Config.discord.guildId] }
          : {}
    );
  }

  public override async chatInputRun(interaction: Command.ChatInputCommandInteraction) {
    try {
      // Defer reply immediately to prevent timeout (Discord requires response within 3s)
      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      const userId = interaction.user.id;
      const guildId = interaction.guildId!;

      // Ensure guild and user exist in database with proper names
      await this.container.walletService.ensureGuild(guildId, interaction.guild?.name);
      const user = await this.container.walletService.ensureUser(userId, guildId, interaction.user.username);
      const balance = user.balance;

      // Create embed response
      const embed = new EmbedBuilder()
        .setColor(EMBED_COLORS.SUCCESS)
        .setTitle('💰 Your Wallet')
        .setDescription(`**Balance:** ${formatCoins(balance)}`)
        .setFooter({ text: `User ID: ${userId}` })
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      this.container.logger.error('Error in mywallet command:', error);

      const errorMessage = 'An error occurred while fetching your wallet. Please try again later.';

      // Only try to respond if we can
      try {
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply({ content: errorMessage });
        } else if (!interaction.replied) {
          await interaction.reply({ content: errorMessage, flags: MessageFlags.Ephemeral });
        }
      } catch (replyError) {
        this.container.logger.error('Failed to send error message:', replyError);
      }
    }
  }
}
