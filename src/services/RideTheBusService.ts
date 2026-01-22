/**
 * RideTheBusService - Handles Ride the Bus game logic
 *
 * Follows the same pattern as BlackjackService:
 * - RideTheBusGame class manages a single game session
 * - RideTheBusService manages game sessions and provides entry point
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  ButtonInteraction,
  EmbedBuilder,
  User,
  Message,
  MessageFlags,
  ChatInputCommandInteraction,
} from 'discord.js';
import { GameSource, UpdateType, GAME_BET_LIMITS } from '../constants.js';
import { WalletService } from './WalletService.js';
import { StatsService } from './StatsService.js';
import { GameStateService } from './GameStateService.js';
import { DeckService, type Card } from './DeckService.js';
import { safeLogger as logger } from '../lib/safe-logger.js';
import { formatCoins } from '../utils/utils.js';

// Re-export Card type for consumers
export type { Card };

/** Embed constants */
const EMBED_TITLE = '🚌 Ride the Bus';
const COLOR_DEFAULT = 0x5865f2;
const COLOR_WIN = 0x00ff00;
const COLOR_LOSS = 0xff0000;

/** Field names */
const FIELD_BET = 'Bet';
const FIELD_CASHOUT_VALUE = 'Cashout Value';
const FIELD_FINAL_PAYOUT = 'Final Payout';
const FIELD_BALANCE = 'Balance';
const FIELD_CARDS = 'Cards';

/** Round multipliers */
const ROUND_1_MULTIPLIER = 2;
const ROUND_2_MULTIPLIER = 3;
const ROUND_3_MULTIPLIER = 4;
const ROUND_4_MULTIPLIER = 8;

/** Round win/loss stat keys */
const ROUND_1_WIN_STAT = 'round_1_wins';
const ROUND_1_LOSS_STAT = 'round_1_losses';
const ROUND_2_WIN_STAT = 'round_2_wins';
const ROUND_2_LOSS_STAT = 'round_2_losses';
const ROUND_3_WIN_STAT = 'round_3_wins';
const ROUND_3_LOSS_STAT = 'round_3_losses';
const ROUND_4_WIN_STAT = 'round_4_wins';
const ROUND_4_LOSS_STAT = 'round_4_losses';

/** Extra stat keys */
const RED_COUNT_STAT = 'red_count';
const BLACK_COUNT_STAT = 'black_count';
const WINS_8X_STAT = 'wins_8x';

/** Button IDs (exported for use by command) */
export const BTN_ID_RED = 'red';
export const BTN_ID_BLACK = 'black';
export const BTN_ID_HIGHER = 'higher';
export const BTN_ID_LOWER = 'lower';
export const BTN_ID_INSIDE = 'inside';
export const BTN_ID_OUTSIDE = 'outside';
export const BTN_ID_SPADES = '♠️';
export const BTN_ID_HEARTS = '♥️';
export const BTN_ID_DIAMONDS = '♦️';
export const BTN_ID_CLUBS = '♣️';
export const BTN_ID_CASHOUT = 'cashout';

const MIN_BET = GAME_BET_LIMITS.RIDE_THE_BUS.MIN;

/** Mutable game state */
interface GameState {
  stage: number;
  multiplier: number;
  deck: Card[];
  cards: Card[];
  balance: number;
}

/** Result returned by each round handler */
interface RoundResult {
  won: boolean;
  isFinalWin?: boolean;
  actual: string;
  extraStats: Record<string, number>;
  lossMessage?: string;
}

/**
 * RideTheBusGame manages a single Ride the Bus game session
 */
class RideTheBusGame {
  private player: User;
  private guildId: string;
  private baseBet: number;
  private walletService: WalletService;
  private statsService: StatsService;
  private deckService: DeckService;

  private state: GameState;
  private message: Message | null = null;
  private onGameEnd: (() => void) | null = null;

