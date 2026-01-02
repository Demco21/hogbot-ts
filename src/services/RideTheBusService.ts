/**
 * RideTheBusService - Handles Ride the Bus game logic
 * Ported from: E:\dev\repos\hogbot\services\ride_the_bus_service.py
 */

export interface Card {
  rank: number; // 2-14 (11=J, 12=Q, 13=K, 14=A)
  suit: string; // ♠️, ♥️, ♦️, ♣️
}

export class RideTheBusService {
  /**
   * Build a shuffled 52-card deck
   */
  buildDeck(): Card[] {
    const suits = ['♠️', '♥️', '♦️', '♣️'];
    const deck: Card[] = [];

    for (const suit of suits) {
      for (let rank = 2; rank <= 14; rank++) {
        // 2-10, 11=J, 12=Q, 13=K, 14=A
        deck.push({ rank, suit });
      }
    }

    // Fisher-Yates shuffle
    for (let i = deck.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [deck[i], deck[j]] = [deck[j], deck[i]];
    }

    return deck;
  }

  /**
   * Get card color (red or black)
   */
  getCardColor(card: Card): 'red' | 'black' {
    if (card.suit === '♥️' || card.suit === '♦️') {
      return 'red';
    }
    return 'black';
  }

  /**
   * Format card as string (e.g., "A♠️", "10♥️", "K♣️")
   */
  formatCard(card: Card): string {
    const rankMap: Record<number, string> = {
      11: 'J',
      12: 'Q',
      13: 'K',
      14: 'A',
    };
    const rankStr = rankMap[card.rank] || card.rank.toString();
    return `${rankStr}${card.suit}`;
  }

  /**
   * Format cards array for display
   */
  formatCards(cards: Card[]): string {
    if (cards.length === 0) return '❓ ❓ ❓ ❓';
    if (cards.length === 1) return `${this.formatCard(cards[0])} ❓ ❓ ❓`;
    if (cards.length === 2) return `${this.formatCard(cards[0])} ${this.formatCard(cards[1])} ❓ ❓`;
    if (cards.length === 3)
      return `${this.formatCard(cards[0])} ${this.formatCard(cards[1])} ${this.formatCard(cards[2])} ❓`;

    return cards.map((c) => this.formatCard(c)).join(' ');
  }

  /**
   * Calculate potential payout for a given multiplier
   */
  calculatePayout(bet: number, multiplier: number): number {
    return bet * multiplier;
  }
}
