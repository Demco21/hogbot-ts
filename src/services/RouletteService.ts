/**
 * RouletteService - Handles American Roulette game logic
 *
 * Follows the same pattern as RideTheBusService:
 * - RouletteGame class manages a single game session
 * - RouletteService manages game sessions and provides entry point
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
import { safeLogger as logger } from '../lib/safe-logger.js';
import { formatCoins } from '../utils/utils.js';

/** Embed constants */
const EMBED_TITLE = '🎰 American Roulette';
const EMBED_TITLE_TIMEOUT = '🎰 American Roulette - Timed Out';
const EMBED_TITLE_CANCELLED = '🎰 American Roulette - Cancelled';

const COLOR_DEFAULT = 0x228b22; // Forest green
const COLOR_WIN = 0x00ff00;
const COLOR_LOSS = 0xff0000;
const COLOR_GREY = 0x808080;

/** Field names */
const FIELD_TOTAL_BET = 'Total Bet';
const FIELD_PAYOUT = 'Payout';
const FIELD_BALANCE = 'Balance';

/** Button IDs */
export const BTN_ID_RED = 'bet_red';
export const BTN_ID_BLACK = 'bet_black';
export const BTN_ID_ODD = 'bet_odd';
export const BTN_ID_EVEN = 'bet_even';
export const BTN_ID_LOW = 'bet_low';
export const BTN_ID_HIGH = 'bet_high';
export const BTN_ID_SPIN = 'spin';
export const BTN_ID_PICK_NUMBER = 'pick_number';
export const BTN_ID_CLEAR = 'clear';
export const BTN_ID_CANCEL = 'cancel';
export const BTN_ID_BACK = 'back_to_main';
export const BTN_ID_PAGE_GREEN = 'page_green';
export const BTN_ID_PAGE_1_12 = 'page_1-12';
export const BTN_ID_PAGE_13_24 = 'page_13-24';
export const BTN_ID_PAGE_25_36 = 'page_25-36';

/** Button labels */
const BTN_LABEL_RED = 'Red';
const BTN_LABEL_BLACK = 'Black';
const BTN_LABEL_ODD = 'Odd';
const BTN_LABEL_EVEN = 'Even';
const BTN_LABEL_LOW = 'Low 1-18';
const BTN_LABEL_HIGH = 'High 19-36';
const BTN_LABEL_SPIN = 'SPIN!';
const BTN_LABEL_SPINNING = 'Spinning...';
const BTN_LABEL_PICK = 'Pick #';
const BTN_LABEL_CLEAR = 'Clear';
const BTN_LABEL_CANCEL = 'Cancel';
const BTN_LABEL_BACK = 'Back';
const BTN_LABEL_GREEN = '0/00';
const BTN_LABEL_1_12 = '1-12';
const BTN_LABEL_13_24 = '13-24';
const BTN_LABEL_25_36 = '25-36';

/** Footer messages */
const FOOTER_BET_INFO = 'Straight pays 35:1';
const FOOTER_PLAY_AGAIN = 'Use /roulette to play again!';

/** Max bets per spin */
const MAX_BETS_PER_SPIN = 30;

/** Bet limits */
const MIN_BET = GAME_BET_LIMITS.ROULETTE.MIN;
const MAX_BET = GAME_BET_LIMITS.ROULETTE.MAX;

/** Stat keys for tracking roulette statistics */
const STAT_KEYS = {
  // Straight number wins
  STRAIGHT_WINS: 'straight_wins',

  // Wheel results (track actual spin outcomes)
  WHEEL_RED: 'wheel_red',
  WHEEL_BLACK: 'wheel_black',
  WHEEL_GREEN: 'wheel_green', // 0 and 00

  // User bet win rates
  BET_RED_WINS: 'bet_red_wins',
  BET_RED_LOSSES: 'bet_red_losses',
  BET_BLACK_WINS: 'bet_black_wins',
  BET_BLACK_LOSSES: 'bet_black_losses',
  BET_ODD_WINS: 'bet_odd_wins',
  BET_ODD_LOSSES: 'bet_odd_losses',
  BET_EVEN_WINS: 'bet_even_wins',
  BET_EVEN_LOSSES: 'bet_even_losses',
  BET_HIGH_WINS: 'bet_high_wins',
  BET_HIGH_LOSSES: 'bet_high_losses',
  BET_LOW_WINS: 'bet_low_wins',
  BET_LOW_LOSSES: 'bet_low_losses',
  BET_STRAIGHT_WINS: 'bet_straight_wins',
  BET_STRAIGHT_LOSSES: 'bet_straight_losses',
} as const;

/**
 * Roulette bet types
 */
export enum RouletteBetType {
  STRAIGHT = 'straight', // Single number (35:1)
  RED = 'red', // Red numbers (1:1)
  BLACK = 'black', // Black numbers (1:1)
  ODD = 'odd', // Odd numbers (1:1)
  EVEN = 'even', // Even numbers (1:1)
  LOW = 'low', // 1-18 (1:1)
  HIGH = 'high', // 19-36 (1:1)
}

/** Number picker page types */
export type NumberPickerPage = 'green' | '1-12' | '13-24' | '25-36' | null;

/** Represents a roulette number on the wheel */
export interface RouletteNumber {
  value: number | '00';
  color: 'red' | 'black' | 'green';
}

/** Represents a single bet placed by a player */
export interface RouletteBet {
  type: RouletteBetType;
  amount: number;
  numbers: (number | '00')[];
  payout: number;
  selection?: number | '00';
}

