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
 *
 * SAFETY RULES (v2):
 * - Never activates during bear trend (EMA20 < EMA50 < EMA200) — prevents
 *   "knife-catching" where grid buys into a confirmed downtrend
 * - Max open positions cap — stops buying more levels once limit is reached
 * - Emergency stop-loss — if price falls too far below grid, sell all positions
 * - Close positions before recentering — no more abandoned losing BTC
 */
export class GridTrader {
    constructor({
        numLevels = 5,           // Levels above AND below current price
        atrMultiplier = 0.5,     // Grid step = ATR * this (tighter = more fills, smaller profit per fill)
        minGridStepPct = 0.003,  // Minimum 0.3% per step (avoid fee erosion)
        maxGridStepPct = 0.02,   // Maximum 2% per step (avoid too-wide grids)
        capitalPerLevel = 0.08,  // Fraction of balance per grid level (reduced from 0.1 → 0.08)
        activationAdx = 22,      // Only activate grid when ADX below this
        deactivationAdx = 30,    // Deactivate grid if ADX rises above this (trend emerging)
        maxOpenPositions = 3,    // Max simultaneous open grid buys — prevents over-exposure in downtrends
        hardStopLevels = 4,      // Emergency sell all if price falls this many grid steps below lowest fill
        logger = console
    } = {}) {
        this.numLevels = numLevels;
        this.atrMultiplier = atrMultiplier;
        this.minGridStepPct = minGridStepPct;
        this.maxGridStepPct = maxGridStepPct;
        this.capitalPerLevel = capitalPerLevel;
        this.activationAdx = activationAdx;
        this.deactivationAdx = deactivationAdx;
        this.maxOpenPositions = maxOpenPositions;
        this.hardStopLevels = hardStopLevels;
        this.logger = logger;

        this.active = false;
        this.gridCenter = null;
        this.gridStep = null;
        this.buyLevels = [];
        this.sellLevels = [];
        this.filledBuys = [];   // Prices where we bought (awaiting sell)
        this.filledSizes = [];  // Parallel array: size bought at each filledBuys entry
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
     * @param {boolean} bearTrend - EMA20 < EMA50 < EMA200 (confirmed downtrend)
     * @param {boolean} h4BearTrend - 4H EMA bearish alignment
     * @returns {{ action, reason, buyPrice, sellPrice, size }}
     */
    evaluate(currentPrice, atr, adx, balance, bearTrend = false, h4BearTrend = false) {
        // BEAR TREND GUARD: Never grid-trade into a confirmed downtrend.
        // Even if ADX is low (ranging), if EMA20 < EMA50 < EMA200 the trend
        // is structurally bearish — grid buys would be catching falling knives.
        if (bearTrend && h4BearTrend) {
            if (this.active) {
                this.active = false;
                this.gridCenter = null;
                this.buyLevels = [];
                this.sellLevels = [];
                this.filledBuys = [];
                this.filledSizes = [];
                this.logger.warn(`[GRID] Deactivated — confirmed bear trend (EMA alignment + 4H bearish). Grid suspended until trend resolves.`);
                return { action: 'GRID_DEACTIVATED', reason: 'Bear trend active — grid suspended to prevent knife-catching' };
            }
            return { action: 'INACTIVE' };
        }

        // DEACTIVATE: Trend emerging — hand back to trend strategy
        if (this.active && adx > this.deactivationAdx) {
            this.active = false;
            this.gridCenter = null;
            this.buyLevels = [];
            this.sellLevels = [];
            this.filledBuys = [];
            this.filledSizes = [];
            this.logger.warn(`[GRID] Deactivated — trend detected (ADX ${adx.toFixed(1)} > ${this.deactivationAdx}). Handing back to trend strategy.`);
            return { action: 'GRID_DEACTIVATED', reason: `ADX ${adx.toFixed(1)} — trend emerging, grid stopped` };
        }

        // ACTIVATE: Ranging market with no bear trend — set up grid
        if (!this.active && adx < this.activationAdx) {
            this._setupGrid(currentPrice, atr);
            this.active = true;
            this.logger.info(`[GRID] Activated | Center: $${currentPrice.toFixed(0)} | Step: $${this.gridStep.toFixed(0)} (${(this.gridStep/currentPrice*100).toFixed(2)}%) | Levels: ${this.numLevels} each side | ADX: ${adx.toFixed(1)} | Max open positions: ${this.maxOpenPositions}`);
        }

        if (!this.active) {
            return { action: 'INACTIVE' };
        }

        // EMERGENCY HARD STOP: If price has fallen too far below our lowest filled buy,
        // close ALL grid positions immediately rather than letting losses compound.
        if (this.filledBuys.length > 0) {
            const lowestFilledBuy = Math.min(...this.filledBuys);
            const hardStopPrice = lowestFilledBuy - (this.hardStopLevels * this.gridStep);
            if (currentPrice <= hardStopPrice) {
                const totalSize = this.filledSizes.reduce((a, b) => a + b, 0);
                const lossPerBtc = currentPrice - lowestFilledBuy;
                this.logger.warn(`[GRID] ⚠️ HARD STOP triggered @ $${currentPrice.toFixed(0)} | ${this.filledBuys.length} open positions | Lowest buy: $${lowestFilledBuy.toFixed(0)} | Hard stop: $${hardStopPrice.toFixed(0)} | Est. loss: $${(lossPerBtc * totalSize).toFixed(2)}`);
                const closedBuys = [...this.filledBuys];
                this.filledBuys = [];
                this.filledSizes = [];
                this.active = false;
                this.gridCenter = null;
                this.buyLevels = [];
                this.sellLevels = [];
                return {
                    action: 'GRID_EMERGENCY_SELL',
                    reason: `Grid hard stop — price $${currentPrice.toFixed(0)} fell ${this.hardStopLevels} steps below lowest fill $${lowestFilledBuy.toFixed(0)}`,
                    size: totalSize,
                    closedBuys
                };
            }
        }

        // Recenter grid if price drifts more than 3 levels from center.
        // IMPORTANT: Only recenter if no open positions — otherwise we'd be
        // abandoning filled buys without closing them (silent loss).
        const drift = Math.abs(currentPrice - this.gridCenter) / this.gridStep;
        if (drift > this.numLevels * 1.5) {
            if (this.filledBuys.length > 0) {
                // Can't recenter with open positions — wait for them to fill or hard-stop to close
                this.logger.info(`[GRID] Skipping recenter — ${this.filledBuys.length} open position(s) pending. Drift: ${drift.toFixed(1)} levels.`);
            } else {
                this.logger.info(`[GRID] Recentering — price drifted ${drift.toFixed(1)} levels from center, no open positions`);
                this._setupGrid(currentPrice, atr);
            }
        }

        // CHECK BUY LEVELS: Price dropped to a buy level?
        // POSITION CAP: Don't open more grid buys than maxOpenPositions allows
        const hitBuyLevel = this.buyLevels.find(lvl =>
            currentPrice <= lvl && !this.filledBuys.includes(lvl)
        );
        if (hitBuyLevel) {
            if (this.filledBuys.length >= this.maxOpenPositions) {
                this.logger.warn(`[GRID] BUY @ $${hitBuyLevel.toFixed(0)} skipped — max open positions (${this.maxOpenPositions}) reached. Protecting capital.`);
                return { action: 'GRID_HOLD', reason: `Position cap reached (${this.filledBuys.length}/${this.maxOpenPositions} open)` };
            }
            const capitalForLevel = balance * this.capitalPerLevel;
            const size = Math.round((capitalForLevel / currentPrice) * 1e6) / 1e6;
            if (size > 0) {
                this.filledBuys.push(hitBuyLevel);
                this.filledSizes.push(size);
                const targetSell = hitBuyLevel + this.gridStep;
                this.logger.info(`[GRID] BUY triggered @ $${hitBuyLevel.toFixed(0)} | Target sell: $${targetSell.toFixed(0)} | Size: ${size} BTC | Open positions: ${this.filledBuys.length}/${this.maxOpenPositions}`);
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
        for (let i = 0; i < this.filledBuys.length; i++) {
            const filledBuy = this.filledBuys[i];
            const targetSell = filledBuy + this.gridStep;
            if (currentPrice >= targetSell) {
                const size = this.filledSizes[i] || 0;
                this.filledBuys.splice(i, 1);
                this.filledSizes.splice(i, 1);
                const profit = this.gridStep * size;
                this.totalGridProfit += profit;
                this.gridCycles++;
                this.logger.info(`[GRID] SELL triggered @ $${targetSell.toFixed(0)} | Grid cycle #${this.gridCycles} | Est. profit: $${profit.toFixed(2)} | Remaining open: ${this.filledBuys.length}`);
                return {
                    action: 'GRID_SELL',
                    reason: `Grid sell target $${targetSell.toFixed(0)} reached (bought @ $${filledBuy.toFixed(0)})`,
                    sellPrice: targetSell,
                    originalBuy: filledBuy,
                    size
                };
            }
        }

        return {
            action: 'GRID_HOLD',
            reason: `Grid active | Center: $${this.gridCenter?.toFixed(0)} | Step: $${this.gridStep?.toFixed(0)} | Open: ${this.filledBuys.length}/${this.maxOpenPositions}`
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
        this.filledSizes = [];

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
            maxOpenPositions: this.maxOpenPositions,
            totalGridProfit: this.totalGridProfit,
            gridCycles: this.gridCycles
        };
    }
}