  constructor(
    player: User,
    guildId: string,
    bet: number,
    initialBalance: number,
    walletService: WalletService,
    statsService: StatsService,
    deckService: DeckService,
    onGameEnd?: () => void
  ) {
    this.player = player;
    this.guildId = guildId;
    this.baseBet = bet;
    this.walletService = walletService;
    this.statsService = statsService;
    this.deckService = deckService;
    this.onGameEnd = onGameEnd || null;

    this.state = {
      stage: 1,
      multiplier: 0,
      deck: this.deckService.createDeck(),
      cards: [],
      balance: initialBalance,
    };
  }

  // ========== Cleanup ==========

  private cleanupSession(): void {
    if (this.onGameEnd) {
      this.onGameEnd();
    }
  }

  // ========== Getters ==========

  getPlayerId(): string {
    return this.player.id;
  }

  getMessage(): Message | null {
    return this.message;
  }

  getStage(): number {
    return this.state.stage;
  }

  getBet(): number {
    return this.baseBet;
  }

  // ========== Safe Message Editing ==========

  private async safeEdit(
    interaction: ButtonInteraction | null,
    embed: EmbedBuilder,
    components: ActionRowBuilder<ButtonBuilder>[]
  ): Promise<void> {
    try {
      if (interaction && !interaction.replied && !interaction.deferred) {
        await interaction.update({ embeds: [embed], components });
        if (!this.message) {
          this.message = await interaction.fetchReply();
        }
      } else if (this.message) {
        await this.message.edit({ embeds: [embed], components });
      } else {
        logger.warn('No message available to edit in RTB game');
      }
    } catch (error) {
      logger.error('Failed to edit RTB message:', error);
    }
  }

  // ========== Round Processing ==========

  private processRound(choice: string): RoundResult {
    switch (this.state.stage) {
      case 1:
        return this.processRound1(choice);
      case 2:
        return this.processRound2(choice);
      case 3:
        return this.processRound3(choice);
      case 4:
        return this.processRound4(choice);
      default:
        throw new Error(`Invalid stage: ${this.state.stage}`);
    }
  }

  /** Round 1: Red or Black */
  private processRound1(choice: string): RoundResult {
    const card = this.state.deck.pop()!;
    this.state.cards.push(card);
    const actualColor = this.deckService.getCardColor(card);
    const won = choice === actualColor;

    if (won) {
      this.state.multiplier = ROUND_1_MULTIPLIER;
    }

    const colorStat = actualColor === 'red' ? RED_COUNT_STAT : BLACK_COUNT_STAT;
    return {
      won,
      actual: actualColor,
      extraStats: { [won ? ROUND_1_WIN_STAT : ROUND_1_LOSS_STAT]: 1, [colorStat]: 1 },
    };
  }

  /** Round 2: Higher or Lower */
  private processRound2(choice: string): RoundResult {
    const card = this.state.deck.pop()!;
    this.state.cards.push(card);
    const firstCard = this.state.cards[0];

    // Tie = loss
    if (card.rank === firstCard.rank) {
      return {
        won: false,
        actual: 'tie',
        extraStats: { [ROUND_2_LOSS_STAT]: 1 },
        lossMessage: "It's a tie – house wins.",
      };
    }

    const isHigher = card.rank > firstCard.rank;
    const won = (choice === 'higher' && isHigher) || (choice === 'lower' && !isHigher);

    if (won) {
      this.state.multiplier = ROUND_2_MULTIPLIER;
    }

    return {
      won,
      actual: isHigher ? 'higher' : 'lower',
      extraStats: { [won ? ROUND_2_WIN_STAT : ROUND_2_LOSS_STAT]: 1 },
    };
  }

  /** Round 3: Inside or Outside */
  private processRound3(choice: string): RoundResult {
    const card = this.state.deck.pop()!;
    this.state.cards.push(card);
    const [first, second] = this.state.cards;
    const low = Math.min(first.rank, second.rank);
    const high = Math.max(first.rank, second.rank);

    // Match = loss
    if (card.rank === first.rank || card.rank === second.rank) {
      return {
        won: false,
        actual: this.deckService.formatCard(card),
        extraStats: { [ROUND_3_LOSS_STAT]: 1 },
        lossMessage: 'The third card matches one of the first two.',
      };
    }

    const inside = low < card.rank && card.rank < high;
    const won = (choice === 'inside' && inside) || (choice === 'outside' && !inside);

    if (won) {
      this.state.multiplier = ROUND_3_MULTIPLIER;
    }

    return {
      won,
      actual: inside ? 'inside' : 'outside',
      extraStats: { [won ? ROUND_3_WIN_STAT : ROUND_3_LOSS_STAT]: 1 },
    };
  }

