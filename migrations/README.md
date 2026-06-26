# Database Schema Reference

This directory contains the SQLite schema for HogBot as a readable reference.

> **Note:** You do not need to run these files manually. The bot applies the schema automatically on startup via `src/lib/database.ts`. The database file (`hogbot.db`) is created on first run with no setup required.

## Files

- `001_initial_schema.sql` — Full SQLite schema with all tables, indexes, and comments

## Schema Overview

| Table | Purpose |
|---|---|
| `guild_settings` | Per-server configuration (casino channel, richest role, beers channel) |
| `users` | Per-guild wallets with balance and beg count |
| `transactions` | Immutable audit log for all wallet operations; source of truth for balance graphs |
| `game_stats` | Denormalized per-game win/loss/streak statistics |
| `progressive_jackpot` | Per-guild slots jackpot pool |
| `loan_rate_limits` | Rate limiting for the `/loan` command (3 per hour) |
| `game_sessions` | Active game tracking for crash recovery and concurrent game prevention |
| `game_crash_history` | Audit log of crashed games with refund details |
| `voice_sessions` | Currently active voice channel sessions |
| `voice_time_history` | Completed voice sessions (historical record) |
| `voice_time_aggregates` | Denormalized all-time and weekly voice totals for fast leaderboard queries |

## Querying the Database

**CLI (on the EC2 instance):**
```bash
sqlite3 hogbot.db
sqlite3 hogbot.db "SELECT * FROM users ORDER BY balance DESC LIMIT 10;"
```

**Useful queries:**
```sql
-- View all users sorted by balance
SELECT user_id, username, balance FROM users ORDER BY balance DESC;

-- Recent transactions
SELECT * FROM transactions ORDER BY created_at DESC LIMIT 20;

-- Balance history for a user (used for stats graph)
SELECT balance_after, created_at FROM transactions
WHERE user_id = '123456789' AND update_type NOT IN ('bet_placed', 'round_won')
ORDER BY created_at ASC;

-- Game stats per user
SELECT user_id, game_source, played, wins, losses FROM game_stats ORDER BY played DESC;

-- Current jackpot per guild
SELECT guild_id, amount, last_winner_id, last_won_at FROM progressive_jackpot;

-- Active game sessions
SELECT * FROM game_sessions WHERE status = 'active';

-- Voice time leaderboard
SELECT user_id, total_seconds, weekly_seconds FROM voice_time_aggregates
ORDER BY total_seconds DESC LIMIT 10;
```

## Backups

The entire database is a single file. Back it up with a simple copy:

```bash
# Manual
cp hogbot.db hogbot.db.bak

# Automated hourly backup to S3
echo "0 * * * * cp /path/to/hogbot.db /path/to/backups/hogbot-\$(date +\%Y\%m\%d-\%H).db" | crontab -
```
