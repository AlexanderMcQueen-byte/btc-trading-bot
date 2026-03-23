/**
 * Professional Backtesting Engine
 *
 * METRICS COMPUTED:
 * - Total Return %
 * - Sharpe Ratio    — return per unit of total risk (> 1.0 = good, > 2.0 = excellent)
 * - Sortino Ratio   — like Sharpe but only penalises downside risk (more relevant for trading)
 * - Calmar Ratio    — annualised return / max drawdown (> 3.0 = institutional grade)
 * - Max Drawdown    — largest peak-to-trough drop
 * - Win Rate        — % of profitable trades
 * - Profit Factor   — total wins / total losses (> 1.5 = good, > 2.0 = excellent)
 * - Avg Win / Loss  — average profit per winning/losing trade
 * - Expectancy      — expected $ profit per trade (positive = edge)
 *
 * USAGE:
 *   node scripts/backtest.js [--data path/to/ohlcv.json] [--initial 10000]
 */

import { readFileSync } from 'fs';
import { StrategyEngine } from '../modules/strategy_engine.js';
import { ATR } from 'technicalindicators';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── CONFIG ────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const dataFile  = args.includes('--data')    ? args[args.indexOf('--data') + 1]    : path.join(__dirname, '../data/historical_btc_1h.json');
const initial   = args.includes('--initial') ? parseFloat(args[args.indexOf('--initial') + 1]) : 10000;
const feeRate   = 0.001; // 0.1% taker fee (Binance standard)
const atrMult   = 2;     // Stop = 2x ATR
const riskPct   = 0.01;  // 1% risk per trade

// ── LOAD DATA ─────────────────────────────────────────────────────────────────
console.log(`\n📊 BTC Trading Bot — Professional Backtest`);
console.log(`${'─'.repeat(60)}`);
console.log(`Data file : ${dataFile}`);
console.log(`Capital   : $${initial.toLocaleString()}`);
console.log(`Fee rate  : ${feeRate * 100}% per trade`);
console.log(`Risk/trade: ${riskPct * 100}% of balance`);
console.log(`ATR mult  : ${atrMult}x (for stop placement)`);
console.log(`${'─'.repeat(60)}\n`);

const raw = JSON.parse(readFileSync(dataFile, 'utf-8'));

// Support both array-of-arrays and array-of-objects
const candles = raw.map(c => Array.isArray(c)
    ? { ts: c[0], open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5] }
    : { ts: c.timestamp || 0, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }
);

const strategy = new StrategyEngine({
    minBuyScore: 3,
    minSellScore: 3
});

// ── SIMULATION STATE ──────────────────────────────────────────────────────────
let balance     = initial;
let position    = 0;
let avgEntry    = 0;
let peakBalance = initial;
let maxDrawdown = 0;
const trades    = [];
const equityCurve = [initial];

const WARMUP = 250; // Need 250 candles for indicators

