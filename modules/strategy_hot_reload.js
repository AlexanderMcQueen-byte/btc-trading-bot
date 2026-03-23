// Live strategy plug-in hot-reloading and optimization
import fs from 'fs';
import path from 'path';

export class StrategyHotReloader {
    constructor(strategyDir = './modules') {
        this.strategyDir = strategyDir;
        this.currentStrategy = null;
        this.strategyName = null;
        this.lastMTime = null;
    }

    async loadStrategy(strategyName) {
        const strategyPath = path.resolve(this.strategyDir, `${strategyName}.js`);
        delete require.cache[require.resolve(strategyPath)];
        this.currentStrategy = (await import(strategyPath)).default;
        this.strategyName = strategyName;
        this.lastMTime = fs.statSync(strategyPath).mtimeMs;
        return this.currentStrategy;
    }

    async checkForUpdate() {
        if (!this.strategyName) return false;
        const strategyPath = path.resolve(this.strategyDir, `${this.strategyName}.js`);
        const mtime = fs.statSync(strategyPath).mtimeMs;
        if (mtime !== this.lastMTime) {
            await this.loadStrategy(this.strategyName);
            return true;
        }
        return false;
    }
}

// Example optimization stub
export async function optimizeStrategy(strategyClass, paramGrid, ohlcv) {
    // paramGrid: { param1: [v1, v2], param2: [v3, v4] }
    // Returns best params (stub)
    let bestParams = null;
    let bestScore = -Infinity;
    for (const params of gridSearch(paramGrid)) {
        const strat = new strategyClass(params);
        const result = strat.backtest(ohlcv); // You must implement backtest()
        if (result.score > bestScore) {
            bestScore = result.score;
            bestParams = params;
        }
    }
    return bestParams;
}

function* gridSearch(paramGrid) {
    const keys = Object.keys(paramGrid);
    function* helper(idx, acc) {
        if (idx === keys.length) {
            yield { ...acc };
            return;
        }
        for (const v of paramGrid[keys[idx]]) {
            acc[keys[idx]] = v;
            yield* helper(idx + 1, acc);
        }
    }
    yield* helper(0, {});
}
