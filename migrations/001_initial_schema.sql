-- Hogbot Casino Database Schema (SQLite)
-- Multi-guild support: Each user has separate balances per guild
--
-- NOTE: This file is a reference copy of the schema.
-- The authoritative schema lives in src/lib/database.ts and is applied
-- automatically on bot startup via db.exec(SCHEMA). You do not need to
-- run this file manually.

-- ============================================================================
-- GUILD SETTINGS (Per-server configuration)
-- ============================================================================
CREATE TABLE IF NOT EXISTS guild_settings (
    guild_id TEXT PRIMARY KEY,
    richest_member_role_id TEXT,              -- Discord role ID (NULL = feature disabled)
    casino_channel_id TEXT,                   -- Per-guild casino channel (NULL = unrestricted)
    beers_channel_id TEXT,                    -- Voice channel ID for daily beers rename (NULL = disabled)
    beers_timezone TEXT DEFAULT 'America/New_York',  -- IANA timezone for beers channel
    guild_name TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================================
-- USERS TABLE (Per-guild wallets)
-- Composite key: (user_id, guild_id) allows same user across multiple servers
-- ============================================================================
CREATE TABLE IF NOT EXISTS users (
    user_id TEXT NOT NULL,
    guild_id TEXT NOT NULL REFERENCES guild_settings(guild_id) ON DELETE CASCADE,
    username TEXT NOT NULL DEFAULT 'Unknown',
    balance INTEGER NOT NULL DEFAULT 10000,
    high_water_balance INTEGER NOT NULL DEFAULT 10000,
    beg_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, guild_id),
    CHECK (balance >= 0)
);

CREATE INDEX IF NOT EXISTS idx_users_guild_balance ON users(guild_id, balance DESC);
CREATE INDEX IF NOT EXISTS idx_users_user_id ON users(user_id);