// ── WALK FORWARD BACKTEST ─────────────────────────────────────────────────────
for (let i = WARMUP; i < candles.length; i++) {
    const window = candles.slice(0, i + 1);
    const close  = candles[i].close;

    const ohlcv = window.map(c => [c.ts, c.open, c.high, c.low, c.close, c.volume]);

    // Compute ATR for stop sizing
    const highs  = window.map(c => c.high);
    const lows   = window.map(c => c.low);
    const closes = window.map(c => c.close);
    const atrArr = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 });
    const atr    = atrArr.length ? atrArr[atrArr.length - 1] : close * 0.02;

    // Check stop loss first
    if (position > 0 && avgEntry > 0) {
        const stopPrice = avgEntry - atrMult * atr;
        if (close <= stopPrice) {
            const proceeds = close * position;
            const fee = proceeds * feeRate;
            const profit = (close - avgEntry) * position - fee;
            balance += proceeds - fee;
            trades.push({ side: 'STOP', entryPrice: avgEntry, exitPrice: close, size: position, profit, candle: i });
            position = 0;
            avgEntry = 0;
        }
    }

    const sig = strategy.generateSignal(ohlcv, position, avgEntry);

    if (["BUY", "BUY_DCA"].includes(sig.signal) && position === 0) {
        const stopPrice = close - atrMult * atr;
        const riskPerUnit = Math.abs(close - stopPrice);
        if (riskPerUnit > 0) {
            const riskAmount = balance * riskPct;
            let size = riskAmount / riskPerUnit;
            const maxSize = (balance * 0.20) / close;
            size = Math.min(size, maxSize);
            size = Math.round(size * 1e6) / 1e6;

            if (size > 0 && balance >= close * size) {
                const cost = close * size;
                const fee = cost * feeRate;
                balance -= cost + fee;
                position = size;
                avgEntry = close;
                trades.push({ side: 'BUY', entryPrice: close, size, fee, candle: i });
            }
        }
    } else if (sig.signal === "SELL" && position > 0) {
        const proceeds = close * position;
        const fee = proceeds * feeRate;
        const profit = (close - avgEntry) * position - fee;
        balance += proceeds - fee;
        trades.push({ side: 'SELL', entryPrice: avgEntry, exitPrice: close, size: position, profit, fee, candle: i });
        position = 0;
        avgEntry = 0;
    }

    // Track equity (include open position value)
    const equity = balance + position * close;
    equityCurve.push(equity);

    if (equity > peakBalance) peakBalance = equity;
    const dd = (peakBalance - equity) / peakBalance;
    if (dd > maxDrawdown) maxDrawdown = dd;
}

// Close any open position at the last candle
if (position > 0) {
    const lastClose = candles[candles.length - 1].close;
    const proceeds = lastClose * position;
    const fee = proceeds * feeRate;
    const profit = (lastClose - avgEntry) * position - fee;
    balance += proceeds - fee;
    trades.push({ side: 'SELL_FINAL', entryPrice: avgEntry, exitPrice: lastClose, size: position, profit, fee });
    equityCurve.push(balance);
}

// ── COMPUTE METRICS ───────────────────────────────────────────────────────────
const finalBalance = balance;
const totalReturn  = (finalBalance - initial) / initial * 100;

const completedTrades = trades.filter(t => t.side === 'SELL' || t.side === 'STOP' || t.side === 'SELL_FINAL');
const wins   = completedTrades.filter(t => t.profit > 0);
const losses = completedTrades.filter(t => t.profit <= 0);

const winRate      = completedTrades.length > 0 ? wins.length / completedTrades.length * 100 : 0;
const avgWin       = wins.length   > 0 ? wins.reduce((s, t)   => s + t.profit, 0) / wins.length   : 0;
const avgLoss      = losses.length > 0 ? losses.reduce((s, t) => s + Math.abs(t.profit), 0) / losses.length : 0;
const totalWinPnl  = wins.reduce((s, t) => s + t.profit, 0);
const totalLossPnl = Math.abs(losses.reduce((s, t) => s + t.profit, 0));
const profitFactor = totalLossPnl > 0 ? totalWinPnl / totalLossPnl : Infinity;
const expectancy   = completedTrades.length > 0
    ? completedTrades.reduce((s, t) => s + t.profit, 0) / completedTrades.length
    : 0;

// Sharpe & Sortino
const returns = [];
for (let i = 1; i < equityCurve.length; i++) {
    returns.push((equityCurve[i] - equityCurve[i - 1]) / equityCurve[i - 1]);
}
const meanReturn  = returns.reduce((s, r) => s + r, 0) / returns.length;
const stdDev      = Math.sqrt(returns.reduce((s, r) => s + Math.pow(r - meanReturn, 2), 0) / returns.length);
const downReturns = returns.filter(r => r < 0);
const downsideDev = downReturns.length > 0
    ? Math.sqrt(downReturns.reduce((s, r) => s + r * r, 0) / downReturns.length)
    : 0.0001;

const annFactor   = Math.sqrt(24 * 365);
const sharpe      = stdDev > 0 ? (meanReturn / stdDev) * annFactor : 0;
const sortino     = downsideDev > 0 ? (meanReturn / downsideDev) * annFactor : 0;

