/**
 * SlotsService - Handles Hog Pen Slots game logic
 *
 * Follows the same pattern as RideTheBusService:
 * - SlotsGame class manages a single game session
 * - SlotsService manages game sessions and provides entry point
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
import { pool } from '../lib/database.js';

/** Embed constants */
const EMBED_TITLE = '🎰 Hog Pen Slots';
const EMBED_TITLE_BONUS = '🎰 Hog Pen Slots – Bonus Spin';
const EMBED_TITLE_RESULT = '🎰 Hog Pen Slots – Result';
const EMBED_TITLE_BONUS_RESULT = '🎰 Hog Pen Slots – Bonus Spin Result';

const COLOR_DEFAULT = 0x5865f2;
const COLOR_WIN = 0x00ff00;
const COLOR_LOSS = 0xff0000;

/** Field names */
const FIELD_BET = 'Bet';
const FIELD_PAYOUT = 'Payout';
const FIELD_BALANCE = 'Balance';
const FIELD_JACKPOT_POOL = 'Jackpot Pool';

/** Button IDs */
export const BTN_ID_CRANK = 'crank';

/** Button labels */
const BTN_LABEL_CRANK = '🎰 Crank!';
const BTN_LABEL_SPINNING = '🎰 Spinning...';
const BTN_LABEL_BONUS = '🎰 Crank! (Bonus Spin)';

/** Jackpot configuration */
const JACKPOT_SEED = 5_000_000;
const JACKPOT_CONTRIBUTION_PERCENT = 1.0;

/** Animation messages */
const SPIN_MSG_START = '_The reels are spinning... steady now......._';
const SPIN_MSG_SLOWING = '_The reels are spinning... slowing down..._';
const SPIN_MSG_ALMOST = '_The reels are spinning... almost there....._';

/** Outcome messages */
const OUTCOME_JACKPOT =
  '🎉 **JACKPOT!**\n🎉 **JACKPOT!**\n🎉 **JACKPOT!**\n\n' +
  'Triple **HOGS** on the line! The **Hog Gods** are pleased. 🐷🐷🐷\n' +
  'You scoop the entire pot on top of your payout!';

const OUTCOME_TRIPLE_TREE =
  '🎄 **Christmas Tree Win!**\n🎄 **Christmas Tree Win!**\n🎄 **Christmas Tree Win!**\n\n' +
  'Triple 🎄🎄🎄 across the board.\n' +
  'You earn a **bonus spin** and a solid payout.';

const OUTCOME_TRIPLE_SNOWFLAKE =
  '❄️ **Lucky Snowflake!**\n❄️ **Lucky Snowflake!**\n❄️ **Lucky Snowflake!**\n\n' +
  'Triple clovers shimmer on the reels.\n' +
  'You feel the Hog Gods smile — **bonus spin** unlocked!';

const OUTCOME_TRIPLE_OTHER =
  '💰 **Triple hit!**\n💰 **Triple hit!**\n💰 **Triple hit!**\n\n' + 'Three of a kind across the board.';

const OUTCOME_DOUBLE_HOG = '✨ **Double Hog!** Two 🐷 on the reels — not bad at all.';

const OUTCOME_PAIR = "🥈 **That's a nice pair!** Two symbols matched. The house pays out.";

const OUTCOME_NOTHING = '🚫 Nothing lines up. The house scoops your bet. Better luck next squeal.';

/** Initial game description */
const INITIAL_DESCRIPTION =
  'Welcome to **Hog Pen Slots**!\n' +
  'Each bet is added towards the **progressive jackpot**.\n' +
  'Press **Crank!** to spin the reels.\n\n' +
  '**Jackpot:** 🐷🐷🐷\n' +
  '**Bonus Spins:** 🎄🎄🎄 or ❄️❄️❄️';

/** Footer messages */
const FOOTER_BONUS_UNLOCKED = '❄️ Bonus unlocked! Press **Crank!** again to use your free spin.';
const FOOTER_PLAY_AGAIN = 'Use /slots again to spin a new machine.';
const FOOTER_TIMEOUT = '⏰ Slot machine timed out, thanks for the donation!';

