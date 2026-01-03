# HogBot Production Deployment Guide

## Prerequisites

- AWS EC2 instance with Docker installed
- SSH access to the instance
- Git installed on the instance

## Initial Setup (First Time Only)

1. **Clone the repository:**
   ```bash
   git clone <your-repo-url>
   cd hogbot-ts
   ```

2. **Create `.env` file:**
   ```bash
   cp .env.example .env
   nano .env  # Add your Discord token and other secrets
   ```

3. **Set up data directory with correct permissions:**
   ```bash
   mkdir -p ./data
   sudo chown -R 1000:1000 ./data
   chmod 755 ./data
   ```

   **Why UID 1000?** The Docker container runs as the `node` user (UID 1000 by default). The host directory must be writable by this user.

## Deployment

### Option 1: Automated Deployment (Recommended)

Use the deployment script:

```bash
# Make script executable (first time only)
chmod +x deploy-prod.sh

# Run deployment
./deploy-prod.sh
```

### Option 2: Manual Deployment

```bash
# 1. Pull latest changes
git pull

# 2. Fix data directory permissions (if needed)
sudo chown -R 1000:1000 ./data

# 3. Stop existing container
sudo docker-compose -f docker-compose.prod.yml down

# 4. Rebuild image
sudo docker build -t hogbot-ts .

# 5. Start container
sudo docker-compose -f docker-compose.prod.yml up -d

# 6. Verify it's running
sudo docker ps | grep hogbot
```

## Viewing Logs

### Docker Logs (Console Output)
```bash
# Follow live logs
sudo docker logs hogbot -f

# View last 100 lines
sudo docker logs hogbot --tail 100
```

### File Logs (Persistent)
```bash
# Follow live file logs
tail -f ./data/hogbot-$(date +%Y-%m-%d).log

# View error logs only
tail -f ./data/hogbot-error-$(date +%Y-%m-%d).log

# List all log files
ls -lh ./data/
```

**Log Retention:**
- All logs: 14 days
- Error logs: 30 days
- Automatic daily rotation

## Troubleshooting

### Container Won't Start / Keeps Restarting

**Check logs:**
```bash
sudo docker logs hogbot --tail 50
```

**Common issues:**
1. **Permission denied on `/app/data/`**
   ```bash
   sudo chown -R 1000:1000 ./data
   ```

2. **Missing .env file**
   ```bash
   cp .env.example .env
   nano .env
   ```

3. **Database not running**
   ```bash
   sudo docker ps | grep postgres
   ```

### No Log Files in `./data/` Directory

**Verify volume mount:**
```bash
sudo docker inspect hogbot | grep -A 10 "Mounts"
```

**Check permissions:**
```bash
ls -la ./data/
# Should show owner as 1000:1000
```

**Check if logs exist inside container:**
```bash
sudo docker exec hogbot ls -la /app/data/
```

### Commands Not Updating in Discord

**Global commands take up to 1 hour to propagate.** To use guild-specific commands (instant updates):

1. Set `NODE_ENV=development` in `.env`
2. Restart container

## Useful Commands

```bash
# Restart container
sudo docker-compose -f docker-compose.prod.yml restart

# Stop container
sudo docker-compose -f docker-compose.prod.yml down

# View container stats
sudo docker stats hogbot

# Enter container shell
sudo docker exec -it hogbot sh

# View environment variables
sudo docker exec hogbot env

# Clean old Docker images
sudo docker image prune -a
```

## Updating the Bot

```bash
cd hogbot-ts
git pull
./deploy-prod.sh
```

The script will:
1. Fix data directory permissions
2. Stop the old container
3. Build the new image
4. Start the new container
5. Show recent logs

## Security Notes

- Container runs as non-root user (`node`, UID 1000)
- Logs are rotated automatically
- `.env` file should never be committed to git
- Database runs in separate container with persistent volume
