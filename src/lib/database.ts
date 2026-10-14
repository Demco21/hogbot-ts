import Database, { type Database as DatabaseType } from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import { safeLogger as logger } from './safe-logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const DB_PATH = process.env.DATABASE_FILE ?? path.join(__dirname, '../../hogbot.db');

export const db: DatabaseType = new Database(DB_PATH);

// WAL mode: concurrent reads don't block writes, much better performance
db.pragma('journal_mode = WAL');
// Foreign key constraints are disabled by default in SQLite
db.pragma('foreign_keys = ON');

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS guild_settings (
    guild_id TEXT PRIMARY KEY,
    richest_member_role_id TEXT,
    casino_channel_id TEXT,
    beers_channel_id TEXT,
    timezone TEXT DEFAULT 'America/New_York',
    guild_name TEXT,
    ai_access_role_id TEXT,
    streaks_enabled INTEGER NOT NULL DEFAULT 0,
    streak_last_rollover_date TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

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

  CREATE TABLE IF NOT EXISTS transactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    guild_id TEXT NOT NULL,
    amount INTEGER NOT NULL,
    balance_after INTEGER NOT NULL,
    game_source TEXT NOT NULL,
    update_type TEXT NOT NULL,
    metadata TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (user_id, guild_id) REFERENCES users(user_id, guild_id) ON DELETE CASCADE,
    FOREIGN KEY (guild_id) REFERENCES guild_settings(guild_id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_transactions_user_guild ON transactions(user_id, guild_id);
  CREATE INDEX IF NOT EXISTS idx_transactions_guild ON transactions(guild_id);
  CREATE INDEX IF NOT EXISTS idx_transactions_created_at ON transactions(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_transactions_game_source ON transactions(game_source);
  CREATE INDEX IF NOT EXISTS idx_transactions_user_guild_created ON transactions(user_id, guild_id, created_at DESC);

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
    extra_stats TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, game_source, guild_id),
    FOREIGN KEY (user_id, guild_id) REFERENCES users(user_id, guild_id) ON DELETE CASCADE,
    FOREIGN KEY (guild_id) REFERENCES guild_settings(guild_id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_game_stats_user_guild ON game_stats(user_id, guild_id);
  CREATE INDEX IF NOT EXISTS idx_game_stats_game_source ON game_stats(game_source);
  CREATE INDEX IF NOT EXISTS idx_game_stats_guild ON game_stats(guild_id);

  CREATE TABLE IF NOT EXISTS progressive_jackpot (
    guild_id TEXT PRIMARY KEY REFERENCES guild_settings(guild_id) ON DELETE CASCADE,
    amount INTEGER NOT NULL DEFAULT 5000000,
    last_winner_id TEXT,
    last_won_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS loan_rate_limits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lender_id TEXT NOT NULL,
    guild_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (guild_id) REFERENCES guild_settings(guild_id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_loan_rate_limits_lender_guild_created ON loan_rate_limits(lender_id, guild_id, created_at);

  CREATE TABLE IF NOT EXISTS ai_rate_limits (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    guild_id TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (guild_id) REFERENCES guild_settings(guild_id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_ai_rate_limits_user_guild_created ON ai_rate_limits(user_id, guild_id, created_at);

  CREATE TABLE IF NOT EXISTS game_sessions (
    session_id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    guild_id TEXT NOT NULL,
    game_source TEXT NOT NULL,
    status TEXT NOT NULL,
    bet_amount INTEGER NOT NULL,
    game_state TEXT NOT NULL DEFAULT '{}',
    crash_reason TEXT,
    refund_amount INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, game_source, guild_id),
    FOREIGN KEY (user_id, guild_id) REFERENCES users(user_id, guild_id) ON DELETE CASCADE,
    FOREIGN KEY (guild_id) REFERENCES guild_settings(guild_id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_game_sessions_user_game_guild ON game_sessions(user_id, game_source, guild_id, status);

  CREATE TABLE IF NOT EXISTS game_crash_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    guild_id TEXT NOT NULL,
    game_source TEXT NOT NULL,
    bet_amount INTEGER NOT NULL,
    refund_amount INTEGER NOT NULL,
    crash_reason TEXT NOT NULL,
    game_duration_seconds INTEGER NOT NULL,
    game_state TEXT,
    game_started_at TEXT NOT NULL,
    crashed_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (guild_id) REFERENCES guild_settings(guild_id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_crash_history_user_id ON game_crash_history(user_id);
  CREATE INDEX IF NOT EXISTS idx_crash_history_guild ON game_crash_history(guild_id);
  CREATE INDEX IF NOT EXISTS idx_crash_history_crashed_at ON game_crash_history(crashed_at DESC);

  CREATE TABLE IF NOT EXISTS voice_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    guild_id TEXT NOT NULL REFERENCES guild_settings(guild_id) ON DELETE CASCADE,
    channel_id TEXT NOT NULL,
    joined_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, guild_id)
  );

  CREATE INDEX IF NOT EXISTS idx_voice_sessions_user_guild ON voice_sessions(user_id, guild_id);
  CREATE INDEX IF NOT EXISTS idx_voice_sessions_joined_at ON voice_sessions(joined_at);

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

  CREATE TABLE IF NOT EXISTS voice_time_aggregates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL,
    guild_id TEXT NOT NULL REFERENCES guild_settings(guild_id) ON DELETE CASCADE,
    total_seconds INTEGER NOT NULL DEFAULT 0,
    weekly_seconds INTEGER NOT NULL DEFAULT 0,
    weekly_updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(user_id, guild_id)
  );

  CREATE INDEX IF NOT EXISTS idx_voice_time_aggregates_guild_total ON voice_time_aggregates(guild_id, total_seconds DESC);
  CREATE INDEX IF NOT EXISTS idx_voice_time_aggregates_guild_weekly ON voice_time_aggregates(guild_id, weekly_seconds DESC);

  -- Daily voice streaks. Dates are 'YYYY-MM-DD' in the guild's timezone (guild_settings.timezone).
  CREATE TABLE IF NOT EXISTS voice_streaks (
    user_id TEXT NOT NULL,
    guild_id TEXT NOT NULL REFERENCES guild_settings(guild_id) ON DELETE CASCADE,
    current_streak INTEGER NOT NULL DEFAULT 0 CHECK (current_streak >= 0),
    longest_streak INTEGER NOT NULL DEFAULT 0 CHECK (longest_streak >= 0),
    last_active_date TEXT,
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (user_id, guild_id)
  );

  CREATE INDEX IF NOT EXISTS idx_voice_streaks_guild_streak ON voice_streaks(guild_id, current_streak);

  -- Streak roles created and owned by HogBot (one per distinct streak length in use).
  -- Only roles listed here are ever modified or deleted by the streak feature.
  CREATE TABLE IF NOT EXISTS streak_roles (
    guild_id TEXT NOT NULL REFERENCES guild_settings(guild_id) ON DELETE CASCADE,
    streak_days INTEGER NOT NULL CHECK (streak_days > 0),
    role_id TEXT NOT NULL UNIQUE,
    PRIMARY KEY (guild_id, streak_days)
  );
`;

/**
 * Adds columns introduced after a table's initial CREATE TABLE IF NOT EXISTS, for
 * existing databases created before the column existed. CREATE TABLE IF NOT EXISTS is a
 * no-op once the table already exists, so new columns need an explicit ALTER TABLE here -
 * guarded by a PRAGMA table_info check since SQLite has no ADD COLUMN IF NOT EXISTS.
 */
function addColumnIfMissing(table: string, column: string, definition: string): void {
  const columns = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  if (columns.some((col) => col.name === column)) return;

  db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  logger.info(`Migrated: added column ${table}.${column}`);
}

/**
 * Renames a column on an existing database (no-op on fresh databases, which are created
 * with the new name). Uses ALTER TABLE ... RENAME COLUMN (SQLite 3.25+), which preserves
 * the column's data.
 */
function renameColumnIfExists(table: string, from: string, to: string): void {
  const columns = (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((col) => col.name);
  if (!columns.includes(from)) return;

  if (columns.includes(to)) {
    logger.warn(`Skipped rename of ${table}.${from} -> ${to}: both columns exist`);
    return;
  }

  db.exec(`ALTER TABLE ${table} RENAME COLUMN ${from} TO ${to}`);
  logger.info(`Migrated: renamed column ${table}.${from} -> ${to}`);
}

export async function initializeDatabase(): Promise<void> {
  try {
    db.exec(SCHEMA);
    // Timezone is shared by beers + voice streaks, so it is no longer named after beers
    renameColumnIfExists('guild_settings', 'beers_timezone', 'timezone');
    addColumnIfMissing('guild_settings', 'ai_access_role_id', 'TEXT');
    addColumnIfMissing('guild_settings', 'streaks_enabled', 'INTEGER NOT NULL DEFAULT 0');
    addColumnIfMissing('guild_settings', 'streak_last_rollover_date', 'TEXT');

    const tables = (
      db.prepare(`SELECT name FROM sqlite_master WHERE type='table' ORDER BY name`).all() as { name: string }[]
    ).map((r) => r.name);

    logger.info(`✓ Database initialized at ${DB_PATH}`);
    logger.info(`✓ Tables present: ${tables.join(', ')}`);
  } catch (error) {
    logger.error('Failed to initialize database:', error);
    throw error;
  }
}

export async function closeDatabase(): Promise<void> {
  db.close();
  logger.info('Database closed');
}

export function isDatabaseHealthy(): boolean {
  try {
    db.prepare('SELECT 1').get();
    return true;
  } catch {
    return false;
  }
}