-- ============================================================================
-- TRANSACTIONS TABLE (Immutable audit log, per-guild)
-- Single source of truth for all wallet operations and balance history.
-- Balance graphs are derived from this table (filtering out bet_placed/round_won).
-- ============================================================================
CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    guild_id TEXT NOT NULL,
    amount INTEGER NOT NULL,                  -- Negative for deductions
    balance_after INTEGER NOT NULL,
    game_source TEXT NOT NULL,               -- 'blackjack', 'slots', 'ride_the_bus', 'loan', 'beg', etc.
    update_type TEXT NOT NULL,               -- 'bet_placed', 'bet_won', 'bet_lost', 'round_won', 'crash_refund', etc.
    metadata TEXT,                           -- JSON string for game-specific data
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id, guild_id) REFERENCES users(user_id, guild_id) ON DELETE CASCADE,
    FOREIGN KEY (guild_id) REFERENCES guild_settings(guild_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_transactions_user_guild ON transactions(user_id, guild_id);
CREATE INDEX IF NOT EXISTS idx_transactions_guild ON transactions(guild_id);
CREATE INDEX IF NOT EXISTS idx_transactions_created_at ON transactions(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_transactions_game_source ON transactions(game_source);
CREATE INDEX IF NOT EXISTS idx_transactions_user_guild_created ON transactions(user_id, guild_id, created_at DESC);

-- ============================================================================
-- GAME STATISTICS (Denormalized for performance, per-guild)
-- extra_stats stores JSON for game-specific data:
--   Slots: bonus_spins, jackpot_hits
--   RTB: round_1_wins, round_2_wins, red_count, black_count
--   Blackjack: double_down_wins, double_down_losses, blackjack_wins
-- ============================================================================
CREATE TABLE IF NOT EXISTS game_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    guild_id TEXT NOT NULL,
    game_source TEXT NOT NULL,
    played INTEGER NOT NULL DEFAULT 0,
    wins INTEGER NOT NULL DEFAULT 0,
    losses INTEGER NOT NULL DEFAULT 0,
    current_win_streak INTEGER NOT NULL DEFAULT 0,
    current_losing_streak INTEGER NOT NULL DEFAULT 0,
    best_win_streak INTEGER NOT NULL DEFAULT 0,
    worst_losing_streak INTEGER NOT NULL DEFAULT 0,
    highest_bet INTEGER NOT NULL DEFAULT 0,
    highest_payout INTEGER NOT NULL DEFAULT 0,
    highest_loss INTEGER NOT NULL DEFAULT 0,
    extra_stats TEXT,                        -- JSON string for game-specific stats
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, game_source, guild_id),
    FOREIGN KEY (user_id, guild_id) REFERENCES users(user_id, guild_id) ON DELETE CASCADE,
    FOREIGN KEY (guild_id) REFERENCES guild_settings(guild_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_game_stats_user_guild ON game_stats(user_id, guild_id);
CREATE INDEX IF NOT EXISTS idx_game_stats_game_source ON game_stats(game_source);
CREATE INDEX IF NOT EXISTS idx_game_stats_guild ON game_stats(guild_id);

-- ============================================================================
-- PROGRESSIVE JACKPOT (Per-guild)
-- Each guild has its own independent jackpot pool
-- ============================================================================
CREATE TABLE IF NOT EXISTS progressive_jackpot (
    guild_id TEXT PRIMARY KEY REFERENCES guild_settings(guild_id) ON DELETE CASCADE,
    amount INTEGER NOT NULL DEFAULT 5000000,
    last_winner_id TEXT,
    last_won_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- ============================================================================
-- LOAN RATE LIMITING (3 loans per hour, per lender per guild)
-- ============================================================================
CREATE TABLE IF NOT EXISTS loan_rate_limits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lender_id TEXT NOT NULL,
    guild_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (guild_id) REFERENCES guild_settings(guild_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_loan_rate_limits_lender_guild_created ON loan_rate_limits(lender_id, guild_id, created_at);

-- ============================================================================
-- GAME SESSIONS (Crash recovery and game state tracking, per-guild)
-- Prevents concurrent games and enables automatic crash refunds on restart
-- ============================================================================
CREATE TABLE IF NOT EXISTS game_sessions (
    session_id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    guild_id TEXT NOT NULL,
    game_source TEXT NOT NULL,
    status TEXT NOT NULL,                    -- 'active', 'finished', 'crashed'
    bet_amount INTEGER NOT NULL,
    game_state TEXT NOT NULL DEFAULT '{}',   -- JSON string for game-specific state
    crash_reason TEXT,
    refund_amount INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, game_source, guild_id),  -- One game per user per type per guild
    FOREIGN KEY (user_id, guild_id) REFERENCES users(user_id, guild_id) ON DELETE CASCADE,
    FOREIGN KEY (guild_id) REFERENCES guild_settings(guild_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_game_sessions_user_game_guild ON game_sessions(user_id, game_source, guild_id, status);

-- ============================================================================
-- GAME CRASH HISTORY (Audit log for crashed games, per-guild)
-- ============================================================================
CREATE TABLE IF NOT EXISTS game_crash_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    guild_id TEXT NOT NULL,
    game_source TEXT NOT NULL,
    bet_amount INTEGER NOT NULL,
    refund_amount INTEGER NOT NULL,
    crash_reason TEXT NOT NULL,
    game_duration_seconds INTEGER NOT NULL,
    game_state TEXT,                         -- JSON snapshot of game state at crash
    game_started_at TEXT NOT NULL,
    crashed_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (guild_id) REFERENCES guild_settings(guild_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_crash_history_user_id ON game_crash_history(user_id);
CREATE INDEX IF NOT EXISTS idx_crash_history_guild ON game_crash_history(guild_id);
CREATE INDEX IF NOT EXISTS idx_crash_history_crashed_at ON game_crash_history(crashed_at DESC);

-- ============================================================================
-- VOICE TIME TRACKING (Per-guild, per-user)
-- ============================================================================

-- Active voice sessions (who is currently in a voice channel)
CREATE TABLE IF NOT EXISTS voice_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    guild_id TEXT NOT NULL REFERENCES guild_settings(guild_id) ON DELETE CASCADE,
    channel_id TEXT NOT NULL,
    joined_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, guild_id)               -- One active session per user per guild
);

CREATE INDEX IF NOT EXISTS idx_voice_sessions_user_guild ON voice_sessions(user_id, guild_id);
CREATE INDEX IF NOT EXISTS idx_voice_sessions_joined_at ON voice_sessions(joined_at);

-- Completed voice sessions (historical record)
CREATE TABLE IF NOT EXISTS voice_time_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    guild_id TEXT NOT NULL REFERENCES guild_settings(guild_id) ON DELETE CASCADE,
    channel_id TEXT NOT NULL,
    duration_seconds INTEGER NOT NULL CHECK (duration_seconds >= 0),
    joined_at TEXT NOT NULL,
    left_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_voice_time_history_user_guild ON voice_time_history(user_id, guild_id);
CREATE INDEX IF NOT EXISTS idx_voice_time_history_left_at ON voice_time_history(left_at DESC);
CREATE INDEX IF NOT EXISTS idx_voice_time_history_user_guild_left ON voice_time_history(user_id, guild_id, left_at DESC);

-- Denormalized totals for fast leaderboard queries
CREATE TABLE IF NOT EXISTS voice_time_aggregates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    guild_id TEXT NOT NULL REFERENCES guild_settings(guild_id) ON DELETE CASCADE,
    total_seconds INTEGER NOT NULL DEFAULT 0,
    weekly_seconds INTEGER NOT NULL DEFAULT 0,   -- Rolling 7-day window, recalculated periodically
    weekly_updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, guild_id)
);

CREATE INDEX IF NOT EXISTS idx_voice_time_aggregates_guild_total ON voice_time_aggregates(guild_id, total_seconds DESC);
CREATE INDEX IF NOT EXISTS idx_voice_time_aggregates_guild_weekly ON voice_time_aggregates(guild_id, weekly_seconds DESC);

-- ============================================================================
-- SCHEMA COMPLETE
-- All application logic handled in TypeScript services (src/services/)
-- ============================================================================
