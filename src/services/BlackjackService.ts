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
import { GameSource, UpdateType, BLACKJACK_CONFIG, GAME_BET_LIMITS } from '../constants.js';
import { WalletService } from './WalletService.js';
import { StatsService } from './StatsService.js';
import { LeaderboardService } from './LeaderboardService.js';
import { GameStateService } from './GameStateService.js';
import { DeckService, type Card } from './DeckService.js';
import { safeLogger as logger } from '../lib/safe-logger.js';
import { formatCoins } from '../utils/utils.js';

/** Embed constants */
const EMBED_TITLE = '🃏 Blackjack';
const EMBED_FOOTER = 'Hit / Stand / Double / Split. No surrender. Dealer stands on 17.';

/** Embed colors */
const COLOR_IN_PROGRESS = 0xdaa520;
const COLOR_WIN = 0x00ff00;
const COLOR_LOSS = 0xff0000;
const COLOR_PUSH = 0xd3d3d3;

/** Field names */
const FIELD_BET = 'Bet';
const FIELD_FINAL_PAYOUT = 'Final Payout';
const FIELD_BALANCE = 'Balance';

/** Button IDs (exported for use by command) */
export const BTN_ID_HIT = 'bj_hit';
export const BTN_ID_STAND = 'bj_stand';
export const BTN_ID_DOUBLE = 'bj_double';
export const BTN_ID_SPLIT = 'bj_split';

/** Button labels */
const BTN_LABEL_HIT = '➕ Hit';
const BTN_LABEL_STAND = '✋ Stand';
const BTN_LABEL_DOUBLE = '💥 Double';
const BTN_LABEL_SPLIT = '🪓 Split';

/** Stat keys */
const STAT_BLACKJACK_WINS = 'blackjack_wins';
const STAT_DOUBLE_DOWN_WINS = 'double_down_wins';
const STAT_DOUBLE_DOWN_LOSSES = 'double_down_losses';

/** Payout multipliers */
const PAYOUT_BLACKJACK_NUMERATOR = 5;
const PAYOUT_BLACKJACK_DENOMINATOR = 2;
const PAYOUT_WIN_MULTIPLIER = 2;

const MIN_BET = GAME_BET_LIMITS.BLACKJACK.MIN;

type HandResult = 'win' | 'loss' | 'push' | 'blackjack';

const RESULT_WIN: HandResult = 'win';
const RESULT_LOSS: HandResult = 'loss';
const RESULT_PUSH: HandResult = 'push';
const RESULT_BLACKJACK:HandResult = 'blackjack';

interface BJHand {
  cards: Card[];
  bet: number;
  doubled: boolean;
  from_split: boolean;
  natural_blackjack: boolean;
  finished: boolean;
  result: HandResult | null;
}

/**
 * BlackjackGame manages a single blackjack game session
 *
 * MULTI-GUILD SUPPORT:
 * - Requires guildId to pass to service calls
 */
class BlackjackGame {
  private player: User;
  private guildId: string;
  private baseBet: number;
  private walletService: WalletService;
  private statsService: StatsService;
  private leaderboardService: LeaderboardService;
  private deckService: DeckService;

  private deck: Card[] = [];
  private hands: BJHand[] = [];
  private activeHandIdx: number = 0;
  private dealerCards: Card[] = [];
  private message: Message | null = null;
  private onGameEnd: (() => void) | null = null;

  constructor(
    player: User,
    guildId: string,
    bet: number,
    walletService: WalletService,
    statsService: StatsService,
    leaderboardService: LeaderboardService,
    deckService: DeckService,
    onGameEnd?: () => void
  ) {
    this.player = player;
    this.guildId = guildId;
    this.baseBet = bet;
    this.walletService = walletService;
    this.statsService = statsService;
    this.leaderboardService = leaderboardService;
    this.deckService = deckService;
    this.onGameEnd = onGameEnd || null;

    this.deck = this.deckService.createDeck();
    this.initDeal();
  }

  // ========== Cleanup ==========

  private cleanupSession(): void {
    if (this.onGameEnd) {
      this.onGameEnd();
    }
  }

  // ========== Deck Management ==========

  private draw(): Card {
    return this.deckService.draw(this.deck);
  }

  private formatCard(card: Card): string {
    return this.deckService.formatCard(card);
  }

