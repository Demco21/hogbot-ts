import { GAME_BET_LIMITS } from '../constants.js';

/**
 * Roulette bet types
 */
export enum RouletteBetType {
  // Inside bets
  STRAIGHT = 'straight', // Single number (35:1)

  // Outside bets
  RED = 'red', // Red numbers (1:1)
  BLACK = 'black', // Black numbers (1:1)
  ODD = 'odd', // Odd numbers (1:1)
  EVEN = 'even', // Even numbers (1:1)
  LOW = 'low', // 1-18 (1:1)
  HIGH = 'high', // 19-36 (1:1)
}

/**
 * Number picker page types
 */
export type NumberPickerPage = 'green' | '1-12' | '13-24' | '25-36' | null;

/**
 * Represents a roulette number on the wheel
 */
export interface RouletteNumber {
  value: number | '00';
  color: 'red' | 'black' | 'green';
}

/**
 * Represents a single bet placed by a player
 */
export interface RouletteBet {
  type: RouletteBetType;
  amount: number;
  numbers: (number | '00')[]; // Numbers covered by this bet
  payout: number; // Payout multiplier (e.g., 35 for straight)
  selection?: number | '00'; // For straight bets, the specific number
}

/**
 * Result of evaluating a bet
 */
export interface BetResult {
  bet: RouletteBet;
  won: boolean;
  payout: number; // Actual payout amount (0 if lost)
}

/**
 * Represents an active roulette game session
 */
export interface RouletteGame {
  odUserId: string;
  guildId: string;
  baseBet: number;
  bets: RouletteBet[];
  totalWagered: number;
  status: 'betting' | 'spinning' | 'finished';
  result?: RouletteNumber;
  numberPickerPage: NumberPickerPage; // Current number picker page, null = main betting view
}

/**
 * RouletteService handles all roulette game logic
 */
export class RouletteService {
  static readonly MIN_BET = GAME_BET_LIMITS.ROULETTE.MIN;
  static readonly MAX_BET = GAME_BET_LIMITS.ROULETTE.MAX;
  static readonly MAX_BETS_PER_SPIN = 10;

  // American roulette wheel - 38 pockets
  static readonly RED_NUMBERS: number[] = [1, 3, 5, 7, 9, 12, 14, 16, 18, 19, 21, 23, 25, 27, 30, 32, 34, 36];
  static readonly BLACK_NUMBERS: number[] = [2, 4, 6, 8, 10, 11, 13, 15, 17, 20, 22, 24, 26, 28, 29, 31, 33, 35];
  static readonly GREEN_NUMBERS: (number | '00')[] = [0, '00'];

  // Column definitions
  static readonly COLUMN_1: number[] = [1, 4, 7, 10, 13, 16, 19, 22, 25, 28, 31, 34];
  static readonly COLUMN_2: number[] = [2, 5, 8, 11, 14, 17, 20, 23, 26, 29, 32, 35];
  static readonly COLUMN_3: number[] = [3, 6, 9, 12, 15, 18, 21, 24, 27, 30, 33, 36];

  // Payout multipliers (not including original bet)
  static readonly PAYOUTS: Record<RouletteBetType, number> = {
    [RouletteBetType.STRAIGHT]: 35,
    [RouletteBetType.RED]: 1,
    [RouletteBetType.BLACK]: 1,
    [RouletteBetType.ODD]: 1,
    [RouletteBetType.EVEN]: 1,
    [RouletteBetType.LOW]: 1,
    [RouletteBetType.HIGH]: 1,
  };

  // Active game sessions
  private activeSessions: Map<string, RouletteGame> = new Map();

  /**
   * Generate session key from user and guild
   */
  private getSessionKey(userId: string, guildId: string): string {
    return `${guildId}:${userId}`;
  }

  /**
   * Get the color of a roulette number
   */
  getNumberColor(num: number | '00'): 'red' | 'black' | 'green' {
    if (num === 0 || num === '00') return 'green';
    if (RouletteService.RED_NUMBERS.includes(num as number)) return 'red';
    return 'black';
  }

  /**
   * Get the numbers covered by a bet type
   */
  getCoveredNumbers(betType: RouletteBetType, selection?: number | '00'): (number | '00')[] {
    switch (betType) {
      case RouletteBetType.STRAIGHT:
        return selection !== undefined ? [selection] : [];

      case RouletteBetType.RED:
        return [...RouletteService.RED_NUMBERS];

      case RouletteBetType.BLACK:
        return [...RouletteService.BLACK_NUMBERS];

      case RouletteBetType.ODD:
        return Array.from({ length: 18 }, (_, i) => i * 2 + 1); // 1,3,5,...,35

      case RouletteBetType.EVEN:
        return Array.from({ length: 18 }, (_, i) => (i + 1) * 2); // 2,4,6,...,36

      case RouletteBetType.LOW:
        return Array.from({ length: 18 }, (_, i) => i + 1); // 1-18

      case RouletteBetType.HIGH:
        return Array.from({ length: 18 }, (_, i) => i + 19); // 19-36

      default:
        return [];
    }
  }

