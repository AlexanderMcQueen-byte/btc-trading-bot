#!/bin/bash
# ─────────────────────────────────────────────────────────────────────────────
# BTC Trading Bot — VPS Deployment Script
# Tested on Ubuntu 22.04 / 24.04 (DigitalOcean, Vultr, Hetzner, Linode)
#
# USAGE:
#   1. SSH into your VPS
#   2. Run: curl -fsSL <raw-github-url>/deploy.sh | bash
#      OR:  bash deploy.sh
#
# WHAT IT DOES:
#   - Installs Node.js 20, git, pm2
#   - Clones the bot from GitHub
#   - Prompts for your Binance API keys
#   - Starts the bot under pm2 (auto-restarts on crash, survives reboots)
# ─────────────────────────────────────────────────────────────────────────────

set -e

REPO="https://github.com/AlexanderMcQueen-byte/btc-trading-bot.git"
APP_DIR="$HOME/btc-trading-bot"
APP_NAME="btc-bot"

echo ""
echo "══════════════════════════════════════════════════════"
echo "  BTC Trading Bot — VPS Setup"
echo "══════════════════════════════════════════════════════"
echo ""

# ── 1. System update ──────────────────────────────────────────────────────────
echo "▶ Updating system packages..."
sudo apt-get update -qq && sudo apt-get upgrade -y -qq

# ── 2. Install Node.js 20 via NodeSource ──────────────────────────────────────
if ! command -v node &>/dev/null || [[ "$(node -v)" != v20* ]]; then
  echo "▶ Installing Node.js 20..."
  curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - -qq
  sudo apt-get install -y nodejs -qq
fi
echo "  Node $(node -v) | npm $(npm -v)"

# ── 3. Install pm2 globally ───────────────────────────────────────────────────
if ! command -v pm2 &>/dev/null; then
  echo "▶ Installing pm2 (process manager)..."
  sudo npm install -g pm2 --quiet
fi

# ── 4. Clone / update repo ───────────────────────────────────────────────────
if [ -d "$APP_DIR/.git" ]; then
  echo "▶ Updating existing repo..."
  git -C "$APP_DIR" pull --ff-only
else
  echo "▶ Cloning repo..."
  git clone "$REPO" "$APP_DIR"
fi

cd "$APP_DIR/BTC trade"

# ── 5. Install npm dependencies ───────────────────────────────────────────────
echo "▶ Installing dependencies..."
npm install --silent

# ── 6. Collect API keys ───────────────────────────────────────────────────────
echo ""
echo "══════════════════════════════════════════════════════"
echo "  Binance API Configuration"
echo "══════════════════════════════════════════════════════"

if [ -f ".env" ]; then
  echo "  Found existing .env — skipping key prompts."
  echo "  (Delete .env and re-run to change keys)"
else
  read -rp "  Binance API Key    : " BINANCE_API_KEY
  read -rsp "  Binance Secret Key : " BINANCE_SECRET_KEY
  echo ""

  cat > .env << EOF
BINANCE_API_KEY=${BINANCE_API_KEY}
BINANCE_SECRET_KEY=${BINANCE_SECRET_KEY}
DEFAULT_SYMBOL=BTC/USDT
TIMEFRAME=1h
MAX_RISK_PCT=0.01
STOP_LOSS_PCT=0.02
MAX_DAILY_LOSS_PCT=0.05
DASHBOARD_PORT=3001
LOG_LEVEL=info
EOF
  chmod 600 .env
  echo "  ✅ .env created (chmod 600 — readable only by you)"
fi

# ── 7. Add server IP to Binance whitelist reminder ────────────────────────────
SERVER_IP=$(curl -s https://api.ipify.org)
echo ""
echo "══════════════════════════════════════════════════════"
echo "  ⚠️  IMPORTANT — Binance IP Whitelist"
echo "══════════════════════════════════════════════════════"
echo "  This server's public IP is: $SERVER_IP"
echo ""
echo "  Add it to your Binance API key whitelist:"
echo "  binance.com → API Management → Edit restrictions"
echo "  → Restrict access to trusted IPs → add $SERVER_IP"
echo ""
read -rp "  Press ENTER once you've added the IP to Binance..."

# ── 8. Start with pm2 ─────────────────────────────────────────────────────────
echo ""
echo "▶ Starting bot with pm2..."
pm2 stop "$APP_NAME" 2>/dev/null || true
pm2 delete "$APP_NAME" 2>/dev/null || true
pm2 start main.js \
  --name "$APP_NAME" \
  --interpreter node \
  --node-args="--env-file=.env" \
  --restart-delay=5000 \
  --max-restarts=10

# Save pm2 config so bot survives reboots
pm2 save
sudo pm2 startup systemd -u "$USER" --hp "$HOME" 2>/dev/null || pm2 startup

echo ""
echo "══════════════════════════════════════════════════════"
echo "  ✅ Bot is LIVE"
echo "══════════════════════════════════════════════════════"
echo ""
echo "  Dashboard   : http://$SERVER_IP:3001"
echo "  Live logs   : pm2 logs $APP_NAME"
echo "  Stop bot    : pm2 stop $APP_NAME"
echo "  Restart bot : pm2 restart $APP_NAME"
echo "  Bot status  : pm2 status"
echo ""
echo "  Open port 3001 on your firewall to access dashboard:"
echo "  sudo ufw allow 3001"
echo ""
pm2 logs "$APP_NAME" --lines 30
