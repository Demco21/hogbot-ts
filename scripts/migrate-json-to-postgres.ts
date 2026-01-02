/**
 * Migration script to transfer data from Python bot's JSON persistence
 * to PostgreSQL database
 *
 * Run with: npm run migrate
 */
import { readFile } from 'fs/promises';
import { pool } from '../src/lib/database.js';
import { GameSource } from '../src/constants.js';

interface PersistenceData {
  member_wallets: Record<string, number>;
  balance_history: Record<string, number[]>;
  slots_progressive_jackpot: number;
  wrapped: {
    members: Record<
      string,
      {
        high_water_balance: number;
        beg_count: number;
        games: Record<
          string,
          {
            played: number;
            wins: number;
            losses: number;
            cur_win_streak: number;
            cur_losing_streak: number;
            best_win_streak: number;
            worst_losing_streak: number;
            [key: string]: any;
          }
        >;
      }
    >;
  };
}

async function migrate() {
  console.log('🚀 Starting migration from JSON to PostgreSQL...\n');

  const client = await pool.connect();

  try {
    // Read persistence data
    const jsonPath = '../Hogbot/data/persistence_data.json';
    const jsonData = await readFile(jsonPath, 'utf-8');
    const data: PersistenceData = JSON.parse(jsonData);

    await client.query('BEGIN');

    // 1. Migrate users and wallets
    console.log('📊 Migrating user wallets...');
    let userCount = 0;
    for (const [userId, balance] of Object.entries(data.member_wallets)) {
      const wrappedData = data.wrapped?.members?.[userId];
      const highWaterBalance = wrappedData?.high_water_balance || balance;
      const begCount = wrappedData?.beg_count || 0;

      await client.query(
        `INSERT INTO users (user_id, username, balance, high_water_balance, beg_count)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (user_id) DO UPDATE
         SET balance = EXCLUDED.balance,
             high_water_balance = EXCLUDED.high_water_balance,
             beg_count = EXCLUDED.beg_count`,
        [userId, 'Unknown', balance, highWaterBalance, begCount]
      );
      userCount++;
    }
    console.log(`  ✓ Migrated ${userCount} users\n`);

    // 2. Migrate balance history
    console.log('📈 Migrating balance history...');
    let historyCount = 0;
    for (const [userId, balances] of Object.entries(data.balance_history || {})) {
      // Take last 100 entries (database keeps max 100)
      const recentBalances = balances.slice(-100);

      for (const balance of recentBalances) {
        await client.query(
          `INSERT INTO balance_history (user_id, balance)
           VALUES ($1, $2)`,
          [userId, balance]
        );
        historyCount++;
      }
    }
    console.log(`  ✓ Migrated ${historyCount} balance history entries\n`);

    // 3. Migrate game statistics
    console.log('🎮 Migrating game statistics...');
    let statsCount = 0;
    for (const [userId, wrappedData] of Object.entries(data.wrapped?.members || {})) {
      for (const [gameName, gameStats] of Object.entries(wrappedData.games || {})) {
        // Map Python game names to TypeScript GameSource enum
        const gameSourceMap: Record<string, GameSource> = {
          blackjack: GameSource.BLACKJACK,
          slots: GameSource.SLOTS,
          ceelo: GameSource.CEELO,
          ride_the_bus: GameSource.RIDE_THE_BUS,
        };

        const gameSource = gameSourceMap[gameName];
        if (!gameSource) {
          console.log(`  ⚠️  Skipping unknown game: ${gameName}`);
          continue;
        }

        // Extract extra stats (game-specific data)
        const extraStats: Record<string, any> = {};
        for (const [key, value] of Object.entries(gameStats)) {
          if (
            ![
              'played',
              'wins',
              'losses',
              'cur_win_streak',
              'cur_losing_streak',
              'best_win_streak',
              'worst_losing_streak',
            ].includes(key)
          ) {
            extraStats[key] = value;
          }
        }

        await client.query(
          `INSERT INTO game_stats (
             user_id, game_source, played, wins, losses,
             current_win_streak, current_losing_streak,
             best_win_streak, worst_losing_streak,
             highest_bet, highest_payout, highest_loss,
             extra_stats
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
           ON CONFLICT (user_id, game_source) DO UPDATE
           SET played = EXCLUDED.played,
               wins = EXCLUDED.wins,
               losses = EXCLUDED.losses,
               current_win_streak = EXCLUDED.current_win_streak,
               current_losing_streak = EXCLUDED.current_losing_streak,
               best_win_streak = EXCLUDED.best_win_streak,
               worst_losing_streak = EXCLUDED.worst_losing_streak,
               extra_stats = EXCLUDED.extra_stats`,
          [
            userId,
            gameSource,
            gameStats.played || 0,
            gameStats.wins || 0,
            gameStats.losses || 0,
            gameStats.cur_win_streak || 0,
            gameStats.cur_losing_streak || 0,
            gameStats.best_win_streak || 0,
            gameStats.worst_losing_streak || 0,
            0, // highest_bet (not in old data)
            0, // highest_payout (not in old data)
            0, // highest_loss (not in old data)
            JSON.stringify(extraStats),
          ]
        );
        statsCount++;
      }
    }
    console.log(`  ✓ Migrated ${statsCount} game statistics entries\n`);

    // 4. Migrate progressive jackpot
    console.log('💎 Migrating progressive jackpot...');
    const jackpotAmount = data.slots_progressive_jackpot || 100000;
    await client.query(
      `UPDATE progressive_jackpot
       SET amount = $1, updated_at = NOW()
       WHERE id = 1`,
      [jackpotAmount]
    );
    console.log(`  ✓ Set progressive jackpot to ${jackpotAmount.toLocaleString()} coins\n`);

    await client.query('COMMIT');

    console.log('✅ Migration completed successfully!\n');
    console.log('Summary:');
    console.log(`  • ${userCount} users migrated`);
    console.log(`  • ${historyCount} balance history entries migrated`);
    console.log(`  • ${statsCount} game statistics entries migrated`);
    console.log(`  • Progressive jackpot set to ${jackpotAmount.toLocaleString()} coins`);
  } catch (error) {
    await client.query('ROLLBACK');
    console.error('\n❌ Migration failed:', error);
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}

// Run migration
migrate()
  .then(() => {
    console.log('\n🎉 All done! Database is ready to use.');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n💥 Migration error:', error);
    process.exit(1);
  });
