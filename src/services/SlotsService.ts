import { pool } from '../lib/database.js';
import { GameSource, UpdateType, GAME_BET_LIMITS } from '../constants.js';
import { safeLogger as logger } from '../lib/safe-logger.js';
import { formatCoins } from '../lib/utils.js';

/**
 * Slot machine symbols with weights (matching Python implementation)
 * Lower weight = rarer symbol
 */
export const SLOTS_SYMBOLS = [
  { emoji: '🐷', name: 'Hog', weight: 1 },      // Rarest - Jackpot symbol
  { emoji: '🎄', name: 'Tree', weight: 2 },     // Bonus spin symbol
  { emoji: '🔔', name: 'Bell', weight: 3 },
  { emoji: '❄️', name: 'Snowflake', weight: 3 }, // Bonus spin symbol
  { emoji: '🎅', name: 'Santa', weight: 4 },
  { emoji: '🎁', name: 'Gift', weight: 6 },     // Most common
] as const;

export interface SpinResult {
  symbols: string[];
  multiplier: number;
  outcomeText: string;
  bonusSpin: boolean;
  jackpotHit: boolean;
}

/**
 * SlotsService handles slot machine game logic
 * Ported from Python: E:\dev\repos\hogbot\services\slots_service.py
 *
 * MULTI-GUILD SUPPORT:
 * - Per-guild progressive jackpot pools (each guild has independent jackpot)
 * - All jackpot methods require guildId parameter
 */
export class SlotsService {
  static readonly MIN_BET = GAME_BET_LIMITS.SLOTS.MIN;
  static readonly MAX_BET = GAME_BET_LIMITS.SLOTS.MAX;
  static readonly JACKPOT_SEED = 5_000_000;
  static readonly JACKPOT_PERCENT = 1.0; // 100% of bet goes to jackpot pool

  /**
   * Get current progressive jackpot amount for a specific guild
   * Initializes jackpot for new guilds on first access
   *
   * @param guildId - Discord guild ID
   */
  async getJackpot(guildId: string): Promise<number> {
    const client = await pool.connect();
    try {
      const result = await client.query<{ amount: string }>(
        'SELECT amount FROM progressive_jackpot WHERE guild_id = $1',
        [guildId]
      );

      if (result.rows.length === 0) {
        // Initialize jackpot for new guild
        await client.query(
          'INSERT INTO progressive_jackpot (guild_id, amount) VALUES ($1, $2) ON CONFLICT (guild_id) DO NOTHING',
          [guildId, SlotsService.JACKPOT_SEED]
        );
        logger.info(`Initialized jackpot for guild ${guildId}: ${SlotsService.JACKPOT_SEED}`);
        return SlotsService.JACKPOT_SEED;
      }

      return parseInt(result.rows[0].amount, 10);
    } finally {
      client.release();
    }
  }

