# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## ⚠️ CRITICAL: Code Quality Standards

**When planning or implementing code changes, ALWAYS do things the "right way" using best practices.**

### Non-Negotiable Principles

**NEVER compromise on:**
- ✅ Best practices and design patterns
- ✅ Maintainability and readability
- ✅ Security (SQL injection prevention, input validation, proper auth)
- ✅ Type safety (use proper TypeScript types, never `as any` without justification)
- ✅ Code quality and consistency
- ✅ **Stats accuracy - ALWAYS verify transaction logging and graph correctness after implementing any feature or game**

**NEVER take shortcuts for:**
- ❌ "Quick fixes" or temporary workarounds
- ❌ "Good enough" solutions that create technical debt
- ❌ Easy wins that sacrifice long-term maintainability
- ❌ Type assertions (`as any`) to bypass TypeScript errors without understanding the root cause

### When Encountering Difficult Problems

1. **Research** the proper solution (official documentation, best practices)
2. **Implement** it correctly using established patterns
3. **Document** why this is the right approach
4. **Test** to verify it works as intended
5. **Never settle** for hacks, workarounds, or compromises

### Examples of Doing It Right

**✅ CORRECT:**
```typescript
// Properly augment Sapphire container and use official pattern
import { container } from '@sapphire/framework';
declare module '@sapphire/pieces' {
  interface Container {
    walletService: WalletService;
  }
}
container.walletService = new WalletService();
```

**❌ WRONG:**
```typescript
// Type assertion to bypass errors without understanding the problem
(this as any).container.walletService = new WalletService();
```

**✅ CORRECT:**
```typescript
// Parameterized queries to prevent SQL injection
await client.query('SELECT * FROM users WHERE id = $1', [userId]);
```

**❌ WRONG:**
```typescript
// String concatenation vulnerable to SQL injection
await client.query(`SELECT * FROM users WHERE id = '${userId}'`);
```

---

## Project Overview

**HogBot-TS** is a Discord casino bot built with TypeScript, discord.js (Sapphire Framework), and PostgreSQL. Features include casino games (blackjack, slots, cee-lo, ride the bus), wallet management, leaderboards, and game statistics tracking.

## Running the Bot

### Prerequisites
- Node.js 24+ (LTS)
- Docker Desktop (for PostgreSQL)
- Discord bot token

### Local Development

```bash
# Install dependencies
npm install

# Start PostgreSQL database (uses docker-compose.yml)
docker-compose up -d

# Run in development mode (with auto-reload)
npm run dev

# Build for production
npm run build
npm start
```

### Environment Setup

The bot requires a `.env` file with the following variables:

```env
# Discord Configuration
DISCORD_TOKEN=your_bot_token_here
GUILD_ID=your_guild_id
CASINO_CHANNEL_ID=your_casino_channel_id
RICHEST_MEMBER_ROLE_ID=your_role_id

# Database Configuration
DATABASE_HOST=localhost
DATABASE_PORT=5432
DATABASE_NAME=hogbot
DATABASE_USER=hogbot
DATABASE_PASSWORD=your_password

# Environment
NODE_ENV=development
```

Use `.env.example` as a template.

## Architecture Overview

### Core Components

**HogBotClient (`src/index.ts`)**
- Custom Sapphire client that extends `SapphireClient`
- Initializes all services (WalletService, LeaderboardService, StatsService)
- Services are attached to `client.container` for global access
- Handles database initialization on login and cleanup on destroy
- Graceful shutdown handlers for SIGINT/SIGTERM

**Services (`src/services/`)**
- **WalletService**: Balance operations, user creation, coin transfers, transaction logging
- **LeaderboardService**: Rankings, richest member role management (debounced updates)
- **StatsService**: Per-game statistics, wrapped stats, streak tracking, high scores
- **DeckService**: Shared card deck management (used by Blackjack, Ride the Bus)
- All services use the PostgreSQL connection pool from `lib/database.ts`
- Services are accessed via `this.container.walletService` in commands