/** Result of evaluating a bet */
export interface BetResult {
  bet: RouletteBet;
  won: boolean;
  payout: number;
}

/** Roulette table layout */
const RED_NUMBERS: number[] = [1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36];
const BLACK_NUMBERS: number[] = [2, 4, 6, 8, 10, 11, 13, 15, 17, 20, 22, 24, 26, 28, 29, 31, 33, 35];
const GREEN_NUMBERS: (number | '00')[] = [0, '00'];

const COLUMN_1: number[] = [1, 4, 7, 10, 13, 16, 19, 22, 25, 28, 31, 34];
const COLUMN_2: number[] = [2, 5, 8, 11, 14, 17, 20, 23, 26, 29, 32, 35];
const COLUMN_3: number[] = [3, 6, 9, 12, 15, 18, 21, 24, 27, 30, 33, 36];

/** Payout multipliers */
const PAYOUTS: Record<RouletteBetType, number> = {
  [RouletteBetType.STRAIGHT]: 35,
  [RouletteBetType.RED]: 1,
  [RouletteBetType.BLACK]: 1,
  [RouletteBetType.ODD]: 1,
  [RouletteBetType.EVEN]: 1,
  [RouletteBetType.LOW]: 1,
  [RouletteBetType.HIGH]: 1,
};

/** Mutable game state */
interface GameState {
  bets: RouletteBet[];
  totalWagered: number;
  status: 'betting' | 'spinning' | 'finished';
  result?: RouletteNumber;
  numberPickerPage: NumberPickerPage;
  balance: number;
}

/**
 * RouletteGame manages a single roulette game session
 */
class RouletteGame {
  private player: User;
  private guildId: string;
  private baseBet: number;
  private walletService: WalletService;
  private statsService: StatsService;

  private state: GameState;
  private message: Message | null = null;
  private onGameEnd: (() => void) | null = null;

  constructor(
    player: User,
    guildId: string,
    baseBet: number,
    initialBalance: number,
    walletService: WalletService,
    statsService: StatsService,
    onGameEnd?: () => void
  ) {
    this.player = player;
    this.guildId = guildId;
    this.baseBet = baseBet;
    this.walletService = walletService;
    this.statsService = statsService;
    this.onGameEnd = onGameEnd || null;

    this.state = {
      bets: [],
      totalWagered: 0,
      status: 'betting',
      numberPickerPage: null,
      balance: initialBalance,
    };
  }

  // ========== Getters ==========

  getPlayerId(): string {
    return this.player.id;
  }

  getMessage(): Message | null {
    return this.message;
  }

  getBaseBet(): number {
    return this.baseBet;
  }

  getStatus(): 'betting' | 'spinning' | 'finished' {
    return this.state.status;
  }

  getBets(): RouletteBet[] {
    return this.state.bets;
  }

  getTotalWagered(): number {
    return this.state.totalWagered;
  }

  // ========== Cleanup ==========

  private cleanupSession(): void {
    if (this.onGameEnd) {
      this.onGameEnd();
    }
  }

  // ========== Number Utilities ==========

  private getNumberColor(num: number | '00'): 'red' | 'black' | 'green' {
    if (num === 0 || num === '00') return 'green';
    if (RED_NUMBERS.includes(num as number)) return 'red';
    return 'black';
  }

  private getCoveredNumbers(betType: RouletteBetType, selection?: number | '00'): (number | '00')[] {
    switch (betType) {
      case RouletteBetType.STRAIGHT:
        return selection !== undefined ? [selection] : [];
      case RouletteBetType.RED:
        return [...RED_NUMBERS];
      case RouletteBetType.BLACK:
        return [...BLACK_NUMBERS];
      case RouletteBetType.ODD:
        return Array.from({ length: 18 }, (_, i) => i * 2 + 1);
      case RouletteBetType.EVEN:
        return Array.from({ length: 18 }, (_, i) => (i + 1) * 2);
      case RouletteBetType.LOW:
        return Array.from({ length: 18 }, (_, i) => i + 1);
      case RouletteBetType.HIGH:
        return Array.from({ length: 18 }, (_, i) => i + 19);
      default:
        return [];
    }
  }

  private getPayoutMultiplier(betType: RouletteBetType): number {
    return PAYOUTS[betType];
  }

  private getBetTypeName(betType: RouletteBetType, selection?: number | '00'): string {
    switch (betType) {
      case RouletteBetType.STRAIGHT:
        return selection !== undefined ? `${selection}` : 'Straight';
      case RouletteBetType.RED:
        return 'Red';
      case RouletteBetType.BLACK:
        return 'Black';
      case RouletteBetType.ODD:
        return 'Odd';
      case RouletteBetType.EVEN:
        return 'Even';
      case RouletteBetType.LOW:
        return 'Low (1-18)';
      case RouletteBetType.HIGH:
        return 'High (19-36)';
      default:
        return betType;
    }
  }

  private getBetTypeEmoji(betType: RouletteBetType, selection?: number | '00'): string {
    switch (betType) {
      case RouletteBetType.STRAIGHT:
        if (selection !== undefined) {
          const color = this.getNumberColor(selection);
          return color === 'red' ? '🔴' : color === 'black' ? '⚫' : '🟢';
        }
        return '🎯';
      case RouletteBetType.RED:
        return '🔴';
      case RouletteBetType.BLACK:
        return '⚫';
      case RouletteBetType.ODD:
        return '1️⃣';
      case RouletteBetType.EVEN:
        return '2️⃣';
      case RouletteBetType.LOW:
        return '⬇️';
      case RouletteBetType.HIGH:
        return '⬆️';
      default:
        return '🎰';
    }
  }

