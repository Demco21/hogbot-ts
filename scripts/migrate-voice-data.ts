/**
 * Migration script to import voice time data from old bot
 * Reads from data/persistence_data.json and populates voice_time_aggregates table
 *
 * ONE-TIME USE SCRIPT - Hardcoded guild ID
 */

import { readFileSync } from 'fs';
import { pool } from '../src/lib/database.js';

interface PersistenceData {
  lifetime_sums: Record<string, string>;
  this_week_time_sums: Record<string, string>;
}

// Hardcoded guild ID for migration
const GUILD_ID = '367904135548239872';

/**
 * Parses time string format "days:hours:minutes:seconds" to total seconds
 * Example: "76:04:59:37" = (76 days * 86400) + (4 hours * 3600) + (59 min * 60) + 37 sec
 */
function parseTimeToSeconds(timeString: string): number {
  const parts = timeString.split(':').map(Number);

  if (parts.length !== 4) {
    throw new Error(`Invalid time format: ${timeString}`);
  }

  const [days, hours, minutes, seconds] = parts;

  return (days * 86400) + (hours * 3600) + (minutes * 60) + seconds;
}

/**
 * Extracts user_id from key like "223647480741363713_voice"
 * Returns null if not a voice key
 */
function extractUserIdFromVoiceKey(key: string): string | null {
  if (!key.endsWith('_voice')) {
    return null;
  }

  return key.replace('_voice', '');
}

async function migrateVoiceData() {
  const client = await pool.connect();

  try {
    console.log('📊 Starting voice time data migration...\n');

    // Read and parse JSON file
    const jsonPath = './data/persistence_data.json';
    const rawData = readFileSync(jsonPath, 'utf-8');
    const data: PersistenceData = JSON.parse(rawData);

    console.log(`🏰 Guild ID: ${GUILD_ID}\n`);

    // Ensure guild exists in database
    await client.query(
      `INSERT INTO guild_settings (guild_id)
       VALUES ($1)
       ON CONFLICT (guild_id) DO NOTHING`,
      [GUILD_ID]
    );

    // Extract voice data
    const voiceData = new Map<string, { lifetimeSeconds: number; weeklySeconds: number }>();

    // Process lifetime_sums
    for (const [key, timeString] of Object.entries(data.lifetime_sums)) {
      const userId = extractUserIdFromVoiceKey(key);
      if (userId) {
        const lifetimeSeconds = parseTimeToSeconds(timeString);
        voiceData.set(userId, { lifetimeSeconds, weeklySeconds: 0 });
      }
    }

    // Process this_week_time_sums
    for (const [key, timeString] of Object.entries(data.this_week_time_sums)) {
      const userId = extractUserIdFromVoiceKey(key);
      if (userId) {
        const weeklySeconds = parseTimeToSeconds(timeString);
        const existing = voiceData.get(userId);

        if (existing) {
          existing.weeklySeconds = weeklySeconds;
        } else {
          // User has weekly data but no lifetime data (shouldn't happen, but handle it)
          voiceData.set(userId, { lifetimeSeconds: weeklySeconds, weeklySeconds });
        }
      }
    }

    console.log(`👥 Found ${voiceData.size} users with voice time data\n`);

    // Insert data into database
    await client.query('BEGIN');

    let insertedCount = 0;
    let skippedCount = 0;

    for (const [userId, { lifetimeSeconds, weeklySeconds }] of voiceData.entries()) {
      try {
        await client.query(
          `INSERT INTO voice_time_aggregates (user_id, guild_id, total_seconds, weekly_seconds, weekly_updated_at)
           VALUES ($1, $2, $3, $4, NOW())
           ON CONFLICT (user_id, guild_id) DO UPDATE
           SET total_seconds = EXCLUDED.total_seconds,
               weekly_seconds = EXCLUDED.weekly_seconds,
               weekly_updated_at = NOW(),
               updated_at = NOW()`,
          [userId, GUILD_ID, lifetimeSeconds, weeklySeconds]
        );

        insertedCount++;

        // Log progress every 10 users
        if (insertedCount % 10 === 0) {
          console.log(`✅ Migrated ${insertedCount} users...`);
        }
      } catch (error) {
        console.error(`❌ Failed to insert user ${userId}:`, error);
        skippedCount++;
      }
    }

    await client.query('COMMIT');

    console.log('\n✅ Migration complete!');
    console.log(`   📥 Inserted/Updated: ${insertedCount} users`);
    if (skippedCount > 0) {
      console.log(`   ⚠️  Skipped: ${skippedCount} users`);
    }

    // Show sample of migrated data
    console.log('\n📊 Sample migrated data:');
    const sample = await client.query(
      `SELECT user_id, total_seconds, weekly_seconds
       FROM voice_time_aggregates
       WHERE guild_id = $1
       ORDER BY total_seconds DESC
       LIMIT 5`,
      [GUILD_ID]
    );

    console.log('\nTop 5 users by total voice time:');
    for (const row of sample.rows) {
      const hours = Math.floor(row.total_seconds / 3600);
      const weeklyHours = Math.floor(row.weekly_seconds / 3600);
      console.log(`  User ${row.user_id}: ${hours.toLocaleString()} hours total, ${weeklyHours.toLocaleString()} hours this week`);
    }

  } catch (error) {
    await client.query('ROLLBACK');
    console.error('❌ Migration failed:', error);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

// Run migration
migrateVoiceData().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
