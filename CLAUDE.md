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
container.walletService = new WalletService(container.leaderboardService);
```

**❌ WRONG:**
```typescript
// Type assertion to bypass errors without understanding the problem
(this as any).container.walletService = new WalletService();
```

**✅ CORRECT:**
```typescript
// Parameterized queries to prevent SQL injection
db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
```

**❌ WRONG:**
```typescript
// String concatenation vulnerable to SQL injection
db.prepare(`SELECT * FROM users WHERE id = '${userId}'`).get();
```

---

## Project Overview

**HogBot-TS** is a Discord casino bot built with TypeScript, discord.js (Sapphire Framework), and SQLite. Features include casino games (blackjack, slots, roulette, ride the bus), wallet management, leaderboards, and game statistics tracking.

## Running the Bot

### Prerequisites
- Node.js 24+ (LTS)
- Discord bot token

### Local Development

```bash
# Install dependencies
npm install

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
GUILD_ID=your_guild_id           # optional: locks commands to one guild

# Database Configuration
DATABASE_FILE=./hogbot.db        # optional: defaults to ./hogbot.db

# Environment
NODE_ENV=development

# AI Configuration
ANTHROPIC_API_KEY=your_anthropic_api_key_here  # required: used by the HogAI @mention feature
```

Use `.env.example` as a template. `CASINO_CHANNEL_ID` is accepted for backward compatibility but is deprecated — casino channel is now configured per-guild (see below).

Per-guild settings (richest member role, casino channel, beers channel + timezone, HogAI access role) are configured via the `/config` command and stored in the `guild_settings` table — not in `.env`.

**Discord Developer Portal requirement:** the `MessageContent` privileged gateway intent must be enabled for the bot (Bot tab), in addition to being declared in `src/index.ts`. Without it, HogAI cannot read message content for the @mention trigger or quoted reply-chain context.

## Architecture Overview

### Core Components

**HogBotClient (`src/index.ts`)**
- Custom Sapphire client that extends `SapphireClient`
- Initializes all services in `login()` with explicit constructor injection
- Services are attached to `container` for global access from commands/listeners
- Handles database initialization on login and cleanup on destroy
- Graceful shutdown handlers for SIGINT/SIGTERM

**Services (`src/services/`)**
- **WalletService**: Balance operations, user creation, coin transfers, transaction logging. Receives `LeaderboardService` via constructor so it can trigger richest member updates after resolved transactions.
- **LeaderboardService**: Rankings, richest member role management. Tracks current richest per-guild in memory; only makes Discord API calls when it changes.
- **StatsService**: Per-game statistics, wrapped stats, streak tracking, high scores
- **DeckService**: Shared card deck management (used by Blackjack, Ride the Bus)
- **GuildSettingsService**: Per-guild configuration (richest member role, casino channel, beers channel + timezone, HogAI access role)
- **GameStateService**: Crash recovery for complex multi-round games
- **BlackjackService**, **RideTheBusService**, **SlotsService**, **RouletteService**: Per-game logic, each constructed with `WalletService`, `StatsService`, and `GameStateService` (SlotsService and RouletteService also track a progressive jackpot / house edge respectively — see each service for specifics)
- **VoiceTimeService**: Tracks active voice sessions and aggregates voice time per user/guild; recovers stale sessions on bot restart (`cleanupStaleSessions()`, called from `index.ts`)
- **AiService**: Backs the HogAI `@mention` feature. Stateless per-request prompt/response wrapper around the Anthropic API — rate limiting (cooldown + daily cap) and prompt-length checks live here (`checkLimits()`), the actual request in `ask()`. `ask()` runs a Claude `web_search` tool (server-executed) and a custom `check_recent_channel_messages` tool (client-executed, resolved via a callback the caller supplies) that Claude can invoke when a prompt seems to depend on context it wasn't given — see `src/listeners/messageCreate.ts` and `src/utils/ai-utils.ts` for how the Discord side (reply-chain walking, recent-message fetch, embed building) is assembled.
- Services accessed via `this.container.walletService` in commands

**Commands (`src/commands/`)**
- Sapphire command pattern using `@ApplyOptions` decorator
- `registerApplicationCommands()` registers globally in production, or to `Config.discord.guildId` (if set) in development — for instant command updates while testing. See the `NODE_ENV === 'production' ? {} : Config.discord.guildId ? { guildIds: [...] } : {}` conditional in any existing command (e.g. `my-wallet.ts`) as the reference pattern.
- Preconditions for channel restrictions (e.g., `CasinoChannelOnly`)
- All casino commands should use the `CasinoChannelOnly` precondition
- File names use kebab-case (e.g., `ride-the-bus.ts`, `my-wallet.ts`)

**Utilities (`src/utils/`)**
- **utils.ts**: Generic formatting utilities (`formatCoins`, `formatDuration`)
- **game-utils.ts**: Shared game UI utilities (`handleGameTimeoutUI`)
- **ai-utils.ts**: HogAI prompt/embed helpers (reply-chain walking, recent-channel-history formatting, answer embed building)

**Tasks (`src/tasks/`)**
- **beers-scheduler.ts**: Scheduled background jobs

**Database Layer (`src/lib/database.ts`)**
- SQLite via `better-sqlite3` — synchronous, embedded, no separate process
- WAL mode enabled for better concurrent read performance
- Schema is created inline via `CREATE TABLE IF NOT EXISTS` on startup
- No connection pooling needed; `db` is a single shared instance

### Database Schema

**Core Tables:**
- `guild_settings`: Per-guild configuration (richest member role, casino/beers channel, beers timezone, HogAI access role)
- `users`: User wallets with composite PK `(user_id, guild_id)`, balance, high water mark
- `transactions`: Immutable transaction log (game_source, update_type, amount, balance_after)
- `game_stats`: Per-game win/loss/streak statistics
- `progressive_jackpot`: Per-guild slots jackpot pool
- `loan_rate_limits`: Enforces loan frequency limits per user
- `ai_rate_limits`: Enforces HogAI cooldown + daily request cap per user
- `game_sessions`: Active game state for crash recovery in complex games
- `game_crash_history`: Audit log of crashed/refunded games
- `voice_sessions`: Active voice channel sessions (for voice time tracking)
- `voice_time_history` / `voice_time_aggregates`: Voice time tracking

**Schema migrations:** `src/lib/database.ts` runs `CREATE TABLE IF NOT EXISTS` for the full schema on every startup (a no-op for existing tables), then calls `addColumnIfMissing()` for any columns added after a table's initial creation (checked via `PRAGMA table_info`, applied via `ALTER TABLE`). When adding a column to an existing table, add both the column to the inline `CREATE TABLE` (for fresh databases) and an `addColumnIfMissing()` call (for existing ones).

**No database functions or views** — all logic lives in TypeScript application code.

**Balance History:**
- The `transactions` table is the single source of truth
- Balance graphs are derived from `transactions`, filtering out intermediate states (`bet_placed`, `round_won`)
- No separate balance history table

### Key Patterns

**Atomic Transactions**
- Multi-step balance operations use `db.transaction()` from better-sqlite3
- This wraps synchronous SQLite operations in a single atomic transaction
- Never update balances with ad-hoc raw SQL outside of `WalletService`

**Service Dependency Injection**
- Services are instantiated in `login()` with explicit constructor arguments
- Dependencies are passed in; services do not import `container` or reach out to each other at module level
- The `container` holds all services; commands access them via `this.container.<serviceName>`

```typescript
// index.ts — initialization order matters
container.leaderboardService = new LeaderboardService();
container.walletService = new WalletService(container.leaderboardService);
container.blackjackService = new BlackjackService(
  container.walletService,
  container.statsService,
  container.leaderboardService,
  container.gameStateService
);
```

**Sapphire Command Pattern**
```typescript
import { Command } from '@sapphire/framework';
import { ApplyOptions } from '@sapphire/decorators';
import { MessageFlags } from 'discord.js';
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
      // Global in production; scoped to Config.discord.guildId in development (if set)
      // for instant command updates while testing
      process.env.NODE_ENV === 'production'
        ? {}
        : Config.discord.guildId
          ? { guildIds: [Config.discord.guildId] }
          : {}
    );
  }

  public override async chatInputRun(interaction: Command.ChatInputCommandInteraction) {
    try {
      const balance = await this.container.walletService.getBalance(userId, guildId);
      const topUsers = await this.container.leaderboardService.getTopUsers(guildId, 10);

      await interaction.reply({ content: 'Response' });
    } catch (error) {
      this.container.logger.error('Error in command:', error);
      await interaction.reply({ content: 'Error occurred', flags: MessageFlags.Ephemeral });
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
- Send user-friendly error messages with `ephemeral: true`

**Leaderboard Role Management**
- Richest member role is updated automatically after every resolved transaction (`BET_WON`, `BET_LOST`, `REFUND`, etc.)
- Both `updateBalance()` and `logTransaction()` in WalletService trigger the check
- The check is a no-op if the richest member hasn't changed (in-memory comparison, no Discord API call)
- `BET_PLACED` and `ROUND_WON` are excluded from triggering the check (intermediate states)

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
- Discord interactions are async; SQLite via better-sqlite3 is synchronous
- Use `async/await` for Discord API calls and service methods
- SQLite operations (`db.prepare().get/all/run`) are synchronous — no `await` needed

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

All wallet logic lives in TypeScript via `WalletService`. Never bypass it with raw SQL updates to the `users` table.

**SQLite Operations Pattern (better-sqlite3):**
```typescript
// Synchronous reads
const user = db.prepare('SELECT balance FROM users WHERE user_id = ? AND guild_id = ?')
  .get(userId, guildId) as { balance: number } | undefined;

// Atomic multi-step operation
const doUpdate = db.transaction(() => {
  db.prepare(`UPDATE users SET balance = ? WHERE user_id = ? AND guild_id = ?`)
    .run(newBalance, userId, guildId);

  db.prepare(`INSERT INTO transactions (user_id, guild_id, amount, balance_after, game_source, update_type, metadata)
     VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(userId, guildId, amount, newBalance, gameSource, updateType, JSON.stringify(metadata));

  return newBalance;
});