  /**
   * Get payout multiplier for a bet type
   */
  getPayoutMultiplier(betType: RouletteBetType): number {
    return RouletteService.PAYOUTS[betType];
  }

  /**
   * Get display name for a bet type
   */
  getBetTypeName(betType: RouletteBetType, selection?: number | '00'): string {
    switch (betType) {
      case RouletteBetType.STRAIGHT:
        return selection !== undefined ? `#${selection}` : 'Straight';
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

  /**
   * Get emoji for a bet type
   */
  getBetTypeEmoji(betType: RouletteBetType, selection?: number | '00'): string {
    switch (betType) {
      case RouletteBetType.STRAIGHT:
        // Return color emoji for straight bets
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

  /**
   * Spin the wheel - returns a random roulette number
   */
  spin(): RouletteNumber {
    // 38 pockets: 0, 00, 1-36
    const pocket = Math.floor(Math.random() * 38);

    if (pocket === 0) {
      return { value: 0, color: 'green' };
    } else if (pocket === 37) {
      return { value: '00', color: 'green' };
    } else {
      return { value: pocket, color: this.getNumberColor(pocket) };
    }
  }

  /**
   * Generate a spin sequence for animation
   * The sequence ends on the winning number
   */
  generateSpinSequence(winner: RouletteNumber, totalFrames: number): RouletteNumber[] {
    const sequence: RouletteNumber[] = [];

    for (let i = 0; i < totalFrames - 1; i++) {
      // Random numbers for animation frames
      const randomNum = this.spin();
      sequence.push(randomNum);
    }

    // Last frame is the winner
    sequence.push(winner);

    return sequence;
  }

  /**
   * Evaluate all bets against the result
   */
  evaluateBets(bets: RouletteBet[], result: RouletteNumber): BetResult[] {
    return bets.map((bet) => {
      // Check if result is in covered numbers
      const won = bet.numbers.some((num) => {
        if (num === '00' && result.value === '00') return true;
        if (num === result.value) return true;
        return false;
      });

      // Calculate payout: bet amount + (bet amount * multiplier)
      const payout = won ? bet.amount + bet.amount * bet.payout : 0;

      return { bet, won, payout };
    });
  }

  /**
   * Format the winning number for display
   */
  formatWinningNumber(result: RouletteNumber): string {
    const colorEmoji = result.color === 'red' ? '🔴' : result.color === 'black' ? '⚫' : '🟢';
    return `${colorEmoji} **${result.value}** ${result.color.toUpperCase()}`;
  }

  // ========== Session Management ==========

  /**
   * Start a new roulette game session
   */
  startGame(userId: string, guildId: string, baseBet: number): RouletteGame {
    const sessionKey = this.getSessionKey(userId, guildId);

    const game: RouletteGame = {
      odUserId: userId,
      guildId,
      baseBet,
      bets: [],
      totalWagered: 0,
      status: 'betting',
      numberPickerPage: null,
    };

    this.activeSessions.set(sessionKey, game);
    return game;
  }

  /**
   * Get an active game session
   */
  getGame(userId: string, guildId: string): RouletteGame | undefined {
    const sessionKey = this.getSessionKey(userId, guildId);
    return this.activeSessions.get(sessionKey);
  }

  /**
   * Check if a user has an active game
   */
  hasActiveGame(userId: string, guildId: string): boolean {
    const sessionKey = this.getSessionKey(userId, guildId);
    return this.activeSessions.has(sessionKey);
  }

  /**
   * End a game session
   */
  endGame(userId: string, guildId: string): void {
    const sessionKey = this.getSessionKey(userId, guildId);
    this.activeSessions.delete(sessionKey);
  }

  /**
   * Add a bet to the game
   */
  addBet(userId: string, guildId: string, betType: RouletteBetType, selection?: number | '00'): RouletteBet | null {
    const game = this.getGame(userId, guildId);
    if (!game || game.status !== 'betting') return null;

    // Check max bets
    if (game.bets.length >= RouletteService.MAX_BETS_PER_SPIN) return null;

    // Check for duplicate bet type (except straight bets can be on different numbers)
    if (betType !== RouletteBetType.STRAIGHT) {
      const existingBet = game.bets.find((b) => b.type === betType);
      if (existingBet) return null; // Already placed this bet type
    } else {
      // For straight bets, check if this specific number is already bet on
      const existingBet = game.bets.find((b) => b.type === RouletteBetType.STRAIGHT && b.selection === selection);
      if (existingBet) return null;
    }

    const bet: RouletteBet = {
      type: betType,
      amount: game.baseBet,
      numbers: this.getCoveredNumbers(betType, selection),
      payout: this.getPayoutMultiplier(betType),
      selection: betType === RouletteBetType.STRAIGHT ? selection : undefined,
    };

    game.bets.push(bet);
    game.totalWagered += bet.amount;

    return bet;
  }

  /**
   * Remove a specific bet from the game
   */
  removeBet(userId: string, guildId: string, betType: RouletteBetType, selection?: number | '00'): RouletteBet | null {
    const game = this.getGame(userId, guildId);
    if (!game || game.status !== 'betting') return null;

    const betIndex = game.bets.findIndex((b) => {
      if (b.type !== betType) return false;
      if (betType === RouletteBetType.STRAIGHT) {
        return b.selection === selection;
      }
      return true;
    });

    if (betIndex === -1) return null;

    const [removedBet] = game.bets.splice(betIndex, 1);
    game.totalWagered -= removedBet.amount;

    return removedBet;
  }

  /**
   * Clear all bets from the game
   */
  clearBets(userId: string, guildId: string): RouletteBet[] {
    const game = this.getGame(userId, guildId);
    if (!game || game.status !== 'betting') return [];

    const clearedBets = [...game.bets];
    game.bets = [];
    game.totalWagered = 0;

    return clearedBets;
  }

  /**
   * Check if any bets have been placed
   */
  hasBets(userId: string, guildId: string): boolean {
    const game = this.getGame(userId, guildId);
    return game ? game.bets.length > 0 : false;
  }

  /**
   * Get the number of bets placed
   */
  getBetCount(userId: string, guildId: string): number {
    const game = this.getGame(userId, guildId);
    return game ? game.bets.length : 0;
  }

  /**
   * Check if more bets can be added
   */
  canAddBet(userId: string, guildId: string): boolean {
    const game = this.getGame(userId, guildId);
    return game ? game.bets.length < RouletteService.MAX_BETS_PER_SPIN : false;
  }

  /**
   * Set game status to spinning
   */
  startSpin(userId: string, guildId: string): void {
    const game = this.getGame(userId, guildId);
    if (game) {
      game.status = 'spinning';
    }
  }

  /**
   * Set game result and status to finished
   */
  finishSpin(userId: string, guildId: string, result: RouletteNumber): void {
    const game = this.getGame(userId, guildId);
    if (game) {
      game.result = result;
      game.status = 'finished';
    }
  }

  /**
   * Set number picker page
   */
  setNumberPickerPage(userId: string, guildId: string, page: NumberPickerPage): void {
    const game = this.getGame(userId, guildId);
    if (game) {
      game.numberPickerPage = page;
    }
  }

  /**
   * Get numbers that have bets placed on them
   */
  getBettedNumbers(userId: string, guildId: string): Set<number | '00'> {
    const game = this.getGame(userId, guildId);
    if (!game) return new Set();

    const bettedNumbers = new Set<number | '00'>();
    for (const bet of game.bets) {
      if (bet.type === RouletteBetType.STRAIGHT && bet.selection !== undefined) {
        bettedNumbers.add(bet.selection);
      }
    }
    return bettedNumbers;
  }

  /**
   * Generate visual board display for embed
   * Shows the roulette table layout with color coding
   */
  generateBoardDisplay(bets: RouletteBet[]): string {
    // Get straight bet numbers for highlighting
    const bettedNumbers = new Set<number | '00'>();
    for (const bet of bets) {
      if (bet.type === RouletteBetType.STRAIGHT && bet.selection !== undefined) {
        bettedNumbers.add(bet.selection);
      }
    }

    // Helper to format a number with color emoji
    const fmt = (n: number | '00'): string => {
      const color = this.getNumberColor(n);
      const emoji = color === 'red' ? '🔴' : color === 'black' ? '⚫' : '🟢';
      const numStr = String(n).padStart(2);
      // Bold if bet placed on this number
      const display = bettedNumbers.has(n) ? `**${numStr}**` : numStr;
      return `${emoji}${display}`;
    };

    // Compact board layout for Discord
    // Row format: emoji+number pairs
    const lines: string[] = [];

    // Green numbers row
    lines.push(`${fmt(0)} ${fmt('00')}`);
    lines.push('');

    // Main grid - 3 rows representing the roulette table layout
    // Note: Using shorter format since Discord embeds have limited width
    const row1Numbers = RouletteService.COLUMN_3.slice(0, 6);
    const row1Numbers2 = RouletteService.COLUMN_3.slice(6);
    const row2Numbers = RouletteService.COLUMN_2.slice(0, 6);
    const row2Numbers2 = RouletteService.COLUMN_2.slice(6);
    const row3Numbers = RouletteService.COLUMN_1.slice(0, 6);
    const row3Numbers2 = RouletteService.COLUMN_1.slice(6);

    // First half
    lines.push(row1Numbers.map((n) => fmt(n)).join(' '));
    lines.push(row2Numbers.map((n) => fmt(n)).join(' '));
    lines.push(row3Numbers.map((n) => fmt(n)).join(' '));
    lines.push('');
    // Second half
    lines.push(row1Numbers2.map((n) => fmt(n)).join(' '));
    lines.push(row2Numbers2.map((n) => fmt(n)).join(' '));
    lines.push(row3Numbers2.map((n) => fmt(n)).join(' '));

    return lines.join('\n');
  }
}
