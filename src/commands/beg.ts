import { Command } from '@sapphire/framework';
import { ApplyOptions } from '@sapphire/decorators';
import { EmbedBuilder, MessageFlags } from 'discord.js';
import { Config } from '../config.js';
import { CASINO_CONFIG } from '../constants.js';
import { GameSource, UpdateType } from '../constants.js';
import { formatCoins } from '../lib/utils.js';

/**
 * Beg command - Gives users 50-200 coins when they're completely broke (0 balance)
 * NO cooldown - can be used repeatedly while balance is 0
 */
@ApplyOptions<Command.Options>({
  name: 'beg',
  description: 'Beg for coins when you\'re completely broke (0 balance required)',
})
export class BegCommand extends Command {
  public override registerApplicationCommands(registry: Command.Registry) {
    registry.registerChatInputCommand(
      (builder) => builder.setName(this.name).setDescription(this.description),
      // Register to specific guild if GUILD_ID is set (dev mode), otherwise register globally
      Config.discord.guildId ? { guildIds: [Config.discord.guildId] } : {}
    );
  }

  public override async chatInputRun(interaction: Command.ChatInputCommandInteraction) {
    try {
      // Defer reply immediately to prevent timeout
      await interaction.deferReply();

      const userId = interaction.user.id;
      const guildId = interaction.guildId!;
      const username = interaction.user.username;

      // Get or create user
      let user = await this.container.walletService.getUser(userId, guildId);
      if (!user) {
        user = await this.container.walletService.createUser(userId, guildId, username);
      }

      const currentBalance = user.balance;

      // Only allow begging if user is completely broke (balance = 0)
      if (currentBalance > 0) {
        await interaction.editReply({
          content: `🫳 ${interaction.user.username}, you're not desperate enough *yet*.\nYou still have **${formatCoins(currentBalance)}** Hog Coins.`,
        });
        return;
      }

      // Generate random beg amount (50-200)
      const begAmount = Math.floor(
        Math.random() * (CASINO_CONFIG.BEG_MAX - CASINO_CONFIG.BEG_MIN + 1) + CASINO_CONFIG.BEG_MIN
      );

      // Update balance
      const newBalance = await this.container.walletService.updateBalance(
        userId,
        guildId,
        begAmount,
        GameSource.BEG,
        UpdateType.BEG_RECEIVED
      );

      // Fun random messages (from Python version)
      const messages = [
        `🤲 ${username} begged outside the casino... a kind stranger took pity and dropped **${formatCoins(begAmount)}** Hog Coins into your cup.`,
        `💍 ${username} pawned their wedding ring for **${formatCoins(begAmount)}**. Time to gamble it all away again!`,
        `😔 ${username} mumbled, *'spare some change for the slots?'* — and somehow got **${formatCoins(begAmount)}**.`,
        `🎰 ${username} swept the casino floor for coins and found **${formatCoins(begAmount)}** under the slot machine.`,
        `🐖 ${username} squealed for mercy and the Hog Gods blessed you with **${formatCoins(begAmount)}**. Try not to lose them in 2 minutes.`,
        `🧎 ${username} groveled before the casino door — **${formatCoins(begAmount)}** jingled into your cup. Pathetic, but effective.`,
        `🤡 ${username} performed a little dance for the high rollers and earned **${formatCoins(begAmount)}** in pity tips.`,
        `🎣 ${username} fished **${formatCoins(begAmount)}** out of the fountain. Smells like chlorine and shame.`,
        `♻️ ${username} recycled empty bottles behind the casino for **${formatCoins(begAmount)}**. Recycling *and* relapsing.`,
        `🐀 ${username} wrestled a rat in the alley for a dropped coin pouch. You earned **${formatCoins(begAmount)}**, and tetanus.`,
      ];

      const randomMessage = messages[Math.floor(Math.random() * messages.length)];

      // Create success embed
      const embed = new EmbedBuilder()
        .setColor(0x00ff00)
        .setTitle('🙏 Begging Successful')
        .setDescription(randomMessage)
        .addFields({ name: 'New Balance', value: formatCoins(newBalance) })
        .setFooter({ text: 'You can beg again when you\'re broke (0 coins)' })
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      this.container.logger.error('Error in beg command:', error);

      const errorMessage = 'An error occurred while begging. Please try again later.';

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
