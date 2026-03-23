import { loadEnv } from './modules/secure_env.js';
import { RiskManager } from './modules/risk_manager.js';
import { StopLossManager } from './modules/stop_loss_manager.js';
import { GridTrader } from './modules/grid_trader.js';
import { getFearGreedIndex } from './modules/fear_greed.js';
import { checkKillSwitch } from './modules/hardware_kill_switch.js';
import { sendAlert } from './modules/alerting.js';
import { subscribeTicker } from './modules/ws_feed.js';
import { loadStrategy } from './modules/strategy_loader.js';
import { isIpWhitelisted, getServerIp } from './modules/ip_whitelist.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { StrategyEngine } from './modules/strategy_engine.js';
import { ExchangeService } from './modules/exchange_service.js';
import logger from './modules/logger.js';
import { BotDatabase } from './modules/database.js';
import { CooldownManager } from './modules/cooldown_manager.js';
import { startDashboard } from './modules/dashboard.js';

// NOTE: We use console.error() for logging because console.log() writes to stdout,
// which breaks the MCP Stdio Transport (JSON-RPC expects clean stdout).

// Securely load environment variables
loadEnv();

// IP Whitelist check (cloud security)
// In LIVE mode: hard exit if IP not whitelisted (prevents API keys being used from unknown servers).
// In DEV/SIMULATION: warn only — Replit rotates IPs frequently.
const serverIp = getServerIp();
if (!isIpWhitelisted(serverIp)) {
    const isLive = process.env.TESTNET !== 'true' && process.env.PAPER_TRADE !== 'true';
    if (isLive) {
        logger.error(`Server IP ${serverIp} not whitelisted. Exiting for security (live mode).`);
        process.exit(1);
    } else {
        logger.warn(`Server IP ${serverIp} not in whitelist — continuing in simulation/testnet mode.`);
    }
}

// Risk and stop-loss managers
let riskManager;
let stopLossManager = new StopLossManager();

const BOT_STATE = {
    isRunning: true,
    circuitBreakerActive: false,
    currentBalance: 10000.0,
    initialDailyBalance: 10000.0,
    totalFeesPaid: 0.0,
    currentPosition: 0.0,
    averageEntry: 0.0,
    lastUpdate: new Date().toISOString(),
    realizedPnL: 0.0,
    winTrades: 0,
    lossTrades: 0,
    maxDrawdown: 0.0,
    peakBalance: 10000.0,
    // Dashboard extras
    dcaLayers: [],          // [{entryPrice, size, stopPrice, openedAt}]
    currentBtcPrice: 0,
    lastSignal: null,       // {signal, score, reason}
    cooldown: {},           // {buyRemaining, sellRemaining, blocked}
    simulationMode: false
};

const server = new Server(
    { name: "btc-trading-bot", version: "1.0.0" },
    { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
        tools: [
            {
                name: "emergency_stop",
                description: "Instantly halts all trading operations and cancels pending orders.",
                inputSchema: { type: "object", properties: {} }
            },
            {
                name: "get_bot_status",
                description: "Retrieves the current financial and operational status of the bot.",
                inputSchema: { type: "object", properties: {} }
            },
            {
                name: "resume_trading",
                description: "Resumes trading operations if the bot was manually halted.",
                inputSchema: { type: "object", properties: {} }
            }
        ]
    };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name } = request.params;

    switch (name) {
        case "emergency_stop":
            BOT_STATE.isRunning = false;
            BOT_STATE.circuitBreakerActive = true;
            console.error("🚨 EMERGENCY STOP ACTIVATED VIA MCP. All trading halted.");
            return { content: [{ type: "text", text: "Emergency stop executed. Bot is now in standby mode. All open orders cancelled." }] };

        case "get_bot_status": {
            const lossPct = ((BOT_STATE.initialDailyBalance - BOT_STATE.currentBalance) / BOT_STATE.initialDailyBalance) * 100;
            const status = BOT_STATE.isRunning ? "RUNNING" : "HALTED";
            const text = `Status: ${status}\nBalance: $${BOT_STATE.currentBalance.toFixed(2)}\nPosition: ${BOT_STATE.currentPosition} BTC\n24h Loss/Gain: ${lossPct.toFixed(2)}%\nTotal Fees Tracked: $${BOT_STATE.totalFeesPaid.toFixed(2)}`;
            return { content: [{ type: "text", text }] };
        }

        case "resume_trading":
            if (BOT_STATE.circuitBreakerActive) {
                return { content: [{ type: "text", text: "Cannot resume: Circuit breaker active. Manual system reset required." }] };
            }
            BOT_STATE.isRunning = true;
            console.error("🟢 Trading resumed via MCP.");
            return { content: [{ type: "text", text: "Trading operations resumed." }] };

        default:
            throw new Error(`Tool ${name} not found`);
    }
});

