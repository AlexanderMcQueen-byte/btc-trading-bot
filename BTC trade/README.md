# FinTech BTC Trading Bot

A modular, production-ready Bitcoin trading bot for Node.js, featuring:
- Model Context Protocol (MCP) integration via STDIO
- Modular strategy engine (MACD + RSI + DCA)
- Secure exchange access via `ccxt`
- Persistent state and trade logging with SQLite
- File and terminal logging (never uses `console.log`)
- Docker-ready for easy deployment

---

## 🚀 Quick Start

### 1. Clone & Install

```bash
git clone <your-repo-url>
cd <project-folder>
npm install
```

### 2. Configure Environment

Copy `.env` and fill in your API keys and settings:

```env
API_KEY=your_exchange_api_key_here
API_SECRET=your_exchange_api_secret_here
DEFAULT_SYMBOL=BTC/USDT
TIMEFRAME=1h
MAX_DAILY_LOSS_PCT=0.05
```

### 3. Run Locally

```bash
npm start
```

### 4. Run with Docker

Build and run the container:

```bash
docker build -t btc-bot .
docker run --env-file .env -v $(pwd)/data:/usr/src/app/data -v $(pwd)/logs:/usr/src/app/logs btc-bot
```

---

## 🛠️ Project Structure

- `main.js` — MCP server, trading loop, state
- `modules/strategy_engine.js` — Trading logic (MACD, RSI, DCA)
- `modules/exchange_service.js` — Secure exchange wrapper
- `modules/database.js` — SQLite persistence
- `modules/logger.js` — File and terminal logging
- `.env` — API keys and settings
- `Dockerfile` — Containerization
- `logs/` — Log files
- `data/` — SQLite database

---

## ⚠️ Logging & STDIO

**Do not use `console.log()` anywhere in the code.**  
All logs go to `console.error()` or to log files.  
Standard output is reserved for MCP JSON-RPC messages.

---

## 📄 License

MIT
