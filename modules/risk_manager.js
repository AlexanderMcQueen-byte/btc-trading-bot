/**
 * Institutional-grade risk management for position sizing and stop-loss.
 */
export class RiskManager {
    constructor({ balance, maxRiskPct = 0.01, stopLossPct = 0.02 }) {
        this.balance = balance;
        this.maxRiskPct = maxRiskPct;
        this.stopLossPct = stopLossPct;
    }

    updateBalance(newBalance) {
        this.balance = newBalance;
    }

    getPositionSize(entryPrice, stopPrice) {
        const riskPerTrade = this.balance * this.maxRiskPct;
        const riskPerUnit = Math.abs(entryPrice - stopPrice);
        if (riskPerUnit === 0) return 0;
        const size = riskPerTrade / riskPerUnit;
        return Math.round(size * 1e6) / 1e6; // Round to 6 decimal places (BTC precision)
    }

    getStopLossPrice(entryPrice, side) {
        if (side === 'BUY') {
            return entryPrice * (1 - this.stopLossPct);
        } else {
            return entryPrice * (1 + this.stopLossPct);
        }
    }
}