/** Multipliers */
const MULTIPLIER_JACKPOT = 20;
const MULTIPLIER_TRIPLE_TREE = 8;
const MULTIPLIER_TRIPLE_SNOWFLAKE = 6;
const MULTIPLIER_TRIPLE_OTHER = 10;
const MULTIPLIER_DOUBLE_HOG = 5;
const MULTIPLIER_PAIR = 2;
const MULTIPLIER_NOTHING = 0;

/** Symbol emojis */
const SYMBOL_HOG = '🐷';
const SYMBOL_TREE = '🎄';
const SYMBOL_BELL = '🔔';
const SYMBOL_SNOWFLAKE = '❄️';
const SYMBOL_SANTA = '🎅';
const SYMBOL_GIFT = '🎁';

/** Slot machine symbols with weights (lower weight = rarer) */
const SLOTS_SYMBOLS = [
  { emoji: SYMBOL_HOG, name: 'Hog', weight: 1 },
  { emoji: SYMBOL_TREE, name: 'Tree', weight: 2 },
  { emoji: SYMBOL_BELL, name: 'Bell', weight: 3 },
  { emoji: SYMBOL_SNOWFLAKE, name: 'Snowflake', weight: 3 },
  { emoji: SYMBOL_SANTA, name: 'Santa', weight: 4 },
  { emoji: SYMBOL_GIFT, name: 'Gift', weight: 6 },
] as const;

/** Stat keys */
const STAT_BONUS_SPINS = 'bonus_spins';
const STAT_JACKPOT_HITS = 'jackpot_hits';

/** Bet limits */
const MIN_BET = GAME_BET_LIMITS.SLOTS.MIN;
const MAX_BET = GAME_BET_LIMITS.SLOTS.MAX;

/** Spin result interface */
export interface SpinResult {
  symbols: string[];
  multiplier: number;
  outcomeText: string;
  bonusSpin: boolean;
  jackpotHit: boolean;
}

/** Mutable game state */
interface GameState {
  bonusSpinAvailable: boolean;
  spinCount: number;
  balance: number;
  jackpotAmount: number;
}

/**
 * SlotsGame manages a single slots game session
 */
class SlotsGame {
  private player: User;
  private guildId: string;
  private bet: number;
  private walletService: WalletService;
  private statsService: StatsService;

  private state: GameState;
  private message: Message | null = null;
  private onGameEnd: (() => void) | null = null;

  constructor(
    player: User,
    guildId: string,
    bet: number,
    initialBalance: number,
    initialJackpot: number,
    walletService: WalletService,
    statsService: StatsService,
    onGameEnd?: () => void
  ) {
    this.player = player;
    this.guildId = guildId;
    this.bet = bet;
    this.walletService = walletService;
    this.statsService = statsService;
    this.onGameEnd = onGameEnd || null;

    this.state = {
      bonusSpinAvailable: false,
      spinCount: 0,
      balance: initialBalance,
      jackpotAmount: initialJackpot,
    };
  }

  // ========== Getters ==========

  getPlayerId(): string {
    return this.player.id;
  }

  getMessage(): Message | null {
    return this.message;
  }

  getBet(): number {
    return this.bet;
  }

  // ========== Cleanup ==========

  private cleanupSession(): void {
    if (this.onGameEnd) {
      this.onGameEnd();
    }
  }

  // ========== Symbol Spinning ==========

  private spinSymbol(): string {
    const totalWeight = SLOTS_SYMBOLS.reduce((sum, sym) => sum + sym.weight, 0);
    let random = Math.random() * totalWeight;

    for (const symbol of SLOTS_SYMBOLS) {
      random -= symbol.weight;
      if (random <= 0) {
        return symbol.emoji;
      }
    }

    return SLOTS_SYMBOLS[SLOTS_SYMBOLS.length - 1].emoji;
  }

  private spin(): string[] {
    return [this.spinSymbol(), this.spinSymbol(), this.spinSymbol()];
  }

  // ========== Spin Evaluation ==========

