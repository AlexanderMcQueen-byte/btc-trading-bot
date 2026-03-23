/**
 * Institutional-Grade Risk Management
 *
 * POSITION SIZING APPROACHES:
 *
 * 1. FIXED FRACTIONAL (current): Risk a fixed % of balance per trade.
 *    Simple, consistent, widely used.
 *
 * 2. KELLY CRITERION: Mathematically optimal position size based on
 *    historical win rate and average win/loss ratio.
 *    Full Kelly is often too aggressive — we use HALF-KELLY for safety.
 *    Formula: f = (winRate * avgWinRatio - lossRate) / avgWinRatio
 *    Where avgWinRatio = avgWin / avgLoss
 *
 * 3. VOLATILITY-SCALED: Reduce size when ATR/volatility is high,
 *    increase when conditions are calm. Never fight volatility with big size.
 *
 * Best practice: Combine all three:
 *   - Kelly sets the baseline
 *   - Fixed fractional caps maximum risk
 *   - Volatility scaling adjusts for current conditions
 */
export class RiskManager {
    constructor({
        balance,
        maxRiskPct = 0.01,      // Max 1% of balance risked per trade
        stopLossPct = 0.02,     // Default 2% stop loss (if ATR not available)
        maxPositionPct = 0.20,  // Never deploy more than 20% of balance in one trade
        useKelly = true         // Use Kelly Criterion for sizing
    }) {
        this.balance = balance;
        this.maxRiskPct = maxRiskPct;
        this.stopLossPct = stopLossPct;
        this.maxPositionPct = maxPositionPct;
        this.useKelly = useKelly;

        // Kelly tracking — updated as trades complete
        this.tradeHistory = []; // { pnl, riskAmount }
    }

    updateBalance(newBalance) {
        this.balance = newBalance;
    }

    /**
     * Record completed trade for Kelly calculation.
     * @param {number} pnl - Realized PnL of the trade
     * @param {number} riskAmount - Dollar amount risked on the trade
     */
    recordTrade(pnl, riskAmount) {
        this.tradeHistory.push({ pnl, riskAmount });
        // Keep last 50 trades for rolling Kelly calculation
        if (this.tradeHistory.length > 50) {
            this.tradeHistory.shift();
        }
    }

    /**
     * Calculate Half-Kelly fraction based on recent trade history.
     * Returns a fraction of balance to risk (e.g. 0.015 = 1.5%).
     * Falls back to maxRiskPct if not enough history.
     */
    _kellyFraction() {
        if (!this.useKelly || this.tradeHistory.length < 10) {
            return this.maxRiskPct; // Not enough data yet
        }

        const wins  = this.tradeHistory.filter(t => t.pnl > 0);
        const losses= this.tradeHistory.filter(t => t.pnl <= 0);

        if (wins.length === 0 || losses.length === 0) {
            return this.maxRiskPct;
        }

        const winRate  = wins.length / this.tradeHistory.length;
        const lossRate = 1 - winRate;

        const avgWin  = wins.reduce((s, t) => s + t.pnl, 0) / wins.length;
        const avgLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0) / losses.length);

        if (avgLoss === 0) return this.maxRiskPct;

        const winRatio = avgWin / avgLoss;
        // Kelly formula
        const kelly = (winRate * winRatio - lossRate) / winRatio;
        // Half-Kelly for safety, capped at maxRiskPct * 2
        const halfKelly = Math.max(0, kelly * 0.5);
        return Math.min(halfKelly, this.maxRiskPct * 2);
    }

    /**
     * Get optimal position size in BTC.
     *
     * @param {number} entryPrice - Current price
     * @param {number} stopPrice  - Stop loss price
     * @param {number} [atr]      - ATR for volatility scaling (optional)
     * @returns {number} - BTC quantity to buy/sell
     */
    getPositionSize(entryPrice, stopPrice, atr = null) {
        const riskFraction = this._kellyFraction();
        const riskPerTrade = this.balance * riskFraction;

        const riskPerUnit = Math.abs(entryPrice - stopPrice);
        if (riskPerUnit === 0) return 0;

        let size = riskPerTrade / riskPerUnit;

        // Volatility scaling: if ATR > 3% of price, halve the size
        if (atr !== null) {
            const atrPct = atr / entryPrice;
            if (atrPct > 0.05)      size *= 0.25; // Extreme volatility — quarter size
            else if (atrPct > 0.03) size *= 0.5;  // High volatility — half size
            else if (atrPct < 0.01) size *= 1.25; // Very calm — 25% larger size
        }

        // Hard cap: never deploy more than maxPositionPct of balance
        const maxBtc = (this.balance * this.maxPositionPct) / entryPrice;
        size = Math.min(size, maxBtc);

        return Math.round(size * 1e6) / 1e6; // BTC precision (6 decimals)
    }

    getStopLossPrice(entryPrice, side) {
        if (side === 'BUY')  return entryPrice * (1 - this.stopLossPct);
        return entryPrice * (1 + this.stopLossPct);
    }

    /** Return Kelly stats for logging */
    getKellyStats() {
        if (this.tradeHistory.length < 10) {
            return `Kelly: insufficient data (${this.tradeHistory.length}/10 trades) | Using fixed ${(this.maxRiskPct*100).toFixed(1)}% risk`;
        }
        const f = this._kellyFraction();
        const wins = this.tradeHistory.filter(t => t.pnl > 0).length;
        const wr = (wins / this.tradeHistory.length * 100).toFixed(1);
        return `Half-Kelly: ${(f*100).toFixed(2)}% risk | Win rate: ${wr}% (${this.tradeHistory.length} trades)`;
    }
}