async function tradingLoop() {
    console.error("Initializing FinTech Trading Modules...");
    const db = new BotDatabase();
    const strategy = new StrategyEngine({
        macdFast: 12, macdSlow: 26, macdSignal: 9,
        rsiPeriod: 14, rsiOverbought: 70, rsiOversold: 30,
        emaFast: 20, emaMid: 50, emaSlow: 200,
        adxPeriod: 14, adxTrendThreshold: 25,
        atrPeriod: 14, bbPeriod: 20, bbStdDev: 2,
        stochRsiPeriod: 14, mfiPeriod: 14, rocPeriod: 9,
        dcaDropPct: 0.05,
        minBuyScore: 6,   // Raised from 3 — only high-conviction entries
        minSellScore: 4   // Raised from 3 — require stronger SELL confirmation
    });
    const gridTrader = new GridTrader({ logger });
    const cooldown   = new CooldownManager({ logger });
    const symbol     = process.env.DEFAULT_SYMBOL || "BTC/USDT";

    riskManager = new RiskManager({
        balance: BOT_STATE.currentBalance,
        maxRiskPct: parseFloat(process.env.MAX_RISK_PCT) || 0.01,
        stopLossPct: parseFloat(process.env.STOP_LOSS_PCT) || 0.02,
        useKelly: true
    });
    const exchange = new ExchangeService({
        apiKey: process.env.API_KEY,
        apiSecret: process.env.API_SECRET,
        exchangeId: process.env.EXCHANGE_ID || 'binance',
        logger
    });

    // Fetch Fear & Greed Index (updates hourly, cached internally)
    let fearGreed = null;
    let lastFearGreedFetch = 0;
    let loopCycle = 0; // Counts main loop iterations for periodic balance sync

    // Hardware kill switch check
    if (checkKillSwitch()) {
        logger.error('Hardware kill switch detected. Trading halted.');
        sendAlert('Hardware kill switch triggered. Trading halted.');
        process.exit(1);
    }

    // Fetch initial candles first — this determines whether we are in live or simulation mode
    let ohlcv = await exchange.fetchOHLCV(symbol, process.env.TIMEFRAME || '1h', undefined, 250);
    if (!ohlcv.length) {
        logger.error('No OHLCV data fetched. Exiting.');
        process.exit(1);
    }

    // ── LIVE MODE: Seed state from real exchange balances ─────────────────
    // The exchange is the single source of truth for what we actually own.
    // We never trust a hardcoded or cached balance over the real account.
    if (!exchange.simulationMode) {
        logger.info('Fetching real account balances from exchange...');
        const accountBalance = await exchange.fetchBalance();

        if (!accountBalance) {
            // Testnet or restricted server: wallet/sapi endpoints may not be available.
            // In fully live mode this is a hard error; in testnet/paper, warn and continue.
            const isFullyLive = process.env.TESTNET !== 'true' && process.env.PAPER_TRADE !== 'true';
            if (isFullyLive) {
                logger.error('Could not fetch account balance from exchange. Halting to protect funds.');
                process.exit(1);
            } else {
                logger.warn('⚠️  Could not fetch live balance (testnet wallet endpoints may be geo-restricted). Continuing with paper-trade starting balance.');
            }
        }

        if (accountBalance) {
            // USDT available to trade
            const usdtFree  = accountBalance?.USDT?.free  ?? accountBalance?.['USDT']?.free  ?? 0;
            const usdtTotal = accountBalance?.USDT?.total ?? accountBalance?.['USDT']?.total ?? 0;

            // BTC already held (existing position)
            const btcFree  = accountBalance?.BTC?.free  ?? accountBalance?.['BTC']?.free  ?? 0;
            const btcTotal = accountBalance?.BTC?.total ?? accountBalance?.['BTC']?.total ?? 0;

            // Also detect the base asset of the symbol (e.g. BTC in BTC/USDT)
            const baseAsset = symbol.split('/')[0];
            const quoteAsset = symbol.split('/')[1] || 'USDT';
            const realBaseFree  = accountBalance?.[baseAsset]?.free  ?? btcFree;
            const realBaseLocked= (accountBalance?.[baseAsset]?.total ?? btcTotal) - realBaseFree;
            const realQuoteFree = accountBalance?.[quoteAsset]?.free ?? usdtFree;

            // Apply real balances — exchange is ground truth
            BOT_STATE.currentBalance = realQuoteFree;
            BOT_STATE.currentPosition = realBaseFree + realBaseLocked; // Include locked (in open orders)

            // Load persisted state for averageEntry and PnL history
            // (exchange doesn't tell us our average cost basis)
            const persisted = db.loadState('bot_state');
            if (persisted) {
                BOT_STATE.averageEntry  = persisted.averageEntry  || 0;
                BOT_STATE.realizedPnL   = persisted.realizedPnL   || 0;
                BOT_STATE.winTrades     = persisted.winTrades     || 0;
                BOT_STATE.lossTrades    = persisted.lossTrades    || 0;
                BOT_STATE.maxDrawdown   = persisted.maxDrawdown   || 0;
                BOT_STATE.totalFeesPaid = persisted.totalFeesPaid || 0;
            }

            // If we hold BTC but have no persisted entry price, warn — use current price as estimate
            if (BOT_STATE.currentPosition > 0.000001 && BOT_STATE.averageEntry === 0) {
                const currentPrice = ohlcv[ohlcv.length - 1][4] ?? ohlcv[ohlcv.length - 1].close;
                BOT_STATE.averageEntry = currentPrice;
                logger.warn(`⚠️  Holding ${BOT_STATE.currentPosition.toFixed(6)} ${baseAsset} but no recorded entry price — using current price $${currentPrice.toFixed(0)} as estimate. PnL tracking may be inaccurate for this position.`);
            }

            BOT_STATE.isRunning = true;
            BOT_STATE.circuitBreakerActive = false;
            BOT_STATE.initialDailyBalance = BOT_STATE.currentBalance + (BOT_STATE.currentPosition * (ohlcv[ohlcv.length - 1][4] ?? ohlcv[ohlcv.length - 1].close));
            BOT_STATE.peakBalance = Math.max(BOT_STATE.initialDailyBalance, BOT_STATE.peakBalance || 0);

            logger.info(`✅ Account loaded from exchange:`);
            logger.info(`   ${quoteAsset} balance : $${BOT_STATE.currentBalance.toFixed(2)} (available to trade)`);
            logger.info(`   ${baseAsset} position : ${BOT_STATE.currentPosition.toFixed(6)} ${baseAsset}${BOT_STATE.currentPosition > 0 ? ` (avg entry: $${BOT_STATE.averageEntry.toFixed(0)})` : ' (none)'}`);
            logger.info(`   Portfolio value: $${BOT_STATE.initialDailyBalance.toFixed(2)}`);
        }

        // Update risk manager with real balance
        riskManager.updateBalance(BOT_STATE.currentBalance);

        // Subscribe to real-time ticker via WebSocket
        subscribeTicker(symbol.replace('/', '').toLowerCase(), (msg) => {
            // stopLossManager.updateTrailing(symbol, msg.p ? parseFloat(msg.p) : null);
        });
    } else {
        logger.info('Simulation mode: starting with clean paper-trade state ($10,000 balance).');
    }

    // Update simulationMode flag for dashboard
    BOT_STATE.simulationMode = exchange.simulationMode;

    // ── Start live dashboard ──────────────────────────────────────────────────
    const dashboard = startDashboard({
        getBotState: () => ({ ...BOT_STATE }),
        db,
        logger
    });

    let lastEquitySnapshot = 0;

    while (true) {
        try {
            // Hardware kill switch check
            if (checkKillSwitch()) {
                logger.error('Hardware kill switch detected. Trading halted.');
                sendAlert('Hardware kill switch triggered. Trading halted.');
                break;
            }

            if (!BOT_STATE.isRunning) {
                await new Promise(resolve => setTimeout(resolve, 10000));
                continue;
            }

            loopCycle++;

            // Refresh Fear & Greed Index every hour
            if (Date.now() - lastFearGreedFetch > 60 * 60 * 1000) {
                try {
                    fearGreed = await getFearGreedIndex();
                    lastFearGreedFetch = Date.now();
                    if (fearGreed.available) {
                        logger.info(`Fear & Greed: ${fearGreed.value} (${fearGreed.classification}) | Trend: ${fearGreed.trend}`);
                    }
                } catch (_) { /* non-critical — continue without it */ }
            }

            // Sync real account balances every 10 cycles (live mode only)
            // Prevents drift from fees, partial fills, or external account changes.
            if (!exchange.simulationMode && loopCycle % 10 === 0) {
                try {
                    const syncedBalance = await exchange.fetchBalance();
                    if (syncedBalance) {
                        const baseAsset  = symbol.split('/')[0];
                        const quoteAsset = symbol.split('/')[1] || 'USDT';
                        const realQuoteFree = syncedBalance?.[quoteAsset]?.free ?? 0;
                        const realBaseFree  = syncedBalance?.[baseAsset]?.free  ?? 0;
                        const realBaseLocked = (syncedBalance?.[baseAsset]?.total ?? realBaseFree) - realBaseFree;
                        const realBaseTotal = realBaseFree + realBaseLocked;

                        const prevBalance  = BOT_STATE.currentBalance;
                        const prevPosition = BOT_STATE.currentPosition;
                        BOT_STATE.currentBalance  = realQuoteFree;
                        BOT_STATE.currentPosition = realBaseTotal;
                        riskManager.updateBalance(realQuoteFree);

                        if (Math.abs(prevBalance - realQuoteFree) > 0.01 || Math.abs(prevPosition - realBaseTotal) > 0.000001) {
                            logger.info(`[Sync] Balance reconciled | ${quoteAsset}: $${realQuoteFree.toFixed(2)} (was $${prevBalance.toFixed(2)}) | ${baseAsset}: ${realBaseTotal.toFixed(6)} (was ${prevPosition.toFixed(6)})`);
                        }
                    }
                } catch (syncErr) {
                    logger.warn(`Balance sync failed (non-critical): ${syncErr.message}`);
                }
            }

            // Fetch latest candle (keep up to 500 candles — enough for all indicators including EMA200)
            const newOhlcv = await exchange.fetchOHLCV(symbol, process.env.TIMEFRAME || '1h', undefined, 2);
            if (newOhlcv.length > 1) {
                ohlcv.push(newOhlcv[newOhlcv.length - 1]);
                if (ohlcv.length > 500) ohlcv.shift();
            }
            const close = ohlcv[ohlcv.length - 1][4] ?? ohlcv[ohlcv.length - 1].close;
            BOT_STATE.currentBtcPrice = close;
            BOT_STATE.lastUpdate = new Date().toISOString();
            BOT_STATE.cooldown = cooldown.status();

            // Record equity snapshot every 5 minutes
            if (Date.now() - lastEquitySnapshot > 5 * 60 * 1000) {
                try {
                    db.recordEquitySnapshot({ balance: BOT_STATE.currentBalance, position: BOT_STATE.currentPosition, btcPrice: close });
                    lastEquitySnapshot = Date.now();
                } catch (_) {}
            }

            // Circuit breaker — uses total portfolio value (USDT + BTC at current price)
            const portfolioValue = BOT_STATE.currentBalance + (BOT_STATE.currentPosition * close);
            const dailyLossPct = (BOT_STATE.initialDailyBalance - portfolioValue) / BOT_STATE.initialDailyBalance;
            if (dailyLossPct >= (parseFloat(process.env.MAX_DAILY_LOSS_PCT) || 0.05)) {
                logger.error(`🚨 CIRCUIT BREAKER: 24h loss reached ${(dailyLossPct * 100).toFixed(2)}%. Halting.`);
                sendAlert(`CIRCUIT BREAKER: 24h loss reached ${(dailyLossPct * 100).toFixed(2)}%. Halting.`);
                BOT_STATE.isRunning = false;
                BOT_STATE.circuitBreakerActive = true;
                db.saveState('bot_state', BOT_STATE);
                continue;
            }

            // Generate strategy signal (pass Fear & Greed for sentiment scoring)
            const signalData = strategy.generateSignal(ohlcv, BOT_STATE.currentPosition, BOT_STATE.averageEntry, fearGreed);
            BOT_STATE.lastSignal = { signal: signalData.signal, score: signalData.score, reason: signalData.reason };
            const adx = signalData.indicators?.adx ?? 30;
            const atr = signalData.indicators?.atr ?? close * 0.02;
            logger.info(`[${new Date().toLocaleTimeString()}] Analysis: ${signalData.signal} | ${signalData.reason}`);

            // ── GRID TRADING (ranging market) ─────────────────────────────
            // When ADX is low (no trend), hand control to the grid trader.
            // Grid trader is profitable in sideways markets where trend strategies fail.
            const gridResult = gridTrader.evaluate(close, atr, adx, BOT_STATE.currentBalance);
            if (gridResult.action === 'GRID_BUY' && gridResult.size > 0 && BOT_STATE.currentBalance > close * gridResult.size) {
                const order = await exchange.createMarketBuyOrder(symbol, gridResult.size);
                if (order && order.status === 'closed') {
                    const cost = close * gridResult.size;
                    const fee = (order.fee?.cost) ?? cost * 0.001;
                    BOT_STATE.currentBalance -= (cost + fee);
                    BOT_STATE.totalFeesPaid += fee;
                    BOT_STATE.currentPosition += gridResult.size;
                    BOT_STATE.averageEntry = BOT_STATE.averageEntry > 0
                        ? (BOT_STATE.averageEntry * (BOT_STATE.currentPosition - gridResult.size) + close * gridResult.size) / BOT_STATE.currentPosition
                        : close;
                    logger.info(`[GRID] BUY executed: ${gridResult.size} BTC @ $${close} | ${gridResult.reason}`);
                }
            } else if (gridResult.action === 'GRID_SELL' && BOT_STATE.currentPosition > 0) {
                const gridSellAmount = Math.min(BOT_STATE.currentPosition, gridResult.size || BOT_STATE.currentPosition);
                const order = await exchange.createMarketSellOrder(symbol, gridSellAmount);
                if (order && order.status === 'closed') {
                    const proceeds = close * gridSellAmount;
                    const fee = (order.fee?.cost) ?? proceeds * 0.001;
                    const profit = (close - BOT_STATE.averageEntry) * gridSellAmount;
                    BOT_STATE.currentBalance += (proceeds - fee);
                    BOT_STATE.totalFeesPaid += fee;
                    BOT_STATE.realizedPnL += profit;
                    if (profit > 0) BOT_STATE.winTrades++; else BOT_STATE.lossTrades++;
                    BOT_STATE.currentPosition -= gridSellAmount;
                    if (BOT_STATE.currentPosition < 0.000001) { BOT_STATE.currentPosition = 0; BOT_STATE.averageEntry = 0; }
                    riskManager.recordTrade(profit, Math.abs(atr * gridSellAmount));
                    logger.info(`[GRID] SELL executed: ${gridSellAmount} BTC @ $${close} | PnL: $${profit.toFixed(2)} | ${gridResult.reason}`);
                }
            }

            // ── TREND STRATEGY (trending market) ─────────────────────────
            // Only run trend signals when grid is NOT active (different regimes)
            if (!gridTrader.active) {
                if (["BUY", "BUY_DCA"].includes(signalData.signal) && BOT_STATE.currentPosition === 0) {
                    const entryPrice = close;

                    // ── Cooldown check ────────────────────────────────────────────────
                    if (!cooldown.canBuy()) {
                        // Already logged inside cooldown.canBuy()
                    }
                    // ── Balance check — always verify funds before sizing ──────────────
                    else if (BOT_STATE.currentBalance <= 0) {
                        logger.warn(`Skipping BUY — no USDT balance available ($${BOT_STATE.currentBalance.toFixed(2)}).`);
                    } else {
                        // ATR-based stop loss — widened to 2.5x ATR to give trades breathing room
                        // Previously 2x was too tight; analysis showed avg loss from premature stops
                        const ATR_MULT = 2.5;
                        const stopPrice = strategy.getAtrStopLoss(ohlcv, entryPrice, 'BUY', ATR_MULT);

                        // Minimum reward:risk check — only take trades with at least 1.5:1 upside.
                        // Target = distance to recent 20-candle swing high (local resistance).
                        // This is dynamic: if resistance is far away the trade is viable; if not, skip.
                        const recentHighs = ohlcv.slice(-20).map(c => (typeof c.high !== 'undefined' ? c.high : c[2]));
                        const nearResistanceTarget = Math.max(...recentHighs);
                        const stopDistance = entryPrice - stopPrice;
                        const targetDistance = nearResistanceTarget - entryPrice; // How far to swing high
                        const rewardRiskRatio = stopDistance > 0 && targetDistance > 0 ? targetDistance / stopDistance : 0;
                        if (rewardRiskRatio < 1.5) {
                            logger.info(`⛔ BUY skipped — R:R ${rewardRiskRatio.toFixed(2)} < 1.5 minimum (risk: $${stopDistance.toFixed(0)}, reward to resistance $${nearResistanceTarget.toFixed(0)}: $${targetDistance.toFixed(0)})`);
                        } else {

                        // Kelly + volatility-scaled position size
                        let buyAmount = riskManager.getPositionSize(entryPrice, stopPrice, atr);

                        // Hard cap: never spend more than 95% of available balance
                        // (reserve 5% buffer for fees and rounding)
                        const maxAffordable = Math.floor((BOT_STATE.currentBalance * 0.95) / close * 1e6) / 1e6;
                        buyAmount = Math.min(buyAmount, maxAffordable);

                        const totalCost = close * buyAmount * 1.001; // include 0.1% fee estimate
                        if (buyAmount <= 0) {
                            logger.warn('Position size is zero — skipping BUY (check balance/risk params).');
                        } else if (totalCost > BOT_STATE.currentBalance) {
                            logger.warn(`Skipping BUY — insufficient balance: need $${totalCost.toFixed(2)}, have $${BOT_STATE.currentBalance.toFixed(2)}.`);
                        } else {
                            const order = await exchange.createMarketBuyOrder(symbol, buyAmount);
                            if (order && order.status === 'closed') {
                                const cost = close * buyAmount;
                                const fee = (order.fee?.cost) ?? cost * 0.001;
                                BOT_STATE.currentPosition = buyAmount;
                                BOT_STATE.averageEntry = close;
                                BOT_STATE.currentBalance -= (cost + fee);
                                BOT_STATE.totalFeesPaid += fee;
                                BOT_STATE.dcaLayers = [{ entryPrice: close, size: buyAmount, stopPrice, openedAt: new Date().toISOString() }];
                                cooldown.recordBuy();
                                db.logTrade({ timestamp: new Date().toISOString(), symbol, side: 'BUY', price: close, amount: buyAmount, fee, balance: BOT_STATE.currentBalance, signalScore: signalData.score });
                                logger.info(`Executed BUY: ${buyAmount} BTC @ $${close} | Stop: $${stopPrice.toFixed(0)} | ${riskManager.getKellyStats()}`);
                                dashboard.push({ ...BOT_STATE });
                                // Set ATR trailing stop — widened to 2.5x ATR to match entry stop
                                stopLossManager.setStop(symbol, entryPrice, stopPrice, 'BUY', true, atr * ATR_MULT);
                            }
                        }
                        } // end R:R check else
                    }
                } else if (signalData.signal === "SELL" && BOT_STATE.currentPosition > 0) {
                    const sellAmount = BOT_STATE.currentPosition;
                    const order = await exchange.createMarketSellOrder(symbol, sellAmount);
                    if (order && order.status === 'closed') {
                        const proceeds = close * sellAmount;
                        const fee = (order.fee?.cost) ?? proceeds * 0.001;
                        const profit = (close - BOT_STATE.averageEntry) * sellAmount;
                        BOT_STATE.currentBalance += (proceeds - fee);
                        BOT_STATE.totalFeesPaid += fee;
                        BOT_STATE.realizedPnL += profit;
                        if (profit > 0) BOT_STATE.winTrades++; else BOT_STATE.lossTrades++;
                        riskManager.recordTrade(profit, Math.abs(close - BOT_STATE.averageEntry) * sellAmount);
                        BOT_STATE.currentPosition = 0;
                        BOT_STATE.averageEntry = 0;
                        BOT_STATE.dcaLayers = [];
                        cooldown.recordSell();
                        db.logTrade({ timestamp: new Date().toISOString(), symbol, side: 'SELL', price: close, amount: sellAmount, fee, pnl: profit, balance: BOT_STATE.currentBalance, signalScore: signalData.score });
                        logger.info(`Executed SELL: ${sellAmount} BTC @ $${close} | PnL: $${profit.toFixed(2)}`);
                        dashboard.push({ ...BOT_STATE });
                        stopLossManager.clearStop(symbol);
                    }
                }
            }

            // ── STOP LOSS & TAKE PROFIT ───────────────────────────────────
            if (BOT_STATE.currentPosition > 0) {
                // Update trailing stop and check for take-profit milestones
                const tpHit = stopLossManager.updateTrailing(symbol, close);
                if (tpHit) {
                    logger.info(`🎯 Take-profit ${tpHit.label} reached @ $${tpHit.price.toFixed(0)} | ${stopLossManager.getStopInfo(symbol)}`);
                }
                // Trigger stop if breached
                if (stopLossManager.shouldStop(symbol, close)) {
                    logger.error(`🛑 Stop-loss triggered for ${symbol} @ $${close} | ${stopLossManager.getStopInfo(symbol)}`);
                    sendAlert(`Stop-loss triggered @ $${close}`);
                    const sellAmount = BOT_STATE.currentPosition;
                    const order = await exchange.createMarketSellOrder(symbol, sellAmount);
                    if (order && order.status === 'closed') {
                        const proceeds = close * sellAmount;
                        const fee = (order.fee?.cost) ?? proceeds * 0.001;
                        const profit = (close - BOT_STATE.averageEntry) * sellAmount;
                        BOT_STATE.currentBalance += (proceeds - fee);
                        BOT_STATE.totalFeesPaid += fee;
                        BOT_STATE.realizedPnL += profit;
                        if (profit > 0) BOT_STATE.winTrades++; else BOT_STATE.lossTrades++;
                        riskManager.recordTrade(profit, Math.abs(close - BOT_STATE.averageEntry) * sellAmount);
                        BOT_STATE.currentPosition = 0;
                        BOT_STATE.averageEntry = 0;
                        BOT_STATE.dcaLayers = [];
                        cooldown.recordSell();
                        db.logTrade({ timestamp: new Date().toISOString(), symbol, side: 'SELL', price: close, amount: sellAmount, fee, pnl: profit, balance: BOT_STATE.currentBalance, notes: 'stop-loss' });
                        dashboard.push({ ...BOT_STATE });
                        stopLossManager.clearStop(symbol);
                    }
                }
            }

            // Update drawdown using total portfolio value (USDT + BTC position)
            const currentPortfolioValue = BOT_STATE.currentBalance + (BOT_STATE.currentPosition * close);
            if (currentPortfolioValue > BOT_STATE.peakBalance) BOT_STATE.peakBalance = currentPortfolioValue;
            const drawdown = BOT_STATE.peakBalance > 0
                ? (BOT_STATE.peakBalance - currentPortfolioValue) / BOT_STATE.peakBalance
                : 0;
            if (drawdown > BOT_STATE.maxDrawdown) BOT_STATE.maxDrawdown = drawdown;

            // Persist state (live mode only — simulation runs in-memory)
            if (!exchange.simulationMode) {
                db.saveState('bot_state', BOT_STATE);
            }

            // Performance summary every 10 cycles
            if (Math.floor(Date.now() / 10000) % 10 === 0) {
                const mode = exchange.simulationMode ? '[SIM] ' : '';
                logger.info(`${mode}Stats | Balance: $${BOT_STATE.currentBalance.toFixed(2)} | Position: ${BOT_STATE.currentPosition.toFixed(6)} BTC | PnL: $${BOT_STATE.realizedPnL.toFixed(2)} | Max DD: ${(BOT_STATE.maxDrawdown * 100).toFixed(2)}% | W/L: ${BOT_STATE.winTrades}/${BOT_STATE.lossTrades}`);
            }

            // In simulation mode cycle fast so you can watch trades unfold;
            // in live mode stay at 10s to avoid hammering the exchange.
            const sleepMs = exchange.simulationMode ? 1500 : 10000;
            await new Promise(resolve => setTimeout(resolve, sleepMs));

        } catch (error) {
            logger.error("Trading loop exception: " + error.message);
            sendAlert("Trading loop exception: " + error.message);
            await new Promise(resolve => setTimeout(resolve, 30000));
        }
    }
}

async function main() {
    console.error("Starting up Modular BTC Trading Bot (Node.js Edition)...");
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("✅ MCP Server connected via STDIO. Ready for natural language commands.");

    tradingLoop().catch(err => logger.error('Fatal trading loop error: ' + err.message));
}

main().catch(console.error);