const hoursRun    = candles.length;
const yearsRun    = hoursRun / (24 * 365);
const annualReturn = Math.pow(finalBalance / initial, 1 / Math.max(yearsRun, 0.001)) - 1;
const calmar      = maxDrawdown > 0 ? (annualReturn * 100) / (maxDrawdown * 100) : 0;

// ── PRINT RESULTS ─────────────────────────────────────────────────────────────
const grade = (val, good, excellent) =>
    val >= excellent ? '🟢 Excellent' : val >= good ? '🟡 Good' : '🔴 Needs Work';

console.log(`📈 BACKTEST RESULTS`);
console.log(`${'═'.repeat(60)}`);
console.log(`Period           : ${candles[0] ? new Date(candles[0].ts).toLocaleDateString() : 'N/A'} – ${candles[candles.length-1] ? new Date(candles[candles.length-1].ts).toLocaleDateString() : 'N/A'}`);
console.log(`Duration         : ${hoursRun.toLocaleString()} hours (${yearsRun.toFixed(2)} years)`);
console.log(`${'─'.repeat(60)}`);
console.log(`💰 PROFITABILITY`);
console.log(`  Start Balance  : $${initial.toLocaleString()}`);
console.log(`  End Balance    : $${finalBalance.toFixed(2)}`);
console.log(`  Total Return   : ${totalReturn.toFixed(2)}%  ${grade(totalReturn, 20, 100)}`);
console.log(`  Annual Return  : ${(annualReturn * 100).toFixed(2)}%`);
console.log(`${'─'.repeat(60)}`);
console.log(`📊 RISK-ADJUSTED RETURNS`);
console.log(`  Sharpe Ratio   : ${sharpe.toFixed(3)}  ${grade(sharpe, 1.0, 2.0)}`);
console.log(`  Sortino Ratio  : ${sortino.toFixed(3)}  ${grade(sortino, 1.5, 3.0)}`);
console.log(`  Calmar Ratio   : ${calmar.toFixed(3)}  ${grade(calmar, 1.0, 3.0)}`);
console.log(`  Max Drawdown   : ${(maxDrawdown * 100).toFixed(2)}%  ${maxDrawdown < 0.1 ? '🟢' : maxDrawdown < 0.2 ? '🟡' : '🔴'}`);
console.log(`${'─'.repeat(60)}`);
console.log(`🎯 TRADE STATISTICS`);
console.log(`  Total Trades   : ${completedTrades.length}`);
console.log(`  Win Rate       : ${winRate.toFixed(1)}%  ${grade(winRate, 50, 60)}`);
console.log(`  Profit Factor  : ${isFinite(profitFactor) ? profitFactor.toFixed(3) : '∞'}  ${grade(isFinite(profitFactor) ? profitFactor : 999, 1.5, 2.0)}`);
console.log(`  Avg Win        : $${avgWin.toFixed(2)}`);
console.log(`  Avg Loss       : -$${avgLoss.toFixed(2)}`);
console.log(`  Win/Loss Ratio : ${avgLoss > 0 ? (avgWin / avgLoss).toFixed(2) : 'N/A'}x`);
console.log(`  Expectancy     : $${expectancy.toFixed(2)}/trade  ${expectancy > 0 ? '🟢 Positive edge' : '🔴 No edge'}`);
console.log(`${'═'.repeat(60)}`);

if (completedTrades.length > 0) {
    console.log(`\n📋 LAST 10 TRADES`);
    console.log(`${'─'.repeat(60)}`);
    completedTrades.slice(-10).forEach(t => {
        const pnl = t.profit >= 0 ? `+$${t.profit.toFixed(2)}` : `-$${Math.abs(t.profit).toFixed(2)}`;
        const emoji = t.profit >= 0 ? '✅' : '❌';
        console.log(`  ${emoji} ${t.side.padEnd(10)} Entry: $${t.entryPrice?.toFixed(0).padStart(6)} → Exit: $${t.exitPrice?.toFixed(0).padStart(6)} | ${pnl}`);
    });
}

console.log(`\n✅ Backtest complete.\n`);