  private formatCards(cards: Card[]): string {
    return this.deckService.formatCards(cards);
  }

  // ========== Card Value Calculations ==========

  private handValue(cards: Card[]): number {
    let total = 0;
    let aces = 0;

    for (const card of cards) {
      const value = this.deckService.getBlackjackValue(card);
      if (card.rank === 14) aces++;
      total += value;
    }

    // Demote aces from 11 to 1 as needed
    while (total > 21 && aces > 0) {
      total -= 10;
      aces--;
    }

    return total;
  }

  private isSoft(cards: Card[]): boolean {
    let total = 0;
    let aces = 0;

    for (const card of cards) {
      if (card.rank === 14) {
        aces++;
        total += 11;
      } else if (card.rank >= 11 && card.rank <= 13) {
        total += 10;
      } else {
        total += card.rank;
      }
    }

    while (total > 21 && aces > 0) {
      total -= 10;
      aces--;
    }

    return aces > 0;
  }

  // ========== Game State Checks ==========

  private initDeal(): void {
    const p1 = this.draw();
    const p2 = this.draw();
    const d1 = this.draw();
    const d2 = this.draw();

    const playerCards = [p1, p2];
    const dealerCards = [d1, d2];

    const isNatural = playerCards.length === 2 && this.handValue(playerCards) === 21;

    this.hands = [
      {
        cards: playerCards,
        bet: this.baseBet,
        doubled: false,
        from_split: false,
        natural_blackjack: isNatural,
        finished: false,
        result: null,
      },
    ];
    this.dealerCards = dealerCards;
  }

  private dealerUpcard(): Card {
    return this.dealerCards[0];
  }

  private dealerHasBlackjack(): boolean {
    return this.dealerCards.length === 2 && this.handValue(this.dealerCards) === 21;
  }

  private playerHasBlackjack(): boolean {
    const h = this.hands[0];
    return !h.from_split && h.natural_blackjack && h.cards.length === 2 && this.handValue(h.cards) === 21;
  }

  private peekRequired(): boolean {
    const upcard = this.dealerUpcard();
    return upcard.rank === 14 || this.deckService.isTenValue(upcard);
  }

  private activeHand(): BJHand {
    return this.hands[this.activeHandIdx];
  }

  private canSplit(): boolean {
    const h = this.activeHand();
    if (h.from_split) return false;
    if (this.hands.length !== 1) return false;
    if (h.cards.length !== 2) return false;

    const v1 = this.deckService.getBlackjackValue(h.cards[0]);
    const v2 = this.deckService.getBlackjackValue(h.cards[1]);
    return v1 === v2;
  }

  private canDouble(): boolean {
    const h = this.activeHand();
    if (h.finished || h.doubled) return false;
    return h.cards.length === 2;
  }

  private hasUnfinishedOtherHand(): boolean {
    return this.hands.some((h) => !h.finished);
  }

  // ========== Embed Building ==========