const result = doUpdate() as number;
```

**General Database Rules:**
- Use parameterized queries (`?` placeholders) to prevent SQL injection
- Use `db.transaction()` for multi-step operations that must be atomic
- Use `RETURNING *` / `RETURNING <col>` is NOT supported in older SQLite; read back with a SELECT if needed
- All coin amounts are stored as `INTEGER` (SQLite); better-sqlite3 returns them as JS numbers natively

**Balance History:**
- The `transactions` table is the single source of truth
- Balance history for graphs is queried from `transactions`, filtering out `bet_placed` and `round_won`

### Error Handling & Logging
- Import logger: `this.container.logger` (in commands/listeners)
- Log levels: `logger.info()`, `logger.warn()`, `logger.error()`
- Always catch and log errors in command handlers
- Provide user-friendly error messages

### Constants & Configuration
- Environment variables: `src/config.ts` (validated with Zod)
- Game constants: `src/constants.ts` (CASINO_CONFIG, enums)
- Use `Config.discord.token`, `Config.database.file`, etc.
- Enums: `GameSource`, `UpdateType` for transaction tracking

### State Management
- All persistent state is stored in SQLite
- Services query the database as needed
- `LeaderboardService` tracks current richest member per-guild in memory (rehydrated on bot start)

## Important Files

- `src/index.ts`: Bot entry point, client initialization, service wiring
- `src/config.ts`: Environment variables with Zod validation
- `src/constants.ts`: Game enums (GameSource, UpdateType), casino config, `AI_CONFIG` (HogAI model/limits/system prompt)
- `src/lib/database.ts`: SQLite database instance, schema, and migration helper (`addColumnIfMissing`)
- `src/lib/types.ts`: TypeScript type definitions
- `src/lib/logger.ts` / `src/lib/safe-logger.ts`: Sapphire/Winston logger setup; `safe-logger` is the logger used outside piece classes (services, utils) where `this.container.logger` isn't available
- `src/lib/cleanup.ts`: Scheduled cleanup of crashed/stale game sessions
- `src/utils/utils.ts`: Formatting utilities (formatCoins, formatDuration)
- `src/utils/game-utils.ts`: Shared game UI utilities (timeout handling)
- `src/utils/ai-utils.ts`: HogAI prompt/embed helpers — reply-chain walking, recent-channel-history formatting, quoted-context budgeting, answer embed building
- `src/services/WalletService.ts`: Balance operations (requires LeaderboardService via constructor)
- `src/services/LeaderboardService.ts`: Rankings and richest member role
- `src/services/StatsService.ts`: Game statistics tracking
- `src/services/GuildSettingsService.ts`: Per-guild configuration
- `src/services/GameStateService.ts`: Active game session / crash recovery
- `src/services/DeckService.ts`: Shared card deck management
- `src/services/BlackjackService.ts`, `RideTheBusService.ts`, `SlotsService.ts`, `RouletteService.ts`: Per-game logic
- `src/services/VoiceTimeService.ts`: Voice channel time tracking
- `src/services/AiService.ts`: HogAI request handling (rate limits, Anthropic API calls, tool-use loop)
- `src/listeners/messageCreate.ts`: HogAI `@mention` trigger — access control, reply-chain/image collection, prompt assembly

## Testing During Development

- Use `npm run dev` for auto-reload during development
- Test all commands in the designated casino channel
- Inspect the SQLite database directly:
  ```bash
  sqlite3 hogbot.db
  .tables
  SELECT * FROM users;
  ```
- View logs in console (Sapphire logger outputs to stdout)

## Code Style Preferences

- Use `async/await` over `.then()` chains
- Prefer `const` over `let` when possible
- Use descriptive variable names (e.g., `userBalance` not `bal`)
- Keep functions focused and single-purpose
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
| **Utilities** | kebab-case | Pure functions, not classes | `game-utils.ts`, `utils.ts`, `ai-utils.ts` |
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
9. **CRITICAL: Log ALL game transactions (bet_placed, bet_won, bet_lost)**
   ```typescript
   // 1. When bet is placed (deduct from balance)
   await walletService.updateBalance(
     userId, guildId, -betAmount,
     GameSource.YOUR_GAME, UpdateType.BET_PLACED,
     { bet_amount: betAmount }
   );

   // 2a. If player WINS (add payout to balance)
   await walletService.updateBalance(
     userId, guildId, payoutAmount,
     GameSource.YOUR_GAME, UpdateType.BET_WON,
     { bet_amount: betAmount, payout_amount: payoutAmount }
   );

   // 2b. If player LOSES (log the loss — balance already deducted at BET_PLACED)
   await walletService.logTransaction(
     userId, guildId,
     GameSource.YOUR_GAME, UpdateType.BET_LOST,
     { bet_amount: betAmount, payout_amount: 0 }
   );
   ```

10. **CRITICAL: Use `StatsService.updateGameStats()` to track EVERY game result (win or loss)**
    ```typescript
    await statsService.updateGameStats(
      userId, guildId,
      GameSource.YOUR_GAME,
      wonOrLost,     // true for win, false for loss
      betAmount,
      payoutAmount,  // 0 if lost
      extraStats     // e.g., { bonus_spins: 1, jackpot_hits: 1 }
    );
    ```

11. **CRITICAL: Verify Stats Accuracy After Implementation**
    After implementing any game or feature, ALWAYS verify:
    - ✅ Check `transactions` table has all three types: `bet_placed`, `bet_won`, `bet_lost`
    - ✅ Run `/stats` command and verify the PNG graph shows accurate balance progression
    - ✅ Verify graph filters out intermediate states (bet_placed, round_won)
    - ✅ Confirm win/loss counts are accurate
    - ✅ Check game-specific stats (bonus spins, jackpot hits, etc.) are incrementing
    - ✅ Test both win and loss scenarios to ensure both are logged correctly

12. **Wire up the new GameService in `index.ts`** — inject its dependencies via constructor (see existing services as reference)

### Adding a new service:
1. Create service class in `src/services/<ServiceName>.ts`
2. Import service in `src/index.ts`
3. Add service to Container interface augmentation in `src/index.ts`:
   ```typescript
   declare module '@sapphire/pieces' {
     interface Container {
       myService: MyService;
     }
   }
   ```
4. Initialize in `login()` with constructor injection for any dependencies:
   ```typescript
   container.myService = new MyService(container.walletService);
   ```
5. Access in commands via `this.container.myService`

## Debugging Tips

- Use `this.container.logger.info()` liberally during development
- Inspect the database directly with `sqlite3 hogbot.db` if balance issues occur
- Use `NODE_ENV=development` for verbose logging
- Test edge cases: insufficient balance, rate limits, concurrent updates
