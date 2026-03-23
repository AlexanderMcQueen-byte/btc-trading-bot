// Portfolio-level risk controls and trailing stop-loss
export class PortfolioRiskManager {
    constructor({ maxPositions = 5, maxExposurePct = 0.5 }) {
        this.maxPositions = maxPositions;
        this.maxExposurePct = maxExposurePct;
        this.positions = {};
    }

    canOpenNewPosition(currentOpen) {
        return Object.keys(this.positions).length < this.maxPositions && currentOpen < this.maxExposurePct;
    }

    updatePosition(symbol, size) {
        if (size > 0) this.positions[symbol] = size;
        else delete this.positions[symbol];
    }
}

export class TrailingStop {
    constructor(trailPct = 0.01) {
        this.trailPct = trailPct;
        this.peak = null;
        this.stop = null;
    }
    update(price) {
        if (this.peak === null || price > this.peak) {
            this.peak = price;
            this.stop = price * (1 - this.trailPct);
        } else if (price < this.stop) {
            return true; // Stop triggered
        }
        return false;
    }
}
