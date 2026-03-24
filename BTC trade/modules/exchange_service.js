import ccxt from 'ccxt';
import fs from 'fs';
import path from 'path';
import logger from './logger.js';
import { withRetry } from './retry_wrapper.js';
import { logApiUsage } from './audit_logger.js';
import { handlePartialFill } from './partial_fill_handler.js';

const HISTORICAL_DATA_PATH = path.resolve('data', 'historical_btc_1h.json');

function isGeoRestricted(err) {
    return (
        (err.message && err.message.includes('451')) ||
        (err.message && err.message.toLowerCase().includes('restricted location')) ||
        (err.message && err.message.toLowerCase().includes('eligibility'))
    );
}

export class ExchangeService {
    /**
     * @param {Object} options
     * @param {string} options.apiKey
     * @param {string} options.apiSecret
     * @param {string} [options.exchangeId='binance']
     * @param {Logger} [options.logger]
     */
    constructor({ apiKey, apiSecret, exchangeId = 'binance', logger: customLogger = null }) {
        this.logger = customLogger || logger;
        this.simulationMode = false;
        this._historicalData = null;
        this._simIndex = 250; // Start after 250 candles so EMA200 has enough data

        // If no API credentials are present, go straight to simulation mode.
        // This happens when CUSTOM_ENVIRONMENT_VARIABLES aren't configured on the host.
        if (!apiKey || !apiSecret) {
            this.logger.warn('No API credentials found — running in SIMULATION MODE.');
            this.simulationMode = true;
            if (fs.existsSync(HISTORICAL_DATA_PATH)) {
                this._historicalData = JSON.parse(fs.readFileSync(HISTORICAL_DATA_PATH, 'utf-8'));
            }
        }

        try {
            const isTestnet = process.env.TESTNET === 'true';
            const exchangeOptions = {
                apiKey:  apiKey  || '',
                secret:  apiSecret || '',
                enableRateLimit: true,
                options: { defaultType: 'spot' }
            };
            if (isTestnet && exchangeId === 'binance') {
                exchangeOptions.urls = {
                    ...ccxt.binance.urls,
                    api: {
                        public: 'https://testnet.binance.vision/api',
                        private: 'https://testnet.binance.vision/api',
                    }
                };
                this.logger.info('Using Binance Spot Testnet endpoint.');
            }
            this.exchange = new ccxt[exchangeId](exchangeOptions);
            this.logger.info(`Initialized exchange: ${exchangeId}`);
        } catch (err) {
            this.logger.error(`Failed to initialize exchange: ${err.message}`);
            throw err;
        }
    }

    _enableSimulationMode() {
        if (this.simulationMode) return;
        this.simulationMode = true;
        this.logger.warn('⚠️  Exchange geo-restricted. Switching to SIMULATION MODE using historical BTC data.');
        this.logger.warn('⚠️  No real trades will be placed. Deploy to an unrestricted server for live trading.');
        if (fs.existsSync(HISTORICAL_DATA_PATH)) {
            this._historicalData = JSON.parse(fs.readFileSync(HISTORICAL_DATA_PATH, 'utf-8'));
            this.logger.info(`Loaded ${this._historicalData.length} historical candles for simulation.`);
        } else {
            this.logger.error('Historical data file not found. Cannot run simulation.');
            process.exit(1);
        }
    }

    _getSimulatedOHLCV(limit = 100) {
        // Loop back to warmup start when all historical candles are exhausted
        if (this._simIndex >= this._historicalData.length) {
            this._simIndex = 250;
            this.logger.info('[SIM] ↺ Historical data complete — looping back to start for continuous simulation.');
        }
        const end = Math.min(this._simIndex, this._historicalData.length);
        const start = Math.max(0, end - limit);
        const slice = this._historicalData.slice(start, end);
        this._simIndex++;
        return slice;
    }

    _getSimulatedCurrentPrice() {
        const idx = Math.min(this._simIndex - 1, this._historicalData.length - 1);
        return this._historicalData[idx][4];
    }

    _simulatedOrder(side, symbol, amount, price) {
        return {
            id: `sim-${Date.now()}`,
            status: 'closed',
            side,
            symbol,
            amount,
            filled: amount,
            price,
            avgFillPrice: price,
            fee: { cost: price * amount * 0.001, currency: 'USDT' }
        };
    }

