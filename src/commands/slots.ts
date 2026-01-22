import { Command } from '@sapphire/framework';
import { ApplyOptions } from '@sapphire/decorators';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ComponentType,
  EmbedBuilder,
  MessageFlags,
  type ChatInputCommandInteraction,
  type ButtonInteraction,
} from 'discord.js';
import { Config } from '../config.js';
import { GameSource, UpdateType, GAME_INTERACTION_TIMEOUT_MINUTES } from '../constants.js';
import { SlotsService } from '../services/SlotsService.js';
import { formatCoins } from '../utils/utils.js';
import { handleGameTimeoutUI } from '../utils/game-utils.js';

@ApplyOptions<Command.Options>({
  name: 'slots',
  description: 'Play the Hog Pen Slots with progressive jackpot',
  preconditions: ['CasinoChannelOnly'],
})
export class SlotsCommand extends Command {
  private slotsService: SlotsService;

  public constructor(context: Command.LoaderContext, options: Command.Options) {
    super(context, options);
    this.slotsService = new SlotsService();
  }

  public override registerApplicationCommands(registry: Command.Registry) {
    registry.registerChatInputCommand(
      (builder) =>
        builder
          .setName(this.name)
          .setDescription(this.description)
          .addIntegerOption((option) =>
            option
              .setName('bet')
              .setDescription(`Bet amount (${SlotsService.MIN_BET.toLocaleString()}-${SlotsService.MAX_BET.toLocaleString()})`)
              .setRequired(false)
              .setMinValue(SlotsService.MIN_BET)
              .setMaxValue(SlotsService.MAX_BET)
          ),
      // Production: Always register globally for instant multi-guild support
      // Development: Register to specific guild for instant testing
      process.env.NODE_ENV === 'production'
        ? {} // Global registration
        : Config.discord.guildId
          ? { guildIds: [Config.discord.guildId] }
          : {}
    );
  }

