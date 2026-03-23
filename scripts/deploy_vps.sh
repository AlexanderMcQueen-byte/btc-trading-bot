#!/bin/bash
# VPS Deployment Script for BTC Trading Bot
# Run this script on your fresh VPS (Ubuntu 22.04 recommended)
# Usage: bash deploy_vps.sh

set -e

echo "======================================"
echo " BTC Trading Bot — VPS Deployment"
echo "======================================"

# 1. Update system
echo "[1/7] Updating system packages..."
apt-get update -y && apt-get upgrade -y

# 2. Install Docker
echo "[2/7] Installing Docker..."
if ! command -v docker &> /dev/null; then
    curl -fsSL https://get.docker.com | sh
    systemctl enable docker
    systemctl start docker
else
    echo "Docker already installed. Skipping."
fi

# 3. Install Docker Compose
echo "[3/7] Installing Docker Compose..."
if ! command -v docker compose &> /dev/null; then
    apt-get install -y docker-compose-plugin
fi

# 4. Copy files to server (assumes you are running this from the project root)
echo "[4/7] Setting up project directory..."
mkdir -p /opt/btc-bot
cp -r . /opt/btc-bot/
cd /opt/btc-bot

# 5. Add current server IP to whitelist
echo "[5/7] Whitelisting server IP..."
SERVER_IP=$(hostname -I | awk '{print $1}')
echo "Detected IP: $SERVER_IP"
if ! grep -qF "$SERVER_IP" ip_whitelist.txt 2>/dev/null; then
    echo "$SERVER_IP" >> ip_whitelist.txt
    echo "IP $SERVER_IP added to whitelist."
else
    echo "IP already whitelisted."
fi

# 6. Build Docker image
echo "[6/7] Building Docker image..."
docker build -t btc-bot .

# 7. Run the bot
echo "[7/7] Starting the bot..."
docker stop btc-bot-container 2>/dev/null || true
docker rm btc-bot-container 2>/dev/null || true
docker run -d \
    --name btc-bot-container \
    --restart unless-stopped \
    --env-file .env \
    -v /opt/btc-bot/data:/usr/src/app/data \
    -v /opt/btc-bot/logs:/usr/src/app/logs \
    btc-bot

echo ""
echo "======================================"
echo " Bot is running!"
echo " View logs: docker logs -f btc-bot-container"
echo " Stop bot:  docker stop btc-bot-container"
echo " Restart:   docker restart btc-bot-container"
echo "======================================"