  private async buildEmbed(options: {
    revealHole?: boolean;
    note?: string;
    gameOver?: boolean;
    payoutOverride?: number;
    dealerPending?: boolean;
    hideActiveMarker?: boolean;
    playerPending?: boolean;
  } = {}): Promise<EmbedBuilder> {
    const {
      revealHole = false,
      note = null,
      gameOver = false,
      payoutOverride = null,
      dealerPending = false,
      hideActiveMarker = false,
      playerPending = false,
    } = options;

    let dealerShow = '';
    if (revealHole) {
      dealerShow = this.formatCards(this.dealerCards);
      if (dealerPending) dealerShow += '  ❓';
    } else {
      dealerShow = `${this.formatCard(this.dealerCards[0])}  ❓`;
    }

    const lines: string[] = [`**Player:** ${this.player.toString()}\n\n**Dealer:** ${dealerShow}\n`];

    const getStatus = (h: BJHand): string => {
      if (h.finished && h.result) {
        if (h.result === RESULT_WIN) return ' — ✅';
        if (h.result === RESULT_PUSH) return ' — 🤝';
        if (h.result === RESULT_LOSS) return ' — ❌';
        if (h.result === RESULT_BLACKJACK) return ' — ✅';
      }
      return '';
    };

    const getEmbedColor = (hands: BJHand[], gameOverFlag: boolean): number => {
      if (!gameOverFlag) return COLOR_IN_PROGRESS;

      let sawPush = false;
      let sawLoss = false;

      for (const hand of hands) {
        if (!hand.finished) continue;
        if (!hand.result) continue;

        if (hand.result === RESULT_WIN || hand.result === RESULT_BLACKJACK) {
          return COLOR_WIN;
        }
        if (hand.result === RESULT_LOSS) {
          sawLoss = true;
          continue;
        }
        if (hand.result === RESULT_PUSH) {
          sawPush = true;
          continue;
        }
      }

      if (sawPush) return COLOR_PUSH;
      if (sawLoss) return COLOR_LOSS;
      return COLOR_PUSH;
    };

    for (let idx = 0; idx < this.hands.length; idx++) {
      const h = this.hands[idx];
      const hv = this.handValue(h.cards);
      let marker = '';
      if (this.hands.length > 1 && !hideActiveMarker) {
        marker = idx === this.activeHandIdx && !gameOver ? '👉 ' : '';
      }
      const tag = h.natural_blackjack && !h.from_split && h.cards.length === 2 && hv === 21 ? ' (Blackjack!)' : '';
      const status = getStatus(h);
      let handCards = this.formatCards(h.cards);
      if (playerPending && idx === this.activeHandIdx && !gameOver) {
        handCards += '  ❓';
      }

      lines.push(`\n${marker}**Hand:** ${handCards}${tag}${status}`);
    }

    let desc = lines.join('');
    if (note) desc += `\n\n${note}`;

    const embed = new EmbedBuilder()
      .setTitle(EMBED_TITLE)
      .setDescription(desc)
      .setColor(getEmbedColor(this.hands, gameOver));

    const totalBet = this.hands.reduce((sum, h) => sum + h.bet, 0);

    // Get current balance
    const balance = await this.walletService.getBalance(this.player.id, this.guildId);

    embed.addFields({ name: FIELD_BET, value: formatCoins(totalBet), inline: true });

    if (gameOver) {
      let payout = 0;
      if (payoutOverride !== null) {
        payout = payoutOverride;
      } else {
        for (const h of this.hands) {
          if (h.result === RESULT_WIN) {
            payout += h.bet * PAYOUT_WIN_MULTIPLIER;
          } else if (h.result === RESULT_PUSH) {
            payout += h.bet;
          } else if (h.result === RESULT_BLACKJACK) {
            payout += Math.floor((h.bet * PAYOUT_BLACKJACK_NUMERATOR) / PAYOUT_BLACKJACK_DENOMINATOR);
          }
        }
      }

      embed.addFields({ name: FIELD_FINAL_PAYOUT, value: formatCoins(payout), inline: true });
    }

    embed.addFields({ name: FIELD_BALANCE, value: formatCoins(balance), inline: true });

    embed.setFooter({ text: EMBED_FOOTER });

    return embed;
  }

  // ========== Button Building ==========

  private createButtons(disabled = false): ActionRowBuilder<ButtonBuilder>[] {
    const hitBtn = new ButtonBuilder()
      .setCustomId(BTN_ID_HIT)
      .setLabel(BTN_LABEL_HIT)
      .setStyle(ButtonStyle.Primary)
      .setDisabled(disabled);

    const standBtn = new ButtonBuilder()
      .setCustomId(BTN_ID_STAND)
      .setLabel(BTN_LABEL_STAND)
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(disabled);

    const doubleBtn = new ButtonBuilder()
      .setCustomId(BTN_ID_DOUBLE)
      .setLabel(BTN_LABEL_DOUBLE)
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled || !this.canDouble());

    const splitBtn = new ButtonBuilder()
      .setCustomId(BTN_ID_SPLIT)
      .setLabel(BTN_LABEL_SPLIT)
      .setStyle(ButtonStyle.Success)
      .setDisabled(disabled || !this.canSplit());