  private evaluateSpin(symbols: string[]): SpinResult {
    const [s1, s2, s3] = symbols;
    const symbolsSet = new Set(symbols);
    const pigCount = symbols.filter((s) => s === SYMBOL_HOG).length;

    // Triple Hogs - JACKPOT!
    if (s1 === SYMBOL_HOG && s2 === SYMBOL_HOG && s3 === SYMBOL_HOG) {
      return {
        symbols,
        multiplier: MULTIPLIER_JACKPOT,
        outcomeText: OUTCOME_JACKPOT,
        bonusSpin: false,
        jackpotHit: true,
      };
    }

    // Triple Trees - Bonus spin!
    if (s1 === SYMBOL_TREE && s2 === SYMBOL_TREE && s3 === SYMBOL_TREE) {
      return {
        symbols,
        multiplier: MULTIPLIER_TRIPLE_TREE,
        outcomeText: OUTCOME_TRIPLE_TREE,
        bonusSpin: true,
        jackpotHit: false,
      };
    }

    // Triple Snowflakes - Bonus spin!
    if (s1 === SYMBOL_SNOWFLAKE && s2 === SYMBOL_SNOWFLAKE && s3 === SYMBOL_SNOWFLAKE) {
      return {
        symbols,
        multiplier: MULTIPLIER_TRIPLE_SNOWFLAKE,
        outcomeText: OUTCOME_TRIPLE_SNOWFLAKE,
        bonusSpin: true,
        jackpotHit: false,
      };
    }

    // Any other triple
    if (symbolsSet.size === 1) {
      return {
        symbols,
        multiplier: MULTIPLIER_TRIPLE_OTHER,
        outcomeText: OUTCOME_TRIPLE_OTHER,
        bonusSpin: false,
        jackpotHit: false,
      };
    }

    // Double Hogs
    if (pigCount === 2) {
      return {
        symbols,
        multiplier: MULTIPLIER_DOUBLE_HOG,
        outcomeText: OUTCOME_DOUBLE_HOG,
        bonusSpin: false,
        jackpotHit: false,
      };
    }

    // Any pair
    if (symbolsSet.size === 2) {
      return {
        symbols,
        multiplier: MULTIPLIER_PAIR,
        outcomeText: OUTCOME_PAIR,
        bonusSpin: false,
        jackpotHit: false,
      };
    }

    // Nothing
    return {
      symbols,
      multiplier: MULTIPLIER_NOTHING,
      outcomeText: OUTCOME_NOTHING,
      bonusSpin: false,
      jackpotHit: false,
    };
  }

  // ========== Reel Formatting ==========

  private formatReels(symbols: string[]): string {
    return `│ ${symbols[0]} │ ${symbols[1]} │ ${symbols[2]} │`;
  }

  // ========== Player Actions ==========

  /**
   * Handle the crank button click
   * Returns true if the game ended, false if it continues (bonus spin available)
   */
  async handleCrank(
    interaction: ButtonInteraction,
    contributeToJackpot: (guildId: string, amount: number) => Promise<void>,
    resetJackpot: (guildId: string, winnerId: string) => Promise<void>,
    getJackpot: (guildId: string) => Promise<number>
  ): Promise<boolean> {
    this.state.spinCount++;
    const isBonusSpin = this.state.bonusSpinAvailable && this.state.spinCount > 1;

    await interaction.deferUpdate();

    // Disable button during spin
    await this.showSpinningButton(interaction);

    // Perform the spin with animation
    const symbols = this.spin();
    await this.animateSpin(interaction, symbols, isBonusSpin);

    // Get current jackpot
    const jackpotAmount = await getJackpot(this.guildId);

    // Evaluate result
    const result = this.evaluateSpin(symbols);
    let totalPayout = this.bet * result.multiplier;

    // Handle jackpot win
    if (result.jackpotHit) {
      totalPayout += jackpotAmount;
      await resetJackpot(this.guildId, this.player.id);
    }

    // Update balance and stats
    if (totalPayout > 0) {
      await this.walletService.updateBalance(
        this.player.id,
        this.guildId,
        totalPayout,
        GameSource.SLOTS,
        UpdateType.BET_WON,
        {
          bet_amount: this.bet,
          payout_amount: totalPayout,
          symbols: symbols,
          multiplier: result.multiplier,
          bonus_spin: result.bonusSpin,
          jackpot_hit: result.jackpotHit,
        }
      );

      const extraStats: Record<string, number> = {};
      if (result.bonusSpin) {
        extraStats[STAT_BONUS_SPINS] = 1;
      }
      if (result.jackpotHit) {
        extraStats[STAT_JACKPOT_HITS] = 1;
      }

      await this.statsService.updateGameStats(
        this.player.id,
        this.guildId,
        GameSource.SLOTS,
        true,
        this.bet,
        totalPayout,
        extraStats
      );
    } else {
      // Record loss
      await this.walletService.updateBalance(this.player.id, this.guildId, 0, GameSource.SLOTS, UpdateType.BET_LOST, {
        bet_amount: this.bet,
        payout_amount: 0,
        symbols: symbols,
        multiplier: result.multiplier,
      });

      await this.statsService.updateGameStats(this.player.id, this.guildId, GameSource.SLOTS, false, this.bet, 0, {});
    }

    // Get updated balance and jackpot
    const newBalance = await this.walletService.getBalance(this.player.id, this.guildId);
    const newJackpot = await getJackpot(this.guildId);

    // Show result
    await this.showResult(interaction, symbols, result, totalPayout, newBalance, newJackpot, isBonusSpin);

    // Handle bonus spin
    if (result.bonusSpin && !isBonusSpin) {
      this.state.bonusSpinAvailable = true;
      await this.showBonusButton(interaction);
      return false; // Game continues
    }

    // Game over
    this.cleanupSession();
    return true;
  }