  /** Round 4: Guess the Suit */
  private processRound4(choice: string): RoundResult {
    const card = this.state.deck.pop()!;
    this.state.cards.push(card);
    const won = card.suit === choice;

    if (won) {
      this.state.multiplier = ROUND_4_MULTIPLIER;
    }

    return {
      won,
      isFinalWin: won,
      actual: card.suit,
      extraStats: won ? { [ROUND_4_WIN_STAT]: 1, [WINS_8X_STAT]: 1 } : { [ROUND_4_LOSS_STAT]: 1 },
    };
  }

  // ========== Payout Calculation ==========

  calculatePayout(multiplier: number): number {
    return this.baseBet * multiplier;
  }

  // ========== Player Actions ==========

  /**
   * Handle a player's choice (button click)
   * Returns true if the game ended, false if it continues
   */
  async handleChoice(interaction: ButtonInteraction, choice: string): Promise<boolean> {
    // Handle cashout (available in rounds 2-4)
    if (choice === BTN_ID_CASHOUT && this.state.stage > 1) {
      await this.handleCashout(interaction);
      return true;
    }

    const result = this.processRound(choice);

    if (result.won) {
      await this.handleRoundWin(interaction, choice, result);

      if (result.isFinalWin) {
        return true;
      } else {
        // Advance to next round
        this.state.stage++;
        const embed = this.buildRoundEmbed();
        const row = this.buildRoundButtons();
        await this.safeEdit(interaction, embed, [row]);
        return false;
      }
    } else {
      await this.handleRoundLoss(interaction, choice, result);
      return true;
    }
  }

  private async handleRoundWin(interaction: ButtonInteraction, choice: string, result: RoundResult): Promise<void> {
    if (result.isFinalWin) {
      // Final round win - pay out
      const payout = this.calculatePayout(this.state.multiplier);

      await this.walletService.updateBalance(
        this.player.id,
        this.guildId,
        payout,
        GameSource.RIDE_THE_BUS,
        UpdateType.BET_WON,
        {
          bet_amount: this.baseBet,
          payout_amount: payout,
          round: this.state.stage,
          choice,
          actual: result.actual,
        }
      );

      await this.statsService.updateGameStats(
        this.player.id,
        this.guildId,
        GameSource.RIDE_THE_BUS,
        true,
        this.baseBet,
        payout,
        result.extraStats
      );

      const finalBalance = this.state.balance + payout;
      const embed = this.buildWinEmbed(payout, finalBalance);
      await this.safeEdit(interaction, embed, []);
      this.cleanupSession();
    } else {
      // Intermediate round win - log for audit trail
      await this.walletService.logTransaction(
        this.player.id,
        this.guildId,
        GameSource.RIDE_THE_BUS,
        UpdateType.ROUND_WON,
        {
          bet_amount: this.baseBet,
          round: this.state.stage,
          choice,
          actual: result.actual,
        }
      );

      await this.statsService.updateExtraStatsOnly(
        this.player.id,
        this.guildId,
        GameSource.RIDE_THE_BUS,
        result.extraStats
      );
    }
  }

  private async handleRoundLoss(interaction: ButtonInteraction, choice: string, result: RoundResult): Promise<void> {
    // Log the loss (no balance change - bet was already deducted)
    await this.walletService.logTransaction(
      this.player.id,
      this.guildId,
      GameSource.RIDE_THE_BUS,
      UpdateType.BET_LOST,
      {
        bet_amount: this.baseBet,
        payout_amount: 0,
        round: this.state.stage,
        choice,
        actual: result.actual,
      }
    );

    await this.statsService.updateGameStats(
      this.player.id,
      this.guildId,
      GameSource.RIDE_THE_BUS,
      false,
      this.baseBet,
      0,
      result.extraStats
    );

    const embed = this.buildLossEmbed(result.lossMessage);
    await this.safeEdit(interaction, embed, []);
    this.cleanupSession();
  }

