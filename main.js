import { loadEnv } from './modules/secure_env.js';
import { RiskManager } from './modules/risk_manager.js';
import { StopLossManager } from './modules/stop_loss_manager.js';
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

// NOTE: We use console.error() for logging because console.log() writes to stdout,
// which breaks the MCP Stdio Transport (JSON-RPC expects clean stdout).

// Securely load environment variables
loadEnv();

// IP Whitelist check (cloud security)
const serverIp = getServerIp();
if (!isIpWhitelisted(serverIp)) {
    logger.error(`Server IP ${serverIp} not whitelisted. Exiting for security.`);
    process.exit(1);
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
    peakBalance: 10000.0
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
        minBuyScore: 3,
        minSellScore: 3
    });
    const symbol = process.env.DEFAULT_SYMBOL || "BTC/USDT";
    // Initialize risk manager with current balance and env risk params
    riskManager = new RiskManager({
        balance: BOT_STATE.currentBalance,
        maxRiskPct: parseFloat(process.env.MAX_RISK_PCT) || 0.01,
        stopLossPct: parseFloat(process.env.STOP_LOSS_PCT) || 0.02
    });
    const exchange = new ExchangeService({
        apiKey: process.env.API_KEY,
        apiSecret: process.env.API_SECRET,
        exchangeId: process.env.EXCHANGE_ID || 'binance',
        logger
    });

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

    // Load persisted state for live trading only.
    // Simulation always runs with a clean paper-trade state to avoid accumulating fake positions.
    if (!exchange.simulationMode) {
        const persisted = db.loadState('bot_state');
        if (persisted) {
            Object.assign(BOT_STATE, persisted);
            BOT_STATE.isRunning = true;
            BOT_STATE.circuitBreakerActive = false;
            BOT_STATE.initialDailyBalance = BOT_STATE.currentBalance;
            BOT_STATE.peakBalance = Math.max(BOT_STATE.currentBalance, BOT_STATE.peakBalance || BOT_STATE.currentBalance);
            logger.info(`Loaded persisted state. Session baseline: $${BOT_STATE.currentBalance.toFixed(2)} | Position: ${BOT_STATE.currentPosition} BTC`);
        }
        // Subscribe to real-time ticker via WebSocket (live mode only)
        subscribeTicker(symbol.replace('/', '').toLowerCase(), (msg) => {
            // stopLossManager.updateTrailing(symbol, msg.p ? parseFloat(msg.p) : null);
        });
    } else {
        logger.info('Simulation mode: starting with clean paper-trade state ($10,000 balance).');
    }

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

            // Fetch latest candle
            const newOhlcv = await exchange.fetchOHLCV(symbol, process.env.TIMEFRAME || '1h', undefined, 2);
            if (newOhlcv.length > 1) {
                ohlcv.push(newOhlcv[newOhlcv.length - 1]);
                if (ohlcv.length > 100) ohlcv.shift();
            }
            const close = ohlcv[ohlcv.length - 1][4];

            // Circuit breaker — use total portfolio value (USDT + BTC position at current price)
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
            const signalData = strategy.generateSignal(ohlcv, BOT_STATE.currentPosition, BOT_STATE.averageEntry);
            logger.info(`[${new Date().toLocaleTimeString()}] Analysis: ${signalData.signal} | ${signalData.reason}`);

            if (["BUY", "BUY_DCA"].includes(signalData.signal)) {
                // ATR-based dynamic stop loss — adapts to current market volatility
                const entryPrice = close;
                const stopPrice = strategy.getAtrStopLoss(ohlcv, entryPrice, 'BUY', 2);
                const buyAmount = riskManager.getPositionSize(entryPrice, stopPrice);
                if (buyAmount <= 0) {
                    logger.warn('Position size is zero. Skipping BUY.');
                } else {
                    const order = await exchange.createMarketBuyOrder(symbol, buyAmount);
                    if (order && order.status === 'closed') {
                        BOT_STATE.currentPosition += buyAmount;
                        BOT_STATE.averageEntry = (BOT_STATE.averageEntry * (BOT_STATE.currentPosition - buyAmount) + close * buyAmount) / BOT_STATE.currentPosition;
                        const fee = (order.fee && order.fee.cost) ? order.fee.cost : close * buyAmount * 0.001;
                        BOT_STATE.currentBalance -= (close * buyAmount + fee);
                        BOT_STATE.totalFeesPaid += fee;
                        db.logTrade({ timestamp: new Date().toISOString(), symbol, side: 'BUY', price: close, amount: buyAmount });
                        logger.info(`Executed BUY: ${buyAmount} ${symbol} @ $${close}`);
                        stopLossManager.setStop(symbol, stopPrice, 'BUY');
                    }
                }
            } else if (signalData.signal === "SELL" && BOT_STATE.currentPosition > 0) {
                const sellAmount = BOT_STATE.currentPosition;
                const order = await exchange.createMarketSellOrder(symbol, sellAmount);
                if (order && order.status === 'closed') {
                    const proceeds = close * sellAmount;
                    const fee = (order.fee && order.fee.cost) ? order.fee.cost : proceeds * 0.001;
                    BOT_STATE.currentBalance += (proceeds - fee);
                    BOT_STATE.totalFeesPaid += fee;
                    const profit = (close - BOT_STATE.averageEntry) * sellAmount;
                    BOT_STATE.realizedPnL += profit;
                    if (profit > 0) BOT_STATE.winTrades++; else BOT_STATE.lossTrades++;
                    db.logTrade({ timestamp: new Date().toISOString(), symbol, side: 'SELL', price: close, amount: sellAmount });
                    logger.info(`Executed SELL: ${sellAmount} ${symbol} @ $${close} | PnL: $${profit.toFixed(2)}`);
                    BOT_STATE.currentPosition = 0;
                    BOT_STATE.averageEntry = 0;
                    stopLossManager.clearStop(symbol);
                }
            }

            // Check stop-loss
            const lastPrice = ohlcv[ohlcv.length - 1][4];
            if (stopLossManager.shouldStop(symbol, lastPrice)) {
                logger.error(`Stop-loss triggered for ${symbol} at price ${lastPrice}`);
                sendAlert(`Stop-loss triggered for ${symbol} at price ${lastPrice}`);
                const sellAmount = BOT_STATE.currentPosition;
                if (sellAmount > 0) {
                    await exchange.createMarketSellOrder(symbol, sellAmount);
                    stopLossManager.clearStop(symbol);
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

            await new Promise(resolve => setTimeout(resolve, 10000));

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