  /**
   * Handle game timeout
   */
  async handleTimeout(): Promise<void> {
    // Log timeout as loss
    await this.walletService.logTransaction(this.player.id, this.guildId, GameSource.SLOTS, UpdateType.BET_LOST, {
      bet_amount: this.bet,
      payout_amount: 0,
      reason: 'timeout',
    });

    await this.statsService.updateGameStats(this.player.id, this.guildId, GameSource.SLOTS, false, this.bet, 0, {});

    this.cleanupSession();
  }

  // ========== Animation ==========

  private async animateSpin(interaction: ButtonInteraction, finalSymbols: string[], isBonusSpin: boolean): Promise<void> {
    const stopSteps = [
      Math.floor(Math.random() * 3) + 5, // First reel stops at 5-7
      Math.floor(Math.random() * 3) + 7, // Second reel stops at 7-9
      Math.floor(Math.random() * 7) + 9, // Third reel stops at 9-15
    ];

    const totalSteps = Math.max(...stopSteps) + 1;

    for (let step = 0; step < totalSteps; step++) {
      const currentSymbols = stopSteps.map((stopStep, idx) =>
        step >= stopStep ? finalSymbols[idx] : this.spinSymbol()
      );

      const spinMessage =
        step < 4 ? SPIN_MSG_START : step < totalSteps - 4 ? SPIN_MSG_SLOWING : SPIN_MSG_ALMOST;

      const reelDisplay = this.formatReels(currentSymbols);
      const description = `${spinMessage}\n\n${reelDisplay}`;

      const title = isBonusSpin ? EMBED_TITLE_BONUS : EMBED_TITLE;
      const embed = this.buildBaseEmbed(description, title);

      await interaction.editReply({ embeds: [embed] });

      const delay = step < 4 ? 200 + step * 30 : step < totalSteps - 4 ? 200 + step * 30 : 300 + step * 30;
      await this.sleep(delay + Math.random() * 80 - 40);
    }

    await this.sleep(300 + Math.random() * 500);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  // ========== Embed Builders ==========

  private buildBaseEmbed(description: string, title: string = EMBED_TITLE): EmbedBuilder {
    return new EmbedBuilder()
      .setTitle(title)
      .setDescription(`**Player:** ${this.player.toString()}\n\n${description}`)
      .setColor(COLOR_DEFAULT)
      .addFields(
        { name: FIELD_BET, value: formatCoins(this.bet), inline: true },
        { name: FIELD_BALANCE, value: formatCoins(this.state.balance), inline: true },
        { name: FIELD_JACKPOT_POOL, value: formatCoins(this.state.jackpotAmount), inline: false }
      );
  }

  private buildInitialEmbed(): EmbedBuilder {
    return this.buildBaseEmbed(INITIAL_DESCRIPTION);
  }

  private buildResultEmbed(
    symbols: string[],
    result: SpinResult,
    totalPayout: number,
    newBalance: number,
    newJackpot: number,
    isBonusSpin: boolean
  ): EmbedBuilder {
    const reelDisplay = this.formatReels(symbols);
    const color = result.multiplier > 0 || result.jackpotHit ? COLOR_WIN : COLOR_LOSS;
    const jackpotText = result.jackpotHit ? ' + 💰 Jackpot Pool' : '';

    const description =
      `**Final Result:**\n${reelDisplay}\n\n` +
      `${result.outcomeText}\n\n` +
      `**Payout Multiplier:** 🪙x${result.multiplier}`;

    const title = isBonusSpin ? EMBED_TITLE_BONUS_RESULT : EMBED_TITLE_RESULT;

    const embed = new EmbedBuilder()
      .setTitle(title)
      .setDescription(`**Player:** ${this.player.toString()}\n\n${description}`)
      .setColor(color)
      .addFields(
        { name: FIELD_BET, value: formatCoins(this.bet), inline: true },
        { name: FIELD_PAYOUT, value: `${formatCoins(totalPayout)}${jackpotText}`, inline: true },
        { name: FIELD_BALANCE, value: formatCoins(newBalance), inline: true },
        { name: FIELD_JACKPOT_POOL, value: formatCoins(newJackpot), inline: false }
      );

    if (result.bonusSpin && !isBonusSpin) {
      embed.setFooter({ text: FOOTER_BONUS_UNLOCKED });
    } else {
      embed.setFooter({ text: FOOTER_PLAY_AGAIN });
    }

    return embed;
  }

  // ========== Button Builders ==========

  private buildCrankButton(): ActionRowBuilder<ButtonBuilder> {
    const button = new ButtonBuilder()
      .setCustomId(BTN_ID_CRANK)
      .setLabel(BTN_LABEL_CRANK)
      .setStyle(ButtonStyle.Success);

    return new ActionRowBuilder<ButtonBuilder>().addComponents(button);
  }

  private buildSpinningButton(): ActionRowBuilder<ButtonBuilder> {
    const button = new ButtonBuilder()
      .setCustomId(BTN_ID_CRANK)
      .setLabel(BTN_LABEL_SPINNING)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(true);

    return new ActionRowBuilder<ButtonBuilder>().addComponents(button);
  }

  private buildBonusButton(): ActionRowBuilder<ButtonBuilder> {
    const button = new ButtonBuilder()
      .setCustomId(BTN_ID_CRANK)
      .setLabel(BTN_LABEL_BONUS)
      .setStyle(ButtonStyle.Success);

    return new ActionRowBuilder<ButtonBuilder>().addComponents(button);
  }

  // ========== UI Updates ==========

  private async showSpinningButton(interaction: ButtonInteraction): Promise<void> {
    const row = this.buildSpinningButton();
    await interaction.editReply({ components: [row] });
  }

  private async showBonusButton(interaction: ButtonInteraction): Promise<void> {
    const row = this.buildBonusButton();
    await interaction.editReply({ components: [row] });
  }

  private async showResult(
    interaction: ButtonInteraction,
    symbols: string[],
    result: SpinResult,
    totalPayout: number,
    newBalance: number,
    newJackpot: number,
    isBonusSpin: boolean
  ): Promise<void> {
    const embed = this.buildResultEmbed(symbols, result, totalPayout, newBalance, newJackpot, isBonusSpin);
    await interaction.editReply({ embeds: [embed] });
  }

  // ========== Start Game ==========

  async start(interaction: ChatInputCommandInteraction): Promise<void> {
    const embed = this.buildInitialEmbed();
    const row = this.buildCrankButton();

    this.message = await interaction.editReply({
      embeds: [embed],
      components: [row],
    });
  }
}

/**
 * SlotsService manages Hog Pen Slots game sessions
 */
export class SlotsService {
  static readonly MIN_BET = MIN_BET;
  static readonly MAX_BET = MAX_BET;
  static readonly JACKPOT_PERCENT = JACKPOT_CONTRIBUTION_PERCENT;
  static readonly FOOTER_TIMEOUT = FOOTER_TIMEOUT;