  private async handleCashout(interaction: ButtonInteraction): Promise<void> {
    const payout = this.calculatePayout(this.state.multiplier);

    await this.walletService.updateBalance(
      this.player.id,
      this.guildId,
      payout,
      GameSource.RIDE_THE_BUS,
      UpdateType.BET_WON,
      {
        bet_amount: this.baseBet,
        payout_amount: payout,
        round: this.state.stage,
        choice: 'cashout',
      }
    );

    await this.statsService.updateGameStats(
      this.player.id,
      this.guildId,
      GameSource.RIDE_THE_BUS,
      true,
      this.baseBet,
      payout,
      {}
    );

    const finalBalance = this.state.balance + payout;
    const embed = this.buildCashoutEmbed(payout, finalBalance);
    await this.safeEdit(interaction, embed, []);
    this.cleanupSession();
  }

  /**
   * Handle game timeout
   */
  async handleTimeout(): Promise<void> {
    // Log the timeout as a loss
    await this.walletService.logTransaction(
      this.player.id,
      this.guildId,
      GameSource.RIDE_THE_BUS,
      UpdateType.BET_LOST,
      {
        bet_amount: this.baseBet,
        payout_amount: 0,
        round: this.state.stage,
        reason: 'timeout',
      }
    );

    await this.statsService.updateGameStats(
      this.player.id,
      this.guildId,
      GameSource.RIDE_THE_BUS,
      false,
      this.baseBet,
      0,
      {}
    );

    this.cleanupSession();
  }

  // ========== Embed Builders ==========

  private buildRoundEmbed(): EmbedBuilder {
    const payout = this.calculatePayout(this.state.multiplier);
    const isFirstRound = this.state.stage === 1;

    const roundDescriptions: Record<number, string> = {
      1: `**Round 1 – Red or Black?**\nGuess the **color** of the first card.\n\n**Round 1 Multiplier**: 🪙x${ROUND_1_MULTIPLIER}`,
      2: `✅ You **won**!\n\n**Round 2 – Higher or Lower**\nGuess if the **next card** will be **higher** or **lower**.\n_Ties lose._\n\n**Round 2 Multiplier**: 🪙x${ROUND_2_MULTIPLIER}`,
      3: `✅ You **won**!\n\n**Round 3 – Inside or Outside**\nGuess if the **next card** will be **inside** or **outside** the first two cards.\nIf it **matches** either card exactly, you **lose**.\n\n**Round 3 Multiplier**: 🪙x${ROUND_3_MULTIPLIER}`,
      4: `✅ You **won**!\n\n**Round 4 – Guess the Suit**\nFinal card! Guess the **suit** of the last card.\n\n**Round 4 Multiplier**: 🪙x${ROUND_4_MULTIPLIER}`,
    };

    return new EmbedBuilder()
      .setTitle(EMBED_TITLE)
      .setDescription(`**Player:** ${this.player.toString()}\n\n${roundDescriptions[this.state.stage]}`)
      .setColor(isFirstRound ? COLOR_DEFAULT : COLOR_WIN)
      .addFields(
        { name: FIELD_BET, value: formatCoins(this.baseBet), inline: true },
        { name: FIELD_CASHOUT_VALUE, value: formatCoins(payout), inline: true },
        { name: FIELD_BALANCE, value: formatCoins(this.state.balance), inline: true },
        { name: FIELD_CARDS, value: this.formatCards(), inline: false }
      );
  }

  private buildWinEmbed(payout: number, balance: number): EmbedBuilder {
    return new EmbedBuilder()
      .setTitle(EMBED_TITLE)
      .setDescription(
        `**Player:** ${this.player.toString()}\n\n🎉 **Jackpot!** You guessed correctly.\n\n**Final Multiplier**: 🪙x${this.state.multiplier}`
      )
      .setColor(COLOR_WIN)
      .addFields(
        { name: FIELD_BET, value: formatCoins(this.baseBet), inline: true },
        { name: FIELD_FINAL_PAYOUT, value: formatCoins(payout), inline: true },
        { name: FIELD_BALANCE, value: formatCoins(balance), inline: true },
        { name: FIELD_CARDS, value: this.formatCards(), inline: false }
      );
  }

