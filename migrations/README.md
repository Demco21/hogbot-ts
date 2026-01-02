# Database Migrations

This directory contains PostgreSQL schema migrations for the Hogbot casino TypeScript bot.

## Getting Started

### 1. Install Docker Desktop

If you don't have Docker installed:
- **Windows/Mac**: Download from https://www.docker.com/products/docker-desktop
- **Linux**: Follow instructions at https://docs.docker.com/engine/install/

### 2. Start PostgreSQL

From the Hogbot directory, run:

```bash
docker-compose up -d
```

This will:
- Download PostgreSQL 16 (if not already downloaded)
- Create a database named `hogbot`
- Create a user `hogbot` with password `hogbot_dev_password`
- Automatically run all `.sql` files in this directory
- Start pgAdmin (optional database management UI)

### 3. Verify Connection

Check that PostgreSQL is running:

```bash
docker-compose ps
```

You should see:
```
NAME                IMAGE                  STATUS
hogbot-postgres     postgres:16-alpine     Up
hogbot-pgadmin      dpage/pgadmin4:latest  Up
```

### 4. Connect to Database

**Via command line:**
```bash
docker exec -it hogbot-postgres psql -U hogbot -d hogbot
```

**Via pgAdmin (Web UI):**
1. Open http://localhost:5050 in your browser
2. Login with:
   - Email: `admin@hogbot.local`
   - Password: `admin`
3. Add server:
   - Host: `postgres` (Docker service name)
   - Port: `5432`
   - Database: `hogbot`
   - Username: `hogbot`
   - Password: `hogbot_dev_password`

### 5. Test the Schema

Run some test queries:

```sql
-- Check tables were created
\dt

-- Check the initial jackpot
SELECT * FROM progressive_jackpot;

-- Create a test user
INSERT INTO users (user_id, username, balance)
VALUES (123456789, 'TestUser', 10000);

-- Check the user was created
SELECT * FROM users;

-- Test the wallet update function
SELECT * FROM update_wallet_with_history(
    123456789,
    -1000,
    'blackjack',
    'bet_placed',
    '{"bet_amount": 1000}'::jsonb
);

-- View the transaction
SELECT * FROM transactions;

-- View balance history
SELECT * FROM balance_history;
```

## Useful Commands

### Start database
```bash
docker-compose up -d
```

### Stop database (keeps data)
```bash
docker-compose stop
```

### Stop and remove containers (keeps data in volumes)
```bash
docker-compose down
```

### Stop and DELETE ALL DATA (⚠️ Warning!)
```bash
docker-compose down -v
```

### View logs
```bash
docker-compose logs -f postgres
```

### Connect to database
```bash
docker exec -it hogbot-postgres psql -U hogbot -d hogbot
```

### Backup database
```bash
docker exec -t hogbot-postgres pg_dump -U hogbot hogbot > backup.sql
```

### Restore database
```bash
docker exec -i hogbot-postgres psql -U hogbot hogbot < backup.sql
```

## Connection String

For your TypeScript application, use:

```
postgresql://hogbot:hogbot_dev_password@localhost:5432/hogbot
```

Or as separate environment variables:

```env
DATABASE_HOST=localhost
DATABASE_PORT=5432
DATABASE_NAME=hogbot
DATABASE_USER=hogbot
DATABASE_PASSWORD=hogbot_dev_password
```

## Migration Files

Migrations are run automatically in alphabetical order when the container is first created.

- `001_initial_schema.sql` - Creates all tables, indexes, functions, and views

### Adding New Migrations

To add a new migration:

1. Create a new file: `002_description.sql`
2. Stop the database: `docker-compose down -v` (⚠️ deletes data)
3. Start the database: `docker-compose up -d`

Alternatively, run migrations manually without deleting data:

```bash
docker exec -i hogbot-postgres psql -U hogbot -d hogbot < migrations/002_description.sql
```

## Troubleshooting

### Port 5432 already in use

If you have PostgreSQL already installed locally:

**Option 1**: Stop local PostgreSQL
- Windows: Stop "PostgreSQL" service
- Mac: `brew services stop postgresql`
- Linux: `sudo systemctl stop postgresql`

**Option 2**: Change port in `docker-compose.yml`:
```yaml
ports:
  - "5433:5432"  # Use 5433 instead
```

Then update connection string to use port `5433`.

### Container won't start

Check logs:
```bash
docker-compose logs postgres
```

### pgAdmin can't connect

Make sure to use `postgres` as the hostname (not `localhost`) when adding the server in pgAdmin. This is the Docker service name.

## Next Steps

After verifying the database works:

1. Create your TypeScript bot project
2. Install `pg` package: `npm install pg @types/pg`
3. Create a database connection pool
4. Implement WalletService using the `update_wallet_with_history()` function
5. Run the JSON migration script to import existing data