  public override async chatInputRun(interaction: ChatInputCommandInteraction) {
    try {
      const userId = interaction.user.id;
      const guildId = interaction.guildId!;
      const betAmount = interaction.options.getInteger('bet') ?? SlotsService.MIN_BET;

      // Ensure guild and user exist in database with proper names
      await this.container.walletService.ensureGuild(guildId, interaction.guild?.name);
      const user = await this.container.walletService.ensureUser(userId, guildId, interaction.user.username);

      // Check for crashed game and recover
      await this.container.gameStateService.checkAndRecoverCrashedGame(userId, guildId, GameSource.SLOTS);

      // Validate bet
      if (betAmount < SlotsService.MIN_BET || betAmount > SlotsService.MAX_BET) {
        await interaction.reply({
          content: `Your bet must be between **${formatCoins(SlotsService.MIN_BET)}** and **${formatCoins(SlotsService.MAX_BET)}**.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      // Check if user already has an active game
      if (await this.container.gameStateService.hasActiveGame(userId, guildId, GameSource.SLOTS)) {
        await interaction.reply({
          content: '🚫 You already have an active slots game. Finish it before starting a new one.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      // Check balance
      const balance = user.balance;
      if (balance < betAmount) {
        await interaction.reply({
          content: `You're too broke to spin right now, ${interaction.user}.\nYour bet is **${formatCoins(betAmount)}**, but you only have **${formatCoins(balance)}**.\nTry /beg to scrounge up some Hog Coins.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      // Defer reply after validation passes
      await interaction.deferReply();

      // Deduct bet from wallet
      await this.container.walletService.updateBalance(
        userId,
        guildId,
        -betAmount,
        GameSource.SLOTS,
        UpdateType.BET_PLACED,
        { bet_amount: betAmount }
      );

      // Start game in database (prevents concurrent games, enables crash recovery)
      await this.container.gameStateService.startGame(userId, guildId, GameSource.SLOTS, betAmount);

      // Contribute to jackpot
      const contribution = Math.max(Math.floor(betAmount * SlotsService.JACKPOT_PERCENT), 1);
      await this.slotsService.contributeToJackpot(guildId, contribution);

      // Get current jackpot
      const jackpotAmount = await this.slotsService.getJackpot(guildId);
      const currentBalance = await this.container.walletService.getBalance(userId, guildId);

      // Create initial embed
      const initialEmbed = this.createBaseEmbed(
        interaction.user.toString(),
        currentBalance,
        betAmount,
        jackpotAmount,
        'Welcome to **Hog Pen Slots**!\n' +
          'Each bet is added towards the **progressive jackpot**.\n' +
          'Press **Crank!** to spin the reels.\n\n' +
          '**Jackpot:** 🐷🐷🐷\n' +
          '**Bonus Spins:** 🎄🎄🎄 or ❄️❄️❄️'
      );

      const crankButton = new ButtonBuilder()
        .setCustomId('crank')
        .setLabel('🎰 Crank!')
        .setStyle(ButtonStyle.Success);

      const row = new ActionRowBuilder<ButtonBuilder>().addComponents(crankButton);

      const response = await interaction.editReply({
        embeds: [initialEmbed],
        components: [row],
      });

      // Handle button interactions
      await this.handleSlotMachine(
        response,
        interaction,
        userId,
        guildId,
        betAmount,
        jackpotAmount
      );
    } catch (error) {
      this.container.logger.error('Error in slots command:', error);
      await interaction.editReply({
        content: 'An error occurred while starting the slot machine. Please try again.',
        components: [],
      });
    }
  }

  private async handleSlotMachine(
    response: any,
    originalInteraction: ChatInputCommandInteraction,
    userId: string,
    guildId: string,
    betAmount: number,
    initialJackpot: number
  ) {
    let bonusSpinAvailable = false;
    let spinCount = 0;

    const collector = response.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: GAME_INTERACTION_TIMEOUT_MINUTES * 60 * 1000, // Convert minutes to milliseconds
    });

    collector.on('collect', async (buttonInteraction: ButtonInteraction) => {
      // Only allow the original player to interact
      if (buttonInteraction.user.id !== userId) {
        await buttonInteraction.reply({
          content: "This isn't your slot machine. Go start your own spin. 🎰",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      if (buttonInteraction.customId === 'crank') {
        spinCount++;
        const isBonusSpin = bonusSpinAvailable && spinCount > 1;

        await buttonInteraction.deferUpdate();

        // Disable button during spin
        const disabledButton = new ButtonBuilder()
          .setCustomId('crank')
          .setLabel('🎰 Spinning...')
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(true);

        const disabledRow = new ActionRowBuilder<ButtonBuilder>().addComponents(disabledButton);

        await buttonInteraction.editReply({ components: [disabledRow] });

        // Perform the spin with animation
        const symbols = this.slotsService.spin();
        await this.animateSpin(buttonInteraction, betAmount, symbols, isBonusSpin, userId, guildId);

        // Get current jackpot
        const jackpotAmount = await this.slotsService.getJackpot(guildId);

        // Evaluate result
        const result = this.slotsService.evaluateSpin(symbols, jackpotAmount);
        let totalPayout = betAmount * result.multiplier;

        // Handle jackpot win
        if (result.jackpotHit) {
          totalPayout += jackpotAmount;
          await this.slotsService.resetJackpot(guildId, userId);
        }

        // Update balance and stats
        if (totalPayout > 0) {
          await this.container.walletService.updateBalance(
            userId,
            guildId,
            totalPayout,
            GameSource.SLOTS,
            UpdateType.BET_WON,
            {
              bet_amount: betAmount,
              payout_amount: totalPayout,
              symbols: symbols,
              multiplier: result.multiplier,
              bonus_spin: result.bonusSpin,
              jackpot_hit: result.jackpotHit,
            }
          );

          // Record win in game stats
          const extraStats: Record<string, any> = {};
          if (result.bonusSpin) {
            extraStats.bonus_spins = 1;
          }
          if (result.jackpotHit) {
            extraStats.jackpot_hits = 1;
          }

          await this.container.statsService.updateGameStats(
            userId,
            guildId,
            GameSource.SLOTS,
            true, // won
            betAmount,
            totalPayout,
            extraStats
          );
        } else {
          // Record loss - log transaction for the lost bet
          // Note: Balance was already deducted in BET_PLACED, so amount is 0 here
          await this.container.walletService.updateBalance(
            userId,
            guildId,
            0, // no balance change (already deducted)
            GameSource.SLOTS,
            UpdateType.BET_LOST,
            {
              bet_amount: betAmount,
              payout_amount: 0,
              symbols: symbols,
              multiplier: result.multiplier,
            }
          );

          // Record loss in game stats
          await this.container.statsService.updateGameStats(
            userId,
            guildId,
            GameSource.SLOTS,
            false, // lost
            betAmount,
            0, // no payout
            {}
          );
        }

        // Get updated balance
        const newBalance = await this.container.walletService.getBalance(userId, guildId);
        const newJackpot = await this.slotsService.getJackpot(guildId);

        // Show result
        await this.showResult(
          buttonInteraction,
          betAmount,
          symbols,
          result,
          totalPayout,
          newBalance,
          newJackpot,
          isBonusSpin
        );

        // Handle bonus spin
        if (result.bonusSpin && !isBonusSpin) {
          bonusSpinAvailable = true;
          // Re-enable button for bonus spin
          const bonusButton = new ButtonBuilder()
            .setCustomId('crank')
            .setLabel('🎰 Crank! (Bonus Spin)')
            .setStyle(ButtonStyle.Success);

          const bonusRow = new ActionRowBuilder<ButtonBuilder>().addComponents(bonusButton);
          await buttonInteraction.editReply({ components: [bonusRow] });
        } else {
          // Game over
          collector.stop('completed');
        }
      }
    });

    collector.on('end', async (_collected: any, reason: string) => {
      try {
        // Finish game in database
        await this.container.gameStateService.finishGame(userId, guildId, GameSource.SLOTS);

        if (reason === 'time') {
          // Log timeout as loss (no balance change - bet was already deducted)
          await this.container.walletService.logTransaction(userId, guildId, GameSource.SLOTS, UpdateType.BET_LOST, {
            bet_amount: betAmount,
            payout_amount: 0,
            reason: 'timeout',
          });

          // Update stats
          await this.container.statsService.updateGameStats(userId, guildId, GameSource.SLOTS, false, betAmount, 0, {});

          // Update UI with timeout state
          await handleGameTimeoutUI({
            interaction: originalInteraction,
            response,
            footerText: '⏰ Slot machine timed out, thanks for the donation!',
            logger: this.container.logger,
          });
        } else {
          // Remove buttons for other end reasons (completed, etc.)
          await originalInteraction.editReply({ components: [] });
        }
      } catch (error) {
        this.container.logger.error('Error cleaning up slot machine:', error);
      }
    });
  }

  private async animateSpin(
    interaction: ButtonInteraction,
    betAmount: number,
    finalSymbols: string[],
    isBonusSpin: boolean,
    userId: string,
    guildId: string
  ) {
    const stopSteps = [
      Math.floor(Math.random() * 3) + 5, // First reel stops at 5-7
      Math.floor(Math.random() * 3) + 7, // Second reel stops at 7-9
      Math.floor(Math.random() * 7) + 9, // Third reel stops at 9-15
    ];

    const totalSteps = Math.max(...stopSteps) + 1;
    const currentBalance = await this.container.walletService.getBalance(userId, guildId);
    const jackpotAmount = await this.slotsService.getJackpot(guildId);

    for (let step = 0; step < totalSteps; step++) {
      const currentSymbols = stopSteps.map((stopStep, idx) =>
        step >= stopStep ? finalSymbols[idx] : this.slotsService.spinSymbol()
      );

      const spinMessage =
        step < 4
          ? '_The reels are spinning... steady now......._'
          : step < totalSteps - 4
          ? '_The reels are spinning... slowing down..._'
          : '_The reels are spinning... almost there....._';

      const reelDisplay = this.slotsService.formatReels(currentSymbols);
      const description = `${spinMessage}\n\n${reelDisplay}`;

      const title = isBonusSpin ? '🎰 Hog Pen Slots – Bonus Spin' : '🎰 Hog Pen Slots';
      const embed = this.createBaseEmbed(
        interaction.user.toString(),
        currentBalance,
        betAmount,
        jackpotAmount,
        description,
        title
      );

      await interaction.editReply({ embeds: [embed] });

      const delay = step < 4 ? 200 + step * 30 : step < totalSteps - 4 ? 200 + step * 30 : 300 + step * 30;
      await this.sleep(delay + Math.random() * 80 - 40);
    }

    await this.sleep(300 + Math.random() * 500);
  }

  private async showResult(
    interaction: ButtonInteraction,
    betAmount: number,
    symbols: string[],
    result: any,
    totalPayout: number,
    newBalance: number,
    newJackpot: number,
    isBonusSpin: boolean
  ) {
    const reelDisplay = this.slotsService.formatReels(symbols);
    const color = result.multiplier > 0 || result.jackpotHit ? 0x00ff00 : 0xff0000;

    const jackpotText = result.jackpotHit ? ' + 💰 Jackpot Pool' : '';

    const description =
      `**Final Result:**\n${reelDisplay}\n\n` +
      `${result.outcomeText}\n\n` +
      `**Payout Multiplier:** 🪙x${result.multiplier}`;

    const title = isBonusSpin ? '🎰 Hog Pen Slots – Bonus Spin Result' : '🎰 Hog Pen Slots – Result';

    const embed = new EmbedBuilder()
      .setTitle(title)
      .setDescription(`**Player:** ${interaction.user.toString()}\n\n${description}`)
      .setColor(color)
      .addFields(
        { name: 'Bet', value: formatCoins(betAmount), inline: true },
        { name: 'Payout', value: `${formatCoins(totalPayout)}${jackpotText}`, inline: true },
        { name: 'Balance', value: formatCoins(newBalance), inline: true },
        { name: 'Jackpot Pool', value: formatCoins(newJackpot), inline: false }
      );

    if (result.bonusSpin && !isBonusSpin) {
      embed.setFooter({ text: '❄️ Bonus unlocked! Press **Crank!** again to use your free spin.' });
    } else {
      embed.setFooter({ text: 'Use /slots again to spin a new machine.' });
    }

    await interaction.editReply({ embeds: [embed] });
  }

  private createBaseEmbed(
    playerMention: string,
    balance: number,
    betAmount: number,
    jackpot: number,
    description: string,
    title: string = '🎰 Hog Pen Slots'
  ): EmbedBuilder {
    return new EmbedBuilder()
      .setTitle(title)
      .setDescription(`**Player:** ${playerMention}\n\n${description}`)
      .setColor(0x5865f2) // Blurple
      .addFields(
        { name: 'Bet', value: formatCoins(betAmount), inline: true },
        { name: 'Balance', value: formatCoins(balance), inline: true },
        { name: 'Jackpot Pool', value: formatCoins(jackpot), inline: false }
      );
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