  private buildLossEmbed(customMessage?: string): EmbedBuilder {
    const message = customMessage || 'You **lost**. The house takes your bet.';
    return new EmbedBuilder()
      .setTitle(EMBED_TITLE)
      .setDescription(`**Player:** ${this.player.toString()}\n\n**Round ${this.state.stage}**\n\n❌ ${message}`)
      .setColor(COLOR_LOSS)
      .addFields(
        { name: FIELD_BET, value: formatCoins(this.baseBet), inline: true },
        { name: FIELD_FINAL_PAYOUT, value: formatCoins(0), inline: true },
        { name: FIELD_BALANCE, value: formatCoins(this.state.balance), inline: true },
        { name: FIELD_CARDS, value: this.formatCards(), inline: false }
      );
  }

  private buildCashoutEmbed(payout: number, balance: number): EmbedBuilder {
    return new EmbedBuilder()
      .setTitle(EMBED_TITLE)
      .setDescription(
        `**Player:** ${this.player.toString()}\n\nYou chose to **cash out**.\n\n**Final Multiplier**: 🪙x${this.state.multiplier}`
      )
      .setColor(COLOR_WIN)
      .addFields(
        { name: FIELD_BET, value: formatCoins(this.baseBet), inline: true },
        { name: FIELD_FINAL_PAYOUT, value: formatCoins(payout), inline: true },
        { name: FIELD_BALANCE, value: formatCoins(balance), inline: true },
        { name: FIELD_CARDS, value: this.formatCards(), inline: false }
      );
  }

  // ========== Button Builders ==========

  private buildRoundButtons(): ActionRowBuilder<ButtonBuilder> {
    switch (this.state.stage) {
      case 1:
        return new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(BTN_ID_RED).setLabel('🟥 Red').setStyle(ButtonStyle.Danger),
          new ButtonBuilder().setCustomId(BTN_ID_BLACK).setLabel('⬛ Black').setStyle(ButtonStyle.Secondary)
        );
      case 2:
        return new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(BTN_ID_HIGHER).setLabel('⬆️ Higher').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId(BTN_ID_LOWER).setLabel('⬇️ Lower').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId(BTN_ID_CASHOUT).setLabel('💰 Cashout').setStyle(ButtonStyle.Success)
        );
      case 3:
        return new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(BTN_ID_INSIDE).setLabel('⬛ Inside').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId(BTN_ID_OUTSIDE).setLabel('⬜ Outside').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId(BTN_ID_CASHOUT).setLabel('💰 Cashout').setStyle(ButtonStyle.Success)
        );
      case 4:
        return new ActionRowBuilder<ButtonBuilder>().addComponents(
          new ButtonBuilder().setCustomId(BTN_ID_SPADES).setLabel('♠️ Spades').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId(BTN_ID_HEARTS).setLabel('♥️ Hearts').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId(BTN_ID_DIAMONDS).setLabel('♦️ Diamonds').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId(BTN_ID_CLUBS).setLabel('♣️ Clubs').setStyle(ButtonStyle.Primary),
          new ButtonBuilder().setCustomId(BTN_ID_CASHOUT).setLabel('💰 Cashout').setStyle(ButtonStyle.Success)
        );
      default:
        throw new Error(`Invalid round: ${this.state.stage}`);
    }
  }

  // ========== Card Formatting ==========

  private formatCards(): string {
    const cards = this.state.cards;
    if (cards.length === 0) return '❓ ❓ ❓ ❓';
    if (cards.length === 1) return `${this.deckService.formatCard(cards[0])} ❓ ❓ ❓`;
    if (cards.length === 2)
      return `${this.deckService.formatCard(cards[0])} ${this.deckService.formatCard(cards[1])} ❓ ❓`;
    if (cards.length === 3)
      return `${this.deckService.formatCard(cards[0])} ${this.deckService.formatCard(cards[1])} ${this.deckService.formatCard(cards[2])} ❓`;

    return cards.map((c) => this.deckService.formatCard(c)).join(' ');
  }

  // ========== Start Game ==========

  async start(interaction: ChatInputCommandInteraction): Promise<void> {
    const embed = this.buildRoundEmbed();
    const row = this.buildRoundButtons();

    this.message = await interaction.editReply({
      embeds: [embed],
      components: [row],
    });
  }
}

