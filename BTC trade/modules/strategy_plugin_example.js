// Example of a modular strategy plugin interface
export default class ExampleStrategy {
    constructor(params = {}) {
        this.params = params;
    }

    generateSignal(ohlcv, currentPosition, averageEntry) {
        // Implement your strategy logic here
        // Return { signal: 'BUY' | 'SELL' | 'HOLD', reason: string }
        return { signal: 'HOLD', reason: 'No signal' };
    }
}
