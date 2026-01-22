# HogBot TypeScript

TypeScript casino bot built with Sapphire Framework and PostgreSQL.

## Features

- **Games**: Blackjack, Slots, Ride the Bus, Roulette, Roll
- **Economy**: Wallets, loans, begging, leaderboards
- **Statistics**: Balance history graphs, game stats tracking
- **Progressive Jackpot**: Shared slots jackpot pool
- **Voice Time Tracking**: Track voice channel participation

## Tech Stack

- **Framework**: Sapphire Framework (discord.js v14)
- **Database**: PostgreSQL
- **Language**: TypeScript
- **Deployment**: Docker

## Local Development Setup

### Prerequisites

- Node.js 24+ (LTS)
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
# Edit .env with your Discord bot token and guild ID
```

4. Run in development mode:
```bash
npm run dev
```

The bot will automatically load commands and connect to the local database.

## Production Deployment (AWS EC2)

### Initial Setup

1. **Create AWS RDS PostgreSQL Database**
   - Go to AWS RDS Console
   - Create PostgreSQL 16 database
   - Note the endpoint, username, and password
   - Configure security group to allow connections from EC2

2. **Run Database Migrations**
```bash
# Connect to RDS and run migrations
for file in migrations/*.sql; do
  echo "Running $file..."
  PGPASSWORD=your_password psql -h your-rds-endpoint.rds.amazonaws.com -U hogbot -d hogbot -f "$file"
done
```

3. **Launch EC2 Instance**
   - Amazon Linux 2023
   - Configure security group for SSH access
   - Note: Bot doesn't need any inbound ports open

4. **Install Docker on EC2**
```bash
# For Amazon Linux 2023
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

5. **Clone Repository**
```bash
git clone https://github.com/yourusername/hogbot-ts.git
cd hogbot-ts
```

6. **Configure Environment**
```bash
# Create .env file
touch .env
vi .env
```

Add the following (replace with your values):
```env
# Discord Configuration
DISCORD_TOKEN=your_bot_token_here
GUILD_ID=your_guild_id  # Optional: Set for dev, remove for production

# Database Configuration (AWS RDS)
DATABASE_HOST=your-rds-endpoint.rds.amazonaws.com
DATABASE_PORT=5432
DATABASE_NAME=hogbot
DATABASE_USER=hogbot
DATABASE_PASSWORD=your_password

# Environment
NODE_ENV=production
```

### Building and Deploying with Docker

#### Build the Docker Image
```bash
# Build the image (this compiles TypeScript and creates production image)
docker build -t hogbot-ts .
```

#### Start the Bot
```bash
# Start in detached mode (runs in background)
docker-compose -f docker-compose.prod.yml up -d
```

#### Stop the Bot
```bash
# Stop the container
docker-compose -f docker-compose.prod.yml down

# Or just stop without removing
docker-compose -f docker-compose.prod.yml stop
```

#### Restart the Bot
```bash
# Quick restart (keeps existing image)
docker-compose -f docker-compose.prod.yml restart

# Full restart (after rebuild)
docker-compose -f docker-compose.prod.yml down
docker-compose -f docker-compose.prod.yml up -d
```

### Viewing Logs

```bash
# View real-time logs (follow mode)
docker logs hogbot -f

# View last 100 lines
docker logs hogbot --tail 100

# View logs since specific time
docker logs hogbot --since 1h

# View logs with timestamps
docker logs hogbot -f --timestamps

# Search logs for specific text
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

# Inspect container details
docker inspect hogbot
```

**Log Rotation:**
The production Docker setup includes automatic log rotation:
- Maximum log file size: 10 MB per file
- Maximum log files kept: 3 files
- Total max disk usage: ~30 MB for logs

This prevents logs from consuming excessive disk space on your EC2 instance.

### Command Registration Modes

The bot supports two command registration modes:

**Development Mode** (`GUILD_ID` set):
- Commands register to specific guild only
- **Instant** command updates (seconds)
- Use for testing and development

**Production Mode** (`GUILD_ID` not set):
- Commands register **globally** to all servers
- **1 hour** initial propagation delay (one-time)
- After initial delay, commands appear **instantly** for new servers
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

When you push code changes to production:

```bash
# 1. Pull latest code
git pull

# 2. Rebuild Docker image with new code
docker build -t hogbot-ts .

# 3. Stop old container and start new one
docker-compose -f docker-compose.prod.yml down
docker-compose -f docker-compose.prod.yml up -d

# 4. Verify bot started successfully
docker logs hogbot -f
```

**Quick Update Process:**
```bash
git pull && docker build -t hogbot-ts . && docker-compose -f docker-compose.prod.yml down && docker-compose -f docker-compose.prod.yml up -d && docker logs hogbot -f
```

### Automated Deployment Script

For easier deployments, use the included `deploy-prod.sh` script:

```bash
# Make the script executable (first time only)
chmod +x deploy-prod.sh

# Run the deployment script
./deploy-prod.sh
```

**What the script does:**
1. Creates and configures the data directory for file logging
2. Stops the existing container
3. Builds a new Docker image with the latest code
4. Starts the container in detached mode
5. Shows container status and recent logs

**After deployment, you can:**
- View live logs: `sudo docker logs hogbot -f`
- View file logs: `tail -f ./data/hogbot-$(date +%Y-%m-%d).log`
- Restart bot: `sudo docker-compose -f docker-compose.prod.yml restart`

## Project Structure

```
src/
├── index.ts                    # Bot entry point with service initialization
├── config.ts                   # Environment config with Zod validation
├── constants.ts                # Enums (GameSource, UpdateType)
├── lib/                        # Infrastructure (database, logging, types)
│   ├── database.ts            # PostgreSQL connection pool
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

### Database Management

```bash
# Connect to local database
docker exec -it hogbot-postgres psql -U hogbot -d hogbot

# Connect to RDS database
PGPASSWORD=your_password psql -h your-rds-endpoint.rds.amazonaws.com -U hogbot -d hogbot

# View transactions
SELECT * FROM transactions ORDER BY created_at DESC LIMIT 10;

# View user balances
SELECT user_id, balance FROM users ORDER BY balance DESC LIMIT 10;
```

## Troubleshooting

### Commands Not Appearing

1. **Check bot intents** are enabled in Discord Developer Portal
2. **Check NODE_ENV**:
   - Development: Set `GUILD_ID` for instant updates
   - Production: Remove `GUILD_ID`, wait 1 hour for global propagation
3. **Verify bot has `applications.commands` scope** when invited

### Database Connection Errors

1. **Check RDS security group** allows EC2 inbound connections
2. **Verify SSL is enabled** (`NODE_ENV=production` enables SSL)
3. **Check credentials** in `.env` file
4. **Run migrations** if tables are missing

### Bot Crashes on Startup

1. **View logs**: `docker logs hogbot --tail 100`
2. **Check .env file** for missing/incorrect values
3. **Verify RDS endpoint** is accessible from EC2
4. **Check Discord token** is valid
5. **Check container status**: `docker ps -a` (look for exit code)

## License

MIT