**Commands (`src/commands/`)**
- Sapphire command pattern using `@ApplyOptions` decorator
- Guild-specific commands using `registerGuildCommands`
- Preconditions for channel restrictions (e.g., `CasinoChannelOnly`)
- All casino commands should use the `CasinoChannelOnly` precondition
- File names use kebab-case (e.g., `ride-the-bus.ts`, `my-wallet.ts`)

**Utilities (`src/utils/`)**
- **utils.ts**: Generic formatting utilities (`formatCoins`, `formatDuration`)
- **game-utils.ts**: Shared game UI utilities (`handleGameTimeoutUI`)

**Tasks (`src/tasks/`)**
- **beers-scheduler.ts**: Scheduled background jobs

**Database Layer (`src/lib/database.ts`)**
- PostgreSQL connection pool with 20 max connections
- Health check and schema verification on startup
- Connection management: get connection, execute query, release in finally block
- All financial operations use database functions for atomicity

### Database Schema

**Core Tables:**
- `users`: User wallets, metadata, last_active timestamps
- `transactions`: Immutable transaction log (game_source, update_type, amount, balance_after)
- `balance_history`: Circular buffer (max 100 per user) for balance graphing
- `game_stats`: Per-game win/loss/streak statistics
- `progressive_jackpot`: Single-row table for slots jackpot pool
- `loan_rate_limits`: Enforces 3 loans per hour per user
- `active_game_sessions`: For crash recovery in complex games
- `rtb_color_stats`: Ride the Bus color choice statistics

**Database Functions:**
- `update_wallet_with_history()`: Atomic balance update + transaction log + history entry
- `transfer_coins()`: Atomic coin transfer between two users
- `update_richest_member()`: Trigger function to track richest member changes

**Views:**
- `leaderboard_view`: Optimized view for leaderboard queries

### Key Patterns

**Atomic Transactions**
- All balance modifications use `update_wallet_with_history()` database function
- This ensures balance updates, transaction logging, and history tracking happen atomically
- Never update balances with raw SQL - always use the database function

**Service Dependency Injection**
- Services are instantiated in the `login()` method override
- Attached to the global `container` object imported from `@sapphire/framework`
- The Container interface is augmented to include service types
- Commands access services via `this.container.walletService`, etc.

**Sapphire Command Pattern**
```typescript
import { Command } from '@sapphire/framework';
import { ApplyOptions } from '@sapphire/decorators';
import { Config } from '../config.js';

@ApplyOptions<Command.Options>({
  name: 'commandname',
  description: 'Command description',
  preconditions: ['CasinoChannelOnly'], // Optional
})
export class MyCommand extends Command {
  public override registerApplicationCommands(registry: Command.Registry) {
    registry.registerChatInputCommand(
      (builder) =>
        builder
          .setName(this.name)
          .setDescription(this.description)
          .addStringOption((option) =>
            option.setName('param').setDescription('Parameter description').setRequired(true)
          ),
      { guildIds: [Config.discord.guildId] } // Guild-specific
    );
  }

  public override async chatInputRun(interaction: Command.ChatInputCommandInteraction) {
    try {
      // Access services from container (available after client login)
      const balance = await this.container.walletService.getBalance(userId);
      const topUsers = await this.container.leaderboardService.getTopUsers(10);

      // Command logic here
      await interaction.reply({ content: 'Response' });
    } catch (error) {
      this.container.logger.error('Error in command:', error);
      await interaction.reply({ content: 'Error occurred', ephemeral: true });
    }
  }
}
```

**Preconditions**
- Use `CasinoChannelOnly` precondition for all casino/gambling commands
- Preconditions run before command execution
- Return `this.error()` or `this.ok()` from precondition

**Error Handling**
- Wrap command logic in try/catch
- Log errors with `this.container.logger.error()`
- Always release database connections in `finally` blocks
- Send user-friendly error messages with `ephemeral: true`

