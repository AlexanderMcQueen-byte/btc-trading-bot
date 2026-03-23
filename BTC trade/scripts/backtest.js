/**
 * Professional Backtesting Engine
 *
 * MODES:
 *   node scripts/backtest.js                          — standard full-period backtest
 *   node scripts/backtest.js --mode walk-forward      — walk-forward cross-validation
 *   node scripts/backtest.js --mode monte-carlo       — Monte Carlo robustness simulation
 *
 * METRICS COMPUTED:
 *   Total Return, Sharpe, Sortino, Calmar, Max Drawdown,
 *   Win Rate, Profit Factor, Avg Win/Loss, Expectancy
 *
 * USAGE:
 *   node scripts/backtest.js [--data path/to/ohlcv.json] [--initial 10000]
 *                            [--mode standard|walk-forward|monte-carlo]
 *                            [--runs 1000]   (Monte Carlo simulations)
 *                            [--folds 5]     (Walk-forward folds)
 */

import { readFileSync } from 'fs';
import { StrategyEngine } from '../modules/strategy_engine.js';
import { ATR } from 'technicalindicators';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── CLI ARGS ──────────────────────────────────────────────────────────────────
const args     = process.argv.slice(2);
const getArg   = (flag, def) => args.includes(flag) ? args[args.indexOf(flag) + 1] : def;

const dataFile = getArg('--data',    path.join(__dirname, '../data/historical_btc_1h.json'));
const initial  = parseFloat(getArg('--initial', 10000));
const mode     = getArg('--mode',    'standard');   // standard | walk-forward | monte-carlo
const mcRuns   = parseInt(getArg('--runs',    1000));
const wfFolds  = parseInt(getArg('--folds',   5));

const feeRate  = 0.001;  // 0.1% taker fee
const atrMult  = 2;      // Stop = 2x ATR below entry
const riskPct  = 0.01;   // 1% account risk per trade

// ── LOAD CANDLES ──────────────────────────────────────────────────────────────
const raw = JSON.parse(readFileSync(dataFile, 'utf-8'));
const candles = raw.map(c => Array.isArray(c)
    ? { ts: c[0], open: c[1], high: c[2], low: c[3], close: c[4], volume: c[5] }
    : { ts: c.timestamp || 0, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume }
);

console.log(`\n📊 BTC Trading Bot — Backtest Engine (${mode.toUpperCase()})`);
console.log('─'.repeat(60));
console.log(`Data      : ${dataFile.split('/').pop()} (${candles.length.toLocaleString()} candles)`);
console.log(`Capital   : $${initial.toLocaleString()}`);
console.log(`Fee rate  : ${(feeRate * 100).toFixed(1)}% | Risk/trade: ${(riskPct * 100).toFixed(1)}% | ATR mult: ${atrMult}x`);
if (mode === 'walk-forward') console.log(`Folds     : ${wfFolds}`);
if (mode === 'monte-carlo')  console.log(`Runs      : ${mcRuns.toLocaleString()}`);
console.log('─'.repeat(60) + '\n');

const strategy = new StrategyEngine({ minBuyScore: 3, minSellScore: 3 });
const WARMUP   = 250;

// ── CORE SIMULATION ───────────────────────────────────────────────────────────
/**
 * Run a single backtest over a candles slice.
 * @param {Array}  candleSlice
 * @param {number} startBalance
 * @returns {{ finalBalance, trades, equityCurve, maxDrawdown }}
 */
