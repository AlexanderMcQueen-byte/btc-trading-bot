/**
 * Grid Trading Engine
 *
 * WHY GRID TRADING BEATS TREND-FOLLOWING IN RANGING MARKETS:
 *
 * When BTC is consolidating (ADX < 20, no clear trend), momentum strategies
 * generate false signals and constant whipsaws. Grid trading PROFITS from
 * volatility in a range — the more BTC bounces, the more grid levels fill.
 *
 * Research (Sept 2024–Jan 2025):
 * - Grid bots turned negative BTC markets into +9.6% returns
 * - Works best when ADX < 20 and price has a defined range
 * - Dynamic grid spacing (ATR-based) adapts to actual volatility
 *
 * HOW IT WORKS:
 * 1. Detect current price and ATR (volatility)
 * 2. Place buy orders below price (every `gridStep` apart)
 * 3. Place sell orders above price (every `gridStep` apart)
 * 4. When a buy fills → immediately place a sell one grid above
 * 5. When a sell fills → immediately place a buy one grid below
 * 6. Profit = gridStep * numFills (repeating endlessly in the range)
 *
 * DYNAMIC SPACING: gridStep = ATR * multiplier
 * This means wider grids in high-volatility periods, tighter in calm markets.
 */
export class GridTrader {
    constructor({
        numLevels = 5,         // Levels above AND below current price
        atrMultiplier = 0.5,   // Grid step = ATR * this (tighter = more fills, smaller profit per fill)
        minGridStepPct = 0.003, // Minimum 0.3% per step (avoid fee erosion)
        maxGridStepPct = 0.02,  // Maximum 2% per step (avoid too-wide grids)
        capitalPerLevel = 0.1,  // Fraction of balance per grid level
        activationAdx = 22,     // Only activate grid when ADX below this
        deactivationAdx = 30,   // Deactivate grid if ADX rises above this (trend emerging)
        logger = console
    } = {}) {
        this.numLevels = numLevels;
        this.atrMultiplier = atrMultiplier;
        this.minGridStepPct = minGridStepPct;
        this.maxGridStepPct = maxGridStepPct;
        this.capitalPerLevel = capitalPerLevel;
        this.activationAdx = activationAdx;
        this.deactivationAdx = deactivationAdx;
        this.logger = logger;

        this.active = false;
        this.gridCenter = null;
        this.gridStep = null;
        this.buyLevels = [];   // Prices to buy at (below center)
        this.sellLevels = [];  // Prices to sell at (above center)
        this.filledBuys = [];  // Prices where we bought (awaiting sell)
        this.totalGridProfit = 0;
        this.gridCycles = 0;
    }

