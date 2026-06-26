# HogBot TypeScript

TypeScript casino bot built with Sapphire Framework and SQLite.

## Features

- **Games**: Blackjack, Slots, Ride the Bus, Roulette, Roll
- **Economy**: Wallets, loans, begging, leaderboards
- **Statistics**: Balance history graphs, game stats tracking
- **Progressive Jackpot**: Shared slots jackpot pool
- **Voice Time Tracking**: Track voice channel participation

## Tech Stack

- **Framework**: Sapphire Framework (discord.js v14)
- **Database**: SQLite (via better-sqlite3)
- **Language**: TypeScript
- **Deployment**: Docker (EC2)

## Local Development Setup

### Prerequisites

- Node.js 24+ (LTS)
- Discord bot token

### Installation

1. Install dependencies:
```bash
npm install
```

2. Configure environment:
```bash
cp .env.example .env
# Edit .env with your Discord bot token and guild ID
```

3. Run in development mode:
```bash
npm run dev
```

The bot creates `hogbot.db` automatically on first run. No database server needed.

## Production Deployment (AWS EC2)

### Initial Setup

1. **Launch EC2 Instance**
   - Amazon Linux 2023
   - Configure security group for SSH access
   - Note: Bot doesn't need any inbound ports open

2. **Install Docker on EC2**
```bash
sudo dnf install -y docker
sudo systemctl start docker
sudo systemctl enable docker
sudo usermod -aG docker ec2-user

# Install docker-compose
DOCKER_COMPOSE_VERSION=$(curl -s https://api.github.com/repos/docker/compose/releases/latest | grep 'tag_name' | cut -d '"' -f 4)
sudo curl -L "https://github.com/docker/compose/releases/download/${DOCKER_COMPOSE_VERSION}/docker-compose-$(uname -s)-$(uname -m)" -o /usr/local/bin/docker-compose
sudo chmod +x /usr/local/bin/docker-compose

# Log out and back in for docker group to take effect
```

3. **Clone Repository**
```bash
git clone https://github.com/yourusername/hogbot-ts.git
cd hogbot-ts
```

4. **Configure Environment**
```bash
cp .env.example .env
vi .env
```

```env
DISCORD_TOKEN=your_bot_token_here

# Optional: set for dev/single-server mode, omit for global commands
# GUILD_ID=your_guild_id

# Path to SQLite database file (defaults to ./hogbot.db)
DATABASE_FILE=./hogbot.db

NODE_ENV=production
```

### Building and Deploying with Docker

#### Build the Docker Image
```bash
docker build -t hogbot-ts .
```

#### Start the Bot
```bash
docker-compose -f docker-compose.prod.yml up -d
```

#### Stop the Bot
```bash
docker-compose -f docker-compose.prod.yml down
```

#### Restart the Bot
```bash
# Quick restart (keeps existing image)
docker-compose -f docker-compose.prod.yml restart

# Full restart after a code change
docker-compose -f docker-compose.prod.yml down
docker-compose -f docker-compose.prod.yml up -d
```

### Viewing Logs

```bash
# View real-time logs
docker logs hogbot -f

# View last 100 lines
docker logs hogbot --tail 100

# View logs with timestamps
docker logs hogbot -f --timestamps

# Search logs for errors
docker logs hogbot 2>&1 | grep "error"
```

### Container Management

```bash
# Check if container is running
docker ps

# Check all containers (including stopped)
docker ps -a

# View container resource usage
docker stats hogbot

# Access container shell (debugging)
docker exec -it hogbot /bin/sh
```

**Log Rotation:**
The production Docker setup includes automatic log rotation:
- Maximum log file size: 10 MB per file
- Maximum log files kept: 3 files

### Database Backups

The SQLite database is a single file (`hogbot.db`). Back it up with a simple copy:

```bash
# Manual backup
cp hogbot.db hogbot.db.bak

# Automated hourly backup to S3
echo "0 * * * * cp /path/to/hogbot.db /path/to/backups/hogbot-\$(date +\%Y\%m\%d-\%H).db" | crontab -
```

### Querying the Database

**On the EC2 instance (CLI):**
```bash
sqlite3 hogbot.db
sqlite3 hogbot.db "SELECT * FROM users ORDER BY balance DESC LIMIT 10;"
```

**Locally with a GUI (DBeaver, TablePlus, DB Browser for SQLite):**
- Point the tool at your local `hogbot.db` during development
- Or `scp` the file from EC2 to inspect production data

### Command Registration Modes