function runSim(candleSlice, startBalance = initial) {
    let balance    = startBalance;
    let position   = 0;
    let avgEntry   = 0;
    let peakBal    = startBalance;
    let maxDD      = 0;
    const trades   = [];
    const equity   = [startBalance];

    for (let i = WARMUP; i < candleSlice.length; i++) {
        const window = candleSlice.slice(0, i + 1);
        const close  = candleSlice[i].close;
        const ohlcv  = window.map(c => [c.ts, c.open, c.high, c.low, c.close, c.volume]);

        // ATR for stop sizing
        const highs  = window.map(c => c.high);
        const lows   = window.map(c => c.low);
        const closes = window.map(c => c.close);
        const atrArr = ATR.calculate({ high: highs, low: lows, close: closes, period: 14 });
        const atr    = atrArr.length ? atrArr[atrArr.length - 1] : close * 0.02;

        // Stop loss check
        if (position > 0 && avgEntry > 0) {
            const stopPrice = avgEntry - atrMult * atr;
            if (close <= stopPrice) {
                const proceeds = close * position;
                const fee      = proceeds * feeRate;
                const profit   = (close - avgEntry) * position - fee;
                balance += proceeds - fee;
                trades.push({ side: 'STOP', entryPrice: avgEntry, exitPrice: close, size: position, profit });
                position = 0;
                avgEntry = 0;
            }
        }

        const sig = strategy.generateSignal(ohlcv, position, avgEntry);

        if (['BUY', 'BUY_DCA'].includes(sig.signal) && position === 0) {
            const stopPrice   = close - atrMult * atr;
            const riskPerUnit = Math.abs(close - stopPrice);
            if (riskPerUnit > 0) {
                const riskAmount = balance * riskPct;
                let size = Math.min(riskAmount / riskPerUnit, (balance * 0.20) / close);
                size = Math.round(size * 1e6) / 1e6;
                if (size > 0 && balance >= close * size) {
                    const cost = close * size;
                    const fee  = cost * feeRate;
                    balance   -= cost + fee;
                    position   = size;
                    avgEntry   = close;
                    trades.push({ side: 'BUY', entryPrice: close, size, fee });
                }
            }
        } else if (sig.signal === 'SELL' && position > 0) {
            const proceeds = close * position;
            const fee      = proceeds * feeRate;
            const profit   = (close - avgEntry) * position - fee;
            balance += proceeds - fee;
            trades.push({ side: 'SELL', entryPrice: avgEntry, exitPrice: close, size: position, profit, fee });
            position = 0;
            avgEntry = 0;
        }

        const eq = balance + position * close;
        equity.push(eq);
        if (eq > peakBal) peakBal = eq;
        const dd = (peakBal - eq) / peakBal;
        if (dd > maxDD) maxDD = dd;
    }

    // Close any open position at the end
    if (position > 0) {
        const lastClose = candleSlice[candleSlice.length - 1].close;
        const proceeds  = lastClose * position;
        const fee       = proceeds * feeRate;
        const profit    = (lastClose - avgEntry) * position - fee;
        balance += proceeds - fee;
        trades.push({ side: 'SELL_FINAL', entryPrice: avgEntry, exitPrice: lastClose, size: position, profit, fee });
        equity.push(balance);
    }

    return { finalBalance: balance, trades, equityCurve: equity, maxDrawdown: maxDD };
}

// ── METRICS ───────────────────────────────────────────────────────────────────
function computeMetrics(sim, candleCount) {
    const { finalBalance, trades, equityCurve, maxDrawdown } = sim;
    const totalReturn = (finalBalance - initial) / initial * 100;

    const completed = trades.filter(t => ['SELL', 'STOP', 'SELL_FINAL'].includes(t.side));
    const wins      = completed.filter(t => t.profit > 0);
    const losses    = completed.filter(t => t.profit <= 0);

    const winRate      = completed.length > 0 ? wins.length / completed.length * 100 : 0;
    const avgWin       = wins.length   > 0 ? wins.reduce((s, t) => s + t.profit, 0)             / wins.length   : 0;
    const avgLoss      = losses.length > 0 ? losses.reduce((s, t) => s + Math.abs(t.profit), 0) / losses.length : 0;
    const totalWin     = wins.reduce((s, t) => s + t.profit, 0);
    const totalLoss    = Math.abs(losses.reduce((s, t) => s + t.profit, 0));
    const profitFactor = totalLoss > 0 ? totalWin / totalLoss : Infinity;
    const expectancy   = completed.length > 0 ? completed.reduce((s, t) => s + t.profit, 0) / completed.length : 0;

    const returns = [];
    for (let i = 1; i < equityCurve.length; i++) {
        if (equityCurve[i - 1] > 0) returns.push((equityCurve[i] - equityCurve[i - 1]) / equityCurve[i - 1]);
    }
    const meanR   = returns.reduce((s, r) => s + r, 0) / Math.max(returns.length, 1);
    const stdDev  = Math.sqrt(returns.reduce((s, r) => s + (r - meanR) ** 2, 0) / Math.max(returns.length, 1));
    const downR   = returns.filter(r => r < 0);
    const downDev = downR.length > 0 ? Math.sqrt(downR.reduce((s, r) => s + r * r, 0) / downR.length) : 0.0001;

    const ann     = Math.sqrt(24 * 365);
    const sharpe  = stdDev > 0 ? (meanR / stdDev) * ann : 0;
    const sortino = downDev > 0 ? (meanR / downDev) * ann : 0;

    const years   = candleCount / (24 * 365);
    const annRet  = Math.pow(finalBalance / initial, 1 / Math.max(years, 0.001)) - 1;
    const calmar  = maxDrawdown > 0 ? (annRet * 100) / (maxDrawdown * 100) : 0;

    return { totalReturn, winRate, avgWin, avgLoss, profitFactor, expectancy, sharpe, sortino, calmar, maxDrawdown, completed, annRet, wins, losses };
}