    /**
     * Called every candle. Evaluates whether grid should activate/deactivate
     * and processes any filled levels.
     *
     * @param {number} currentPrice
     * @param {number} atr - ATR value for dynamic spacing
     * @param {number} adx - ADX value for regime detection
     * @param {number} balance - Available USDT balance
     * @returns {{ action, reason, buyPrice, sellPrice, size }}
     */
    evaluate(currentPrice, atr, adx, balance) {
        // DEACTIVATE: Trend emerging — hand back to trend strategy
        if (this.active && adx > this.deactivationAdx) {
            this.active = false;
            this.gridCenter = null;
            this.buyLevels = [];
            this.sellLevels = [];
            this.filledBuys = [];
            this.logger.warn(`[GRID] Deactivated — trend detected (ADX ${adx.toFixed(1)} > ${this.deactivationAdx}). Handing back to trend strategy.`);
            return { action: 'GRID_DEACTIVATED', reason: `ADX ${adx.toFixed(1)} — trend emerging, grid stopped` };
        }

        // ACTIVATE: Ranging market — set up grid
        if (!this.active && adx < this.activationAdx) {
            this._setupGrid(currentPrice, atr);
            this.active = true;
            this.logger.info(`[GRID] Activated | Center: $${currentPrice.toFixed(0)} | Step: $${this.gridStep.toFixed(0)} (${(this.gridStep/currentPrice*100).toFixed(2)}%) | Levels: ${this.numLevels} each side | ADX: ${adx.toFixed(1)}`);
        }

        if (!this.active) {
            return { action: 'INACTIVE' };
        }

        // Recenter grid if price drifts more than 3 levels from center
        const drift = Math.abs(currentPrice - this.gridCenter) / this.gridStep;
        if (drift > this.numLevels * 1.5) {
            this.logger.info(`[GRID] Recentering — price drifted ${drift.toFixed(1)} levels from center`);
            this._setupGrid(currentPrice, atr);
        }

        // CHECK BUY LEVELS: Price dropped to a buy level?
        const hitBuyLevel = this.buyLevels.find(lvl =>
            currentPrice <= lvl && !this.filledBuys.includes(lvl)
        );
        if (hitBuyLevel) {
            const capitalForLevel = balance * this.capitalPerLevel;
            const size = Math.round((capitalForLevel / currentPrice) * 1e6) / 1e6;
            if (size > 0) {
                this.filledBuys.push(hitBuyLevel);
                const targetSell = hitBuyLevel + this.gridStep;
                this.logger.info(`[GRID] BUY triggered @ $${hitBuyLevel.toFixed(0)} | Target sell: $${targetSell.toFixed(0)} | Size: ${size} BTC`);
                return {
                    action: 'GRID_BUY',
                    reason: `Grid buy level $${hitBuyLevel.toFixed(0)} | Target exit: $${targetSell.toFixed(0)}`,
                    buyPrice: hitBuyLevel,
                    targetSell,
                    size
                };
            }
        }

        // CHECK SELL LEVELS: Price rose to sell level for a filled buy?
        for (const filledBuy of this.filledBuys) {
            const targetSell = filledBuy + this.gridStep;
            if (currentPrice >= targetSell) {
                const idx = this.filledBuys.indexOf(filledBuy);
                this.filledBuys.splice(idx, 1);
                const profit = this.gridStep; // Approximate profit per BTC before fees
                this.totalGridProfit += profit;
                this.gridCycles++;
                this.logger.info(`[GRID] SELL triggered @ $${targetSell.toFixed(0)} | Grid cycle #${this.gridCycles} | Est. profit: $${profit.toFixed(2)}/BTC`);
                return {
                    action: 'GRID_SELL',
                    reason: `Grid sell target $${targetSell.toFixed(0)} reached (bought @ $${filledBuy.toFixed(0)})`,
                    sellPrice: targetSell,
                    originalBuy: filledBuy
                };
            }
        }

        return {
            action: 'GRID_HOLD',
            reason: `Grid active | Center: $${this.gridCenter?.toFixed(0)} | Step: $${this.gridStep?.toFixed(0)} | Pending buys: [${this.buyLevels.map(l => '$' + l.toFixed(0)).join(', ')}] | Open positions: ${this.filledBuys.length}`
        };
    }

    _setupGrid(centerPrice, atr) {
        this.gridCenter = centerPrice;

        // Dynamic grid step: ATR-based, clamped to min/max
        let step = atr * this.atrMultiplier;
        step = Math.max(step, centerPrice * this.minGridStepPct);
        step = Math.min(step, centerPrice * this.maxGridStepPct);
        this.gridStep = step;

        this.buyLevels = [];
        this.sellLevels = [];
        this.filledBuys = [];

        for (let i = 1; i <= this.numLevels; i++) {
            this.buyLevels.push(Math.round((centerPrice - i * step) * 100) / 100);
            this.sellLevels.push(Math.round((centerPrice + i * step) * 100) / 100);
        }
    }

    getStats() {
        return {
            active: this.active,
            gridCenter: this.gridCenter,
            gridStep: this.gridStep,
            buyLevels: this.buyLevels,
            sellLevels: this.sellLevels,
            openPositions: this.filledBuys.length,
            totalGridProfit: this.totalGridProfit,
            gridCycles: this.gridCycles
        };
    }
}
