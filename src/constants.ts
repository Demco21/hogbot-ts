/**
 * Game sources for transaction tracking
 */
export enum GameSource {
  BLACKJACK = 'blackjack',
  SLOTS = 'slots',
  CEELO = 'ceelo',
  RIDE_THE_BUS = 'ride_the_bus',
  LOAN = 'loan',
  BEG = 'beg',
  ADMIN = 'admin',
}

/**
 * Transaction update types for detailed tracking
 */
export enum UpdateType {
  // Betting
  BET_PLACED = 'bet_placed',
  BET_WON = 'bet_won',
  BET_LOST = 'bet_lost',
  BET_PUSH = 'bet_push',

  // Game events
  ROUND_WON = 'round_won',

  // Economy
  LOAN_SENT = 'loan_sent',
  LOAN_RECEIVED = 'loan_received',
  BEG_RECEIVED = 'beg_received',
  ADMIN_ADJUSTMENT = 'admin_adjustment',

  // Refunds
  REFUND = 'refund',
  CRASH_REFUND = 'crash_refund',
}

/**
 * Casino configuration constants
 */
export const CASINO_CONFIG = {
  // Starting balance for new users
  STARTING_BALANCE: 10000,

  // Beg command
  BEG_MIN: 500,
  BEG_MAX: 1000,

  // Loan command
  LOAN_RATE_LIMIT: 3, // loans per hour
  LOAN_RATE_LIMIT_WINDOW_HOURS: 1,
} as const;

/**
 * Game bet limits
 */
export const GAME_BET_LIMITS = {
  BLACKJACK: {
    MIN: 50,
    MAX: 100_000,
  },
  SLOTS: {
    MIN: 50,
    MAX: 10_000,
  },
  CEELO: {
    MIN: 50,
    MAX: 100_000,
  },
  RIDE_THE_BUS: {
    MIN: 50,
    MAX: 100_000,
  },
} as const;

/**
 * Game interaction timeout (in minutes)
 * How long players have to respond to game prompts before the game times out
 * This is the normal player inactivity timeout
 */
export const GAME_INTERACTION_TIMEOUT_MINUTES = 3; // 3 minutes for all games

/**
 * Game session crash threshold (in minutes)
 * Games inactive for this duration will be auto-crashed and refunded
 * This is for detecting games that crashed unexpectedly (bot restart, etc.)
 *
 * Automatically set to GAME_INTERACTION_TIMEOUT_MINUTES + 1 to give a buffer
 * for detecting crashed games after the normal timeout period.
 */
export const GAME_CRASH_THRESHOLD_MINUTES: Record<GameSource, number> = {
  [GameSource.BLACKJACK]: GAME_INTERACTION_TIMEOUT_MINUTES + 1,
  [GameSource.SLOTS]: GAME_INTERACTION_TIMEOUT_MINUTES + 1,
  [GameSource.CEELO]: GAME_INTERACTION_TIMEOUT_MINUTES + 1,
  [GameSource.RIDE_THE_BUS]: GAME_INTERACTION_TIMEOUT_MINUTES + 1,
  [GameSource.LOAN]: GAME_INTERACTION_TIMEOUT_MINUTES + 1,
  [GameSource.BEG]: GAME_INTERACTION_TIMEOUT_MINUTES + 1,
  [GameSource.ADMIN]: GAME_INTERACTION_TIMEOUT_MINUTES + 1,
} as const;

/**
 * Blackjack configuration
 */
export const BLACKJACK_CONFIG = {
  DEALER_STAND_VALUE: 17,
} as const;

/**
 * Stats command configuration
 */
export const STATS_CONFIG = {
  // Balance history graph limits
  HISTORY_DEFAULT: 100, // Default number of rounds to show
  HISTORY_MIN: 2, // Minimum rounds allowed
  HISTORY_MAX: 1000, // Maximum rounds allowed
} as const;