// ── STANDARD BACKTEST ─────────────────────────────────────────────────────────
function runStandard() {
    const sim     = runSim(candles);
    const metrics = computeMetrics(sim, candles.length);
    const { finalBalance, trades } = sim;
    const { totalReturn, winRate, avgWin, avgLoss, profitFactor, expectancy, sharpe, sortino, calmar, maxDrawdown, completed, annRet } = metrics;

    const grade = (val, good, excellent) =>
        val >= excellent ? '🟢 Excellent' : val >= good ? '🟡 Good' : '🔴 Needs Work';

    const hoursRun = candles.length;
    const yearsRun = hoursRun / (24 * 365);

    console.log(`📈 BACKTEST RESULTS`);
    console.log('═'.repeat(60));
    console.log(`Period           : ${new Date(candles[0].ts).toLocaleDateString()} – ${new Date(candles[candles.length - 1].ts).toLocaleDateString()}`);
    console.log(`Duration         : ${hoursRun.toLocaleString()} hours (${yearsRun.toFixed(2)} years)`);
    console.log('─'.repeat(60));
    console.log(`💰 PROFITABILITY`);
    console.log(`  Start Balance  : $${initial.toLocaleString()}`);
    console.log(`  End Balance    : $${finalBalance.toFixed(2)}`);
    console.log(`  Total Return   : ${totalReturn.toFixed(2)}%  ${grade(totalReturn, 20, 100)}`);
    console.log(`  Annual Return  : ${(annRet * 100).toFixed(2)}%`);
    console.log('─'.repeat(60));
    console.log(`📊 RISK-ADJUSTED RETURNS`);
    console.log(`  Sharpe Ratio   : ${sharpe.toFixed(3)}  ${grade(sharpe, 1.0, 2.0)}`);
    console.log(`  Sortino Ratio  : ${sortino.toFixed(3)}  ${grade(sortino, 1.5, 3.0)}`);
    console.log(`  Calmar Ratio   : ${calmar.toFixed(3)}  ${grade(calmar, 1.0, 3.0)}`);
    console.log(`  Max Drawdown   : ${(maxDrawdown * 100).toFixed(2)}%  ${maxDrawdown < 0.1 ? '🟢' : maxDrawdown < 0.2 ? '🟡' : '🔴'}`);
    console.log('─'.repeat(60));
    console.log(`🎯 TRADE STATISTICS`);
    console.log(`  Total Trades   : ${completed.length}`);
    console.log(`  Win Rate       : ${winRate.toFixed(1)}%  ${grade(winRate, 50, 60)}`);
    console.log(`  Profit Factor  : ${isFinite(profitFactor) ? profitFactor.toFixed(3) : '∞'}  ${grade(isFinite(profitFactor) ? profitFactor : 999, 1.5, 2.0)}`);
    console.log(`  Avg Win        : $${avgWin.toFixed(2)}`);
    console.log(`  Avg Loss       : -$${avgLoss.toFixed(2)}`);
    console.log(`  Win/Loss Ratio : ${avgLoss > 0 ? (avgWin / avgLoss).toFixed(2) : 'N/A'}x`);
    console.log(`  Expectancy     : $${expectancy.toFixed(2)}/trade  ${expectancy > 0 ? '🟢 Positive edge' : '🔴 No edge'}`);
    console.log('═'.repeat(60));

    if (completed.length > 0) {
        console.log(`\n📋 LAST 10 TRADES`);
        console.log('─'.repeat(60));
        completed.slice(-10).forEach(t => {
            const pnl   = t.profit >= 0 ? `+$${t.profit.toFixed(2)}` : `-$${Math.abs(t.profit).toFixed(2)}`;
            const emoji = t.profit >= 0 ? '✅' : '❌';
            console.log(`  ${emoji} ${t.side.padEnd(10)} Entry: $${t.entryPrice?.toFixed(0).padStart(6)} → Exit: $${t.exitPrice?.toFixed(0).padStart(6)} | ${pnl}`);
        });
    }

    console.log(`\n✅ Backtest complete.\n`);
}

// ── WALK-FORWARD VALIDATION ───────────────────────────────────────────────────
/**
 * Splits candles into N folds.  For each fold:
 *   - In-sample  = first 70% of the fold period (strategy selection)
 *   - Out-sample = last 30%  of the fold period (reality check)
 * Reports per-fold out-of-sample Sharpe, return, max-DD.
 */
