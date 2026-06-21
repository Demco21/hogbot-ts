#!/bin/bash
# Production deployment script for HogBot
# Run this on your EC2 instance to deploy/update the bot

set -e  # Exit on error

echo "🚀 HogBot Production Deployment"
echo "================================"

# 1. Create data directory with correct permissions
echo "📁 Setting up data directory..."
mkdir -p ./data
chmod 755 ./data
# Change ownership to UID 1000 (node user in container)
sudo chown -R 1000:1000 ./data
echo "✓ Data directory ready (hogbot.db lives here and survives rebuilds)"

# 2. Stop existing container
echo "🛑 Stopping existing container..."
sudo docker-compose -f docker-compose.prod.yml down || true
echo "✓ Container stopped"

# 3. Build new image
echo "🔨 Building Docker image..."
sudo docker build -t hogbot-ts .
echo "✓ Image built"

# 4. Start container
echo "🚀 Starting container..."
sudo docker-compose -f docker-compose.prod.yml up -d
echo "✓ Container started"

# 5. Wait for container to be healthy
echo "⏳ Waiting for container to start..."
sleep 5

# 6. Check container status
echo "📊 Container status:"
sudo docker ps | grep hogbot || echo "⚠️  Container not running!"

# 7. Show recent logs
echo ""
echo "📋 Recent logs:"
sudo docker logs hogbot --tail 20

echo ""
echo "================================"
echo "✅ Deployment complete!"
echo ""
echo "Useful commands:"
echo "  View logs:        sudo docker logs hogbot -f"
echo "  View file logs:   tail -f ./data/hogbot-$(date +%Y-%m-%d).log"
echo "  Container status: sudo docker ps | grep hogbot"
echo "  Restart:          sudo docker-compose -f docker-compose.prod.yml restart"
echo "  Query database:   sqlite3 ./data/hogbot.db"
echo "  Backup database:  cp ./data/hogbot.db ./data/hogbot.db.bak"
