-- Hogbot Casino Database Schema
-- Multi-guild support: Each user has separate balances per guild
-- Users can participate in multiple Discord servers independently

-- ============================================================================
-- GUILD SETTINGS (Per-server configuration)
-- ============================================================================
CREATE TABLE guild_settings (
    guild_id BIGINT PRIMARY KEY,
    richest_member_role_id BIGINT,             -- Discord role ID (NULL = feature disabled)
    casino_channel_id BIGINT,                  -- Per-guild casino channel (future enhancement)
    beers_channel_id BIGINT,                   -- Voice channel ID for daily beers rename (NULL = feature disabled)
    beers_timezone VARCHAR(50) DEFAULT 'America/New_York',  -- IANA timezone for beers channel day changes
    guild_name VARCHAR(255),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_guild_settings_richest_role ON guild_settings(richest_member_role_id)
    WHERE richest_member_role_id IS NOT NULL;

CREATE INDEX idx_guild_settings_beers_channel ON guild_settings(beers_channel_id)
    WHERE beers_channel_id IS NOT NULL;

COMMENT ON TABLE guild_settings IS 'Per-guild configuration for richest member role and other features';
COMMENT ON COLUMN guild_settings.richest_member_role_id IS 'Discord role ID for richest member (NULL = feature disabled)';
COMMENT ON COLUMN guild_settings.beers_channel_id IS 'Voice channel ID for daily beers channel rename (NULL = feature disabled)';
COMMENT ON COLUMN guild_settings.beers_timezone IS 'IANA timezone for beers channel day changes (e.g., America/New_York, America/Los_Angeles, UTC)';

-- ============================================================================
-- USERS TABLE (Per-guild wallets)
-- Composite key: (user_id, guild_id) allows same user across multiple servers
-- ============================================================================
CREATE TABLE users (
    user_id BIGINT NOT NULL,
    guild_id BIGINT NOT NULL REFERENCES guild_settings(guild_id) ON DELETE CASCADE,
    username VARCHAR(255) NOT NULL DEFAULT 'Unknown',
    balance BIGINT NOT NULL DEFAULT 10000,
    high_water_balance BIGINT NOT NULL DEFAULT 10000,
    beg_count INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    PRIMARY KEY (user_id, guild_id),
    CONSTRAINT balance_non_negative CHECK (balance >= 0)
);

-- Indexes for leaderboard queries (per-guild)
CREATE INDEX idx_users_guild_balance ON users(guild_id, balance DESC);
CREATE INDEX idx_users_user_id ON users(user_id);

COMMENT ON TABLE users IS 'Discord users with per-guild wallet balances (composite key for multi-server support)';

-- ============================================================================
-- TRANSACTIONS TABLE (Immutable audit log, per-guild)
-- Single source of truth for all wallet operations and balance history
-- ============================================================================
CREATE TABLE transactions (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL,
    guild_id BIGINT NOT NULL,
    amount BIGINT NOT NULL,                    -- Can be negative for deductions
    balance_after BIGINT NOT NULL,
    game_source VARCHAR(50) NOT NULL,          -- 'blackjack', 'slots', 'ceelo', 'ride_the_bus', 'loan', 'beg'
    update_type VARCHAR(50) NOT NULL,          -- 'bet_placed', 'bet_won', 'bet_lost', 'round_won', 'crash_refund', etc.
    metadata JSONB,                            -- Flexible storage for game-specific data
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    FOREIGN KEY (user_id, guild_id) REFERENCES users(user_id, guild_id) ON DELETE CASCADE,
    FOREIGN KEY (guild_id) REFERENCES guild_settings(guild_id) ON DELETE CASCADE
);

-- Indexes for querying transaction history and balance graphs
CREATE INDEX idx_transactions_user_guild ON transactions(user_id, guild_id);
CREATE INDEX idx_transactions_guild ON transactions(guild_id);
CREATE INDEX idx_transactions_created_at ON transactions(created_at DESC);
CREATE INDEX idx_transactions_game_source ON transactions(game_source);
CREATE INDEX idx_transactions_user_guild_created ON transactions(user_id, guild_id, created_at DESC);

COMMENT ON TABLE transactions IS 'Immutable transaction log with per-guild tracking - single source of truth for wallet operations and balance history';

-- ============================================================================
-- GAME STATISTICS (Denormalized for performance, per-guild)
-- extra_stats JSONB stores game-specific data like:
-- - Slots: bonus_spins, jackpot_hits
-- - RTB: round_1_wins, round_2_wins, red_count, black_count
-- - Blackjack: double_down_wins, double_down_losses, blackjack_wins
-- ============================================================================
CREATE TABLE game_stats (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL,
    guild_id BIGINT NOT NULL,
    game_source VARCHAR(50) NOT NULL,
    played INTEGER NOT NULL DEFAULT 0,
    wins INTEGER NOT NULL DEFAULT 0,
    losses INTEGER NOT NULL DEFAULT 0,
    current_win_streak INTEGER NOT NULL DEFAULT 0,
    current_losing_streak INTEGER NOT NULL DEFAULT 0,
    best_win_streak INTEGER NOT NULL DEFAULT 0,
    worst_losing_streak INTEGER NOT NULL DEFAULT 0,
    highest_bet BIGINT NOT NULL DEFAULT 0,
    highest_payout BIGINT NOT NULL DEFAULT 0,
    highest_loss BIGINT NOT NULL DEFAULT 0,
    extra_stats JSONB,                         -- Game-specific stats (JSONB for flexibility)
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE(user_id, game_source, guild_id),
    FOREIGN KEY (user_id, guild_id) REFERENCES users(user_id, guild_id) ON DELETE CASCADE,
    FOREIGN KEY (guild_id) REFERENCES guild_settings(guild_id) ON DELETE CASCADE
);

-- Index for stats queries
CREATE INDEX idx_game_stats_user_guild ON game_stats(user_id, guild_id);
CREATE INDEX idx_game_stats_game_source ON game_stats(game_source);
CREATE INDEX idx_game_stats_guild ON game_stats(guild_id);

COMMENT ON TABLE game_stats IS 'Denormalized per-game statistics with per-guild tracking and flexible JSONB for game-specific data';

-- ============================================================================
-- PROGRESSIVE JACKPOT (Per-guild)
-- Each guild has its own independent jackpot pool
-- ============================================================================
CREATE TABLE progressive_jackpot (
    guild_id BIGINT PRIMARY KEY REFERENCES guild_settings(guild_id) ON DELETE CASCADE,
    amount BIGINT NOT NULL DEFAULT 5000000,
    last_winner_id BIGINT,
    last_won_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE progressive_jackpot IS 'Per-guild slots progressive jackpot pool (isolated server economies)';

-- ============================================================================
-- LOAN RATE LIMITING (3 loans per hour, per-guild)
-- ============================================================================
CREATE TABLE loan_rate_limits (
    id BIGSERIAL PRIMARY KEY,
    lender_id BIGINT NOT NULL,
    guild_id BIGINT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    FOREIGN KEY (guild_id) REFERENCES guild_settings(guild_id) ON DELETE CASCADE
);

-- Index for rate limit queries
CREATE INDEX idx_loan_rate_limits_lender_guild_created ON loan_rate_limits(lender_id, guild_id, created_at);

COMMENT ON TABLE loan_rate_limits IS 'Rate limiting for loans (3 per hour per lender per guild)';

-- ============================================================================
-- GAME SESSIONS (Crash recovery and game state tracking, per-guild)
-- Prevents concurrent games and enables automatic crash refunds
-- ============================================================================
CREATE TABLE game_sessions (
    session_id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL,
    guild_id BIGINT NOT NULL,
    game_source VARCHAR(50) NOT NULL,
    status VARCHAR(20) NOT NULL,  -- 'active', 'finished', 'crashed'
    bet_amount BIGINT NOT NULL,
    game_state JSONB NOT NULL DEFAULT '{}'::jsonb,  -- Game-specific state (cards, choices, etc.)

    -- Crash recovery fields
    crash_reason TEXT,
    refund_amount BIGINT,

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE(user_id, game_source, guild_id),  -- One game per user per type per guild
    FOREIGN KEY (user_id, guild_id) REFERENCES users(user_id, guild_id) ON DELETE CASCADE,
    FOREIGN KEY (guild_id) REFERENCES guild_settings(guild_id) ON DELETE CASCADE
);

-- Indexes for efficient queries
CREATE INDEX idx_game_sessions_user_game_guild ON game_sessions(user_id, game_source, guild_id, status);
CREATE INDEX idx_game_sessions_stale ON game_sessions(status, created_at) WHERE status = 'active';

COMMENT ON TABLE game_sessions IS 'Game session tracking for crash recovery with automatic refunds after timeout (per-guild)';

-- ============================================================================
-- GAME CRASH HISTORY (Audit log for crashed games, per-guild)
-- Preserves crash details for analysis and debugging
-- ============================================================================
CREATE TABLE game_crash_history (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL,
    guild_id BIGINT NOT NULL,
    game_source VARCHAR(50) NOT NULL,
    bet_amount BIGINT NOT NULL,
    refund_amount BIGINT NOT NULL,

    -- Crash details
    crash_reason TEXT NOT NULL,
    game_duration_seconds INTEGER NOT NULL,  -- How long the game was active
    game_state JSONB,                        -- Optional: snapshot of game state at crash

    -- Timestamps
    game_started_at TIMESTAMPTZ NOT NULL,
    crashed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    FOREIGN KEY (guild_id) REFERENCES guild_settings(guild_id) ON DELETE CASCADE
);

-- Indexes for crash analysis queries
CREATE INDEX idx_crash_history_user_id ON game_crash_history(user_id);
CREATE INDEX idx_crash_history_guild ON game_crash_history(guild_id);
CREATE INDEX idx_crash_history_game_source ON game_crash_history(game_source);
CREATE INDEX idx_crash_history_crashed_at ON game_crash_history(crashed_at DESC);

COMMENT ON TABLE game_crash_history IS 'Audit log of all crashed games with full crash details for analysis (per-guild)';

-- ============================================================================
-- VOICE TIME TRACKING (Per-guild, per-user)
-- Tracks time spent in voice channels with weekly and all-time aggregation
-- ============================================================================

-- Active voice sessions (who's currently in voice)
CREATE TABLE voice_sessions (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL,
    guild_id BIGINT NOT NULL REFERENCES guild_settings(guild_id) ON DELETE CASCADE,
    channel_id BIGINT NOT NULL,
    joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    -- Composite unique constraint: one active session per user per guild
    UNIQUE(user_id, guild_id)
);

CREATE INDEX idx_voice_sessions_user_guild ON voice_sessions(user_id, guild_id);
CREATE INDEX idx_voice_sessions_guild ON voice_sessions(guild_id);
CREATE INDEX idx_voice_sessions_joined_at ON voice_sessions(joined_at);

COMMENT ON TABLE voice_sessions IS 'Active voice channel sessions (currently in voice)';

-- Voice time history (completed sessions)
CREATE TABLE voice_time_history (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL,
    guild_id BIGINT NOT NULL REFERENCES guild_settings(guild_id) ON DELETE CASCADE,
    channel_id BIGINT NOT NULL,
    duration_seconds INTEGER NOT NULL CHECK (duration_seconds >= 0),
    joined_at TIMESTAMPTZ NOT NULL,
    left_at TIMESTAMPTZ NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT valid_duration CHECK (left_at >= joined_at)
);

CREATE INDEX idx_voice_time_history_user_guild ON voice_time_history(user_id, guild_id);
CREATE INDEX idx_voice_time_history_guild ON voice_time_history(guild_id);
CREATE INDEX idx_voice_time_history_left_at ON voice_time_history(left_at DESC);
CREATE INDEX idx_voice_time_history_user_guild_left ON voice_time_history(user_id, guild_id, left_at DESC);

COMMENT ON TABLE voice_time_history IS 'Historical voice channel session records (completed sessions)';

-- Voice time aggregates (denormalized for performance)
-- Stores weekly and all-time totals per user per guild
CREATE TABLE voice_time_aggregates (
    id BIGSERIAL PRIMARY KEY,
    user_id BIGINT NOT NULL,
    guild_id BIGINT NOT NULL REFERENCES guild_settings(guild_id) ON DELETE CASCADE,

    -- All-time totals
    total_seconds BIGINT NOT NULL DEFAULT 0,

    -- Weekly totals (rolling 7 days from NOW())
    weekly_seconds BIGINT NOT NULL DEFAULT 0,
    weekly_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    UNIQUE(user_id, guild_id)
);

CREATE INDEX idx_voice_time_aggregates_user_guild ON voice_time_aggregates(user_id, guild_id);
CREATE INDEX idx_voice_time_aggregates_guild_total ON voice_time_aggregates(guild_id, total_seconds DESC);
CREATE INDEX idx_voice_time_aggregates_guild_weekly ON voice_time_aggregates(guild_id, weekly_seconds DESC);

COMMENT ON TABLE voice_time_aggregates IS 'Denormalized voice time totals (weekly and all-time) for fast leaderboard queries';

-- ============================================================================
-- SCHEMA COMPLETE
-- All application logic handled in TypeScript services
-- ============================================================================
