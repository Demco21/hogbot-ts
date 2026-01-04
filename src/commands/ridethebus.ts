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
import { GameSource, UpdateType, GAME_INTERACTION_TIMEOUT_MINUTES, GAME_BET_LIMITS } from '../constants.js';
import { RideTheBusService, type Card } from '../services/RideTheBusService.js';
import { formatCoins } from '../lib/utils.js';

@ApplyOptions<Command.Options>({
  name: 'ridethebus',
  description: 'Play a high-risk, high-reward casino card game',
  preconditions: ['CasinoChannelOnly'],
})
export class RideTheBusCommand extends Command {
  private rtbService: RideTheBusService;

  public constructor(context: Command.LoaderContext, options: Command.Options) {
    super(context, options);
    this.rtbService = new RideTheBusService();
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
              .setDescription(
                `Amount to bet (${GAME_BET_LIMITS.RIDE_THE_BUS.MIN.toLocaleString()}-${GAME_BET_LIMITS.RIDE_THE_BUS.MAX.toLocaleString()})`
              )
              .setRequired(false)
              .setMinValue(GAME_BET_LIMITS.RIDE_THE_BUS.MIN)
              .setMaxValue(GAME_BET_LIMITS.RIDE_THE_BUS.MAX)
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
      const betAmount = interaction.options.getInteger('bet') ?? GAME_BET_LIMITS.RIDE_THE_BUS.MIN;

      // Ensure guild and user exist in database with proper names
      await this.container.walletService.ensureGuild(guildId, interaction.guild?.name);
      const user = await this.container.walletService.ensureUser(userId, guildId, interaction.user.username);

      // Check for crashed game and recover
      await this.container.gameStateService.checkAndRecoverCrashedGame(userId, guildId, GameSource.RIDE_THE_BUS);

      // Check if user already has an active game
      if (await this.container.gameStateService.hasActiveGame(userId, guildId, GameSource.RIDE_THE_BUS)) {
        await interaction.reply({
          content: '🚫 You already have an active Ride the Bus game. Finish it before starting a new one.',
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      // Check balance
      const balance = user.balance;
      if (balance < betAmount) {
        await interaction.reply({
          content: `You don't have enough **Hog Coins** to make that bet.\nYour current balance is **${formatCoins(balance)}**.`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      // Defer reply after validation passes
      await interaction.deferReply();

      // Deduct bet
      await this.container.walletService.updateBalance(userId, guildId, -betAmount, GameSource.RIDE_THE_BUS, UpdateType.BET_PLACED, {
        bet_amount: betAmount,
        round: 1,
      });

      // Start game in database (prevents concurrent games, enables crash recovery)
      await this.container.gameStateService.startGame(userId, guildId, GameSource.RIDE_THE_BUS, betAmount);

      // Start game
      const deck = this.rtbService.buildDeck();
      const cards: Card[] = [];
      const currentBalance = await this.container.walletService.getBalance(userId, guildId);

      const embed = this.buildRound1Embed(interaction.user.toString(), betAmount, cards, currentBalance);
      const row = this.buildRound1Buttons();

      const response = await interaction.editReply({
        embeds: [embed],
        components: [row],
      });

      // Handle game flow
      await this.handleGameFlow(response, interaction, userId, guildId, betAmount, deck, cards);
    } catch (error) {
      this.container.logger.error('Error in ridethebus command:', error);
      await interaction.editReply({
        content: 'An error occurred while starting Ride the Bus. Please try again.',
        components: [],
      });
    }
  }

  private async handleGameFlow(
    response: any,
    originalInteraction: ChatInputCommandInteraction,
    userId: string,
    guildId: string,
    betAmount: number,
    deck: Card[],
    cards: Card[]
  ) {
    let stage = 1;
    let currentMultiplier = 0;

    const collector = response.createMessageComponentCollector({
      componentType: ComponentType.Button,
      time: GAME_INTERACTION_TIMEOUT_MINUTES * 60 * 1000, // Convert minutes to milliseconds
    });

    collector.on('collect', async (buttonInteraction: ButtonInteraction) => {
      if (buttonInteraction.user.id !== userId) {
        await buttonInteraction.reply({
          content: "This isn't your game of Ride the Bus.",
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      const choice = buttonInteraction.customId;

      try {
        // Round 1: Red or Black
        if (stage === 1) {
          const card = deck.pop()!;
          cards.push(card);
          const actualColor = this.rtbService.getCardColor(card);
          const won = choice === actualColor;

          if (won) {
            currentMultiplier = 2;
            // Log ROUND_WON (filtered from graph)
            await this.container.walletService.updateBalance(userId, guildId, 0, GameSource.RIDE_THE_BUS, UpdateType.ROUND_WON, {
              bet_amount: betAmount,
              payout_amount: 0,
              round: 1,
              choice,
              actual: actualColor,
            });

            // Update stats (including color choice)
            await this.container.statsService.updateGameStats(userId, guildId, GameSource.RIDE_THE_BUS, true, betAmount, 0, {
              round_1_wins: 1,
              [`${actualColor}_count`]: 1,
            });

            stage = 2;
            const balance = await this.container.walletService.getBalance(userId, guildId);
            const embed = this.buildRound2Embed(buttonInteraction.user.toString(), betAmount, cards, currentMultiplier, balance);
            const row = this.buildRound2Buttons();
            await buttonInteraction.update({ embeds: [embed], components: [row] });
          } else {
            // Lost Round 1
            await this.container.walletService.updateBalance(userId, guildId, 0, GameSource.RIDE_THE_BUS, UpdateType.BET_LOST, {
              bet_amount: betAmount,
              payout_amount: 0,
              round: 1,
              choice,
              actual: actualColor,
            });

            await this.container.statsService.updateGameStats(userId, guildId, GameSource.RIDE_THE_BUS, false, betAmount, 0, {
              round_1_losses: 1,
              [`${actualColor}_count`]: 1,
            });

            const balance = await this.container.walletService.getBalance(userId, guildId);
            const embed = this.buildLossEmbed(buttonInteraction.user.toString(), betAmount, cards, 1, balance);
            await buttonInteraction.update({ embeds: [embed], components: [] });
            collector.stop('lost');
          }
          return;
        }

        // Round 2: Higher or Lower
        if (stage === 2) {
          if (choice === 'cashout') {
            await this.handleCashout(buttonInteraction, userId, guildId, betAmount, currentMultiplier, cards, stage);
            collector.stop('cashout');
            return;
          }

          const card = deck.pop()!;
          cards.push(card);
          const firstCard = cards[0];

          // Tie = loss
          if (card.rank === firstCard.rank) {
            await this.container.walletService.updateBalance(userId, guildId, 0, GameSource.RIDE_THE_BUS, UpdateType.BET_LOST, {
              bet_amount: betAmount,
              payout_amount: 0,
              round: 2,
              choice,
              actual: 'tie',
            });

            await this.container.statsService.updateGameStats(userId, guildId, GameSource.RIDE_THE_BUS, false, betAmount, 0, {
              round_2_losses: 1,
            });

            const balance = await this.container.walletService.getBalance(userId, guildId);
            const embed = this.buildLossEmbed(buttonInteraction.user.toString(), betAmount, cards, 2, balance, 'It\'s a tie – house wins.');
            await buttonInteraction.update({ embeds: [embed], components: [] });
            collector.stop('lost');
            return;
          }

          const isHigher = card.rank > firstCard.rank;
          const won = (choice === 'higher' && isHigher) || (choice === 'lower' && !isHigher);

          if (won) {
            currentMultiplier = 3;
            await this.container.walletService.updateBalance(userId, guildId, 0, GameSource.RIDE_THE_BUS, UpdateType.ROUND_WON, {
              bet_amount: betAmount,
              payout_amount: 0,
              round: 2,
              choice,
            });

            await this.container.statsService.updateGameStats(userId, guildId, GameSource.RIDE_THE_BUS, true, betAmount, 0, {
              round_2_wins: 1,
            });

            stage = 3;
            const balance = await this.container.walletService.getBalance(userId, guildId);
            const embed = this.buildRound3Embed(buttonInteraction.user.toString(), betAmount, cards, currentMultiplier, balance);
            const row = this.buildRound3Buttons();
            await buttonInteraction.update({ embeds: [embed], components: [row] });
          } else {
            await this.container.walletService.updateBalance(userId, guildId, 0, GameSource.RIDE_THE_BUS, UpdateType.BET_LOST, {
              bet_amount: betAmount,
              payout_amount: 0,
              round: 2,
              choice,
              actual: isHigher ? 'higher' : 'lower',
            });

            await this.container.statsService.updateGameStats(userId, guildId, GameSource.RIDE_THE_BUS, false, betAmount, 0, {
              round_2_losses: 1,
            });

            const balance = await this.container.walletService.getBalance(userId, guildId);
            const embed = this.buildLossEmbed(buttonInteraction.user.toString(), betAmount, cards, 2, balance);
            await buttonInteraction.update({ embeds: [embed], components: [] });
            collector.stop('lost');
          }
          return;
        }

        // Round 3: Inside or Outside
        if (stage === 3) {
          if (choice === 'cashout') {
            await this.handleCashout(buttonInteraction, userId, guildId, betAmount, currentMultiplier, cards, stage);
            collector.stop('cashout');
            return;
          }

          const card = deck.pop()!;
          cards.push(card);
          const [first, second] = cards;
          const low = Math.min(first.rank, second.rank);
          const high = Math.max(first.rank, second.rank);

          // Match = loss
          if (card.rank === first.rank || card.rank === second.rank) {
            await this.container.walletService.updateBalance(userId, guildId, 0, GameSource.RIDE_THE_BUS, UpdateType.BET_LOST, {
              bet_amount: betAmount,
              payout_amount: 0,
              round: 3,
              choice,
              actual: this.rtbService.formatCard(card),
            });

            await this.container.statsService.updateGameStats(userId, guildId, GameSource.RIDE_THE_BUS, false, betAmount, 0, {
              round_3_losses: 1,
            });

            const balance = await this.container.walletService.getBalance(userId, guildId);
            const embed = this.buildLossEmbed(
              buttonInteraction.user.toString(),
              betAmount,
              cards,
              3,
              balance,
              'The third card matches one of the first two.'
            );
            await buttonInteraction.update({ embeds: [embed], components: [] });
            collector.stop('lost');
            return;
          }

          const inside = low < card.rank && card.rank < high;
          const won = (choice === 'inside' && inside) || (choice === 'outside' && !inside);

          if (won) {
            currentMultiplier = 4;
            await this.container.walletService.updateBalance(userId, guildId, 0, GameSource.RIDE_THE_BUS, UpdateType.ROUND_WON, {
              bet_amount: betAmount,
              payout_amount: 0,
              round: 3,
              choice,
            });

            await this.container.statsService.updateGameStats(userId, guildId, GameSource.RIDE_THE_BUS, true, betAmount, 0, {
              round_3_wins: 1,
            });

            stage = 4;
            const balance = await this.container.walletService.getBalance(userId, guildId);
            const embed = this.buildRound4Embed(buttonInteraction.user.toString(), betAmount, cards, currentMultiplier, balance);
            const row = this.buildRound4Buttons();
            await buttonInteraction.update({ embeds: [embed], components: [row] });
          } else {
            await this.container.walletService.updateBalance(userId, guildId, 0, GameSource.RIDE_THE_BUS, UpdateType.BET_LOST, {
              bet_amount: betAmount,
              payout_amount: 0,
              round: 3,
              choice,
              actual: inside ? 'inside' : 'outside',
            });

            await this.container.statsService.updateGameStats(userId, guildId, GameSource.RIDE_THE_BUS, false, betAmount, 0, {
              round_3_losses: 1,
            });

            const balance = await this.container.walletService.getBalance(userId, guildId);
            const embed = this.buildLossEmbed(buttonInteraction.user.toString(), betAmount, cards, 3, balance);
            await buttonInteraction.update({ embeds: [embed], components: [] });
            collector.stop('lost');
          }
          return;
        }

        // Round 4: Guess Suit
        if (stage === 4) {
          if (choice === 'cashout') {
            await this.handleCashout(buttonInteraction, userId, guildId, betAmount, currentMultiplier, cards, stage);
            collector.stop('cashout');
            return;
          }

          const card = deck.pop()!;
          cards.push(card);
          const won = card.suit === choice;

          if (won) {
            currentMultiplier = 8;
            const payout = this.rtbService.calculatePayout(betAmount, currentMultiplier);

            await this.container.walletService.updateBalance(userId, guildId, payout, GameSource.RIDE_THE_BUS, UpdateType.BET_WON, {
              bet_amount: betAmount,
              payout_amount: payout,
              round: 4,
              choice,
              actual: card.suit,
            });

            await this.container.statsService.updateGameStats(userId, guildId, GameSource.RIDE_THE_BUS, true, betAmount, payout, {
              round_4_wins: 1,
              wins_8x: 1,
            });

            const balance = await this.container.walletService.getBalance(userId, guildId);
            const embed = this.buildWinEmbed(buttonInteraction.user.toString(), betAmount, cards, currentMultiplier, payout, balance);
            await buttonInteraction.update({ embeds: [embed], components: [] });
            collector.stop('won');
          } else {
            await this.container.walletService.updateBalance(userId, guildId, 0, GameSource.RIDE_THE_BUS, UpdateType.BET_LOST, {
              bet_amount: betAmount,
              payout_amount: 0,
              round: 4,
              choice,
              actual: card.suit,
            });

            await this.container.statsService.updateGameStats(userId, guildId, GameSource.RIDE_THE_BUS, false, betAmount, 0, {
              round_4_losses: 1,
            });

            const balance = await this.container.walletService.getBalance(userId, guildId);
            const embed = this.buildLossEmbed(buttonInteraction.user.toString(), betAmount, cards, 4, balance, 'Wrong suit.');
            await buttonInteraction.update({ embeds: [embed], components: [] });
            collector.stop('lost');
          }
        }
      } catch (error) {
        this.container.logger.error('Error handling RTB button:', error);
        await buttonInteraction.update({
          content: 'An error occurred. Game ended.',
          components: [],
        });
        collector.stop('error');
      }
    });

    collector.on('end', async (_collected: any, reason: string) => {
      try {
        // Finish game in database
        await this.container.gameStateService.finishGame(userId, guildId, GameSource.RIDE_THE_BUS);

        if (reason === 'time') {
          // Log timeout as loss
          await this.container.walletService.updateBalance(userId, guildId, 0, GameSource.RIDE_THE_BUS, UpdateType.BET_LOST, {
            bet_amount: betAmount,
            payout_amount: 0,
            round: stage,
            reason: 'timeout',
          });

          await originalInteraction.editReply({
            content: '⏰ Game timed out.',
            components: [],
          });
        }
      } catch (error) {
        this.container.logger.error('Error handling timeout or cleanup:', error);
      }
    });
  }

  private async handleCashout(
    interaction: ButtonInteraction,
    userId: string,
    guildId: string,
    betAmount: number,
    multiplier: number,
    cards: Card[],
    stage: number
  ) {
    const payout = this.rtbService.calculatePayout(betAmount, multiplier);

    await this.container.walletService.updateBalance(userId, guildId, payout, GameSource.RIDE_THE_BUS, UpdateType.BET_WON, {
      bet_amount: betAmount,
      payout_amount: payout,
      round: stage,
      choice: 'cashout',
    });

    await this.container.statsService.updateGameStats(userId, guildId, GameSource.RIDE_THE_BUS, true, betAmount, payout, {});

    const balance = await this.container.walletService.getBalance(userId, guildId);
    const embed = this.buildCashoutEmbed(interaction.user.toString(), betAmount, cards, multiplier, payout, balance);
    await interaction.update({ embeds: [embed], components: [] });
  }

  // Embed builders
  private buildRound1Embed(player: string, bet: number, cards: Card[], balance: number): EmbedBuilder {
    return new EmbedBuilder()
      .setTitle('🚌 Ride the Bus')
      .setDescription(
        `**Player:** ${player}\n\n` +
          '**Round 1 – Red or Black?**\n' +
          'Guess the **color** of the first card.\n\n' +
          '**Round 1 Multiplier**: 🪙x2'
      )
      .setColor(0x5865f2)
      .addFields(
        { name: 'Bet', value: formatCoins(bet), inline: true },
        { name: 'Cashout Value', value: formatCoins(0), inline: true },
        { name: 'Balance', value: formatCoins(balance), inline: true },
        { name: 'Cards so far', value: this.rtbService.formatCards(cards), inline: false }
      );
  }

  private buildRound2Embed(player: string, bet: number, cards: Card[], multiplier: number, balance: number): EmbedBuilder {
    const payout = this.rtbService.calculatePayout(bet, multiplier);
    return new EmbedBuilder()
      .setTitle('🚌 Ride the Bus')
      .setDescription(
        `**Player:** ${player}\n\n` +
          '✅ You **won**!\n\n' +
          '**Round 2 – Higher or Lower**\n' +
          'Guess if the **next card** will be **higher** or **lower**.\n' +
          '_Ties lose._\n\n' +
          '**Round 2 Multiplier**: 🪙x3'
      )
      .setColor(0x00ff00)
      .addFields(
        { name: 'Bet', value: formatCoins(bet), inline: true },
        { name: 'Cashout Value', value: formatCoins(payout), inline: true },
        { name: 'Balance', value: formatCoins(balance), inline: true },
        { name: 'Cards so far', value: this.rtbService.formatCards(cards), inline: false }
      );
  }

  private buildRound3Embed(player: string, bet: number, cards: Card[], multiplier: number, balance: number): EmbedBuilder {
    const payout = this.rtbService.calculatePayout(bet, multiplier);
    return new EmbedBuilder()
      .setTitle('🚌 Ride the Bus')
      .setDescription(
        `**Player:** ${player}\n\n` +
          '✅ You **won**!\n\n' +
          '**Round 3 – Inside or Outside**\n' +
          'Guess if the **next card** will be **inside** or **outside** the first two cards.\n' +
          'If it **matches** either card exactly, you **lose**.\n\n' +
          '**Round 3 Multiplier**: 🪙x4'
      )
      .setColor(0x00ff00)
      .addFields(
        { name: 'Bet', value: formatCoins(bet), inline: true },
        { name: 'Cashout Value', value: formatCoins(payout), inline: true },
        { name: 'Balance', value: formatCoins(balance), inline: true },
        { name: 'Cards so far', value: this.rtbService.formatCards(cards), inline: false }
      );
  }

  private buildRound4Embed(player: string, bet: number, cards: Card[], multiplier: number, balance: number): EmbedBuilder {
    const payout = this.rtbService.calculatePayout(bet, multiplier);
    return new EmbedBuilder()
      .setTitle('🚌 Ride the Bus')
      .setDescription(
        `**Player:** ${player}\n\n` +
          '✅ You **won**!\n\n' +
          '**Round 4 – Guess the Suit**\n' +
          'Final card! Guess the **suit** of the last card.\n\n' +
          '**Round 4 Multiplier**: 🪙x8'
      )
      .setColor(0x00ff00)
      .addFields(
        { name: 'Bet', value: formatCoins(bet), inline: true },
        { name: 'Cashout Value', value: formatCoins(payout), inline: true },
        { name: 'Balance', value: formatCoins(balance), inline: true },
        { name: 'Cards so far', value: this.rtbService.formatCards(cards), inline: false }
      );
  }

  private buildWinEmbed(player: string, bet: number, cards: Card[], multiplier: number, payout: number, balance: number): EmbedBuilder {
    return new EmbedBuilder()
      .setTitle('🚌 Ride the Bus')
      .setDescription(`**Player:** ${player}\n\n` + '🎉 **Jackpot!** You guessed correctly.\n\n' + `**Final Multiplier**: 🪙x${multiplier}`)
      .setColor(0x00ff00)
      .addFields(
        { name: 'Bet', value: formatCoins(bet), inline: true },
        { name: 'Final Payout', value: formatCoins(payout), inline: true },
        { name: 'Balance', value: formatCoins(balance), inline: true },
        { name: 'Cards', value: this.rtbService.formatCards(cards), inline: false }
      );
  }

  private buildLossEmbed(player: string, bet: number, cards: Card[], round: number, balance: number, customMessage?: string): EmbedBuilder {
    const message = customMessage || 'You **lost**. The house takes your bet.';
    return new EmbedBuilder()
      .setTitle('🚌 Ride the Bus')
      .setDescription(`**Player:** ${player}\n\n` + `**Round ${round}**\n\n` + `❌ ${message}`)
      .setColor(0xff0000)
      .addFields(
        { name: 'Bet', value: formatCoins(bet), inline: true },
        { name: 'Final Payout', value: formatCoins(0), inline: true },
        { name: 'Balance', value: formatCoins(balance), inline: true },
        { name: 'Cards', value: this.rtbService.formatCards(cards), inline: false }
      );
  }

  private buildCashoutEmbed(player: string, bet: number, cards: Card[], multiplier: number, payout: number, balance: number): EmbedBuilder {
    return new EmbedBuilder()
      .setTitle('🚌 Ride the Bus')
      .setDescription(`**Player:** ${player}\n\n` + 'You chose to **cash out**.\n\n' + `**Final Multiplier**: 🪙x${multiplier}`)
      .setColor(0x00ff00)
      .addFields(
        { name: 'Bet', value: formatCoins(bet), inline: true },
        { name: 'Final Payout', value: formatCoins(payout), inline: true },
        { name: 'Balance', value: formatCoins(balance), inline: true },
        { name: 'Cards', value: this.rtbService.formatCards(cards), inline: false }
      );
  }

  // Button builders
  private buildRound1Buttons(): ActionRowBuilder<ButtonBuilder> {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('red').setLabel('🟥 Red').setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId('black').setLabel('⬛ Black').setStyle(ButtonStyle.Secondary)
    );
  }

  private buildRound2Buttons(): ActionRowBuilder<ButtonBuilder> {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('higher').setLabel('⬆️ Higher').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('lower').setLabel('⬇️ Lower').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('cashout').setLabel('💰 Cashout').setStyle(ButtonStyle.Success)
    );
  }

  private buildRound3Buttons(): ActionRowBuilder<ButtonBuilder> {
    return new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('inside').setLabel('⬛ Inside').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('outside').setLabel('⬜ Outside').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('cashout').setLabel('💰 Cashout').setStyle(ButtonStyle.Success)
    );
  }

  private buildRound4Buttons(): ActionRowBuilder<ButtonBuilder> {
    const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder().setCustomId('♠️').setLabel('♠️ Spades').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('♥️').setLabel('♥️ Hearts').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('♦️').setLabel('♦️ Diamonds').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('♣️').setLabel('♣️ Clubs').setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId('cashout').setLabel('💰 Cashout').setStyle(ButtonStyle.Success)
    );
    return row1;
  }
}
