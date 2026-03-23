/**
 * CooldownManager — enforces a minimum time gap between trades.
 *
 * Prevents "whipsaw" behaviour where the bot immediately re-enters after
 * a stop-out or sell, before the market has had time to settle.
 *
 * Config (env vars):
 *   BUY_COOLDOWN_MS  — ms to wait after any buy before buying again (default: 5 min)
 *   SELL_COOLDOWN_MS — ms to wait after a sell/stop before re-entering (default: 15 min)
 */

export class CooldownManager {
    constructor({
        buyCooldownMs  = parseInt(process.env.BUY_COOLDOWN_MS)  || 5  * 60 * 1000,
        sellCooldownMs = parseInt(process.env.SELL_COOLDOWN_MS) || 15 * 60 * 1000,
        logger = console
    } = {}) {
        this.buyCooldownMs  = buyCooldownMs;
        this.sellCooldownMs = sellCooldownMs;
        this.logger = logger;

        this._lastBuyTime  = 0;
        this._lastSellTime = 0;
    }

    /**
     * Returns true if a BUY is allowed right now.
     */
    canBuy() {
        const now = Date.now();
        const buySince  = now - this._lastBuyTime;
        const sellSince = now - this._lastSellTime;

        if (buySince < this.buyCooldownMs) {
            const remaining = Math.ceil((this.buyCooldownMs - buySince) / 1000);
            this.logger.warn(`[Cooldown] BUY blocked — ${remaining}s remaining after last buy.`);
            return false;
        }
        if (sellSince < this.sellCooldownMs) {
            const remaining = Math.ceil((this.sellCooldownMs - sellSince) / 1000);
            this.logger.warn(`[Cooldown] BUY blocked — ${remaining}s remaining after last sell/stop.`);
            return false;
        }
        return true;
    }

    /**
     * Call immediately after a BUY order is filled.
     */
    recordBuy() {
        this._lastBuyTime = Date.now();
    }

    /**
     * Call immediately after a SELL or stop-out.
     */
    recordSell() {
        this._lastSellTime = Date.now();
    }

    /**
     * Remaining cooldown in seconds (for logging/dashboard).
     */
    status() {
        const now = Date.now();
        const buyRemaining  = Math.max(0, Math.ceil((this.buyCooldownMs  - (now - this._lastBuyTime))  / 1000));
        const sellRemaining = Math.max(0, Math.ceil((this.sellCooldownMs - (now - this._lastSellTime)) / 1000));
        return { buyRemaining, sellRemaining, blocked: buyRemaining > 0 || sellRemaining > 0 };
    }
}