  // ========== Wheel Operations ==========

  private spin(): RouletteNumber {
    const pocket = Math.floor(Math.random() * 38);
    if (pocket === 0) {
      return { value: 0, color: 'green' };
    } else if (pocket === 37) {
      return { value: '00', color: 'green' };
    } else {
      return { value: pocket, color: this.getNumberColor(pocket) };
    }
  }

  private generateSpinSequence(winner: RouletteNumber, totalFrames: number): RouletteNumber[] {
    const sequence: RouletteNumber[] = [];
    for (let i = 0; i < totalFrames - 1; i++) {
      sequence.push(this.spin());
    }
    sequence.push(winner);
    return sequence;
  }

  private formatWinningNumber(result: RouletteNumber): string {
    const colorEmoji = result.color === 'red' ? '🔴' : result.color === 'black' ? '⚫' : '🟢';
    return `${colorEmoji} **${result.value}** ${result.color.toUpperCase()}`;
  }

  // ========== Bet Evaluation ==========

  private evaluateBets(bets: RouletteBet[], result: RouletteNumber): BetResult[] {
    return bets.map((bet) => {
      const won = bet.numbers.some((num) => {
        if (num === '00' && result.value === '00') return true;
        if (num === result.value) return true;
        return false;
      });
      const payout = won ? bet.amount + bet.amount * bet.payout : 0;
      return { bet, won, payout };
    });
  }

  // ========== Board Display ==========

  private generateBoardDisplay(): string {
    const bettedNumbers = new Set<number | '00'>();
    for (const bet of this.state.bets) {
      if (bet.type === RouletteBetType.STRAIGHT && bet.selection !== undefined) {
        bettedNumbers.add(bet.selection);
      }
    }

    const fmt = (n: number | '00'): string => {
      const color = this.getNumberColor(n);
      const emoji = color === 'red' ? '🔴' : color === 'black' ? '⚫' : '🟢';
      const numStr = String(n).padStart(2);
      const display = bettedNumbers.has(n) ? `**${numStr}**` : numStr;
      return `${emoji}${display}`;
    };

    const lines: string[] = [];

    // Green numbers row
    lines.push(`${fmt(0)} ${fmt('00')}`);
    lines.push('');

    // Main grid
    const row1Numbers = COLUMN_3.slice(0, 6);
    const row1Numbers2 = COLUMN_3.slice(6);
    const row2Numbers = COLUMN_2.slice(0, 6);
    const row2Numbers2 = COLUMN_2.slice(6);
    const row3Numbers = COLUMN_1.slice(0, 6);
    const row3Numbers2 = COLUMN_1.slice(6);

    lines.push(row1Numbers.map((n) => fmt(n)).join(' '));
    lines.push(row2Numbers.map((n) => fmt(n)).join(' '));
    lines.push(row3Numbers.map((n) => fmt(n)).join(' '));
    lines.push('');
    lines.push(row1Numbers2.map((n) => fmt(n)).join(' '));
    lines.push(row2Numbers2.map((n) => fmt(n)).join(' '));
    lines.push(row3Numbers2.map((n) => fmt(n)).join(' '));

    return lines.join('\n');
  }

  private getBetList(): string {
    if (this.state.bets.length === 0) return '_None_';
    return this.state.bets
      .map((bet) => {
        const emoji = this.getBetTypeEmoji(bet.type, bet.selection);
        const name = this.getBetTypeName(bet.type, bet.selection);
        return `${emoji} ${name}`;
      })
      .join(', ');
  }

  // ========== Bet Management ==========

  private hasBetType(betType: RouletteBetType): boolean {
    return this.state.bets.some((b) => b.type === betType);
  }

  private getBettedNumbers(): Set<number | '00'> {
    const bettedNumbers = new Set<number | '00'>();
    for (const bet of this.state.bets) {
      if (bet.type === RouletteBetType.STRAIGHT && bet.selection !== undefined) {
        bettedNumbers.add(bet.selection);
      }
    }
    return bettedNumbers;
  }

  addBet(betType: RouletteBetType, selection?: number | '00'): RouletteBet | null {
    if (this.state.status !== 'betting') return null;
    if (this.state.bets.length >= MAX_BETS_PER_SPIN) return null;

    // Check for duplicate bets
    if (betType !== RouletteBetType.STRAIGHT) {
      if (this.hasBetType(betType)) return null;
    } else {
      const existingBet = this.state.bets.find((b) => b.type === RouletteBetType.STRAIGHT && b.selection === selection);
      if (existingBet) return null;
    }

    const bet: RouletteBet = {
      type: betType,
      amount: this.baseBet,
      numbers: this.getCoveredNumbers(betType, selection),
      payout: this.getPayoutMultiplier(betType),
      selection: betType === RouletteBetType.STRAIGHT ? selection : undefined,
    };

    this.state.bets.push(bet);
    this.state.totalWagered += bet.amount;

    return bet;
  }

  clearBets(): RouletteBet[] {
    if (this.state.status !== 'betting') return [];
    const clearedBets = [...this.state.bets];
    this.state.bets = [];
    this.state.totalWagered = 0;
    return clearedBets;
  }

