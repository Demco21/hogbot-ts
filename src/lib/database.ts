import pg from 'pg';
import { Config } from '../config.js';
import { safeLogger as logger } from './safe-logger.js';

const { Pool, types } = pg;

/**
 * CRITICAL: Do NOT parse BIGINT as numbers globally!
 *
 * Discord snowflake IDs (guild_id, user_id, channel_id, role_id) exceed
 * Number.MAX_SAFE_INTEGER (9,007,199,254,740,991), causing precision loss.
 *
 * Example bug: Channel ID 1262202594596622458 becomes 1262202594596622300
 *
 * Strategy:
 * - Keep BIGINTs as strings by default (pg's default behavior)
 * - Parse to numbers ONLY for currency amounts using parseBigInt() helper
 * - Always use strings for Discord IDs
 */
// DO NOT set a global BIGINT parser!

/**
 * Helper function to safely parse BIGINT currency values from database
 * Use this for balance, amount, payout, etc. - NOT for Discord IDs!
 *
 * @param value - BIGINT value from database (string or number)
 * @returns Parsed number value
 */
export function parseBigInt(value: string | number | null | undefined): number {
  if (value === null || value === undefined) {
    return 0;
  }
  if (typeof value === 'number') {
    return value;
  }
  const parsed = parseInt(value, 10);
  if (isNaN(parsed)) {
    logger.warn(`Failed to parse BIGINT value: ${value}`);
    return 0;
  }
  return parsed;
}

/**
 * PostgreSQL connection pool
 */
export const pool = new Pool({
  host: Config.database.host,
  port: Config.database.port,
  database: Config.database.database,
  user: Config.database.user,
  password: Config.database.password,
  max: 20, // Maximum connections in pool
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 2000,
  // SSL configuration for AWS RDS
  // For production: Use SSL with certificate verification
  // For development (localhost): Disable SSL
  ssl:
    process.env.NODE_ENV === 'production'
      ? {
          rejectUnauthorized: true, // Verify SSL certificates (secure)
          // AWS RDS certificates are signed by Amazon RDS CA, which should be trusted
          // If connection fails, you may need to set rejectUnauthorized: false temporarily
        }
      : false,
});

/**
 * Initialize database connection and verify schema
 */
export async function initializeDatabase(): Promise<void> {
  const client = await pool.connect();
  try {
    // Test connection
    const result = await client.query('SELECT NOW()');
    logger.info(`✓ Database connected at ${result.rows[0].now}`);

    // Verify tables exist
    const tables = await client.query(`
      SELECT table_name
      FROM information_schema.tables
      WHERE table_schema = 'public'
      AND table_type = 'BASE TABLE'
    `);

    const requiredTables = [
      'users',
      'transactions',
      'game_stats',
      'progressive_jackpot',
      'loan_rate_limits',
      'game_sessions',
      'game_crash_history',
      'voice_sessions',
      'voice_time_history',
      'voice_time_aggregates',
    ];

    const existingTables = tables.rows.map((row) => row.table_name);
    const missingTables = requiredTables.filter((t) => !existingTables.includes(t));

    if (missingTables.length > 0) {
      throw new Error(`Missing required tables: ${missingTables.join(', ')}`);
    }

    logger.info(`✓ All required tables present (${existingTables.length} total)`);
  } catch (error) {
    logger.error('Failed to initialize database:', error);
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Gracefully close database connection pool
 */
export async function closeDatabase(): Promise<void> {
  await pool.end();
  logger.info('Database connection pool closed');
}

/**
 * Health check for database connection
 */
export async function isDatabaseHealthy(): Promise<boolean> {
  try {
    const client = await pool.connect();
    await client.query('SELECT 1');
    client.release();
    return true;
  } catch (error) {
    logger.error('Database health check failed:', error);
    return false;
  }
}