    return [new ActionRowBuilder<ButtonBuilder>().addComponents(hitBtn, standBtn, doubleBtn, splitBtn)];
  }

  private disableAllButtons(): ActionRowBuilder<ButtonBuilder>[] {
    return this.createButtons(true);
  }

  // ========== Safe Message Editing ==========

  private async safeEdit(
    interaction: ButtonInteraction | null,
    embed: EmbedBuilder,
    components: ActionRowBuilder<ButtonBuilder>[]
  ): Promise<void> {
    try {
      if (interaction && !interaction.replied && !interaction.deferred) {
        // First update - use interaction.update() and capture the message
        await interaction.update({ embeds: [embed], components });
        // After updating, fetch the message to ensure we have it for subsequent edits
        if (!this.message) {
          this.message = await interaction.fetchReply();
        }
      } else if (this.message) {
        // Subsequent updates - edit message directly
        await this.message.edit({ embeds: [embed], components });
      } else {
        logger.warn('No message available to edit in blackjack game');
      }
    } catch (error) {
      logger.error('Failed to edit blackjack message:', error);
    }
  }

  // ========== Animations ==========

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private async animateStandToDealerReveal(interaction: ButtonInteraction, note: string | null): Promise<void> {
    const embed = await this.buildEmbed({
      revealHole: false,
      note: note || undefined,
      gameOver: false,
      hideActiveMarker: true,
    });
    // First call - respond to the interaction
    await this.safeEdit(interaction, embed, this.disableAllButtons());
    await this.sleep(1000);
  }

  private async animateDoubleDown(interaction: ButtonInteraction, note: string | null): Promise<void> {
    // Step 1: Show "double down" note with pending card
    const embed1 = await this.buildEmbed({
      revealHole: false,
      note: note || undefined,
      gameOver: false,
      playerPending: true,
    });
    await this.safeEdit(interaction, embed1, this.disableAllButtons());
    await this.sleep(1000);

    // Step 2: Draw the player's final card
    const h = this.activeHand();
    h.cards.push(this.draw());
    const hv = this.handValue(h.cards);

    const embed2 = await this.buildEmbed({
      revealHole: false,
      note: note || undefined,
      gameOver: false,
      playerPending: false,
    });
    await this.safeEdit(null, embed2, this.disableAllButtons());
    await this.sleep(1000);

    // Step 3: Check if busted
    if (hv > 21) {
      h.finished = true;
      h.result = RESULT_LOSS;
      const bustNote = this.hasUnfinishedOtherHand()
        ? '💥 **Double down**... and you busted. Moving to the next hand...'
        : '💥 **Double down**... and you busted.';
      await this.advanceOrResolve(interaction, bustNote);
      return;
    }

    // Otherwise, forced stand
    h.finished = true;
    await this.advanceOrResolve(interaction, note);
  }

  private async animateDealerPlay(interaction: ButtonInteraction, note: string | null): Promise<void> {
    // Reveal hole card first
    let pending = this.handValue(this.dealerCards) < BLACKJACK_CONFIG.DEALER_STAND_VALUE;
    const embed1 = await this.buildEmbed({
      revealHole: true,
      note: note || undefined,
      gameOver: false,
      dealerPending: pending,
      hideActiveMarker: true,
    });
    await this.safeEdit(interaction, embed1, this.disableAllButtons());

    const getDelay = (): number => {
      if (this.dealerCards.length === 2) return 1500 + Math.random() * 500;
      if (this.dealerCards.length === 3) return 2000 + Math.random() * 500;
      return 2500 + Math.random() * 500;
    };

    // Draw cards until dealer stands
    while (this.handValue(this.dealerCards) < BLACKJACK_CONFIG.DEALER_STAND_VALUE) {
      const delay = getDelay();
      await this.sleep(delay);
      this.dealerCards.push(this.draw());

      pending = this.handValue(this.dealerCards) < BLACKJACK_CONFIG.DEALER_STAND_VALUE;
      const embed = await this.buildEmbed({
        revealHole: true,
        note: note || undefined,
        gameOver: false,
        dealerPending: pending,
        hideActiveMarker: true,
      });
      await this.safeEdit(null, embed, this.disableAllButtons());
    }

    // Final state with no ❓
    const embedFinal = await this.buildEmbed({
      revealHole: true,
      note: note || undefined,
      gameOver: false,
      dealerPending: false,
      hideActiveMarker: true,
    });
    await this.safeEdit(null, embedFinal, this.disableAllButtons());
  }

  // ========== Player Actions ==========

  async hit(interaction: ButtonInteraction): Promise<void> {
    const h = this.activeHand();
    if (h.finished) return;

    h.cards.push(this.draw());
    const hv = this.handValue(h.cards);

    if (hv > 21) {
      h.finished = true;
      h.result = RESULT_LOSS;
      const note = this.hasUnfinishedOtherHand()
        ? '💀 **Busted.** Moving to the next hand...'
        : '💀 **Busted.** Resolving dealer...';
      await this.advanceOrResolve(interaction, note);
      return;
    }

    const embed = await this.buildEmbed({ revealHole: false });
    await this.safeEdit(interaction, embed, this.createButtons());
  }

  async stand(interaction: ButtonInteraction): Promise<void> {
    const h = this.activeHand();
    if (h.finished) return;
    h.finished = true;
    await this.advanceOrResolve(interaction, '✋ **Stand.**');
  }

  async double(interaction: ButtonInteraction): Promise<void> {
    const h = this.activeHand();
    if (!this.canDouble()) return;

    const balance = await this.walletService.getBalance(this.player.id, this.guildId);
    if (balance < h.bet) {
      await interaction.reply({
        content: `🚫 You need **${formatCoins(h.bet)}** more to double. Current balance: **${formatCoins(balance)}**`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Deduct extra bet
    await this.walletService.updateBalance(this.player.id, this.guildId,-h.bet, GameSource.BLACKJACK, UpdateType.BET_PLACED, {
      bet_amount: h.bet,
      choice: 'double_down',
    });

    h.bet *= 2;
    h.doubled = true;

    await this.animateDoubleDown(interaction, '💥 **Double down** taken.');
  }

  async split(interaction: ButtonInteraction): Promise<void> {
    if (!this.canSplit()) return;

    const balance = await this.walletService.getBalance(this.player.id, this.guildId);
    if (balance < this.baseBet) {
      await interaction.reply({
        content: `🚫 You need **${formatCoins(this.baseBet)}** to split. Current balance: **${formatCoins(balance)}**`,
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    // Deduct extra bet for second hand
    await this.walletService.updateBalance(this.player.id, this.guildId,-this.baseBet, GameSource.BLACKJACK, UpdateType.BET_PLACED, {
      bet_amount: this.baseBet,
      choice: 'split',
    });

    const orig = this.hands[0];
    const c1 = orig.cards[0];
    const c2 = orig.cards[1];

    const h1: BJHand = {
      cards: [c1, this.draw()],
      bet: this.baseBet,
      doubled: false,
      from_split: true,
      natural_blackjack: false,
      finished: false,
      result: null,
    };

    const h2: BJHand = {
      cards: [c2, this.draw()],
      bet: this.baseBet,
      doubled: false,
      from_split: true,
      natural_blackjack: false,
      finished: false,
      result: null,
    };

    this.hands = [h1, h2];
    this.activeHandIdx = 0;

    const embed = await this.buildEmbed({ revealHole: false, note: '🪓 **Split!** Playing Hand 1 first.' });
    await this.safeEdit(interaction, embed, this.createButtons());
  }

  // ========== Flow Control ==========

  private async advanceOrResolve(interaction: ButtonInteraction, note: string | null): Promise<void> {
    // Move to next unfinished hand
    for (let idx = 0; idx < this.hands.length; idx++) {
      if (!this.hands[idx].finished) {
        this.activeHandIdx = idx;
        const embed = await this.buildEmbed({ revealHole: false, note: note || undefined });
        await this.safeEdit(interaction, embed, this.createButtons());
        return;
      }
    }

    // All hands finished, resolve
    await this.resolveAll(interaction, note);
  }

  // ========== Resolution ==========

  private async resolveImmediateDealerBlackjack(
    interaction: ChatInputCommandInteraction | ButtonInteraction,
    revealHole: boolean
  ): Promise<void> {
    const balance = await this.walletService.getBalance(this.player.id, this.guildId);

    // Log the loss (no balance change - bet was already deducted)
    await this.walletService.logTransaction(this.player.id, this.guildId, GameSource.BLACKJACK, UpdateType.BET_LOST, {
      bet_amount: this.baseBet,
      payout_amount: 0,
      reason: 'dealer_blackjack',
    });

    for (const h of this.hands) {
      h.finished = true;
      h.result = RESULT_LOSS;
    }

    await this.statsService.updateGameStats(this.player.id, this.guildId, GameSource.BLACKJACK, false, this.baseBet, 0, {});

    const embed = await this.buildEmbed({
      revealHole,
      note: '🂡 Dealer has **BLACKJACK**. You lose.',
      gameOver: true,
    });

    if ('update' in interaction) {
      // ButtonInteraction
      await this.safeEdit(interaction as ButtonInteraction, embed, this.disableAllButtons());
    } else {
      // ChatInputCommandInteraction
      await interaction.editReply({ embeds: [embed], components: this.disableAllButtons() });
    }

    this.cleanupSession();
  }

  private async resolveImmediatePushBlackjack(
    interaction: ChatInputCommandInteraction | ButtonInteraction,
    revealHole: boolean
  ): Promise<void> {
    const balance = await this.walletService.getBalance(this.player.id, this.guildId);
    const newBalance = await this.walletService.updateBalance(
      this.player.id,
      this.guildId,
      this.baseBet,
      GameSource.BLACKJACK,
      UpdateType.BET_PUSH,
      {
        bet_amount: this.baseBet,
        payout_amount: this.baseBet,
        reason: 'both_blackjack',
      }
    );

    for (const h of this.hands) {
      h.finished = true;
      h.result = RESULT_PUSH;
    }

    // Push doesn't count as win or loss for stats, so we don't update stats here

    const embed = await this.buildEmbed({
      revealHole,
      note: '🤝 Both have **BLACKJACK**. Push.',
      gameOver: true,
    });

    if ('update' in interaction) {
      await this.safeEdit(interaction as ButtonInteraction, embed, this.disableAllButtons());
    } else {
      await interaction.editReply({ embeds: [embed], components: this.disableAllButtons() });
    }

    this.cleanupSession();
  }

  private async resolvePlayerBlackjack(interaction: ChatInputCommandInteraction | ButtonInteraction): Promise<void> {
    const payout = Math.floor((this.baseBet * PAYOUT_BLACKJACK_NUMERATOR) / PAYOUT_BLACKJACK_DENOMINATOR);
    const balance = await this.walletService.getBalance(this.player.id, this.guildId);
    const newBalance = await this.walletService.updateBalance(
      this.player.id,
      this.guildId,
      payout,
      GameSource.BLACKJACK,
      UpdateType.BET_WON,
      {
        bet_amount: this.baseBet,
        payout_amount: payout,
        blackjack: true,
        reason: 'natural_blackjack',
      }
    );

    this.hands[0].finished = true;
    this.hands[0].result = RESULT_BLACKJACK;

    await this.statsService.updateGameStats(this.player.id, this.guildId, GameSource.BLACKJACK, true, this.baseBet, payout, {
      [STAT_BLACKJACK_WINS]: 1,
    });

    const embed = await this.buildEmbed({
      revealHole: false,
      note: `🂡🃏 **BLACKJACK!** You win **${formatCoins(payout)}**.`,
      gameOver: true,
    });

    if ('update' in interaction) {
      await this.safeEdit(interaction as ButtonInteraction, embed, this.disableAllButtons());
    } else {
      await interaction.editReply({ embeds: [embed], components: this.disableAllButtons() });
    }

    this.cleanupSession();
  }

  private async resolveAll(interaction: ButtonInteraction, note: string | null): Promise<void> {
    // If all hands busted, skip dealer play
    if (this.hands.every((h) => this.handValue(h.cards) > 21)) {
      const balance = await this.walletService.getBalance(this.player.id, this.guildId);

      for (const h of this.hands) {
        h.result = RESULT_LOSS;
        h.finished = true;
        // Log the loss (no balance change - bet was already deducted)
        await this.walletService.logTransaction(this.player.id, this.guildId, GameSource.BLACKJACK, UpdateType.BET_LOST, {
          bet_amount: h.bet,
          payout_amount: 0,
          double_down: h.doubled,
          reason: 'bust',
        });
      }

      // Update stats - track each hand individually for double down stats
      for (const h of this.hands) {
        const extraStats: Record<string, any> = {};
        if (h.doubled) {
          extraStats[STAT_DOUBLE_DOWN_LOSSES] = 1;
        }
        await this.statsService.updateGameStats(this.player.id, this.guildId, GameSource.BLACKJACK, false, h.bet, 0, extraStats);
      }

      const embed = await this.buildEmbed({
        revealHole: false,
        note: note || undefined,
        gameOver: true,
      });
      await this.safeEdit(interaction, embed, this.disableAllButtons());
      this.cleanupSession();
      return;
    }

    // Suspense before dealer reveal
    await this.animateStandToDealerReveal(interaction, note);

    // Dealer plays with animation
    await this.animateDealerPlay(interaction, note);

    const dealerTotal = this.handValue(this.dealerCards);
    const dealerBust = dealerTotal > 21;

    let totalPayout = 0;
    let wonAnyHand = false;

    for (const h of this.hands) {
      if (this.handValue(h.cards) > 21) {
        h.result = RESULT_LOSS;
        h.finished = true;
        // Log the loss (no balance change - bet was already deducted)
        await this.walletService.logTransaction(this.player.id, this.guildId, GameSource.BLACKJACK, UpdateType.BET_LOST, {
          bet_amount: h.bet,
          payout_amount: 0,
          double_down: h.doubled,
          reason: 'bust',
        });
        continue;
      }

      const playerTotal = this.handValue(h.cards);

      if (dealerBust) {
        const payout = h.bet * PAYOUT_WIN_MULTIPLIER;
        totalPayout += payout;
        await this.walletService.updateBalance(this.player.id, this.guildId, payout, GameSource.BLACKJACK, UpdateType.BET_WON, {
          bet_amount: h.bet,
          payout_amount: payout,
          double_down: h.doubled,
          reason: 'dealer_bust',
        });
        h.result = RESULT_WIN;
        h.finished = true;
        wonAnyHand = true;
        continue;
      }

      if (playerTotal > dealerTotal) {
        const payout = h.bet * PAYOUT_WIN_MULTIPLIER;
        totalPayout += payout;
        await this.walletService.updateBalance(this.player.id, this.guildId, payout, GameSource.BLACKJACK, UpdateType.BET_WON, {
          bet_amount: h.bet,
          payout_amount: payout,
          double_down: h.doubled,
          reason: 'higher_than_dealer',
        });
        h.result = RESULT_WIN;
        wonAnyHand = true;
      } else if (playerTotal < dealerTotal) {
        // Log the loss (no balance change - bet was already deducted)
        await this.walletService.logTransaction(this.player.id, this.guildId, GameSource.BLACKJACK, UpdateType.BET_LOST, {
          bet_amount: h.bet,
          payout_amount: 0,
          double_down: h.doubled,
          reason: 'lower_than_dealer',
        });
        h.result = RESULT_LOSS;
      } else {
        const payout = h.bet;
        totalPayout += payout;
        await this.walletService.updateBalance(this.player.id, this.guildId,payout, GameSource.BLACKJACK, UpdateType.BET_PUSH, {
          bet_amount: h.bet,
          payout_amount: payout,
          double_down: h.doubled,
          reason: 'push',
        });
        h.result = RESULT_PUSH;
      }

      h.finished = true;
    }

    // Update stats - track each hand individually for double down stats
    for (const h of this.hands) {
      const won = h.result === RESULT_WIN || h.result === RESULT_BLACKJACK;
      const payout = won
        ? h.result === RESULT_BLACKJACK
          ? Math.floor((h.bet * PAYOUT_BLACKJACK_NUMERATOR) / PAYOUT_BLACKJACK_DENOMINATOR)
          : h.bet * PAYOUT_WIN_MULTIPLIER
        : 0;

      const extraStats: Record<string, any> = {};
      if (h.doubled && won) {
        extraStats[STAT_DOUBLE_DOWN_WINS] = 1;
      } else if (h.doubled && h.result === RESULT_LOSS) {
        extraStats[STAT_DOUBLE_DOWN_LOSSES] = 1;
      }

      if (h.result === RESULT_BLACKJACK) {
        extraStats.blackjack_wins = 1;
      }

      // Don't count pushes as wins or losses
      if (h.result !== RESULT_PUSH) {
        await this.statsService.updateGameStats(this.player.id, this.guildId, GameSource.BLACKJACK, won, h.bet, payout, extraStats);
      }
    }

    const embed = await this.buildEmbed({
      revealHole: true,
      note: note || undefined,
      gameOver: true,
    });
    await this.safeEdit(interaction, embed, this.disableAllButtons());
    this.cleanupSession();
  }

  // ========== Start Game ==========

  async start(interaction: ChatInputCommandInteraction): Promise<void> {
    // Dealer peek only if upcard is Ace or 10-value
    if (this.peekRequired() && this.dealerHasBlackjack()) {
      const reveal = true;
      if (this.playerHasBlackjack()) {
        // Both have blackjack - push
        await this.resolveImmediatePushBlackjack(interaction, reveal);
      } else {
        // Dealer wins immediately
        await this.resolveImmediateDealerBlackjack(interaction, reveal);
      }
      return;
    }

    // Player natural blackjack ends immediately (dealer didn't have blackjack)
    if (this.playerHasBlackjack()) {
      await this.resolvePlayerBlackjack(interaction);
      return;
    }

    // Normal play
    const embed = await this.buildEmbed({ revealHole: false });
    this.message = await interaction.editReply({ embeds: [embed], components: this.createButtons() });
  }

  // ========== Utility ==========

  // NOTE: Richest member updates are now handled automatically by WalletService
  // via fire-and-forget on resolved transactions. No manual triggering needed.

  getPlayerId(): string {
    return this.player.id;
  }

  setMessage(message: Message): void {
    this.message = message;
  }

  getMessage(): Message | null {
    return this.message;
  }
}

/**
 * BlackjackService manages blackjack game sessions
 */
export class BlackjackService {
  private walletService: WalletService;
  private statsService: StatsService;
  private leaderboardService: LeaderboardService;
  private gameStateService: GameStateService;
  private deckService: DeckService;
  private activeSessions: Map<string, BlackjackGame> = new Map();

  constructor(
    walletService: WalletService,
    statsService: StatsService,
    leaderboardService: LeaderboardService,
    gameStateService: GameStateService
  ) {
    this.walletService = walletService;
    this.statsService = statsService;
    this.leaderboardService = leaderboardService;
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

    // Check if user already has an active session (database check)
    if (await this.gameStateService.hasActiveGame(userId, guildId, GameSource.BLACKJACK)) {
      await interaction.reply({
        content: '🚫 You already have an active blackjack game. Finish it before starting a new one.',
        flags: MessageFlags.Ephemeral,
      });
      return null;
    }

    const balance = await this.walletService.getBalance(userId, guildId);

    if (bet > balance) {
      await interaction.reply({
        content: `You don't have enough **Hog Coins** to make that bet. Your current balance is **${formatCoins(balance)}**.`,
        flags: MessageFlags.Ephemeral,
      });
      return null;
    }

    try {
      // Deduct bet upfront
      await this.walletService.updateBalance(userId, guildId, -bet, GameSource.BLACKJACK, UpdateType.BET_PLACED, {
        bet_amount: bet,
        choice: 'game_start',
      });

      // Start game in database (prevents concurrent games, enables crash recovery)
      await this.gameStateService.startGame(userId, guildId, GameSource.BLACKJACK, bet);

      // Create game instance with cleanup callback
      const game = new BlackjackGame(
        interaction.user,
        guildId,
        bet,
        this.walletService,
        this.statsService,
        this.leaderboardService,
        this.deckService,
        async () => {
          // Cleanup callback - remove session when game ends
          this.activeSessions.delete(userId);
          await this.gameStateService.finishGame(userId, guildId, GameSource.BLACKJACK);
        }
      );

      this.activeSessions.set(interaction.user.id, game);

      // Send initial embed and return the message for collector
      await interaction.deferReply();
      await game.start(interaction);

      // Return the message so the command can attach a collector
      return game.getMessage();
    } catch (error) {
      logger.error('Error starting blackjack game:', error);

      // Clean up game state if it was created
      this.activeSessions.delete(userId);
      await this.gameStateService.finishGame(userId, guildId, GameSource.BLACKJACK);

      // Refund the bet since game failed to start
      await this.walletService.updateBalance(userId, guildId, bet, GameSource.BLACKJACK, UpdateType.REFUND, {
        bet_amount: bet,
        reason: 'Game failed to start',
      });

      // Use editReply if interaction was deferred, otherwise use reply
      if (interaction.deferred) {
        await interaction.editReply({
          content: 'An error occurred while starting Blackjack. Your bet has been refunded. Please try again.',
        });
      } else {
        await interaction.reply({
          content: 'An error occurred while starting Blackjack. Your bet has been refunded. Please try again.',
          flags: MessageFlags.Ephemeral,
        });
      }
      return null;
    }
  }

  /**
   * Get an active game session for a user
   * Used by the collector to handle button interactions
   */
  getGame(userId: string): BlackjackGame | undefined {
    return this.activeSessions.get(userId);
  }
}