function runWalkForward() {
    const usable = candles.slice(WARMUP); // skip warmup
    const foldSize = Math.floor(usable.length / wfFolds);
    const inSamplePct = 0.70;

    console.log(`🔄 WALK-FORWARD VALIDATION (${wfFolds} folds)`);
    console.log('═'.repeat(60));
    console.log(`Each fold  : ${foldSize} candles  |  In-sample: ${Math.round(inSamplePct * 100)}%  |  Out-sample: ${Math.round((1 - inSamplePct) * 100)}%`);
    console.log('─'.repeat(60));
    console.log(` Fold  │   Out-Sample Return   │  Sharpe  │  MaxDD  │  Trades`);
    console.log('─'.repeat(60));

    const foldResults = [];

    for (let f = 0; f < wfFolds; f++) {
        const start   = f * foldSize;
        const end     = start + foldSize;
        const fold    = usable.slice(start, end);

        const splitAt = Math.floor(fold.length * inSamplePct);
        const outSlice = fold.slice(splitAt);       // out-of-sample window

        if (outSlice.length < WARMUP + 20) {
            console.log(`  ${String(f + 1).padStart(3)}  │  (insufficient data)  │          │         │`);
            continue;
        }

        // Prefix outSlice with warmup candles from in-sample period so indicators work
        const warmupData = fold.slice(Math.max(0, splitAt - WARMUP), splitAt);
        const testData   = [...warmupData, ...outSlice];

        const sim     = runSim(testData);
        const metrics = computeMetrics(sim, outSlice.length);

        const { totalReturn, sharpe, maxDrawdown, completed } = metrics;

        const returnStr = `${totalReturn >= 0 ? '+' : ''}${totalReturn.toFixed(2)}%`;
        const sharpeStr = sharpe.toFixed(3);
        const ddStr     = `${(maxDrawdown * 100).toFixed(2)}%`;

        const returnColor = totalReturn >= 0 ? '🟢' : '🔴';
        const sharpeColor = sharpe >= 1.0 ? '🟢' : sharpe >= 0 ? '🟡' : '🔴';

        console.log(`  ${String(f + 1).padStart(3)}  │  ${returnColor} ${returnStr.padStart(8)}        │  ${sharpeColor} ${sharpeStr}  │  ${ddStr.padStart(6)} │  ${completed.length}`);
        foldResults.push({ totalReturn, sharpe, maxDrawdown, tradeCount: completed.length });
    }

    if (foldResults.length > 0) {
        console.log('─'.repeat(60));
        const avgReturn = foldResults.reduce((s, r) => s + r.totalReturn, 0) / foldResults.length;
        const avgSharpe = foldResults.reduce((s, r) => s + r.sharpe, 0) / foldResults.length;
        const avgDD     = foldResults.reduce((s, r) => s + r.maxDrawdown, 0) / foldResults.length;
        const positiveFolds = foldResults.filter(r => r.totalReturn > 0).length;

        console.log(`\n📊 WALK-FORWARD SUMMARY`);
        console.log(`  Positive folds   : ${positiveFolds}/${foldResults.length} (${(positiveFolds / foldResults.length * 100).toFixed(0)}%)`);
        console.log(`  Avg return/fold  : ${avgReturn >= 0 ? '+' : ''}${avgReturn.toFixed(2)}%`);
        console.log(`  Avg Sharpe       : ${avgSharpe.toFixed(3)}`);
        console.log(`  Avg Max Drawdown : ${(avgDD * 100).toFixed(2)}%`);
        const consistency = positiveFolds / foldResults.length;
        console.log(`\n  Strategy consistency: ${consistency >= 0.8 ? '🟢 High (>80% positive folds)' : consistency >= 0.6 ? '🟡 Moderate (60–80%)' : '🔴 Low (<60%)'}`);
    }

    console.log(`\n✅ Walk-forward validation complete.\n`);
}

// ── MONTE CARLO SIMULATION ─────────────────────────────────────────────────────
/**
 * Runs N simulations where trade outcomes are randomly shuffled (bootstrap)
 * to test whether results are due to luck or a real edge.
 *
 * Approach:
 *   1. Run the standard backtest once to collect trade P&L sequence.
 *   2. Randomly reshuffle the trade order `runs` times.
 *   3. Rebuild equity curves from reshuffled P&L sequences.
 *   4. Report distribution of final returns and max-DD at 5th/50th/95th percentiles.
 */
