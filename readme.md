# BTC Trading Bot — Project Overview

## Purpose
Modular, production-ready Node.js BTC trading bot connecting to Binance. Runs in **simulation mode** on Replit (Binance geo-restricts Replit IPs with 451 errors). Deploy to a VPS for live trading.

## Architecture
```
BTC trade/
├── main.js                      # Orchestrator: candle loop, signal routing, trade execution
├── modules/
│   ├── strategy_engine.js       # All indicators + scoring (22 indicators, 7 timeframes)
│   ├── risk_manager.js          # Kelly Criterion + ATR-scaled position sizing
│   ├── stop_loss_manager.js     # ATR trailing stop + partial TP at 2R/3R
│   ├── grid_trader.js           # Range-market grid strategy (ADX < 22)
│   ├── exchange_service.js      # Binance CCXT wrapper + sim mode fallback
│   ├── dashboard.js             # Express web dashboard (port 3001)
│   └── db.js                    # SQLite trade log (better-sqlite3)
├── scripts/backtest.js          # Historical backtesting runner
└── data/bot.db                  # SQLite database
```

## Strategy Engine — All Indicators (strategy_engine.js)
1. EMA 20/50/200 — trend alignment
2. ADX — market regime (trending vs ranging)
3. MACD — momentum + crossovers
4. RSI (14) — overbought/oversold
5. StochasticRSI — fast momentum shifts
6. Bollinger Bands — volatility + squeeze detection
7. ATR — stop placement, volatility scaling
8. OBV — on-balance volume trend
9. MFI — money flow index (volume-weighted RSI)
10. ROC — rate of change momentum
11. Candlestick patterns (Engulfing, Morning Star, 3 White Soldiers, Hammer, etc.)
12. Swing High/Low — dynamic support/resistance
13. VWAP (48H rolling) — institutional reference price
14. Fibonacci retracement (0.382/0.5/0.618) — auto-detected from 50-candle swing
15. 4H Multi-Timeframe — derived from 1H data, confirms trend direction
16. **Supertrend** (period=10, mult=3) — ATR-based trend confirmation + crossovers
17. **RSI Divergence** — bullish/bearish divergence detection (early reversal warning)
18. **Volume Surge** — 2× avg volume confirms breakouts
19. **Daily Pivot Points** — S1/S2/R1/R2 from previous 24H session
20. **Market Structure** — HH/HL vs LH/LL (3-section structural analysis)
21. **Williams %R** — overbought/oversold momentum exhaustion
22. **CCI** (20) — commodity channel index, cyclical reversal detection
- **Fear & Greed Index** — alternative.me sentiment (daily, contrarian signal)

## Risk Management
- **Kelly Criterion (Half-Kelly)** — position size from rolling 50-trade win rate
- **ATR volatility scaling** — quarter size at ATR > 5%, half at ATR > 3%
- **Max 20% balance per trade**, 1% risk fraction default
- **Trailing stop** — 2.5× ATR trail distance, rises with price
- **Partial take profits**: 33% sold at 2R + stop moves to breakeven; 100% at 3R
- **Breakeven move** at 2R — risk-free from that point on

## Scoring System
- BUY threshold: `minBuyScore = 6`
- SELL threshold: `minSellScore = 4`
- Hard veto: price below EMA200 = no BUY
- Hard veto: 4H bearish + MACD bearish = no BUY
- Penalties: bearTrend (−3), h4BearTrend (−2), MACD bearish in trend (−2)
- Max realistic buy score in strong bull: ~20

## Grid Trader (grid_trader.js)
- Activates when ADX < 22 AND NOT (bearTrend AND h4BearTrend)
- Max 3 open positions simultaneously
- Emergency sell: price falls 4+ grid steps below lowest fill
- No recenter with open positions
- capitalPerLevel = 0.08 (8% of balance per grid level)

## Deployment Notes
- **Replit**: Runs simulation only (Binance 451 geo-block). Dashboard at port 3001.
- **VPS target**: Frankfurt/Amsterdam/Singapore (Binance-accessible). Set BINANCE_API_KEY + BINANCE_SECRET_KEY.
- **GitHub**: `AlexanderMcQueen-byte/btc-trading-bot` (main branch, squash merges from btc branch)
- **Database**: SQLite at `BTC trade/data/bot.db` — fresh paper-trade state ($10K) each restart
- **MCP Server**: Enabled via STDIO for natural language commands

## Key Dependencies
- `ccxt` — Binance exchange connectivity
- `technicalindicators` — all indicator calculations
- `better-sqlite3` — trade log database
- `express` + `ws` — dashboard web server
- `winston` — structured logging