  private walletService: WalletService;
  private statsService: StatsService;
  private gameStateService: GameStateService;
  private activeSessions: Map<string, SlotsGame> = new Map();

  constructor(walletService: WalletService, statsService: StatsService, gameStateService: GameStateService) {
    this.walletService = walletService;
    this.statsService = statsService;
    this.gameStateService = gameStateService;
  }

  // ========== Jackpot Methods ==========

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
          [guildId, JACKPOT_SEED]
        );
        logger.info(`Initialized jackpot for guild ${guildId}: ${JACKPOT_SEED}`);
        return JACKPOT_SEED;
      }

      return parseInt(result.rows[0].amount, 10);
    } finally {
      client.release();
    }
  }

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

  async resetJackpot(guildId: string, winnerId: string): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query(
        `UPDATE progressive_jackpot
         SET amount = $1,
             last_winner_id = $2,
             last_won_at = NOW(),
             updated_at = NOW()
         WHERE guild_id = $3`,
        [JACKPOT_SEED, winnerId, guildId]
      );
      logger.info(`Reset jackpot for guild ${guildId}, winner: ${winnerId}`);
    } finally {
      client.release();
    }
  }

  // ========== Game Management ==========

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

    if (bet > MAX_BET) {
      await interaction.reply({
        content: `Maximum bet is **${formatCoins(MAX_BET)}**.`,
        flags: MessageFlags.Ephemeral,
      });
      return null;
    }

    // Check if user already has an active session
    if (await this.gameStateService.hasActiveGame(userId, guildId, GameSource.SLOTS)) {
      await interaction.reply({
        content: '🚫 You already have an active slots game. Finish it before starting a new one.',
        flags: MessageFlags.Ephemeral,
      });
      return null;
    }

    const balance = await this.walletService.getBalance(userId, guildId);

    if (bet > balance) {
      await interaction.reply({
        content: `You're too broke to spin right now, ${interaction.user}.\nYour bet is **${formatCoins(bet)}**, but you only have **${formatCoins(balance)}**.\nTry /beg to scrounge up some Hog Coins.`,
        flags: MessageFlags.Ephemeral,
      });
      return null;
    }

    try {
      // Defer reply before processing
      await interaction.deferReply();

      // Deduct bet upfront
      await this.walletService.updateBalance(userId, guildId, -bet, GameSource.SLOTS, UpdateType.BET_PLACED, {
        bet_amount: bet,
      });

      // Start game in database
      await this.gameStateService.startGame(userId, guildId, GameSource.SLOTS, bet);

      // Contribute to jackpot
      const contribution = Math.max(Math.floor(bet * JACKPOT_CONTRIBUTION_PERCENT), 1);
      await this.contributeToJackpot(guildId, contribution);

      // Get current state
      const balanceAfterBet = await this.walletService.getBalance(userId, guildId);
      const jackpotAmount = await this.getJackpot(guildId);

      // Create game instance with cleanup callback
      const game = new SlotsGame(
        interaction.user,
        guildId,
        bet,
        balanceAfterBet,
        jackpotAmount,
        this.walletService,
        this.statsService,
        async () => {
          this.activeSessions.delete(userId);
          await this.gameStateService.finishGame(userId, guildId, GameSource.SLOTS);
        }
      );

      this.activeSessions.set(userId, game);

      // Send initial embed
      await game.start(interaction);

      return game.getMessage();
    } catch (error) {
      logger.error('Error starting slots game:', error);

      // Clean up
      this.activeSessions.delete(userId);
      await this.gameStateService.finishGame(userId, guildId, GameSource.SLOTS);

      // Refund the bet
      await this.walletService.updateBalance(userId, guildId, bet, GameSource.SLOTS, UpdateType.REFUND, {
        bet_amount: bet,
        reason: 'Game failed to start',
      });

      if (interaction.deferred) {
        await interaction.editReply({
          content: 'An error occurred while starting the slot machine. Your bet has been refunded. Please try again.',
        });
      } else {
        await interaction.reply({
          content: 'An error occurred while starting the slot machine. Your bet has been refunded. Please try again.',
          flags: MessageFlags.Ephemeral,
        });
      }
      return null;
    }
  }

  /**
   * Get an active game session for a user
   */
  getGame(userId: string): SlotsGame | undefined {
    return this.activeSessions.get(userId);
  }

  /**
   * Bound methods for passing to game
   */
  getJackpotBound = this.getJackpot.bind(this);
  contributeToJackpotBound = this.contributeToJackpot.bind(this);
  resetJackpotBound = this.resetJackpot.bind(this);
}
