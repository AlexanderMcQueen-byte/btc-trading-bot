// Per-trade stop-loss and trailing stop manager
export class StopLossManager {
    constructor() {
        this.activeStops = new Map(); // symbol -> { stopPrice, trailing, side }
    }

    setStop(symbol, stopPrice, side, trailing = false) {
        this.activeStops.set(symbol, { stopPrice, trailing, side });
    }

    updateTrailing(symbol, currentPrice) {
        const stop = this.activeStops.get(symbol);
        if (!stop || !stop.trailing) return;
        if (stop.side === 'BUY' && currentPrice > stop.stopPrice) {
            stop.stopPrice = currentPrice;
        } else if (stop.side === 'SELL' && currentPrice < stop.stopPrice) {
            stop.stopPrice = currentPrice;
        }
        this.activeStops.set(symbol, stop);
    }

    shouldStop(symbol, currentPrice) {
        const stop = this.activeStops.get(symbol);
        if (!stop) return false;
        if (stop.side === 'BUY' && currentPrice <= stop.stopPrice) return true;
        if (stop.side === 'SELL' && currentPrice >= stop.stopPrice) return true;
        return false;
    }

    clearStop(symbol) {
        this.activeStops.delete(symbol);
    }
}
