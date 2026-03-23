/**
 * Unit Tests — Strategy Engine & Risk Manager
 * Run with:  node --experimental-vm-modules node_modules/.bin/jest tests/
 */

import { StrategyEngine } from '../modules/strategy_engine.js';
import { RiskManager }    from '../modules/risk_manager.js';
import { CooldownManager } from '../modules/cooldown_manager.js';

// ── Helpers ───────────────────────────────────────────────────────────────────
function makeCandles(n, startPrice = 50000, trend = 0) {
    const candles = [];
    let price = startPrice;
    for (let i = 0; i < n; i++) {
        const open  = price;
        price += trend + (Math.random() - 0.5) * 200;
        const close  = price;
        const high   = Math.max(open, close) + Math.random() * 100;
        const low    = Math.min(open, close) - Math.random() * 100;
        const volume = 100 + Math.random() * 50;
        candles.push([Date.now() - (n - i) * 3600000, open, high, low, close, volume]);
    }
    return candles;
}

// ── StrategyEngine ────────────────────────────────────────────────────────────
describe('StrategyEngine', () => {
    let strategy;
    beforeEach(() => { strategy = new StrategyEngine({ minBuyScore: 3, minSellScore: 3 }); });

    test('should instantiate without errors', () => {
        expect(strategy).toBeDefined();
    });

    test('should return HOLD with insufficient candles', () => {
        const result = strategy.generateSignal([[Date.now(), 50000, 51000, 49000, 50500, 100]], 0, 0);
        expect(result.signal).toBe('HOLD');
    });

    test('should return a valid signal object with all required fields', () => {
        const candles = makeCandles(300, 50000, 10);
        const result  = strategy.generateSignal(candles, 0, 0);
        expect(result).toHaveProperty('signal');
        expect(result).toHaveProperty('score');
        expect(result).toHaveProperty('reason');
        expect(['BUY', 'BUY_DCA', 'SELL', 'HOLD']).toContain(result.signal);
        expect(typeof result.score).toBe('number');
    });

    test('score should be a non-negative integer', () => {
        const candles = makeCandles(300, 50000, 5);
        const result  = strategy.generateSignal(candles, 0, 0);
        expect(result.score).toBeGreaterThanOrEqual(0);
        expect(Number.isInteger(result.score)).toBe(true);
    });

    test('should compute ATR stop loss without throwing', () => {
        const candles = makeCandles(300, 50000, 0);
        const stop = strategy.getAtrStopLoss(candles, 50000, 'BUY', 2);
        expect(typeof stop).toBe('number');
        expect(stop).toBeLessThan(50000);
        expect(stop).toBeGreaterThan(0);
    });

    test('BUY_DCA signal should only appear when position > 0', () => {
        const candles = makeCandles(300, 50000, -5);
        const noPos   = strategy.generateSignal(candles, 0, 0);
        const withPos = strategy.generateSignal(candles, 0.1, 52000);
        if (noPos.signal === 'BUY_DCA') {
            fail('BUY_DCA should not appear without a position');
        }
        expect(['BUY', 'BUY_DCA', 'SELL', 'HOLD']).toContain(withPos.signal);
    });
});

// ── RiskManager ───────────────────────────────────────────────────────────────
describe('RiskManager', () => {
    let risk;
    beforeEach(() => {
        risk = new RiskManager({ balance: 10000, maxRiskPct: 0.01, stopLossPct: 0.02, useKelly: true });
    });

    test('should instantiate without errors', () => { expect(risk).toBeDefined(); });

    test('updateBalance should update internal balance', () => {
        risk.updateBalance(15000);
        const size = risk.getPositionSize(50000, 49000, 1000);
        expect(size).toBeGreaterThan(0);
    });

    test('getPositionSize should return a positive number', () => {
        const size = risk.getPositionSize(50000, 49000, 1000);
        expect(size).toBeGreaterThan(0);
        expect(typeof size).toBe('number');
    });

    test('position size should scale with risk%', () => {
        const r1 = new RiskManager({ balance: 10000, maxRiskPct: 0.01 });
        const r2 = new RiskManager({ balance: 10000, maxRiskPct: 0.02 });
        const s1 = r1.getPositionSize(50000, 49000, 1000);
        const s2 = r2.getPositionSize(50000, 49000, 1000);
        expect(s2).toBeGreaterThan(s1);
    });

    test('position size should be zero if balance is zero', () => {
        risk.updateBalance(0);
        const size = risk.getPositionSize(50000, 49000, 1000);
        expect(size).toBe(0);
    });

    test('Kelly criterion should activate after 10 trades', () => {
        for (let i = 0; i < 10; i++) {
            risk.recordTrade(i % 2 === 0 ? 100 : -50, 1000);
        }
        const stats = risk.getKellyStats();
        expect(stats).not.toContain('insufficient data');
    });

    test('recordTrade should not throw', () => {
        expect(() => risk.recordTrade(200, 1000)).not.toThrow();
        expect(() => risk.recordTrade(-100, 1000)).not.toThrow();
    });
});

// ── CooldownManager ───────────────────────────────────────────────────────────
describe('CooldownManager', () => {
    test('should allow BUY before any trade', () => {
        const cd = new CooldownManager({ buyCooldownMs: 1000, sellCooldownMs: 2000 });
        expect(cd.canBuy()).toBe(true);
    });

    test('should block BUY immediately after buy', () => {
        const cd = new CooldownManager({ buyCooldownMs: 60000, sellCooldownMs: 60000 });
        cd.recordBuy();
        expect(cd.canBuy()).toBe(false);
    });

    test('should block BUY immediately after sell', () => {
        const cd = new CooldownManager({ buyCooldownMs: 60000, sellCooldownMs: 60000 });
        cd.recordSell();
        expect(cd.canBuy()).toBe(false);
    });

    test('status().blocked should be false before any trade', () => {
        const cd = new CooldownManager({ buyCooldownMs: 1000, sellCooldownMs: 1000 });
        expect(cd.status().blocked).toBe(false);
    });

    test('status() should report non-zero remaining after buy', () => {
        const cd = new CooldownManager({ buyCooldownMs: 60000, sellCooldownMs: 120000 });
        cd.recordBuy();
        expect(cd.status().buyRemaining).toBeGreaterThan(0);
        expect(cd.status().sellRemaining).toBe(0);
    });

    test('status() should report non-zero remaining after sell', () => {
        const cd = new CooldownManager({ buyCooldownMs: 60000, sellCooldownMs: 120000 });
        cd.recordSell();
        expect(cd.status().sellRemaining).toBeGreaterThan(0);
    });
});