    async fetchOHLCV(symbol, timeframe = '1h', since = undefined, limit = 100) {
        if (this.simulationMode) {
            const ohlcv = this._getSimulatedOHLCV(limit);
            this.logger.info(`[SIM] OHLCV candle ${this._simIndex}/${this._historicalData.length} | Price: $${ohlcv[ohlcv.length - 1][4].toFixed(2)}`);
            return ohlcv;
        }
        try {
            const ohlcv = await withRetry(
                (...args) => this.exchange.fetchOHLCV(...args),
                [symbol, timeframe, since, limit],
                5,
                this.logger
            );
            this.logger.info(`Fetched OHLCV for ${symbol} (${timeframe}), count: ${ohlcv.length}`);
            logApiUsage({ endpoint: 'fetchOHLCV', params: { symbol, timeframe, since, limit }, status: 'success' });
            return ohlcv;
        } catch (err) {
            if (isGeoRestricted(err) || err.message.includes('Max retries')) {
                this._enableSimulationMode();
                return this._getSimulatedOHLCV(limit);
            }
            this.logger.error(`fetchOHLCV error: ${err.message}`);
            logApiUsage({ endpoint: 'fetchOHLCV', params: { symbol, timeframe, since, limit }, status: 'error' });
            return [];
        }
    }

    async fetchBalance() {
        if (this.simulationMode) {
            return { USDT: { free: 10000, used: 0, total: 10000 } };
        }
        try {
            // Use spot account endpoint — avoids the /sapi/ capital endpoint
            // which is NOT available on testnet or from geo-restricted servers.
            const balance = await this.exchange.fetchBalance({ type: 'spot' });
            this.logger.info('Fetched account balance');
            logApiUsage({ endpoint: 'fetchBalance', params: {}, status: 'success' });
            return balance;
        } catch (err) {
            // 451 = geo-restricted endpoint (e.g. /sapi/ not available on testnet).
            // Don't retry — return null immediately so caller can handle gracefully.
            if (isGeoRestricted(err) || err.message.includes('451')) {
                this.logger.warn(`fetchBalance: geo-restricted endpoint (451). Returning null — caller will use fallback balance.`);
                logApiUsage({ endpoint: 'fetchBalance', params: {}, status: 'geo-restricted' });
                return null;
            }
            this.logger.error(`fetchBalance error: ${err.message}`);
            logApiUsage({ endpoint: 'fetchBalance', params: {}, status: 'error' });
            return null;
        }
    }

    async createMarketBuyOrder(symbol, amount) {
        if (this.simulationMode) {
            const price = this._getSimulatedCurrentPrice();
            const order = this._simulatedOrder('buy', symbol, amount, price);
            this.logger.info(`[SIM] BUY ${amount} ${symbol} @ $${price.toFixed(2)}`);
            logApiUsage({ endpoint: 'createMarketBuyOrder', params: { symbol, amount }, status: 'simulated' });
            return order;
        }
        try {
            const order = await withRetry(
                (...args) => this.exchange.createMarketBuyOrder(...args),
                [symbol, amount],
                5,
                this.logger
            );
            this.logger.info(`BUY ${amount} ${symbol} @ ${order.price || 'market'}`);
            logApiUsage({ endpoint: 'createMarketBuyOrder', params: { symbol, amount }, status: 'success' });
            handlePartialFill(order, amount, this.logger);
            return order;
        } catch (err) {
            this.logger.error(`createMarketBuyOrder error: ${err.message}`);
            logApiUsage({ endpoint: 'createMarketBuyOrder', params: { symbol, amount }, status: 'error' });
            return null;
        }
    }

    async createMarketSellOrder(symbol, amount) {
        if (this.simulationMode) {
            const price = this._getSimulatedCurrentPrice();
            const order = this._simulatedOrder('sell', symbol, amount, price);
            this.logger.info(`[SIM] SELL ${amount} ${symbol} @ $${price.toFixed(2)}`);
            logApiUsage({ endpoint: 'createMarketSellOrder', params: { symbol, amount }, status: 'simulated' });
            return order;
        }
        try {
            const order = await withRetry(
                (...args) => this.exchange.createMarketSellOrder(...args),
                [symbol, amount],
                5,
                this.logger
            );
            this.logger.info(`SELL ${amount} ${symbol} @ ${order.price || 'market'}`);
            logApiUsage({ endpoint: 'createMarketSellOrder', params: { symbol, amount }, status: 'success' });
            handlePartialFill(order, amount, this.logger);
            return order;
        } catch (err) {
            this.logger.error(`createMarketSellOrder error: ${err.message}`);
            logApiUsage({ endpoint: 'createMarketSellOrder', params: { symbol, amount }, status: 'error' });
            return null;
        }
    }
}
