/**
 * DeckService - Shared card deck management for card games
 *
 * Provides standard 52-card deck creation, shuffling, and card utilities.
 * Used by Blackjack and Ride the Bus.
 */

export interface Card {
  rank: number; // 2-14 (11=J, 12=Q, 13=K, 14=A)
  suit: string; // ♠️, ♥️, ♦️, ♣️
}

export type CardColor = 'red' | 'black';

const SUITS = ['♠️', '♥️', '♦️', '♣️'] as const;
const RANK_DISPLAY: Record<number, string> = {
  11: 'J',
  12: 'Q',
  13: 'K',
  14: 'A',
};

export class DeckService {
  /**
   * Create a new shuffled 52-card deck
   */
  createDeck(): Card[] {
    const deck: Card[] = [];

    for (const suit of SUITS) {
      for (let rank = 2; rank <= 14; rank++) {
        deck.push({ rank, suit });
      }
    }

    return this.shuffle(deck);
  }

  /**
   * Shuffle a deck using Fisher-Yates algorithm
   */
  shuffle(deck: Card[]): Card[] {
    const shuffled = [...deck];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
  }

  /**
   * Draw a card from the deck (removes and returns the last card)
   * If deck is empty, creates a new shuffled deck first
   */
  draw(deck: Card[]): Card {
    if (deck.length === 0) {
      const newDeck = this.createDeck();
      deck.push(...newDeck);
    }
    return deck.pop()!;
  }

  /**
   * Get the color of a card (red for hearts/diamonds, black for spades/clubs)
   */
  getCardColor(card: Card): CardColor {
    return card.suit === '♥️' || card.suit === '♦️' ? 'red' : 'black';
  }

  /**
   * Format a single card for display (e.g., "A♠️", "10♥️", "K♣️")
   */
  formatCard(card: Card): string {
    const rankStr = RANK_DISPLAY[card.rank] ?? card.rank.toString();
    return `${rankStr}${card.suit}`;
  }

  /**
   * Format an array of cards for display
   */
  formatCards(cards: Card[]): string {
    return cards.map((c) => this.formatCard(c)).join(' ');
  }

  /**
   * Get the blackjack value of a card
   * Face cards (J, Q, K) = 10, Ace = 11, others = face value
   */
  getBlackjackValue(card: Card): number {
    if (card.rank >= 11 && card.rank <= 13) return 10;
    if (card.rank === 14) return 11; // Ace
    return card.rank;
  }

  /**
   * Check if a card is a 10-value card (10, J, Q, K)
   */
  isTenValue(card: Card): boolean {
    return card.rank === 10 || (card.rank >= 11 && card.rank <= 13);
  }
}
