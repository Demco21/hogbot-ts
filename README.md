# HogBot TypeScript

TypeScript casino bot built with Sapphire Framework and PostgreSQL.

## Features

- **Games**: Blackjack, Slots, Cee-Lo, Ride the Bus
- **Economy**: Wallets, loans, begging, leaderboards
- **Statistics**: Balance history graphs, game stats tracking
- **Progressive Jackpot**: Shared slots jackpot pool

## Tech Stack

- **Framework**: Sapphire Framework (discord.js)
- **Database**: PostgreSQL
- **Language**: TypeScript

## Setup

### Prerequisites

- Node.js 18+
- Docker Desktop (for PostgreSQL)

### Installation

1. Install dependencies:
```bash
npm install
```

2. Start PostgreSQL:
```bash
docker-compose up -d
```

3. Configure environment:
```bash
cp .env.example .env
# Edit .env with your Discord bot token
```

4. Build:
```bash
npm run build
```

5. Run:
```bash
npm run dev
```

## Project Structure

```
src/
├── index.ts                    # Bot entry point
├── config.ts                   # Environment config
├── constants.ts                # Enums (GameSource, UpdateType)
├── lib/
│   ├── database.ts            # PostgreSQL connection pool
│   ├── logger.ts              # Logger configuration
│   ├── types.ts               # Shared TypeScript types
│   └── embeds.ts              # Embed utilities
├── services/
│   ├── WalletService.ts       # Balance operations
│   ├── LeaderboardService.ts  # Rankings
│   ├── StatsService.ts        # Statistics
│   └── [GameServices]         # Game logic
├── commands/                   # Slash commands
├── interaction-handlers/       # Button handlers
└── preconditions/             # Command preconditions
```

## Available Commands

### Economy
- `/mywallet` - Check your balance
- `/leaderboard` - View top 10 richest users
- `/loan @user amount` - Transfer coins (3/hour limit)
- `/beg` - Get 50-200 coins when broke
- `/stats` - View your gambling statistics

### Games
- `/blackjack [bet]` - Play blackjack
- `/slots [bet]` - Spin the slots
- `/ceelo [bet]` - Play Cee-Lo dice
- `/ridethebus [bet]` - Play Ride the Bus

## Development

### Run in development mode:
```bash
npm run dev
```

### Build for production:
```bash
npm run build
npm start
```

## License

MIT
