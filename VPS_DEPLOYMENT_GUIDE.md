# VPS Deployment Guide — BTC Trading Bot

This guide walks you through deploying the bot on a VPS in Germany or Singapore,
both of which are Binance-unrestricted regions.

---

## Recommended VPS Providers

| Provider | Region | Starting Price | Notes |
|---|---|---|---|
| **Hetzner** | Germany (Nuremberg/Falkenstein) | ~€4/mo | Best value, very reliable |
| **DigitalOcean** | Singapore (SGP1) | ~$6/mo | Easy UI, good docs |
| **Vultr** | Germany (Frankfurt) or Singapore | ~$6/mo | Good performance |
| **Contabo** | Germany (Munich) | ~€5/mo | High RAM/storage for price |

**Minimum specs:** 1 vCPU, 1 GB RAM, 20 GB storage (Ubuntu 22.04 LTS)

---

## Step 1: Create Your VPS

### Hetzner (Recommended — Germany)
1. Go to [hetzner.com/cloud](https://www.hetzner.com/cloud)
2. Create account → New Project → Add Server
3. Location: **Nuremberg** or **Falkenstein** (Germany)
4. Image: **Ubuntu 22.04**
5. Type: **CX21** (2 vCPU, 4 GB RAM) or **CX11** (1 vCPU, 2 GB RAM)
6. Add your SSH key (recommended) or use password
7. Click **Create & Buy**

### DigitalOcean (Singapore)
1. Go to [cloud.digitalocean.com](https://cloud.digitalocean.com)
2. Create Droplet → Region: **Singapore**
3. Image: **Ubuntu 22.04 LTS**
4. Size: **Basic — $6/mo** (1 vCPU, 1 GB RAM)
5. Add SSH key → Create Droplet

---

## Step 2: Connect to Your Server

```bash
ssh root@YOUR_SERVER_IP
```

---

## Step 3: Upload the Bot Files

From your **local machine** (or from Replit shell), run:

```bash
# Install rsync if not available
# Then copy all files to your server:
rsync -avz --exclude 'node_modules' "BTC trade/" root@YOUR_SERVER_IP:/opt/btc-bot/
```

Alternatively, use **SFTP** with FileZilla or WinSCP if you prefer a GUI.

---

## Step 4: Run the Deployment Script

SSH into your server and run:

```bash
ssh root@YOUR_SERVER_IP
cd /opt/btc-bot
bash scripts/deploy_vps.sh
```

This script will:
- Install Docker
- Detect and whitelist the server's IP automatically
- Build the Docker image
- Start the bot with auto-restart enabled

---

## Step 5: Verify It's Running

```bash
# Watch live logs
docker logs -f btc-bot-container

# Check container status
docker ps
```

You should see the bot connecting to Binance without geo-restriction errors.

---

## Managing the Bot

| Action | Command |
|---|---|
| View logs | `docker logs -f btc-bot-container` |
| Stop bot | `docker stop btc-bot-container` |
| Start bot | `docker start btc-bot-container` |
| Restart bot | `docker restart btc-bot-container` |
| Update & redeploy | Re-upload files → `docker build -t btc-bot . && docker restart btc-bot-container` |

---

## Security Checklist

- [ ] Keep `.env` file permissions restricted: `chmod 600 /opt/btc-bot/.env`
- [ ] Set up a firewall: `ufw allow ssh && ufw enable`
- [ ] Use SSH key authentication (disable password login)
- [ ] The bot's IP whitelist (`ip_whitelist.txt`) is auto-updated by the deploy script
- [ ] Consider rotating your Binance API keys after deployment

---

## Switching from Testnet to Live Trading

In your `.env` file on the server:

```env
TESTNET=false       # Switch to live Binance
API_KEY=your_live_api_key
API_SECRET=your_live_api_secret
```

Then restart: `docker restart btc-bot-container`