**Leaderboard Role Management**
- Richest member role is updated automatically via debounced function
- 5-second debounce prevents role spam during rapid balance changes

## TypeScript/Node.js Development Guidelines

### Modern TypeScript (ES2022)
- Use native TypeScript types: `string | null`, `Record<string, number>`, etc.
- Use `interface` or `type` for complex types
- Store type definitions in `src/lib/types.ts`

### ES Modules
- This project uses ES modules (`"type": "module"` in package.json)
- Always use `.js` extensions in imports: `import { foo } from './foo.js'`
- TypeScript will compile `.ts` to `.js`, but imports must reference `.js`

### Async Patterns
- All Discord interactions and database queries are async
- Use `async/await` - no callbacks or raw promises
- Database connections must be released in `finally` blocks:
  ```typescript
  const client = await pool.connect();
  try {
    const result = await client.query('SELECT ...');
    return result.rows;
  } finally {
    client.release();
  }
  ```

### Discord.js (v14) Patterns
- **Interaction responses**:
  - Use `interaction.reply()` for initial response
  - Use `interaction.followUp()` for additional messages
  - Use `interaction.editReply()` to update original response
  - Add `ephemeral: true` for private messages
- **Guild-specific commands**: Register with `guildIds: [Config.discord.guildId]`
- **Embeds**: Use `EmbedBuilder` from discord.js
  ```typescript
  import { EmbedBuilder } from 'discord.js';

  const embed = new EmbedBuilder()
    .setColor(0x0099ff)
    .setTitle('Title')
    .setDescription('Description')
    .addFields({ name: 'Field', value: 'Value' });
  ```