  // ========== Player Actions ==========

  /**
   * Handle adding an outside bet (red, black, odd, even, low, high)
   */
  async handleOutsideBet(
    interaction: ButtonInteraction,
    betType: RouletteBetType
  ): Promise<void> {
    await interaction.deferUpdate();

    // Check balance
    const balance = await this.walletService.getBalance(this.player.id, this.guildId);
    if (balance < this.baseBet) {
      await interaction.followUp({
        content: `You don't have enough coins to place another bet. Balance: ${formatCoins(balance)}`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Deduct bet
    await this.walletService.updateBalance(
      this.player.id,
      this.guildId,
      -this.baseBet,
      GameSource.ROULETTE,
      UpdateType.BET_PLACED,
      { bet_type: betType, bet_amount: this.baseBet }
    );

    // Add bet to game
    const bet = this.addBet(betType);
    if (!bet) {
      // Refund if bet couldn't be added
      await this.walletService.updateBalance(
        this.player.id,
        this.guildId,
        this.baseBet,
        GameSource.ROULETTE,
        UpdateType.REFUND,
        { bet_type: betType, bet_amount: this.baseBet, reason: 'bet_failed' }
      );
      return;
    }

    // Update balance in state
    this.state.balance = await this.walletService.getBalance(this.player.id, this.guildId);

    // Update UI
    const embed = this.buildBettingEmbed();
    const components = this.buildBettingComponents();
    await interaction.editReply({ embeds: [embed], components });
  }

  /**
   * Handle adding a straight bet (specific number)
   */
  async handleStraightBet(
    interaction: ButtonInteraction,
    number: number | '00'
  ): Promise<void> {
    await interaction.deferUpdate();

    // Check balance
    const balance = await this.walletService.getBalance(this.player.id, this.guildId);
    if (balance < this.baseBet) {
      await interaction.followUp({
        content: `You don't have enough coins to place another bet. Balance: ${formatCoins(balance)}`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Deduct bet
    await this.walletService.updateBalance(
      this.player.id,
      this.guildId,
      -this.baseBet,
      GameSource.ROULETTE,
      UpdateType.BET_PLACED,
      { bet_type: RouletteBetType.STRAIGHT, bet_amount: this.baseBet, number: number }
    );

    // Add bet to game
    const bet = this.addBet(RouletteBetType.STRAIGHT, number);
    if (!bet) {
      // Refund if bet couldn't be added
      await this.walletService.updateBalance(
        this.player.id,
        this.guildId,
        this.baseBet,
        GameSource.ROULETTE,
        UpdateType.REFUND,
        { bet_type: RouletteBetType.STRAIGHT, bet_amount: this.baseBet, reason: 'bet_failed' }
      );
      return;
    }

    // Update balance in state
    this.state.balance = await this.walletService.getBalance(this.player.id, this.guildId);

    // Stay on current number picker page
    const currentPage = this.state.numberPickerPage ?? '1-12';
    const embed = this.buildBettingEmbed();
    const components = this.buildNumberPickerComponents(currentPage);
    await interaction.editReply({ embeds: [embed], components });
  }

  /**
   * Handle opening number picker
   */
  async handlePickNumber(interaction: ButtonInteraction): Promise<void> {
    await interaction.deferUpdate();
    this.state.numberPickerPage = '1-12';

    const embed = this.buildBettingEmbed();
    const components = this.buildNumberPickerComponents('1-12');
    await interaction.editReply({ embeds: [embed], components });
  }

  /**
   * Handle page navigation in number picker
   */
  async handlePageNavigation(interaction: ButtonInteraction, page: NumberPickerPage): Promise<void> {
    await interaction.deferUpdate();
    this.state.numberPickerPage = page;

    const embed = this.buildBettingEmbed();
    const components = page ? this.buildNumberPickerComponents(page) : this.buildBettingComponents();
    await interaction.editReply({ embeds: [embed], components });
  }

  /**
   * Handle back to main betting view
   */
  async handleBackToMain(interaction: ButtonInteraction): Promise<void> {
    await interaction.deferUpdate();
    this.state.numberPickerPage = null;

    const embed = this.buildBettingEmbed();
    const components = this.buildBettingComponents();
    await interaction.editReply({ embeds: [embed], components });
  }

  /**
   * Handle clearing all bets
   */
  async handleClear(interaction: ButtonInteraction): Promise<void> {
    await interaction.deferUpdate();

    // Refund all bets
    const clearedBets = this.clearBets();
    for (const bet of clearedBets) {
      await this.walletService.updateBalance(
        this.player.id,
        this.guildId,
        bet.amount,
        GameSource.ROULETTE,
        UpdateType.REFUND,
        { bet_type: bet.type, bet_amount: bet.amount, reason: 'cleared' }
      );
    }

    // Update balance in state
    this.state.balance = await this.walletService.getBalance(this.player.id, this.guildId);

    // Update UI
    const embed = this.buildBettingEmbed();
    const components = this.buildBettingComponents();
    await interaction.editReply({ embeds: [embed], components });
  }

  /**
   * Handle cancelling the game
   * Returns true to indicate game ended
   */
  async handleCancel(interaction: ButtonInteraction): Promise<boolean> {
    await interaction.deferUpdate();

    // Refund all bets
    for (const bet of this.state.bets) {
      await this.walletService.updateBalance(
        this.player.id,
        this.guildId,
        bet.amount,
        GameSource.ROULETTE,
        UpdateType.REFUND,
        { bet_type: bet.type, bet_amount: bet.amount, reason: 'cancelled' }
      );
    }

    const balance = await this.walletService.getBalance(this.player.id, this.guildId);
    const embed = this.buildCancelledEmbed(balance);
    await interaction.editReply({ embeds: [embed], components: [] });

    this.cleanupSession();
    return true;
  }

  /**
   * Handle spinning the wheel
   * Returns true to indicate game ended
   */
  async handleSpin(interaction: ButtonInteraction): Promise<boolean> {
    await interaction.deferUpdate();

    // Store bet info before game state changes
    const totalBet = this.state.totalWagered;
    const bets = this.state.bets.map((b) => ({ type: b.type, selection: b.selection }));

    // Set status to spinning
    this.state.status = 'spinning';

    // Get final result BEFORE animation
    const result = this.spin();

    // Disable all buttons during spin
    await interaction.editReply({ components: this.buildDisabledComponents() });

    // Run animation
    await this.animateWheelSpin(interaction, result);

    // Evaluate bets
    const betResults = this.evaluateBets(this.state.bets, result);

    // Build extra stats for this spin
    const extraStats: Record<string, number> = {};

    // Track wheel result distribution (once per spin)
    const resultValue = result.value === '00' ? 37 : (result.value as number);
    if (resultValue === 0 || resultValue === 37) {
      extraStats[STAT_KEYS.WHEEL_GREEN] = 1;
    } else {
      // Red/Black
      extraStats[RED_NUMBERS.includes(resultValue) ? STAT_KEYS.WHEEL_RED : STAT_KEYS.WHEEL_BLACK] = 1;
    }

    // Log transactions and track bet-specific wins/losses
    let totalPayout = 0;
    let anyBetWon = false;

    for (const br of betResults) {
      // Track bet-specific wins/losses
      this.trackBetStats(extraStats, br.bet.type, br.won);

      if (br.won) {
        anyBetWon = true;
        totalPayout += br.payout;
        await this.walletService.updateBalance(
          this.player.id,
          this.guildId,
          br.payout,
          GameSource.ROULETTE,
          UpdateType.BET_WON,
          {
            bet_type: br.bet.type,
            bet_amount: br.bet.amount,
            payout_amount: br.payout,
            winning_number: result.value,
            multiplier: br.bet.payout,
          }
        );
      } else {
        await this.walletService.logTransaction(
          this.player.id,
          this.guildId,
          GameSource.ROULETTE,
          UpdateType.BET_LOST,
          {
            bet_type: br.bet.type,
            bet_amount: br.bet.amount,
            payout_amount: 0,
            winning_number: result.value,
          }
        );
      }
    }

    // Update game stats once per spin with aggregated extra stats
    await this.statsService.updateGameStats(
      this.player.id,
      this.guildId,
      GameSource.ROULETTE,
      anyBetWon,
      totalBet,
      totalPayout,
      extraStats
    );

    // Mark game as finished
    this.state.status = 'finished';
    this.state.result = result;

    // Get new balance
    const newBalance = await this.walletService.getBalance(this.player.id, this.guildId);

    // Show result
    const resultEmbed = this.buildResultEmbed(result, totalBet, totalPayout, newBalance, bets);
    await interaction.editReply({ embeds: [resultEmbed], components: [] });

    this.cleanupSession();
    return true;
  }

  /**
   * Track bet-specific stats based on bet type and outcome
   */
  private trackBetStats(extraStats: Record<string, number>, betType: RouletteBetType, won: boolean): void {
    switch (betType) {
      case RouletteBetType.RED:
        extraStats[won ? STAT_KEYS.BET_RED_WINS : STAT_KEYS.BET_RED_LOSSES] =
          (extraStats[won ? STAT_KEYS.BET_RED_WINS : STAT_KEYS.BET_RED_LOSSES] || 0) + 1;
        break;
      case RouletteBetType.BLACK:
        extraStats[won ? STAT_KEYS.BET_BLACK_WINS : STAT_KEYS.BET_BLACK_LOSSES] =
          (extraStats[won ? STAT_KEYS.BET_BLACK_WINS : STAT_KEYS.BET_BLACK_LOSSES] || 0) + 1;
        break;
      case RouletteBetType.ODD:
        extraStats[won ? STAT_KEYS.BET_ODD_WINS : STAT_KEYS.BET_ODD_LOSSES] =
          (extraStats[won ? STAT_KEYS.BET_ODD_WINS : STAT_KEYS.BET_ODD_LOSSES] || 0) + 1;
        break;
      case RouletteBetType.EVEN:
        extraStats[won ? STAT_KEYS.BET_EVEN_WINS : STAT_KEYS.BET_EVEN_LOSSES] =
          (extraStats[won ? STAT_KEYS.BET_EVEN_WINS : STAT_KEYS.BET_EVEN_LOSSES] || 0) + 1;
        break;
      case RouletteBetType.HIGH:
        extraStats[won ? STAT_KEYS.BET_HIGH_WINS : STAT_KEYS.BET_HIGH_LOSSES] =
          (extraStats[won ? STAT_KEYS.BET_HIGH_WINS : STAT_KEYS.BET_HIGH_LOSSES] || 0) + 1;
        break;
      case RouletteBetType.LOW:
        extraStats[won ? STAT_KEYS.BET_LOW_WINS : STAT_KEYS.BET_LOW_LOSSES] =
          (extraStats[won ? STAT_KEYS.BET_LOW_WINS : STAT_KEYS.BET_LOW_LOSSES] || 0) + 1;
        break;
      case RouletteBetType.STRAIGHT:
        extraStats[won ? STAT_KEYS.BET_STRAIGHT_WINS : STAT_KEYS.BET_STRAIGHT_LOSSES] =
          (extraStats[won ? STAT_KEYS.BET_STRAIGHT_WINS : STAT_KEYS.BET_STRAIGHT_LOSSES] || 0) + 1;
        if (won) {
          extraStats[STAT_KEYS.STRAIGHT_WINS] = (extraStats[STAT_KEYS.STRAIGHT_WINS] || 0) + 1;
        }
        break;
    }
  }

  /**
   * Handle game timeout
   */
  async handleTimeout(interaction: ChatInputCommandInteraction): Promise<void> {
    if (this.state.status === 'betting') {
      // Refund all placed bets
      for (const bet of this.state.bets) {
        await this.walletService.updateBalance(
          this.player.id,
          this.guildId,
          bet.amount,
          GameSource.ROULETTE,
          UpdateType.REFUND,
          { bet_type: bet.type, bet_amount: bet.amount, reason: 'timeout' }
        );
      }

      // Update the embed to show timeout
      const balance = await this.walletService.getBalance(this.player.id, this.guildId);
      const embed = this.buildTimeoutEmbed(balance);
      await interaction.editReply({ embeds: [embed], components: [] });
    }

    this.cleanupSession();
  }

  // ========== Animation ==========

  private async animateWheelSpin(interaction: ButtonInteraction, winningNumber: RouletteNumber): Promise<void> {
    const totalFrames = 12 + Math.floor(Math.random() * 6);
    const spinSequence = this.generateSpinSequence(winningNumber, totalFrames);

    const betList = this.getBetList();
    const boardDisplay = this.generateBoardDisplay();

    for (let frame = 0; frame < totalFrames; frame++) {
      const currentNumber = spinSequence[frame];
      const colorEmoji = currentNumber.color === 'red' ? '🔴' : currentNumber.color === 'black' ? '⚫' : '🟢';
      const spinStatus = `_Spinning..._ ${colorEmoji} **${currentNumber.value}**`;

      const embed = new EmbedBuilder()
        .setTitle(EMBED_TITLE)
        .setColor(COLOR_DEFAULT)
        .setDescription(
          `**Player:** ${this.player.toString()}\n\n` +
            `${boardDisplay}\n\n` +
            `**Active Bets:** ${betList}\n\n` +
            spinStatus
        )
        .addFields(
          { name: FIELD_TOTAL_BET, value: formatCoins(this.state.totalWagered), inline: true },
          { name: FIELD_BALANCE, value: formatCoins(this.state.balance), inline: true }
        );

      await interaction.editReply({ embeds: [embed], components: this.buildDisabledComponents() });

      const baseDelay = frame < 4 ? 150 : frame < totalFrames - 4 ? 250 : 350;
      const jitter = Math.random() * 80 - 40;
      await this.sleep(baseDelay + frame * 15 + jitter);
    }

    // Final dramatic pause
    await this.sleep(500 + Math.random() * 300);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ========== Embed Builders ==========

  private buildBettingEmbed(): EmbedBuilder {
    const betList = this.getBetList();
    const boardDisplay = this.generateBoardDisplay();

    return new EmbedBuilder()
      .setTitle(EMBED_TITLE)
      .setColor(COLOR_DEFAULT)
      .setDescription(
        `**Player:** ${this.player.toString()}\n\n` +
          `${boardDisplay}\n\n` +
          `**Active Bets:** ${betList}`
      )
      .addFields(
        { name: FIELD_TOTAL_BET, value: formatCoins(this.state.totalWagered), inline: true },
        { name: FIELD_BALANCE, value: formatCoins(this.state.balance), inline: true }
      )
      .setFooter({ text: `Each bet: ${formatCoins(this.baseBet)} | Max ${MAX_BETS_PER_SPIN} bets | ${FOOTER_BET_INFO}` });
  }

  private buildResultEmbed(
    result: RouletteNumber,
    totalBet: number,
    totalPayout: number,
    newBalance: number,
    bets: { type: RouletteBetType; selection?: number | '00' }[]
  ): EmbedBuilder {
    const winningNumber = this.formatWinningNumber(result);
    const betList =
      bets.length > 0
        ? bets.map((bet) => `${this.getBetTypeEmoji(bet.type, bet.selection)} ${this.getBetTypeName(bet.type, bet.selection)}`).join(', ')
        : '_None_';
    const boardDisplay = this.generateBoardDisplay();
    const color = totalPayout > 0 ? COLOR_WIN : COLOR_LOSS;

    return new EmbedBuilder()
      .setTitle(EMBED_TITLE)
      .setColor(color)
      .setDescription(
        `**Player:** ${this.player.toString()}\n\n` +
          `${boardDisplay}\n\n` +
          `**Active Bets:** ${betList}\n\n` +
          `The ball lands on... ${winningNumber}`
      )
      .addFields(
        { name: FIELD_TOTAL_BET, value: formatCoins(totalBet), inline: true },
        { name: FIELD_PAYOUT, value: formatCoins(totalPayout), inline: true },
        { name: FIELD_BALANCE, value: formatCoins(newBalance), inline: true }
      )
      .setFooter({ text: FOOTER_PLAY_AGAIN });
  }

  private buildTimeoutEmbed(balance: number): EmbedBuilder {
    return new EmbedBuilder()
      .setTitle(EMBED_TITLE_TIMEOUT)
      .setColor(COLOR_GREY)
      .setDescription(
        `**Player:** ${this.player.toString()}\n\n` +
          `Game timed out. Your bets have been refunded.\n\n` +
          `**Balance:** ${formatCoins(balance)}`
      )
      .setFooter({ text: FOOTER_PLAY_AGAIN });
  }

  private buildCancelledEmbed(balance: number): EmbedBuilder {
    return new EmbedBuilder()
      .setTitle(EMBED_TITLE_CANCELLED)
      .setColor(COLOR_GREY)
      .setDescription(
        `**Player:** ${this.player.toString()}\n\n` +
          `Game cancelled. Your bets have been refunded.\n\n` +
          `**Balance:** ${formatCoins(balance)}`
      )
      .setFooter({ text: FOOTER_PLAY_AGAIN });
  }

  // ========== Button Builders ==========

  private buildBettingComponents(): ActionRowBuilder<ButtonBuilder>[] {
    const hasBets = this.state.bets.length > 0;
    const canAddMore = this.state.bets.length < MAX_BETS_PER_SPIN;

    // Row 1: Color/Parity bets + Spin
    const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(BTN_ID_RED)
        .setLabel(BTN_LABEL_RED)
        .setStyle(ButtonStyle.Danger)
        .setDisabled(!canAddMore || this.hasBetType(RouletteBetType.RED)),
      new ButtonBuilder()
        .setCustomId(BTN_ID_BLACK)
        .setLabel(BTN_LABEL_BLACK)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(!canAddMore || this.hasBetType(RouletteBetType.BLACK)),
      new ButtonBuilder()
        .setCustomId(BTN_ID_ODD)
        .setLabel(BTN_LABEL_ODD)
        .setStyle(ButtonStyle.Primary)
        .setDisabled(!canAddMore || this.hasBetType(RouletteBetType.ODD)),
      new ButtonBuilder()
        .setCustomId(BTN_ID_EVEN)
        .setLabel(BTN_LABEL_EVEN)
        .setStyle(ButtonStyle.Primary)
        .setDisabled(!canAddMore || this.hasBetType(RouletteBetType.EVEN)),
      new ButtonBuilder()
        .setCustomId(BTN_ID_SPIN)
        .setLabel(BTN_LABEL_SPIN)
        .setStyle(ButtonStyle.Success)
        .setDisabled(!hasBets)
    );

    // Row 2: Range bets + Pick # + Controls
    const row2 = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(BTN_ID_LOW)
        .setLabel(BTN_LABEL_LOW)
        .setStyle(ButtonStyle.Primary)
        .setDisabled(!canAddMore || this.hasBetType(RouletteBetType.LOW)),
      new ButtonBuilder()
        .setCustomId(BTN_ID_HIGH)
        .setLabel(BTN_LABEL_HIGH)
        .setStyle(ButtonStyle.Primary)
        .setDisabled(!canAddMore || this.hasBetType(RouletteBetType.HIGH)),
      new ButtonBuilder()
        .setCustomId(BTN_ID_PICK_NUMBER)
        .setLabel(BTN_LABEL_PICK)
        .setStyle(ButtonStyle.Primary)
        .setDisabled(!canAddMore),
      new ButtonBuilder()
        .setCustomId(BTN_ID_CLEAR)
        .setLabel(BTN_LABEL_CLEAR)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(!hasBets),
      new ButtonBuilder()
        .setCustomId(BTN_ID_CANCEL)
        .setLabel(BTN_LABEL_CANCEL)
        .setStyle(ButtonStyle.Danger)
    );

    return [row1, row2];
  }

  private buildNumberPickerComponents(page: NumberPickerPage): ActionRowBuilder<ButtonBuilder>[] {
    const bettedNumbers = this.getBettedNumbers();
    const canAddMore = this.state.bets.length < MAX_BETS_PER_SPIN;

    // Row 1: Page navigation tabs
    // All tabs are blue (Primary), selected tab has arrow indicator
    const navRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(BTN_ID_PAGE_GREEN)
        .setLabel(page === 'green' ? `▸ ${BTN_LABEL_GREEN}` : BTN_LABEL_GREEN)
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(BTN_ID_PAGE_1_12)
        .setLabel(page === '1-12' ? `▸ ${BTN_LABEL_1_12}` : BTN_LABEL_1_12)
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(BTN_ID_PAGE_13_24)
        .setLabel(page === '13-24' ? `▸ ${BTN_LABEL_13_24}` : BTN_LABEL_13_24)
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(BTN_ID_PAGE_25_36)
        .setLabel(page === '25-36' ? `▸ ${BTN_LABEL_25_36}` : BTN_LABEL_25_36)
        .setStyle(ButtonStyle.Primary),
      new ButtonBuilder()
        .setCustomId(BTN_ID_BACK)
        .setLabel(BTN_LABEL_BACK)
        .setStyle(ButtonStyle.Danger)
    );

    const rows: ActionRowBuilder<ButtonBuilder>[] = [navRow];

    if (page === 'green') {
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
      const startNum = page === '1-12' ? 1 : page === '13-24' ? 13 : 25;

      for (let rowNum = 0; rowNum < 3; rowNum++) {
        const rowButtons: ButtonBuilder[] = [];
        for (let col = 0; col < 4; col++) {
          const num = startNum + rowNum * 4 + col;
          const color = this.getNumberColor(num);
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

  private buildDisabledComponents(): ActionRowBuilder<ButtonBuilder>[] {
    const row1 = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(BTN_ID_RED)
        .setLabel(BTN_LABEL_RED)
        .setStyle(ButtonStyle.Danger)
        .setDisabled(true),
      new ButtonBuilder()
        .setCustomId(BTN_ID_BLACK)
        .setLabel(BTN_LABEL_BLACK)
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(true),
      new ButtonBuilder()
        .setCustomId(BTN_ID_ODD)
        .setLabel(BTN_LABEL_ODD)
        .setStyle(ButtonStyle.Primary)
        .setDisabled(true),
      new ButtonBuilder()
        .setCustomId(BTN_ID_EVEN)
        .setLabel(BTN_LABEL_EVEN)
        .setStyle(ButtonStyle.Primary)
        .setDisabled(true),
      new ButtonBuilder()
        .setCustomId(BTN_ID_SPIN)
        .setLabel(BTN_LABEL_SPINNING)
        .setStyle(ButtonStyle.Success)
        .setDisabled(true)
    );

    return [row1];
  }

  // ========== Start Game ==========

  async start(interaction: ChatInputCommandInteraction): Promise<void> {
    const embed = this.buildBettingEmbed();
    const components = this.buildBettingComponents();

    this.message = await interaction.editReply({
      embeds: [embed],
      components,
    });
  }
}

/**
 * RouletteService manages American Roulette game sessions
 */
export class RouletteService {
  static readonly MIN_BET = MIN_BET;
  static readonly MAX_BET = MAX_BET;
  static readonly MAX_BETS_PER_SPIN = MAX_BETS_PER_SPIN;

  private walletService: WalletService;
  private statsService: StatsService;
  private gameStateService: GameStateService;
  private activeSessions: Map<string, RouletteGame> = new Map();

  constructor(walletService: WalletService, statsService: StatsService, gameStateService: GameStateService) {
    this.walletService = walletService;
    this.statsService = statsService;
    this.gameStateService = gameStateService;
  }

  private getSessionKey(userId: string, guildId: string): string {
    return `${guildId}:${userId}`;
  }

  async startGame(interaction: ChatInputCommandInteraction, baseBet: number): Promise<Message | null> {
    const guildId = interaction.guildId!;
    const userId = interaction.user.id;

    if (baseBet < MIN_BET) {
      await interaction.reply({
        content: `Minimum bet is **${formatCoins(MIN_BET)}**.`,
        flags: MessageFlags.Ephemeral,
      });
      return null;
    }

    if (baseBet > MAX_BET) {
      await interaction.reply({
        content: `Maximum bet is **${formatCoins(MAX_BET)}**.`,
        flags: MessageFlags.Ephemeral,
      });
      return null;
    }

    // Check if user already has an active session
    if (await this.gameStateService.hasActiveGame(userId, guildId, GameSource.ROULETTE)) {
      await interaction.reply({
        content: '🚫 You already have an active roulette game. Finish it before starting a new one.',
        flags: MessageFlags.Ephemeral,
      });
      return null;
    }

    const balance = await this.walletService.getBalance(userId, guildId);

    if (baseBet > balance) {
      await interaction.reply({
        content: `You don't have enough **Hog Coins** to play. Your current balance is **${formatCoins(balance)}**, but the minimum bet is **${formatCoins(baseBet)}**.\nTry /beg to get some coins.`,
        flags: MessageFlags.Ephemeral,
      });
      return null;
    }

    try {
      // Defer reply before processing
      await interaction.deferReply();

      // Start game in database
      await this.gameStateService.startGame(userId, guildId, GameSource.ROULETTE, baseBet);

      // Create game instance with cleanup callback
      const sessionKey = this.getSessionKey(userId, guildId);
      const game = new RouletteGame(
        interaction.user,
        guildId,
        baseBet,
        balance,
        this.walletService,
        this.statsService,
        async () => {
          this.activeSessions.delete(sessionKey);
          await this.gameStateService.finishGame(userId, guildId, GameSource.ROULETTE);
        }
      );

      this.activeSessions.set(sessionKey, game);

      // Send initial embed
      await game.start(interaction);

      return game.getMessage();
    } catch (error) {
      logger.error('Error starting roulette game:', error);

      // Clean up
      const sessionKey = this.getSessionKey(userId, guildId);
      this.activeSessions.delete(sessionKey);
      await this.gameStateService.finishGame(userId, guildId, GameSource.ROULETTE);

      if (interaction.deferred) {
        await interaction.editReply({
          content: 'An error occurred while starting roulette. Please try again.',
        });
      } else {
        await interaction.reply({
          content: 'An error occurred while starting roulette. Please try again.',
          flags: MessageFlags.Ephemeral,
        });
      }
      return null;
    }
  }

  /**
   * Get an active game session for a user
   */
  getGame(userId: string, guildId: string): RouletteGame | undefined {
    const sessionKey = this.getSessionKey(userId, guildId);
    return this.activeSessions.get(sessionKey);
  }

  /**
   * End a game session
   */
  endGame(userId: string, guildId: string): void {
    const sessionKey = this.getSessionKey(userId, guildId);
    this.activeSessions.delete(sessionKey);
  }
}
