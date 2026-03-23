import fs from 'fs';
import path from 'path';
import ccxt from 'ccxt';
import { StrategyEngine } from '../modules/strategy_engine.js';

const DATA_PATH = path.resolve('data/historical_btc_1h.json');
const SYMBOL = 'BTC/USDT';
const TIMEFRAME = '1h';
const HIST_MONTHS = 6;
const START_BALANCE = 10000;
const FEE_RATE = 0.001; // 0.1%

// 1. Historical Data Fetcher
async function fetchHistoricalData() {
    if (fs.existsSync(DATA_PATH)) {
        console.error('Historical data already exists. Skipping download.');
        return JSON.parse(fs.readFileSync(DATA_PATH, 'utf-8'));
    }
    const exchange = new ccxt.binance({ enableRateLimit: true });
    const since = Date.now() - HIST_MONTHS * 30 * 24 * 60 * 60 * 1000;
    let all = [];
    let fetchSince = since;
    let limit = 1000;
    console.error('Fetching historical OHLCV data from Binance...');
    while (true) {
        const ohlcv = await exchange.fetchOHLCV(SYMBOL, TIMEFRAME, fetchSince, limit);
        if (!ohlcv.length) break;
        all = all.concat(ohlcv);
        fetchSince = ohlcv[ohlcv.length - 1][0] + 1;
        console.error(`Fetched ${all.length} candles so far...`);
        if (ohlcv.length < limit) break;
        await new Promise(r => setTimeout(r, exchange.rateLimit));
    }
    fs.writeFileSync(DATA_PATH, JSON.stringify(all, null, 2));
    console.error(`Saved ${all.length} candles to ${DATA_PATH}`);
    return all;
}

// 2. Simulation Engine
function simulateStrategy(ohlcv, params) {
    const strategy = new StrategyEngine(params);
    let balance = START_BALANCE;
    let position = 0;
    let avgEntry = 0;
    let fees = 0;
    let equityCurve = [START_BALANCE];
    let trades = [];
    let wins = 0, losses = 0, maxDrawdown = 0, peak = START_BALANCE;

    for (let i = 0; i < ohlcv.length; i++) {
        const slice = ohlcv.slice(0, i + 1);
        const close = slice[slice.length - 1][4];
        const signalData = strategy.generateSignal(slice, position, avgEntry);
        if (["BUY", "BUY_DCA"].includes(signalData.signal)) {
            // Simulate buy
            const buyAmount = 0.01; // 0.01 BTC per buy
            const cost = close * buyAmount;
            if (balance >= cost * (1 + FEE_RATE)) {
                fees += cost * FEE_RATE;
                balance -= cost * (1 + FEE_RATE);
                avgEntry = (avgEntry * position + cost) / (position + buyAmount);
                position += buyAmount;
                trades.push({ type: 'BUY', price: close, amount: buyAmount, i });
            }
        } else if (signalData.signal === "SELL" && position > 0) {
            // Simulate sell
            const proceeds = close * position;
            fees += proceeds * FEE_RATE;
            balance += proceeds * (1 - FEE_RATE);
            const profit = (close - avgEntry) * position;
            if (profit > 0) wins++; else losses++;
            trades.push({ type: 'SELL', price: close, amount: position, i, profit });
            position = 0;
            avgEntry = 0;
        }
        // Track equity
        const equity = balance + position * close;
        equityCurve.push(equity);
        if (equity > peak) peak = equity;
        const dd = (peak - equity) / peak;
        if (dd > maxDrawdown) maxDrawdown = dd;
    }
    // Liquidate at end
    if (position > 0) {
        const close = ohlcv[ohlcv.length - 1][4];
        const proceeds = close * position;
        fees += proceeds * FEE_RATE;
        balance += proceeds * (1 - FEE_RATE);
        const profit = (close - avgEntry) * position;
        if (profit > 0) wins++; else losses++;
        trades.push({ type: 'SELL', price: close, amount: position, i: ohlcv.length - 1, profit });
        position = 0;
        avgEntry = 0;
        equityCurve.push(balance);
    }
    const netProfit = ((balance - START_BALANCE) / START_BALANCE) * 100;
    const winRate = trades.filter(t => t.type === 'SELL' && t.profit > 0).length / trades.filter(t => t.type === 'SELL').length * 100 || 0;
    return {
        netProfit,
        maxDrawdown: maxDrawdown * 100,
        winRate,
        totalFees: fees,
        trades,
        params
    };
}

// 4. Grid Search Optimizer
async function runGridSearch(ohlcv) {
    const rsiOverboughts = [65, 70, 75, 80];
    const rsiOversolds = [20, 25, 30, 35];
    const macdFasts = [8, 12];
    const macdSlows = [21, 26];
    const dcaDrops = [0.03, 0.05, 0.08];
    let leaderboard = [];
    for (const macdFast of macdFasts) {
        for (const macdSlow of macdSlows) {
            for (const rsiOverbought of rsiOverboughts) {
                for (const rsiOversold of rsiOversolds) {
                    for (const dcaDropPct of dcaDrops) {
                        const params = {
                            macdFast,
                            macdSlow,
                            macdSignal: 9,
                            rsiPeriod: 14,
                            rsiOverbought,
                            rsiOversold,
                            dcaDropPct
                        };
                        const result = simulateStrategy(ohlcv, params);
                        leaderboard.push(result);
                        console.error(`Tested params: ${JSON.stringify(params)} | Net Profit: ${result.netProfit.toFixed(2)}% | Max DD: ${result.maxDrawdown.toFixed(2)}% | Win Rate: ${result.winRate.toFixed(2)}% | Fees: $${result.totalFees.toFixed(2)}`);
                    }
                }
            }
        }
    }
    leaderboard.sort((a, b) => b.netProfit - a.netProfit);
    console.error('\n===== TOP 5 PARAMETER SETS =====');
    leaderboard.slice(0, 5).forEach((r, idx) => {
        console.error(`#${idx + 1}: Profit: ${r.netProfit.toFixed(2)}% | MaxDD: ${r.maxDrawdown.toFixed(2)}% | Win: ${r.winRate.toFixed(2)}% | Fees: $${r.totalFees.toFixed(2)} | Params: ${JSON.stringify(r.params)}`);
    });
}

// Main
(async () => {
    const ohlcv = await fetchHistoricalData();
    await runGridSearch(ohlcv);
})();