### Sapphire Framework Patterns
- **Commands**: Extend `Command` class, use `@ApplyOptions` decorator
- **Listeners**: Extend `Listener` class for event handling
- **Preconditions**: Extend `Precondition` class for command guards
- **Container**: Access services via `this.container.<serviceName>`
- **Logger**: Use `this.container.logger` (Sapphire's logger)

### Database Patterns

**⚠️ CRITICAL: Use Application Logic, Not Database Functions**

We use **application logic with SQL transactions** instead of database functions for all wallet operations. This provides:
- ✅ Better testability (can unit test TypeScript)
- ✅ Type safety (TypeScript types, not SQL)
- ✅ Easier debugging (step through code)
- ✅ Better code review (visible in PRs)
- ✅ Version control (no migration scripts for logic changes)

**Wallet Operations Pattern:**
```typescript
async updateBalance(...) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    // 1. Ensure user exists (upsert)
    await client.query(
      `INSERT INTO users (user_id, balance, username)
       VALUES ($1, 10000, 'Unknown')
       ON CONFLICT (user_id) DO NOTHING`,
      [userId]
    );

    // 2. Update balance atomically
    const result = await client.query(
      `UPDATE users
       SET balance = balance + $1,
           high_water_balance = GREATEST(high_water_balance, balance + $1),
           updated_at = NOW()
       WHERE user_id = $2
       RETURNING balance`,
      [amount, userId]
    );

    // 3. Log transaction
    await client.query(
      `INSERT INTO transactions (user_id, amount, balance_after, ...)
       VALUES ($1, $2, $3, ...)`,
      [userId, amount, newBalance, ...]
    );

    await client.query('COMMIT');
    return newBalance;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}
```

**General Database Rules:**
- Use parameterized queries to prevent SQL injection: `client.query('SELECT * FROM users WHERE id = $1', [userId])`
- Always use transactions (`BEGIN/COMMIT/ROLLBACK`) for multi-query operations
- Connection pooling is automatic - get connection, use it, release it in `finally`
- Use `RETURNING *` to get updated row data in INSERT/UPDATE queries
- **IMPORTANT:** BIGINT columns are configured to parse as JavaScript numbers (via `types.setTypeParser(20, ...)` in `database.ts`)
  - This is safe for in-game currency (won't exceed `Number.MAX_SAFE_INTEGER`)
  - Without this, `pg` returns BIGINT as strings, breaking `toLocaleString()` formatting

**Balance History:**
- The `transactions` table is the single source of truth
- Balance history for graphs is queried from `transactions` table, filtering out `bet_placed` and `round_won`
- No separate `balance_history` table needed - eliminates data duplication

### Error Handling & Logging
- Import logger: `this.container.logger` (in commands/listeners)
- Log levels: `logger.info()`, `logger.warn()`, `logger.error()`
- Always catch and log errors in command handlers
- Provide user-friendly error messages

### Constants & Configuration
- Environment variables: `src/config.ts` (validated with Zod)
- Game constants: `src/constants.ts` (CASINO_CONFIG, enums)
- Use `Config.discord.token`, `Config.database.host`, etc.
- Enums: `GameSource`, `UpdateType` for transaction tracking

### State Management
- All state is stored in PostgreSQL
- Services query database as needed
- Caching should be minimal and invalidated properly

## Important Files

- `src/index.ts`: Bot entry point, client initialization
- `src/config.ts`: Environment variables with Zod validation
- `src/constants.ts`: Game enums (GameSource, UpdateType), casino config
- `src/lib/database.ts`: PostgreSQL connection pool
- `src/lib/types.ts`: TypeScript type definitions
- `src/utils/utils.ts`: Formatting utilities (formatCoins, formatDuration)
- `src/utils/game-utils.ts`: Shared game UI utilities (timeout handling)
- `src/services/WalletService.ts`: Balance operations
- `src/services/LeaderboardService.ts`: Rankings and richest member role
- `src/services/StatsService.ts`: Game statistics tracking
- `src/services/DeckService.ts`: Shared card deck management

## Testing During Development

- Use `npm run dev` for auto-reload during development
- Test all commands in the designated casino channel
- Check database state with:
  ```bash
  docker exec -it hogbot-postgres psql -U hogbot -d hogbot
  ```
- View logs in console (Sapphire logger outputs to stdout)

## Code Style Preferences

- Use `async/await` over `.then()` chains
- Prefer `const` over `let` when possible
- Use descriptive variable names (e.g., `userBalance` not `bal`)
- Keep functions focused and single-purpose
- Add JSDoc comments for complex functions
- Use TypeScript strict mode (enabled in tsconfig.json)
- **CRITICAL: ALWAYS use `formatCoins()` for displaying coin amounts**
  - Import from `src/utils/utils.ts`
  - NEVER use raw numbers or manual `toLocaleString()` for coin amounts
  - This ensures consistent formatting with commas and coin emoji across all views
  - Example: `formatCoins(1000)` → `🪙 1,000`

### File Naming Conventions

**We follow Sapphire Framework conventions:**

| Category | Convention | Reason | Example |
|----------|------------|--------|---------|
| **Services** | PascalCase | Manually imported and instantiated | `BlackjackService.ts`, `DeckService.ts` |
| **Commands** | kebab-case | Named after the slash command | `ride-the-bus.ts`, `my-wallet.ts` |
| **Listeners** | camelCase | Named after Discord.js event | `voiceStateUpdate.ts`, `guildCreate.ts` |
| **Preconditions** | PascalCase | Descriptive class names | `CasinoChannelOnly.ts` |
| **Utilities** | kebab-case | Pure functions, not classes | `game-utils.ts`, `utils.ts` |
| **Tasks/Jobs** | kebab-case | Background scripts | `beers-scheduler.ts` |
| **Config** | lowercase | Simple config files | `config.ts`, `constants.ts` |

**The distinction:**
- **Services** = things you manually `import` and instantiate → **PascalCase**
- **Framework-managed pieces** (commands, listeners) = Sapphire auto-loads these → **match what they handle**
- **Everything else** = **kebab-case**

Note: Commands, listeners, and preconditions all export classes, but file naming follows what they *represent* (the command name, the event name) rather than the class name.

## Common Patterns to Follow

### Creating a new command:
1. Create file in `src/commands/<command-name>.ts` (use kebab-case for multi-word names)
2. Extend `Command` class
3. Use `@ApplyOptions` decorator with name, description, preconditions
4. Implement `registerApplicationCommands()` to define slash command structure
5. Implement `chatInputRun()` for command logic
6. Access services via `this.container.<serviceName>`
7. Wrap in try/catch, log errors, send user-friendly messages

### Adding a new game:

1. Create GameService in `src/services/<GameName>Service.ts` with game logic
2. Add game to `GameSource` enum in `constants.ts`
3. Add game-specific update types to `UpdateType` enum if needed
4. Create command in `src/commands/<game-name>.ts` (use kebab-case)
5. Use `CasinoChannelOnly` precondition
6. Use `WalletService` for all balance operations
7. For card games, use `DeckService` for deck/card management
8. Use `handleGameTimeoutUI()` from `src/utils/game-utils.ts` for timeout handling
7. **CRITICAL: Log ALL game transactions (bet_placed, bet_won, bet_lost)**
   ```typescript
   // 1. When bet is placed (deduct from balance)
   await this.container.walletService.updateBalance(
     userId,
     -betAmount,
     GameSource.YOUR_GAME,
     UpdateType.BET_PLACED,
     { bet_amount: betAmount }
   );

   // 2a. If player WINS (add payout to balance)
   await this.container.walletService.updateBalance(
     userId,
     payoutAmount,
     GameSource.YOUR_GAME,
     UpdateType.BET_WON,
     { bet_amount: betAmount, payout_amount: payoutAmount }
   );

   // 2b. If player LOSES (log the loss, no balance change)
   await this.container.walletService.updateBalance(
     userId,
     0, // no balance change (already deducted in BET_PLACED)
     GameSource.YOUR_GAME,
     UpdateType.BET_LOST,
     { bet_amount: betAmount, payout_amount: 0 }
   );
   ```

8. **CRITICAL: Use `StatsService.updateGameStats()` to track EVERY game result (win or loss)**
   ```typescript
   // After each game round, call updateGameStats
   await this.container.statsService.updateGameStats(
     userId,
     GameSource.YOUR_GAME,
     wonOrLost, // true for win, false for loss
     betAmount,
     payoutAmount, // 0 if lost
     extraStats // e.g., { bonus_spins: 1, jackpot_hits: 1 }
   );
   ```

9. **CRITICAL: Verify Stats Accuracy After Implementation**
    After implementing any game or feature, ALWAYS verify:
    - ✅ Check `transactions` table has all three types: `bet_placed`, `bet_won`, `bet_lost`
    - ✅ Run `/stats` command and verify the PNG graph shows accurate balance progression
    - ✅ Verify graph filters out intermediate states (bet_placed, round_won)
    - ✅ Confirm win/loss counts are accurate
    - ✅ Check game-specific stats (bonus spins, jackpot hits, etc.) are incrementing
    - ✅ Test both win and loss scenarios to ensure both are logged correctly

### Adding a new service:
1. Create service class in `src/services/<ServiceName>.ts`
2. Import service in `src/index.ts`
3. Add service to Container interface augmentation:
   ```typescript
   declare module '@sapphire/pieces' {
     interface Container {
       myService: MyService;
     }
   }
   ```
4. Initialize service in `login()` method:
   ```typescript
   container.myService = new MyService();
   ```
5. Access in commands via `this.container.myService`

## Debugging Tips

- Use `this.container.logger.info()` liberally during development
- Check database state directly if balance issues occur
- Use `NODE_ENV=development` for verbose logging
- Monitor database connections with `SELECT * FROM pg_stat_activity;`
- Test edge cases: insufficient balance, rate limits, concurrent updates
