import { Command } from '@sapphire/framework';
import { ApplyOptions } from '@sapphire/decorators';
import { EmbedBuilder, MessageFlags } from 'discord.js';
import { Config } from '../config.js';
import { CASINO_CONFIG, GAME_BET_LIMITS, EMBED_COLORS } from '../constants.js';
import { GameSource, UpdateType } from '../constants.js';
import { formatCoins } from '../utils/utils.js';

/**
 * Beg command - Gives users 500-1000 coins when they can't afford to play
 * NO cooldown - can be used repeatedly while balance is below minimum bet
 */
@ApplyOptions<Command.Options>({
  name: 'beg',
  description: 'Beg for coins when you can\'t afford to play',
})
export class BegCommand extends Command {
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
      const userId = interaction.user.id;
      const guildId = interaction.guildId!;

      // Ensure guild and user exist in database with proper names (fast query, no need to defer yet)
      await this.container.walletService.ensureGuild(guildId, interaction.guild?.name);
      const user = await this.container.walletService.ensureUser(userId, guildId, interaction.user.username);
      const currentBalance = user.balance;

      // Get the minimum bet amount across all games (currently all games have MIN: 50)
      const minBet = Math.min(
        GAME_BET_LIMITS.BLACKJACK.MIN,
        GAME_BET_LIMITS.SLOTS.MIN,
        GAME_BET_LIMITS.CEELO.MIN,
        GAME_BET_LIMITS.RIDE_THE_BUS.MIN
      );

      // Only allow begging if user can't afford to play any game
      if (currentBalance >= minBet) {
        // Rejection message - ephemeral so only they see it
        await interaction.reply({
          content: `🫳 You're not desperate enough *yet*.\nYou still have **${formatCoins(currentBalance)}**.\n\n*You can beg when you have less than ${formatCoins(minBet)}.*`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      // User can't afford any game - defer publicly so everyone sees the successful beg
      await interaction.deferReply();

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
        `🤲 <@${userId}> begged outside the casino... a kind stranger took pity and dropped **${formatCoins(begAmount)}** Hog Coins into your cup.`,
        `💍 <@${userId}> pawned their wedding ring for **${formatCoins(begAmount)}**. Time to gamble it all away again!`,
        `😔 <@${userId}> mumbled, *'spare some change for the slots?'* — and somehow got **${formatCoins(begAmount)}**.`,
        `🎰 <@${userId}> swept the casino floor for coins and found **${formatCoins(begAmount)}** under the slot machine.`,
        `🐖 <@${userId}> squealed for mercy and the Hog Gods blessed you with **${formatCoins(begAmount)}**. Try not to lose them in 2 minutes.`,
        `🧎 <@${userId}> groveled before the casino door — **${formatCoins(begAmount)}** jingled into your cup. Pathetic, but effective.`,
        `🤡 <@${userId}> performed a little dance for the high rollers and earned **${formatCoins(begAmount)}** in pity tips.`,
        `🎣 <@${userId}> fished **${formatCoins(begAmount)}** out of the fountain. Smells like chlorine and shame.`,
        `♻️ <@${userId}> recycled empty bottles behind the casino for **${formatCoins(begAmount)}**. Recycling *and* relapsing.`,
        `🐀 <@${userId}> wrestled a rat in the alley for a dropped coin pouch. You earned **${formatCoins(begAmount)}**, and tetanus.`,
      ];

      const randomMessage = messages[Math.floor(Math.random() * messages.length)];

      // Create success embed
      const embed = new EmbedBuilder()
        .setColor(EMBED_COLORS.SUCCESS)
        .setDescription(randomMessage);

      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      this.container.logger.error('Error in beg command:', error);

      const errorMessage = 'An error occurred while begging. Please try again later.';

      try {
        if (interaction.deferred) {
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
