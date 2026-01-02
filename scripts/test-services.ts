import { initializeDatabase, closeDatabase, pool } from '../src/lib/database.js';
import { WalletService } from '../src/services/WalletService.js';
import { LeaderboardService } from '../src/services/LeaderboardService.js';
import { StatsService } from '../src/services/StatsService.js';
import { GameSource, UpdateType } from '../src/constants.js';

/**
 * Test script to verify database connectivity and service functionality
 */
async function testServices() {
  console.log('🧪 Starting service tests...\n');

  try {
    // Test 1: Database connection
    console.log('📊 Test 1: Database Connection');
    await initializeDatabase();
    console.log('✅ Database connected successfully\n');

    // Test 2: WalletService
    console.log('💰 Test 2: WalletService');
    const walletService = new WalletService();

    const testUserId = '12345';
    const testUsername = 'TestUser';

    // Create user
    const user = await walletService.createUser(testUserId, testUsername);
    console.log(`✅ User created: ${user.username} with balance ${user.balance}`);

    // Test balance update
    const updatedBalance = await walletService.updateBalance(
      testUserId,
      500,
      GameSource.ADMIN,
      UpdateType.ADMIN_ADJUSTMENT
    );
    console.log(`✅ Balance updated: ${updatedBalance}\n`);

    // Test 3: LeaderboardService
    console.log('🏆 Test 3: LeaderboardService');
    const leaderboardService = new LeaderboardService();

    const topUsers = await leaderboardService.getTopUsers(5);
    console.log(`✅ Retrieved top ${topUsers.length} users`);

    const userRank = await leaderboardService.getUserRank(testUserId);
    console.log(`✅ User rank: ${userRank}\n`);

    // Test 4: StatsService
    console.log('📈 Test 4: StatsService');
    const statsService = new StatsService();

    await statsService.updateGameStats(
      testUserId,
      GameSource.BLACKJACK,
      true,  // won
      1000,  // bet
      1500   // payout (bet + winnings)
    );
    console.log('✅ Game result recorded');

    const gameStats = await statsService.getGameStats(testUserId, GameSource.BLACKJACK);
    console.log(`✅ Game stats retrieved: ${gameStats?.games_played || 0} games played`);

    const wrappedStats = await statsService.getWrappedStats(testUserId);
    console.log(`✅ Wrapped stats retrieved: ${wrappedStats.total_games_played} total games\n`);

    // Test 5: Progressive Jackpot
    console.log('💎 Test 5: Progressive Jackpot');
    const client = await pool.connect();
    try {
      const result = await client.query('SELECT * FROM progressive_jackpot');
      console.log(`✅ Jackpot value: ${result.rows[0]?.current_amount || 0}\n`);
    } finally {
      client.release();
    }

    console.log('✅ All tests passed!\n');

  } catch (error) {
    console.error('❌ Test failed:', error);
    process.exit(1);
  } finally {
    await closeDatabase();
    console.log('🔌 Database connection closed');
  }
}

// Run tests
testServices();