/**
 * RideTheBusService manages Ride the Bus game sessions
 */
export class RideTheBusService {
  private walletService: WalletService;
  private statsService: StatsService;
  private gameStateService: GameStateService;
  private deckService: DeckService;
  private activeSessions: Map<string, RideTheBusGame> = new Map();

  constructor(walletService: WalletService, statsService: StatsService, gameStateService: GameStateService) {
    this.walletService = walletService;
    this.statsService = statsService;
    this.gameStateService = gameStateService;
    this.deckService = new DeckService();
  }

  async startGame(interaction: ChatInputCommandInteraction, bet: number): Promise<Message | null> {
    const guildId = interaction.guildId!;
    const userId = interaction.user.id;

    if (bet < MIN_BET) {
      await interaction.reply({
        content: `Minimum bet is **${formatCoins(MIN_BET)}**.`,
        flags: MessageFlags.Ephemeral,
      });
      return null;
    }

    if (bet <= 0) {
      await interaction.reply({
        content: 'Bet must be a positive number.',
        flags: MessageFlags.Ephemeral,
      });
      return null;
    }

    // Check if user already has an active session
    if (await this.gameStateService.hasActiveGame(userId, guildId, GameSource.RIDE_THE_BUS)) {
      await interaction.reply({
        content: '🚫 You already have an active Ride the Bus game. Finish it before starting a new one.',
        flags: MessageFlags.Ephemeral,
      });
      return null;
    }

    const balance = await this.walletService.getBalance(userId, guildId);

    if (bet > balance) {
      await interaction.reply({
        content: `You don't have enough **Hog Coins** to make that bet.\nYour current balance is **${formatCoins(balance)}**.`,
        flags: MessageFlags.Ephemeral,
      });
      return null;
    }

    try {
      // Deduct bet upfront
      await this.walletService.updateBalance(userId, guildId, -bet, GameSource.RIDE_THE_BUS, UpdateType.BET_PLACED, {
        bet_amount: bet,
        round: 1,
      });

      // Start game in database
      await this.gameStateService.startGame(userId, guildId, GameSource.RIDE_THE_BUS, bet);

      // Get balance after bet deduction
      const balanceAfterBet = await this.walletService.getBalance(userId, guildId);

      // Create game instance with cleanup callback
      const game = new RideTheBusGame(
        interaction.user,
        guildId,
        bet,
        balanceAfterBet,
        this.walletService,
        this.statsService,
        this.deckService,
        async () => {
          this.activeSessions.delete(userId);
          await this.gameStateService.finishGame(userId, guildId, GameSource.RIDE_THE_BUS);
        }
      );

      this.activeSessions.set(userId, game);

      // Send initial embed
      await interaction.deferReply();
      await game.start(interaction);

      return game.getMessage();
    } catch (error) {
      logger.error('Error starting RTB game:', error);

      // Clean up
      this.activeSessions.delete(userId);
      await this.gameStateService.finishGame(userId, guildId, GameSource.RIDE_THE_BUS);

      // Refund the bet
      await this.walletService.updateBalance(userId, guildId, bet, GameSource.RIDE_THE_BUS, UpdateType.REFUND, {
        bet_amount: bet,
        reason: 'Game failed to start',
      });

      if (interaction.deferred) {
        await interaction.editReply({
          content: 'An error occurred while starting Ride the Bus. Your bet has been refunded. Please try again.',
        });
      } else {
        await interaction.reply({
          content: 'An error occurred while starting Ride the Bus. Your bet has been refunded. Please try again.',
          flags: MessageFlags.Ephemeral,
        });
      }
      return null;
    }
  }

  /**
   * Get an active game session for a user
   */
  getGame(userId: string): RideTheBusGame | undefined {
    return this.activeSessions.get(userId);
  }
}
