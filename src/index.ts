import { SapphireClient, container, ApplicationCommandRegistries, RegisterBehavior } from '@sapphire/framework';
import { GatewayIntentBits, Partials } from 'discord.js';
import { Config } from './config.js';
import { SapphireWinstonLogger, winstonLogger } from './lib/logger.js';
import { initializeDatabase, closeDatabase } from './lib/database.js';
import { startCleanupJobs } from './lib/cleanup.js';
import { startBeersScheduler } from './tasks/beers-scheduler.js';
import { WalletService } from './services/WalletService.js';
import { LeaderboardService } from './services/LeaderboardService.js';
import { StatsService } from './services/StatsService.js';
import { BlackjackService } from './services/BlackjackService.js';
import { RideTheBusService } from './services/RideTheBusService.js';
import { GameStateService } from './services/GameStateService.js';
import { GuildSettingsService } from './services/GuildSettingsService.js';
import { VoiceTimeService } from './services/VoiceTimeService.js';

// Configure Sapphire to not overwrite commands unless they changed
// This prevents unnecessary command recreation and propagation delays
ApplicationCommandRegistries.setDefaultBehaviorWhenNotIdentical(RegisterBehavior.BulkOverwrite);

// Augment Sapphire's Container interface to include our services
declare module '@sapphire/pieces' {
  interface Container {
    guildSettingsService: GuildSettingsService;
    walletService: WalletService;
    leaderboardService: LeaderboardService;
    statsService: StatsService;
    blackjackService: BlackjackService;
    rideTheBusService: RideTheBusService;
    gameStateService: GameStateService;
    voiceTimeService: VoiceTimeService;
  }
}

/**
 * Extended Sapphire client with custom services
 */
class HogBotClient extends SapphireClient {
  public constructor() {
    super({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildVoiceStates,
      ],
      partials: [Partials.GuildMember],
      loadMessageCommandListeners: true,
      logger: {
        instance: new SapphireWinstonLogger(),
      },
      // Tell Sapphire where to find pieces (commands, listeners, preconditions)
      // When running with tsx in dev, use src/ directory
      // When running compiled code in production, use dist/ directory (current directory)
      baseUserDirectory: new URL(
        process.env.NODE_ENV === 'production' ? './' : '../src/',
        import.meta.url
      ),
    });
  }

  public override async login(token?: string): Promise<string> {
    // Initialize services and attach to container before login
    container.guildSettingsService = new GuildSettingsService();
    container.walletService = new WalletService();
    container.leaderboardService = new LeaderboardService();
    container.statsService = new StatsService();
    container.gameStateService = new GameStateService();
    container.voiceTimeService = new VoiceTimeService();
    container.blackjackService = new BlackjackService(
      container.walletService,
      container.statsService,
      container.leaderboardService,
      container.gameStateService
    );
    container.rideTheBusService = new RideTheBusService(
      container.walletService,
      container.statsService,
      container.gameStateService
    );

    // Initialize database before logging in
    await initializeDatabase();

    // Initialize richest member tracking for all guilds
    await container.leaderboardService.initializeAllGuilds();

    // Start cleanup jobs for crashed games
    startCleanupJobs();

    // Start beers channel scheduler
    startBeersScheduler();

    // Cleanup stale voice sessions (bot restart recovery)
    await container.voiceTimeService.cleanupStaleSessions();

    return super.login(token);
  }

  public override async destroy(): Promise<void> {
    // Clean up database connection
    await closeDatabase();
    return super.destroy();
  }
}

// Create and login bot
const client = new HogBotClient();

// Handle process signals for graceful shutdown
process.on('SIGINT', async () => {
  winstonLogger.info('Received SIGINT, shutting down gracefully...');
  await client.destroy();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  winstonLogger.info('Received SIGTERM, shutting down gracefully...');
  await client.destroy();
  process.exit(0);
});

// Handle unhandled rejections
process.on('unhandledRejection', (error) => {
  winstonLogger.error('Unhandled rejection:', error);
});

// Login
client.login(Config.discord.token).catch((error) => {
  client.logger.error('Failed to login:', error);
  process.exit(1);
});
