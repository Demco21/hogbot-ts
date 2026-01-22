import { Command } from '@sapphire/framework';
import { ApplyOptions } from '@sapphire/decorators';
import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  MessageFlags,
  type ChatInputCommandInteraction,
  type ButtonInteraction,
} from 'discord.js';
import { Config } from '../config.js';
import { GameSource, UpdateType, GAME_INTERACTION_TIMEOUT_MINUTES } from '../constants.js';
import { RouletteService, RouletteBetType, type RouletteNumber, type BetResult, type NumberPickerPage } from '../services/RouletteService.js';
import { formatCoins } from '../utils/utils.js';

@ApplyOptions<Command.Options>({
  name: 'roulette',
  description: 'Play American Roulette',
  preconditions: ['CasinoChannelOnly'],
})
export class RouletteCommand extends Command {
  private rouletteService: RouletteService;

  public constructor(context: Command.LoaderContext, options: Command.Options) {
    super(context, options);
    this.rouletteService = new RouletteService();
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
              .setDescription(`Base bet amount per wager (${RouletteService.MIN_BET.toLocaleString()}-${RouletteService.MAX_BET.toLocaleString()})`)
              .setRequired(false)
              .setMinValue(RouletteService.MIN_BET)
              .setMaxValue(RouletteService.MAX_BET)
          ),
      process.env.NODE_ENV === 'production'
        ? {}
        : Config.discord.guildId
          ? { guildIds: [Config.discord.guildId] }
          : {}
    );
  }

  public override async chatInputRun(interaction: ChatInputCommandInteraction) {
    try {
      const userId = interaction.user.id;
      const guildId = interaction.guildId!;
      const baseBet = interaction.options.getInteger('bet') ?? RouletteService.MIN_BET;

      // Ensure guild and user exist
      await this.container.walletService.ensureGuild(guildId, interaction.guild?.name);
      const user = await this.container.walletService.ensureUser(userId, guildId, interaction.user.username);

      // Check for crashed game and recover
      await this.container.gameStateService.checkAndRecoverCrashedGame(userId, guildId, GameSource.ROULETTE);

      // Validate bet
      if (baseBet < RouletteService.MIN_BET || baseBet > RouletteService.MAX_BET) {
        await interaction.reply({
          content: `Your bet must be between **${formatCoins(RouletteService.MIN_BET)}** and **${formatCoins(RouletteService.MAX_BET)}**.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      // Check if user already has an active game
      if (await this.container.gameStateService.hasActiveGame(userId, guildId, GameSource.ROULETTE)) {
        await interaction.reply({
          content: '🚫 You already have an active roulette game. Finish it before starting a new one.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      // Check balance - need at least one bet
      const balance = user.balance;
      if (balance < baseBet) {
        await interaction.reply({
          content: `You don't have enough **Hog Coins** to play. Your current balance is **${formatCoins(balance)}**, but the minimum bet is **${formatCoins(baseBet)}**.\nTry /beg to get some coins.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      // Defer reply
      await interaction.deferReply();

      // Start game in database
      await this.container.gameStateService.startGame(userId, guildId, GameSource.ROULETTE, baseBet);

      try {
        // Start game in service
        this.rouletteService.startGame(userId, guildId, baseBet);

        // Create initial embed
        const initialEmbed = this.createBettingEmbed(userId, guildId, balance, interaction.user.toString());

        // Create betting UI components
        const components = this.createBettingComponents(userId, guildId);

        const response = await interaction.editReply({
          embeds: [initialEmbed],
          components,
        });

        // Handle interactions
        await this.handleBettingPhase(response, interaction, userId, guildId, baseBet);
      } catch (innerError) {
        // Clean up game state if something fails after starting
        await this.container.gameStateService.finishGame(userId, guildId, GameSource.ROULETTE);
        this.rouletteService.endGame(userId, guildId);
        throw innerError;
      }
    } catch (error) {
      this.container.logger.error('Error in roulette command:', error);

      const errorMessage = 'An error occurred while starting roulette. Please try again.';
      if (interaction.deferred) {
        await interaction.editReply({ content: errorMessage, components: [] });
      } else {
        await interaction.reply({ content: errorMessage, flags: MessageFlags.Ephemeral });
      }
    }
  }

  // ========== Embed Creation ==========

  private createBettingEmbed(userId: string, guildId: string, balance: number, userMention: string): EmbedBuilder {
    const game = this.rouletteService.getGame(userId, guildId);
    if (!game) {
      return new EmbedBuilder().setTitle('🎰 American Roulette').setDescription('Error: Game not found').setColor(0xff0000);
    }

    const betList =
      game.bets.length > 0
        ? game.bets
            .map((bet) => {
              const emoji = this.rouletteService.getBetTypeEmoji(bet.type, bet.selection);
              const name = this.rouletteService.getBetTypeName(bet.type, bet.selection);
              return `${emoji} ${name}`;
            })
            .join(', ')
        : '_None_';

    // Generate visual board
    const boardDisplay = this.rouletteService.generateBoardDisplay(game.bets);

    const embed = new EmbedBuilder()
      .setTitle('🎰 American Roulette')
      .setColor(0x228b22) // Forest green
      .setDescription(`**Player:** ${userMention}\n\n**The Board:**\n${boardDisplay}\n\n**Active Bets:** ${betList}`)
      .addFields(
        { name: 'Total Bet', value: formatCoins(game.totalWagered), inline: true },
        { name: 'Balance', value: formatCoins(balance), inline: true }
      )
      .setFooter({
        text: `Each bet: ${formatCoins(game.baseBet)} | Max ${RouletteService.MAX_BETS_PER_SPIN} bets | Straight pays 35:1`,
      });

    return embed;
  }

  private createResultEmbed(
    userMention: string,
    result: RouletteNumber,
    betResults: BetResult[],
    totalBet: number,
    totalPayout: number,
    newBalance: number,
    bets: { type: RouletteBetType; selection?: number | '00' }[]
  ): EmbedBuilder {
    const winningNumber = this.rouletteService.formatWinningNumber(result);

    // Format bets list same as during betting
    const betList =
      bets.length > 0
        ? bets
            .map((bet) => {
              const emoji = this.rouletteService.getBetTypeEmoji(bet.type, bet.selection);
              const name = this.rouletteService.getBetTypeName(bet.type, bet.selection);
              return `${emoji} ${name}`;
            })
            .join(', ')
        : '_None_';

    // Generate board display (will show the bet markers)
    const boardDisplay = this.rouletteService.generateBoardDisplay(
      bets.map((b) => ({ type: b.type, selection: b.selection, amount: 0, numbers: [], payout: 0 }))
    );

    const color = totalPayout > 0 ? 0x00ff00 : 0xff0000;

    const embed = new EmbedBuilder()
      .setTitle('🎰 American Roulette')
      .setColor(color)
      .setDescription(
        `**Player:** ${userMention}\n\n` +
          `**The Board:**\n${boardDisplay}\n\n` +
          `**Active Bets:** ${betList}\n\n` +
          `The ball lands on... ${winningNumber}`
      )
      .addFields(
        { name: 'Total Bet', value: formatCoins(totalBet), inline: true },
        { name: 'Payout', value: formatCoins(totalPayout), inline: true },
        { name: 'Balance', value: formatCoins(newBalance), inline: true }
      )
      .setFooter({ text: 'Use /roulette to play again!' });

    return embed;
  }

  // ========== Component Creation ==========

  private createBettingComponents(userId: string, guildId: string): ActionRowBuilder<ButtonBuilder>[] {
    const game = this.rouletteService.getGame(userId, guildId);
    const hasBets = game && game.bets.length > 0;
    const canAddMore = game && game.bets.length < RouletteService.MAX_BETS_PER_SPIN;

    // Row 1: Color/Parity bets + Spin
    const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId('bet_red')
        .setLabel('Red')
        .setStyle(ButtonStyle.Danger)
        .setDisabled(!canAddMore || this.hasBetType(userId, guildId, RouletteBetType.RED)),
      new ButtonBuilder()
        .setCustomId('bet_black')
        .setLabel('Black')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(!canAddMore || this.hasBetType(userId, guildId, RouletteBetType.BLACK)),
      new ButtonBuilder()
        .setCustomId('bet_odd')
        .setLabel('Odd')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(!canAddMore || this.hasBetType(userId, guildId, RouletteBetType.ODD)),
      new ButtonBuilder()
        .setCustomId('bet_even')
        .setLabel('Even')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(!canAddMore || this.hasBetType(userId, guildId, RouletteBetType.EVEN)),
      new ButtonBuilder().setCustomId('spin').setLabel('SPIN!').setStyle(ButtonStyle.Success).setDisabled(!hasBets)
    );

    // Row 2: Range bets + Pick # + Controls
    const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId('bet_low')
        .setLabel('Low 1-18')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(!canAddMore || this.hasBetType(userId, guildId, RouletteBetType.LOW)),
      new ButtonBuilder()
        .setCustomId('bet_high')
        .setLabel('High 19-36')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(!canAddMore || this.hasBetType(userId, guildId, RouletteBetType.HIGH)),
      new ButtonBuilder()
        .setCustomId('pick_number')
        .setLabel('Pick #')
        .setStyle(ButtonStyle.Primary)
        .setDisabled(!canAddMore),
      new ButtonBuilder().setCustomId('clear').setLabel('Clear').setStyle(ButtonStyle.Secondary).setDisabled(!hasBets),
      new ButtonBuilder().setCustomId('cancel').setLabel('Cancel').setStyle(ButtonStyle.Danger)
    );

    return [row1, row2];
  }

  private createNumberPickerComponents(
    userId: string,
    guildId: string,
    page: NumberPickerPage
  ): ActionRowBuilder<ButtonBuilder>[] {
    const bettedNumbers = this.rouletteService.getBettedNumbers(userId, guildId);
    const game = this.rouletteService.getGame(userId, guildId);
    const canAddMore = game && game.bets.length < RouletteService.MAX_BETS_PER_SPIN;

    // Row 1: Page navigation tabs (all blue when selected, grey when not)
    const navRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId('page_green')
        .setLabel('0/00')
        .setStyle(page === 'green' ? ButtonStyle.Primary : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('page_1-12')
        .setLabel('1-12')
        .setStyle(page === '1-12' ? ButtonStyle.Primary : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('page_13-24')
        .setLabel('13-24')
        .setStyle(page === '13-24' ? ButtonStyle.Primary : ButtonStyle.Secondary),
      new ButtonBuilder()
        .setCustomId('page_25-36')
        .setLabel('25-36')
        .setStyle(page === '25-36' ? ButtonStyle.Primary : ButtonStyle.Secondary),
      new ButtonBuilder().setCustomId('back_to_main').setLabel('Back').setStyle(ButtonStyle.Danger)
    );

    const rows: ActionRowBuilder<ButtonBuilder>[] = [navRow];

    // Generate number buttons based on current page
    if (page === 'green') {
      // Just 0 and 00
      const greenRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
        new ButtonBuilder()
          .setCustomId('num_0')
          .setLabel('0')
          .setStyle(ButtonStyle.Success)
          .setDisabled(!canAddMore || bettedNumbers.has(0)),
        new ButtonBuilder()
          .setCustomId('num_00')
          .setLabel('00')
          .setStyle(ButtonStyle.Success)
          .setDisabled(!canAddMore || bettedNumbers.has('00'))
      );
      rows.push(greenRow);
    } else {
      // Number pages: 1-12, 13-24, 25-36
      const startNum = page === '1-12' ? 1 : page === '13-24' ? 13 : 25;

      // Create 3 rows of 4 numbers each
      for (let rowNum = 0; rowNum < 3; rowNum++) {
        const rowButtons: ButtonBuilder[] = [];
        for (let col = 0; col < 4; col++) {
          const num = startNum + rowNum * 4 + col;
          const color = this.rouletteService.getNumberColor(num);
          const style = color === 'red' ? ButtonStyle.Danger : ButtonStyle.Secondary;

          rowButtons.push(
            new ButtonBuilder()
              .setCustomId(`num_${num}`)
              .setLabel(String(num))
              .setStyle(style)
              .setDisabled(!canAddMore || bettedNumbers.has(num))
          );
        }
        rows.push(new ActionRowBuilder<ButtonBuilder>().addComponents(...rowButtons));
      }
    }

    return rows;
  }

  private createDisabledComponents(): ActionRowBuilder<ButtonBuilder>[] {
    // Just disable everything for spinning/finished state
    const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('bet_red').setLabel('Red').setStyle(ButtonStyle.Danger).setDisabled(true),
      new ButtonBuilder().setCustomId('bet_black').setLabel('Black').setStyle(ButtonStyle.Secondary).setDisabled(true),
      new ButtonBuilder().setCustomId('bet_odd').setLabel('Odd').setStyle(ButtonStyle.Primary).setDisabled(true),
      new ButtonBuilder().setCustomId('bet_even').setLabel('Even').setStyle(ButtonStyle.Primary).setDisabled(true),
      new ButtonBuilder().setCustomId('spin').setLabel('Spinning...').setStyle(ButtonStyle.Success).setDisabled(true)
    );

    return [row1];
  }

  // ========== Helpers ==========

  private hasBetType(userId: string, guildId: string, betType: RouletteBetType): boolean {
    const game = this.rouletteService.getGame(userId, guildId);
    if (!game) return false;
    return game.bets.some((b) => b.type === betType);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private mapButtonToBetType(customId: string): RouletteBetType | null {
    const mapping: Record<string, RouletteBetType> = {
      bet_red: RouletteBetType.RED,
      bet_black: RouletteBetType.BLACK,
      bet_odd: RouletteBetType.ODD,
      bet_even: RouletteBetType.EVEN,
      bet_low: RouletteBetType.LOW,
      bet_high: RouletteBetType.HIGH,
    };
    return mapping[customId] ?? null;
  }

  private mapPageButtonToPage(customId: string): NumberPickerPage | null {
    const mapping: Record<string, NumberPickerPage> = {
      page_green: 'green',
      'page_1-12': '1-12',
      'page_13-24': '13-24',
      'page_25-36': '25-36',
    };
    return mapping[customId] ?? null;
  }

  private parseNumberFromCustomId(customId: string): number | '00' | null {
    if (!customId.startsWith('num_')) return null;
    const numStr = customId.slice(4);
    if (numStr === '00') return '00';
    const num = parseInt(numStr, 10);
    if (isNaN(num) || num < 0 || num > 36) return null;
    return num;
  }

  // ========== Betting Phase Handler ==========

  private async handleBettingPhase(
    response: any,
    originalInteraction: ChatInputCommandInteraction,
    userId: string,
    guildId: string,
    baseBet: number
  ) {
    const collector = response.createMessageComponentCollector({
      time: GAME_INTERACTION_TIMEOUT_MINUTES * 60 * 1000,
    });

    collector.on('collect', async (interaction: ButtonInteraction) => {
      // Only allow the original player
      if (interaction.user.id !== userId) {
        await interaction.reply({
          content: "This isn't your roulette table. Start your own game with /roulette.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      try {
        await this.handleButtonInteraction(interaction, originalInteraction, userId, guildId, baseBet, collector);
      } catch (error) {
        this.container.logger.error('Error handling roulette interaction:', error);
        await interaction.reply({
          content: 'An error occurred. Please try again.',
          flags: MessageFlags.Ephemeral,
        });
      }
    });

    collector.on('end', async (_collected: any, reason: string) => {
      try {
        const game = this.rouletteService.getGame(userId, guildId);

        if (reason === 'time' && game && game.status === 'betting') {
          // Timeout during betting - refund all placed bets
          for (const bet of game.bets) {
            await this.container.walletService.updateBalance(userId, guildId, bet.amount, GameSource.ROULETTE, UpdateType.REFUND, {
              bet_type: bet.type,
              bet_amount: bet.amount,
              reason: 'timeout',
            });
          }

          // Update the embed to show timeout
          const balance = await this.container.walletService.getBalance(userId, guildId);
          const embed = new EmbedBuilder()
            .setTitle('🎰 American Roulette - Timed Out')
            .setColor(0x808080)
            .setDescription(
              `**Player:** ${originalInteraction.user.toString()}\n\n` +
                `Game timed out. Your bets have been refunded.\n\n` +
                `**Balance:** ${formatCoins(balance)}`
            )
            .setFooter({ text: 'Use /roulette to play again!' });

          await originalInteraction.editReply({ embeds: [embed], components: [] });
        }

        // Cleanup
        await this.container.gameStateService.finishGame(userId, guildId, GameSource.ROULETTE);
        this.rouletteService.endGame(userId, guildId);
      } catch (error) {
        this.container.logger.error('Error cleaning up roulette game:', error);
      }
    });
  }

  // ========== Button Handler ==========

  private async handleButtonInteraction(
    interaction: ButtonInteraction,
    originalInteraction: ChatInputCommandInteraction,
    userId: string,
    guildId: string,
    baseBet: number,
    collector: any
  ) {
    const customId = interaction.customId;

    // Cancel button
    if (customId === 'cancel') {
      await interaction.deferUpdate();

      // Refund all bets
      const game = this.rouletteService.getGame(userId, guildId);
      if (game) {
        for (const bet of game.bets) {
          await this.container.walletService.updateBalance(userId, guildId, bet.amount, GameSource.ROULETTE, UpdateType.REFUND, {
            bet_type: bet.type,
            bet_amount: bet.amount,
            reason: 'cancelled',
          });
        }
      }

      collector.stop('cancelled');

      const balance = await this.container.walletService.getBalance(userId, guildId);
      const embed = new EmbedBuilder()
        .setTitle('🎰 American Roulette - Cancelled')
        .setColor(0x808080)
        .setDescription(
          `**Player:** ${originalInteraction.user.toString()}\n\n` + `Game cancelled. Your bets have been refunded.\n\n` + `**Balance:** ${formatCoins(balance)}`
        )
        .setFooter({ text: 'Use /roulette to play again!' });

      await interaction.editReply({ embeds: [embed], components: [] });
      return;
    }

    // Clear button
    if (customId === 'clear') {
      await interaction.deferUpdate();

      // Refund all bets
      const clearedBets = this.rouletteService.clearBets(userId, guildId);
      for (const bet of clearedBets) {
        await this.container.walletService.updateBalance(userId, guildId, bet.amount, GameSource.ROULETTE, UpdateType.REFUND, {
          bet_type: bet.type,
          bet_amount: bet.amount,
          reason: 'cleared',
        });
      }

      // Update UI
      const balance = await this.container.walletService.getBalance(userId, guildId);
      const embed = this.createBettingEmbed(userId, guildId, balance, originalInteraction.user.toString());
      const components = this.createBettingComponents(userId, guildId);
      await interaction.editReply({ embeds: [embed], components });
      return;
    }

    // Spin button
    if (customId === 'spin') {
      await interaction.deferUpdate();

      // Get game state before spinning
      const game = this.rouletteService.getGame(userId, guildId);
      if (!game) return;

      // Store bet info before game state changes
      const totalBet = game.totalWagered;
      const bets = game.bets.map((b) => ({ type: b.type, selection: b.selection }));

      // Set status to spinning
      this.rouletteService.startSpin(userId, guildId);

      // Get final result BEFORE animation
      const result = this.rouletteService.spin();

      // Get current balance for display during animation
      const balanceDuringAnimation = await this.container.walletService.getBalance(userId, guildId);

      // Disable all buttons during spin
      await interaction.editReply({ components: this.createDisabledComponents() });

      // Run animation
      await this.animateWheelSpin(interaction, userId, guildId, result, originalInteraction.user.toString(), balanceDuringAnimation);

      // Resolve bets (re-fetch game since it may have been modified)
      const gameAfterSpin = this.rouletteService.getGame(userId, guildId);
      if (!gameAfterSpin) return;

      const betResults = this.rouletteService.evaluateBets(gameAfterSpin.bets, result);

      // Log transactions and update stats
      let totalPayout = 0;
      for (const br of betResults) {
        if (br.won) {
          totalPayout += br.payout;
          await this.container.walletService.updateBalance(userId, guildId, br.payout, GameSource.ROULETTE, UpdateType.BET_WON, {
            bet_type: br.bet.type,
            bet_amount: br.bet.amount,
            payout_amount: br.payout,
            winning_number: result.value,
            multiplier: br.bet.payout,
          });

          await this.container.statsService.updateGameStats(userId, guildId, GameSource.ROULETTE, true, br.bet.amount, br.payout, {
            straight_wins: br.bet.type === RouletteBetType.STRAIGHT ? 1 : 0,
          });
        } else {
          // Log the loss (no balance change - bet was already deducted)
          await this.container.walletService.logTransaction(userId, guildId, GameSource.ROULETTE, UpdateType.BET_LOST, {
            bet_type: br.bet.type,
            bet_amount: br.bet.amount,
            payout_amount: 0,
            winning_number: result.value,
          });

          await this.container.statsService.updateGameStats(userId, guildId, GameSource.ROULETTE, false, br.bet.amount, 0, {});
        }
      }

      // Mark game as finished
      this.rouletteService.finishSpin(userId, guildId, result);

      // Get new balance
      const newBalance = await this.container.walletService.getBalance(userId, guildId);

      // Show result
      const resultEmbed = this.createResultEmbed(
        originalInteraction.user.toString(),
        result,
        betResults,
        totalBet,
        totalPayout,
        newBalance,
        bets
      );

      await interaction.editReply({ embeds: [resultEmbed], components: [] });

      // Stop collector
      collector.stop('completed');
      return;
    }

    // Pick Number button - opens number picker
    if (customId === 'pick_number') {
      await interaction.deferUpdate();

      // Set to number picker mode, default to 1-12 page
      this.rouletteService.setNumberPickerPage(userId, guildId, '1-12');

      const balance = await this.container.walletService.getBalance(userId, guildId);
      const embed = this.createBettingEmbed(userId, guildId, balance, originalInteraction.user.toString());
      const components = this.createNumberPickerComponents(userId, guildId, '1-12');
      await interaction.editReply({ embeds: [embed], components });
      return;
    }

    // Back to main button - exits number picker
    if (customId === 'back_to_main') {
      await interaction.deferUpdate();

      this.rouletteService.setNumberPickerPage(userId, guildId, null);

      const balance = await this.container.walletService.getBalance(userId, guildId);
      const embed = this.createBettingEmbed(userId, guildId, balance, originalInteraction.user.toString());
      const components = this.createBettingComponents(userId, guildId);
      await interaction.editReply({ embeds: [embed], components });
      return;
    }

    // Page navigation buttons
    const page = this.mapPageButtonToPage(customId);
    if (page) {
      await interaction.deferUpdate();

      this.rouletteService.setNumberPickerPage(userId, guildId, page);

      const balance = await this.container.walletService.getBalance(userId, guildId);
      const embed = this.createBettingEmbed(userId, guildId, balance, originalInteraction.user.toString());
      const components = this.createNumberPickerComponents(userId, guildId, page);
      await interaction.editReply({ embeds: [embed], components });
      return;
    }

    // Number buttons (straight bets)
    const number = this.parseNumberFromCustomId(customId);
    if (number !== null) {
      await interaction.deferUpdate();

      // Check balance
      const balance = await this.container.walletService.getBalance(userId, guildId);
      if (balance < baseBet) {
        await interaction.followUp({
          content: `You don't have enough coins to place another bet. Balance: ${formatCoins(balance)}`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      // Deduct bet
      await this.container.walletService.updateBalance(userId, guildId, -baseBet, GameSource.ROULETTE, UpdateType.BET_PLACED, {
        bet_type: RouletteBetType.STRAIGHT,
        bet_amount: baseBet,
        number: number,
      });

      // Add straight bet to game
      const bet = this.rouletteService.addBet(userId, guildId, RouletteBetType.STRAIGHT, number);
      if (!bet) {
        // Refund if bet couldn't be added
        await this.container.walletService.updateBalance(userId, guildId, baseBet, GameSource.ROULETTE, UpdateType.REFUND, {
          bet_type: RouletteBetType.STRAIGHT,
          bet_amount: baseBet,
          reason: 'bet_failed',
        });
        return;
      }

      // Stay on current number picker page so user can select more numbers
      const game = this.rouletteService.getGame(userId, guildId);
      const currentPage = game?.numberPickerPage ?? '1-12';

      const newBalance = await this.container.walletService.getBalance(userId, guildId);
      const embed = this.createBettingEmbed(userId, guildId, newBalance, originalInteraction.user.toString());
      const components = this.createNumberPickerComponents(userId, guildId, currentPage);
      await interaction.editReply({ embeds: [embed], components });
      return;
    }

    // Bet buttons (outside bets)
    const betType = this.mapButtonToBetType(customId);
    if (betType) {
      await interaction.deferUpdate();

      // Check balance
      const balance = await this.container.walletService.getBalance(userId, guildId);
      if (balance < baseBet) {
        await interaction.followUp({
          content: `You don't have enough coins to place another bet. Balance: ${formatCoins(balance)}`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      // Deduct bet
      await this.container.walletService.updateBalance(userId, guildId, -baseBet, GameSource.ROULETTE, UpdateType.BET_PLACED, {
        bet_type: betType,
        bet_amount: baseBet,
      });

      // Add bet to game
      const bet = this.rouletteService.addBet(userId, guildId, betType);
      if (!bet) {
        // Refund if bet couldn't be added (shouldn't happen)
        await this.container.walletService.updateBalance(userId, guildId, baseBet, GameSource.ROULETTE, UpdateType.REFUND, {
          bet_type: betType,
          bet_amount: baseBet,
          reason: 'bet_failed',
        });
        return;
      }

      // Update UI
      const newBalance = await this.container.walletService.getBalance(userId, guildId);
      const embed = this.createBettingEmbed(userId, guildId, newBalance, originalInteraction.user.toString());
      const components = this.createBettingComponents(userId, guildId);
      await interaction.editReply({ embeds: [embed], components });
    }
  }

  // ========== Animation ==========

  private async animateWheelSpin(
    interaction: ButtonInteraction,
    userId: string,
    guildId: string,
    winningNumber: RouletteNumber,
    userMention: string,
    balance: number
  ) {
    const totalFrames = 12 + Math.floor(Math.random() * 6); // 12-17 frames
    const spinSequence = this.rouletteService.generateSpinSequence(winningNumber, totalFrames);

    const game = this.rouletteService.getGame(userId, guildId);
    if (!game) return;

    // Format bets list same as during betting
    const betList = game.bets
      .map((b) => `${this.rouletteService.getBetTypeEmoji(b.type, b.selection)} ${this.rouletteService.getBetTypeName(b.type, b.selection)}`)
      .join(', ');

    // Generate board display
    const boardDisplay = this.rouletteService.generateBoardDisplay(game.bets);

    for (let frame = 0; frame < totalFrames; frame++) {
      const currentNumber = spinSequence[frame];
      const colorEmoji = currentNumber.color === 'red' ? '🔴' : currentNumber.color === 'black' ? '⚫' : '🟢';

      // Show current spinning number inline with "The ball lands on..."
      const spinStatus = `_Spinning..._ ${colorEmoji} **${currentNumber.value}**`;

      const embed = new EmbedBuilder()
        .setTitle('🎰 American Roulette')
        .setColor(0x228b22)
        .setDescription(
          `**Player:** ${userMention}\n\n` +
            `**The Board:**\n${boardDisplay}\n\n` +
            `**Active Bets:** ${betList}\n\n` +
            spinStatus
        )
        .addFields(
          { name: 'Total Bet', value: formatCoins(game.totalWagered), inline: true },
          { name: 'Balance', value: formatCoins(balance), inline: true }
        );

      await interaction.editReply({ embeds: [embed], components: this.createDisabledComponents() });

      // Variable delay
      const baseDelay = frame < 4 ? 150 : frame < totalFrames - 4 ? 250 : 350;
      const jitter = Math.random() * 80 - 40;
      await this.sleep(baseDelay + frame * 15 + jitter);
    }

    // Final dramatic pause
    await this.sleep(500 + Math.random() * 300);
  }
}