  /**
   * Add to the progressive jackpot pool for a specific guild
   *
   * @param guildId - Discord guild ID
   * @param amount - Amount to add to jackpot
   */
  async contributeToJackpot(guildId: string, amount: number): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query(
        `UPDATE progressive_jackpot
         SET amount = amount + $1,
             updated_at = NOW()
         WHERE guild_id = $2`,
        [amount, guildId]
      );
    } finally {
      client.release();
    }
  }

  /**
   * Reset jackpot to seed value after it's won
   *
   * @param guildId - Discord guild ID
   * @param winnerId - User ID who won the jackpot
   */
  async resetJackpot(guildId: string, winnerId?: string): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query(
        `UPDATE progressive_jackpot
         SET amount = $1,
             last_winner_id = $2,
             last_won_at = NOW(),
             updated_at = NOW()
         WHERE guild_id = $3`,
        [SlotsService.JACKPOT_SEED, winnerId || null, guildId]
      );
      logger.info(`Reset jackpot for guild ${guildId}, winner: ${winnerId || 'none'}`);
    } finally {
      client.release();
    }
  }

  /**
   * Spin a single reel (weighted random selection)
   */
  spinSymbol(): string {
    const totalWeight = SLOTS_SYMBOLS.reduce((sum, sym) => sum + sym.weight, 0);
    let random = Math.random() * totalWeight;

    for (const symbol of SLOTS_SYMBOLS) {
      random -= symbol.weight;
      if (random <= 0) {
        return symbol.emoji;
      }
    }

    // Fallback (should never reach here)
    return SLOTS_SYMBOLS[SLOTS_SYMBOLS.length - 1].emoji;
  }

  /**
   * Spin all three reels
   */
  spin(): string[] {
    return [this.spinSymbol(), this.spinSymbol(), this.spinSymbol()];
  }

  /**
   * Evaluate spin result and calculate payout
   * Matches Python logic exactly from slots_service.py line 282
   */
  evaluateSpin(symbols: string[], jackpotAmount: number): SpinResult {
    const [s1, s2, s3] = symbols;
    const symbolsSet = new Set(symbols);
    const pigCount = symbols.filter((s) => s === '🐷').length;

    let multiplier = 0;
    let outcomeText = '';
    let bonusSpin = false;
    let jackpotHit = false;

    // Triple Hogs - JACKPOT! (20x + entire jackpot pool)
    if (s1 === '🐷' && s2 === '🐷' && s3 === '🐷') {
      jackpotHit = true;
      outcomeText =
        '🎉 **JACKPOT!**\n🎉 **JACKPOT!**\n🎉 **JACKPOT!**\n\n' +
        'Triple **HOGS** on the line! The **Hog Gods** are pleased. 🐷🐷🐷\n' +
        `You scoop the entire pot of **${formatCoins(jackpotAmount)}** on top of your payout!`;
      return { symbols, multiplier: 20, outcomeText, bonusSpin, jackpotHit };
    }

    // Triple Trees - Bonus spin! (8x + bonus)
    if (s1 === '🎄' && s2 === '🎄' && s3 === '🎄') {
      bonusSpin = true;
      outcomeText =
        '🎄 **Christmas Tree Win!**\n🎄 **Christmas Tree Win!**\n🎄 **Christmas Tree Win!**\n\n' +
        'Triple 🎄🎄🎄 across the board.\n' +
        'You earn a **bonus spin** and a solid payout.';
      return { symbols, multiplier: 8, outcomeText, bonusSpin, jackpotHit };
    }

    // Triple Snowflakes - Bonus spin! (6x + bonus)
    if (s1 === '❄️' && s2 === '❄️' && s3 === '❄️') {
      bonusSpin = true;
      outcomeText =
        '❄️ **Lucky Snowflake!**\n❄️ **Lucky Snowflake!**\n❄️ **Lucky Snowflake!**\n\n' +
        'Triple clovers shimmer on the reels.\n' +
        'You feel the Hog Gods smile — **bonus spin** unlocked!';
      return { symbols, multiplier: 6, outcomeText, bonusSpin, jackpotHit };
    }

    // Any other triple (10x)
    if (symbolsSet.size === 1) {
      outcomeText =
        '💰 **Triple hit!**\n💰 **Triple hit!**\n💰 **Triple hit!**\n\n' +
        'Three of a kind across the board.';
      return { symbols, multiplier: 10, outcomeText, bonusSpin, jackpotHit };
    }

    // Double Hogs (5x)
    if (pigCount === 2) {
      outcomeText = '✨ **Double Hog!** Two 🐷 on the reels — not bad at all.';
      return { symbols, multiplier: 5, outcomeText, bonusSpin, jackpotHit };
    }

    // Any pair (2x)
    if (symbolsSet.size === 2) {
      outcomeText = '🥈 **That\'s a nice pair!** Two symbols matched. The house pays out.';
      return { symbols, multiplier: 2, outcomeText, bonusSpin, jackpotHit };
    }

    // Nothing (0x)
    outcomeText = '🚫 Nothing lines up. The house scoops your bet. Better luck next squeal.';
    return { symbols, multiplier: 0, outcomeText, bonusSpin, jackpotHit };
  }

  /**
   * Format reel display
   */
  formatReels(symbols: string[]): string {
    return `│ ${symbols[0]} │ ${symbols[1]} │ ${symbols[2]} │`;
  }
}
