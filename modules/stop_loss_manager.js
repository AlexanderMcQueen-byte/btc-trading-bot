/**
 * Advanced Stop Loss & Take Profit Manager
 *
 * WHY TRAILING STOPS BEAT FIXED STOPS:
 * A fixed stop captures a maximum loss but never locks in profit.
 * A trailing stop rises with price, locking in gains as the trade moves in your
 * favour. Professional algo traders always use trailing stops on trending assets.
 *
 * ATR-BASED TRAILING DISTANCE:
 * Rather than a fixed % (which ignores volatility), we trail by 2x ATR.
 * In calm periods: tight trail (locks profit sooner).
 * In volatile periods: wider trail (avoids premature stop-out on normal noise).
 *
 * TAKE PROFIT LEVELS (R-Multiple Targets):
 * Set at 1.5R, 2R, 3R (multiples of the initial risk).
 * At 2R: move stop to breakeven (risk-free trade).
 * At 3R: close full position (don't give it back).
 */
export class StopLossManager {
    constructor() {
        this.activeStops = new Map();
        // symbol -> {
        //   stopPrice, side, trailing, trailDistance,
        //   highestPrice (for buy trailing), lowestPrice (for sell trailing),
        //   entryPrice, initialRisk,
        //   takeProfitLevels: [{price, label, hit}],
        //   breakEvenMoved
        // }
    }

    /**
     * Set a stop loss for a position.
     * @param {string} symbol
     * @param {number} entryPrice
     * @param {number} stopPrice - Initial stop price
     * @param {'BUY'|'SELL'} side
     * @param {boolean} trailing - Enable trailing stop
     * @param {number|null} trailDistance - Distance to trail (in $). If null, calculated as (entryPrice - stopPrice)
     */
    setStop(symbol, entryPrice, stopPrice, side, trailing = true, trailDistance = null) {
        const initialRisk = Math.abs(entryPrice - stopPrice);
        const distance = trailDistance ?? initialRisk;

        const takeProfitLevels = [];
        if (side === 'BUY') {
            takeProfitLevels.push({ price: entryPrice + initialRisk * 1.5, label: '1.5R', hit: false });
            takeProfitLevels.push({ price: entryPrice + initialRisk * 2,   label: '2R',   hit: false });
            takeProfitLevels.push({ price: entryPrice + initialRisk * 3,   label: '3R',   hit: false });
        }

        this.activeStops.set(symbol, {
            stopPrice,
            side,
            trailing,
            trailDistance: distance,
            highestPrice: entryPrice,
            lowestPrice: entryPrice,
            entryPrice,
            initialRisk,
            takeProfitLevels,
            breakEvenMoved: false
        });
    }

    /**
     * Update trailing stop and check take profit levels.
     * Call every candle with the current price.
     * @returns {{ takeProfitHit, label } | null}
     */
    updateTrailing(symbol, currentPrice) {
        const stop = this.activeStops.get(symbol);
        if (!stop) return null;

        let tpHit = null;

        if (stop.side === 'BUY') {
            // Track highest price seen
            if (currentPrice > stop.highestPrice) {
                stop.highestPrice = currentPrice;

                if (stop.trailing) {
                    // Trail stop up (never down) — keep stop below highest by trailDistance
                    const newStop = stop.highestPrice - stop.trailDistance;
                    if (newStop > stop.stopPrice) {
                        stop.stopPrice = newStop;
                    }
                }
            }

            // Move to breakeven at 2R (eliminate risk on the trade)
            if (!stop.breakEvenMoved && currentPrice >= stop.entryPrice + stop.initialRisk * 2) {
                stop.stopPrice = Math.max(stop.stopPrice, stop.entryPrice);
                stop.breakEvenMoved = true;
            }

            // Check take profit levels
            for (const tp of stop.takeProfitLevels) {
                if (!tp.hit && currentPrice >= tp.price) {
                    tp.hit = true;
                    tpHit = { takeProfitHit: true, label: tp.label, price: tp.price };
                    break; // Return one at a time
                }
            }
        }

        this.activeStops.set(symbol, stop);
        return tpHit;
    }

    /** Returns true if stop has been triggered */
    shouldStop(symbol, currentPrice) {
        const stop = this.activeStops.get(symbol);
        if (!stop) return false;
        if (stop.side === 'BUY'  && currentPrice <= stop.stopPrice) return true;
        if (stop.side === 'SELL' && currentPrice >= stop.stopPrice) return true;
        return false;
    }

    getStop(symbol) {
        return this.activeStops.get(symbol) || null;
    }

    clearStop(symbol) {
        this.activeStops.delete(symbol);
    }

    /** Return summary info for logging */
    getStopInfo(symbol) {
        const s = this.activeStops.get(symbol);
        if (!s) return 'No stop set';
        const trailing = s.trailing ? ` (trailing, trail=$${s.trailDistance.toFixed(0)})` : '';
        const be = s.breakEvenMoved ? ' [BE moved]' : '';
        return `Stop: $${s.stopPrice.toFixed(0)}${trailing}${be} | Peak: $${s.highestPrice.toFixed(0)}`;
    }
}