**Development Mode** (`GUILD_ID` set):
- Commands register to specific guild only
- **Instant** command updates (seconds)
- Use for testing and development

**Production Mode** (`GUILD_ID` not set):
- Commands register **globally** to all servers
- **1 hour** initial propagation delay (one-time)
- Recommended for multi-guild production bots

### Discord Bot Configuration

1. **Discord Developer Portal** → Your Application → **Bot**
2. Enable these **Privileged Gateway Intents**:
   - ✅ Server Members Intent
   - ✅ Message Content Intent
3. **OAuth2** → **URL Generator**:
   - Scopes: `bot`, `applications.commands`
   - Permissions: `563091419221072` (or Administrator for testing)
4. Use generated URL to invite bot to your server

### Updating the Bot

```bash
# 1. Pull latest code
git pull

# 2. Rebuild Docker image
docker build -t hogbot-ts .

# 3. Restart container
docker-compose -f docker-compose.prod.yml down
docker-compose -f docker-compose.prod.yml up -d

# 4. Verify startup
docker logs hogbot -f
```

**One-liner:**
```bash
git pull && docker build -t hogbot-ts . && docker-compose -f docker-compose.prod.yml down && docker-compose -f docker-compose.prod.yml up -d && docker logs hogbot -f
```

### Automated Deployment Script

```bash
chmod +x deploy-prod.sh
./deploy-prod.sh
```

## Project Structure

```
src/
├── index.ts                    # Bot entry point with service initialization
├── config.ts                   # Environment config with Zod validation
├── constants.ts                # Enums (GameSource, UpdateType)
├── lib/                        # Infrastructure (database, logging, types)
│   ├── database.ts            # SQLite singleton (better-sqlite3)
│   ├── logger.ts              # Winston logger configuration
│   └── types.ts               # Shared TypeScript types
├── utils/                      # Shared utilities
│   ├── utils.ts               # Formatting (formatCoins, formatDuration)
│   └── game-utils.ts          # Game UI utilities (timeout handling)
├── tasks/                      # Scheduled background jobs
│   └── beers-scheduler.ts     # Daily channel renaming
├── services/                   # Business logic services (PascalCase)
│   ├── WalletService.ts       # Balance operations
│   ├── LeaderboardService.ts  # Rankings and richest role
│   ├── StatsService.ts        # Statistics tracking
│   ├── DeckService.ts         # Shared card deck management
│   ├── GuildSettingsService.ts # Per-guild configuration
│   ├── VoiceTimeService.ts    # Voice channel tracking
│   └── [GameServices]         # Game logic (Blackjack, Slots, etc.)
├── commands/                   # Slash commands (kebab-case)
├── listeners/                  # Event listeners (camelCase, match event names)
└── preconditions/             # Command preconditions (PascalCase)
```

## Available Commands

### Economy
- `/mywallet` - Check your balance and stats
- `/leaderboard` - View top 10 richest users
- `/loan @user amount` - Transfer coins (3/hour limit)
- `/beg` - Get 500 coins when broke (unlimited when balance = 0)
- `/stats [@user]` - View gambling statistics with graph

### Games
- `/blackjack [bet]` - Play blackjack (21 card game)
- `/slots [bet]` - Spin the slots with progressive jackpot
- `/ridethebus [bet]` - Card guessing game (red/black, higher/lower, inside/outside, suit)
- `/roulette [bet]` - Play American Roulette with multiple bet types
- `/roll [from] [to]` - Simple dice roll betting

### Admin
- `/config` - Configure casino channel and richest member role
- `/voicetime [@user] [leaderboard]` - View voice channel time stats

## Development

### Run in development mode with auto-reload:
```bash
npm run dev
```

### Build for production:
```bash
npm run build
npm start
```

## Troubleshooting

### Commands Not Appearing

1. **Check bot intents** are enabled in Discord Developer Portal
2. **Check NODE_ENV**:
   - Development: Set `GUILD_ID` for instant updates
   - Production: Remove `GUILD_ID`, wait 1 hour for global propagation
3. **Verify bot has `applications.commands` scope** when invited

### Database Errors on Startup

1. **Check `DATABASE_FILE` path** is writable by the bot process
2. **Check disk space** — `df -h` on EC2
3. **Verify the WAL files** (`hogbot.db-wal`, `hogbot.db-shm`) are not corrupted — if so, restore from backup

### Bot Crashes on Startup

1. **View logs**: `docker logs hogbot --tail 100`
2. **Check `.env` file** for missing/incorrect values
3. **Check Discord token** is valid
4. **Check container status**: `docker ps -a` (look for exit code)

## License

MIT