function runMonteCarlo() {
    console.log(`🎲 MONTE CARLO SIMULATION (${mcRuns.toLocaleString()} runs)`);
    console.log('─'.repeat(60));
    console.log('Running base simulation to extract trade sequence...');

    const baseSim   = runSim(candles);
    const baseTrades = baseSim.trades.filter(t => ['SELL', 'STOP', 'SELL_FINAL'].includes(t.side));

    if (baseTrades.length < 5) {
        console.log('❌ Not enough trades for Monte Carlo (need >= 5). Run on a larger dataset.');
        return;
    }

    const pnls = baseTrades.map(t => t.profit);

    console.log(`  Base trades    : ${pnls.length}`);
    console.log(`  Base return    : ${((baseSim.finalBalance - initial) / initial * 100).toFixed(2)}%`);
    console.log('─'.repeat(60));
    console.log(`Running ${mcRuns.toLocaleString()} Monte Carlo simulations...`);

    const finalReturns  = [];
    const maxDrawdowns  = [];
    const winRates      = [];

    for (let run = 0; run < mcRuns; run++) {
        // Fisher-Yates shuffle of P&L outcomes
        const shuffled = [...pnls];
        for (let i = shuffled.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
        }

        // Rebuild equity curve from shuffled P&Ls
        let bal    = initial;
        let peak   = initial;
        let maxDD  = 0;
        let wins   = 0;
        const equity = [initial];

        for (const pnl of shuffled) {
            bal += pnl;
            equity.push(bal);
            if (bal > peak) peak = bal;
            const dd = (peak - bal) / peak;
            if (dd > maxDD) maxDD = dd;
            if (pnl > 0) wins++;
        }

        finalReturns.push((bal - initial) / initial * 100);
        maxDrawdowns.push(maxDD * 100);
        winRates.push(wins / shuffled.length * 100);
    }

    // Sort for percentile extraction
    finalReturns.sort((a, b) => a - b);
    maxDrawdowns.sort((a, b) => a - b);

    const pct = (arr, p) => arr[Math.floor(arr.length * p)];

    const profitProbability = finalReturns.filter(r => r > 0).length / mcRuns * 100;
    const ruin = finalReturns.filter(r => r <= -90).length / mcRuns * 100;

    console.log(`\n📊 MONTE CARLO RESULTS (${mcRuns.toLocaleString()} simulations)`);
    console.log('═'.repeat(60));
    console.log(`Final Return Distribution`);
    console.log(`  5th  percentile : ${pct(finalReturns, 0.05).toFixed(2)}%  (worst 5% of scenarios)`);
    console.log(`  25th percentile : ${pct(finalReturns, 0.25).toFixed(2)}%`);
    console.log(`  50th percentile : ${pct(finalReturns, 0.50).toFixed(2)}%  (median)`);
    console.log(`  75th percentile : ${pct(finalReturns, 0.75).toFixed(2)}%`);
    console.log(`  95th percentile : ${pct(finalReturns, 0.95).toFixed(2)}%  (best 5% of scenarios)`);
    console.log('─'.repeat(60));
    console.log(`Max Drawdown Distribution`);
    console.log(`  5th  percentile : ${pct(maxDrawdowns, 0.05).toFixed(2)}%`);
    console.log(`  50th percentile : ${pct(maxDrawdowns, 0.50).toFixed(2)}%  (typical scenario)`);
    console.log(`  95th percentile : ${pct(maxDrawdowns, 0.95).toFixed(2)}%  (worst 5% of scenarios)`);
    console.log('─'.repeat(60));
    console.log(`Edge Assessment`);
    console.log(`  Probability of profit   : ${profitProbability.toFixed(1)}%  ${profitProbability >= 70 ? '🟢' : profitProbability >= 50 ? '🟡' : '🔴'}`);
    console.log(`  Risk of ruin (>90% loss): ${ruin.toFixed(1)}%  ${ruin < 1 ? '🟢 Very low' : ruin < 5 ? '🟡 Moderate' : '🔴 High'}`);
    console.log('═'.repeat(60));

    const medianReturn = pct(finalReturns, 0.50);
    const worstCase    = pct(finalReturns, 0.05);
    if (medianReturn > 0 && worstCase > -30 && profitProbability >= 60) {
        console.log(`\n✅ Monte Carlo: Strategy shows a REAL EDGE — median positive with manageable downside.`);
    } else if (medianReturn > 0) {
        console.log(`\n⚠️  Monte Carlo: Strategy is profitable on median but with significant tail risk.`);
    } else {
        console.log(`\n❌ Monte Carlo: Strategy may be curve-fit — median result is negative across random orderings.`);
    }

    console.log(`\n✅ Monte Carlo simulation complete.\n`);
}

// ── DISPATCH ──────────────────────────────────────────────────────────────────
switch (mode) {
    case 'walk-forward':
        runWalkForward();
        break;
    case 'monte-carlo':
        runMonteCarlo();
        break;
    default:
        runStandard();
}
