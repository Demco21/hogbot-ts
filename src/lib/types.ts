import { GameSource, UpdateType } from '../constants.js';

/**
 * Database user record
 */
export interface User {
  user_id: string;
  username: string;
  balance: number;
  high_water_balance: number;
  beg_count: number;
  created_at: string;
  updated_at: string;
}

/**
 * Transaction record for audit log
 */
export interface Transaction {
  id: number;
  user_id: string;
  amount: number;
  balance_after: number;
  game_source: GameSource;
  update_type: UpdateType;
  metadata: Record<string, any>;
  created_at: string;
}

/**
 * Balance history snapshot
 */
export interface BalanceHistory {
  id: number;
  user_id: string;
  balance: number;
  created_at: string;
}

/**
 * Game statistics per user per game
 */
export interface GameStats {
  id: number;
  user_id: string;
  game_source: GameSource;
  played: number;
  wins: number;
  losses: number;
  current_win_streak: number;
  current_losing_streak: number;
  best_win_streak: number;
  worst_losing_streak: number;
  highest_bet: number;
  highest_payout: number;
  highest_loss: number;
  extra_stats: Record<string, any>;
  created_at: string;
  updated_at: string;
}

/**
 * Progressive jackpot (single row)
 */
export interface ProgressiveJackpot {
  id: number;
  amount: number;
  last_winner_id: string | null;
  last_won_at: string | null;
  created_at: string;
  updated_at: string;
}

/**
 * Active game session for crash recovery
 */
export interface ActiveGameSession {
  id: string;
  user_id: string;
  game_source: GameSource;
  state: Record<string, any>;
  created_at: string;
  expires_at: string;
}

/**
 * Leaderboard entry
 */
export interface LeaderboardEntry {
  user_id: string;
  username: string;
  balance: number;
  rank: number;
}

/**
 * Wrapped game stats (aggregated across all games)
 */
export interface WrappedStats {
  total_games_played: number;
  total_won: number;
  total_lost: number;
  total_wagered: number;
  total_winnings: number;
  net_profit: number;
  win_rate: number;
  favorite_game: GameSource | null;
  biggest_win: number;
  biggest_loss: number;
  current_streak: number;
  best_streak: number;
  worst_streak: number;
}

/**
 * Card suits and ranks for card games
 */
export enum Suit {
  HEARTS = '♥️',
  DIAMONDS = '♦️',
  CLUBS = '♣️',
  SPADES = '♠️',
}

export enum Rank {
  ACE = 'A',
  TWO = '2',
  THREE = '3',
  FOUR = '4',
  FIVE = '5',
  SIX = '6',
  SEVEN = '7',
  EIGHT = '8',
  NINE = '9',
  TEN = '10',
  JACK = 'J',
  QUEEN = 'Q',
  KING = 'K',
}

export interface Card {
  suit: Suit;
  rank: Rank;
}

/**
 * Service container for dependency injection
 */
export interface ServiceContainer {
  walletService: any;
  leaderboardService: any;
  statsService: any;
}

/**
 * Voice Time Tracking Types
 */

export interface VoiceSession {
  id: number;
  user_id: string;
  guild_id: string;
  channel_id: string;
  joined_at: string;
}

export interface VoiceTimeHistory {
  id: number;
  user_id: string;
  guild_id: string;
  channel_id: string;
  duration_seconds: number;
  joined_at: string;
  left_at: string;
  created_at: string;
}

export interface VoiceTimeAggregate {
  id: number;
  user_id: string;
  guild_id: string;
  total_seconds: number;
  weekly_seconds: number;
  weekly_updated_at: string;
  created_at: string;
  updated_at: string;
}

export interface VoiceTimeStats {
  user_id: string;
  username: string;
  total_seconds: number;
  weekly_seconds: number;
  active_session_seconds: number;
}

export interface VoiceTimeLeaderboardEntry {
  user_id: string;
  username: string;
  seconds: number;
  rank: number;
}
