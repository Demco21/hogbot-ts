import { Command } from '@sapphire/framework';
import { ApplyOptions } from '@sapphire/decorators';
import { EmbedBuilder, MessageFlags } from 'discord.js';
import { Config } from '../config.js';
import { formatCoins } from '../lib/utils.js';

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
      // Register to specific guild if GUILD_ID is set (dev mode), otherwise register globally
      Config.discord.guildId ? { guildIds: [Config.discord.guildId] } : {}
    );
  }

  public override async chatInputRun(interaction: Command.ChatInputCommandInteraction) {
    try {
      // Defer reply immediately to prevent timeout (Discord requires response within 3s)
      await interaction.deferReply();

      const userId = interaction.user.id;
      const guildId = interaction.guildId!;
      const username = interaction.user.username;

      // Get user's balance (creates user if doesn't exist)
      const user = await this.container.walletService.getUser(userId, guildId);

      let balance: number;
      if (!user) {
        // Create new user with starting balance
        const newUser = await this.container.walletService.createUser(userId, guildId, username);
        balance = newUser.balance;
      } else {
        balance = user.balance;

        // Update username if it changed
        if (user.username !== username) {
          await this.container.walletService.updateUsername(userId, guildId, username);
        }
      }

      // Create embed response
      const embed = new EmbedBuilder()
        .setColor(0x00ff00)
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
