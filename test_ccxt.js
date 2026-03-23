import ccxt from 'ccxt';

(async () => {
    const exchange = new ccxt.binance({
        apiKey: 'yHS5fKWfX6Nhd3s9f00yWRTEe65qvygTvdBo16JreYCNePr6P5b8m1dBltsHTQ8Y',
        secret: 'XMer4WHlJJgONnBduSeG5d0GQ2ojRRaakvKqu4xusxaTLVynvbqGXJrcTcykixMd',
        enableRateLimit: true,
        urls: {
            api: {
                public: 'https://testnet.binance.vision/api',
                private: 'https://testnet.binance.vision/api',
            }
        }
    });
    try {
        const balance = await exchange.fetchBalance();
        console.log(balance);
    } catch (e) {
        console.error(e);
    }
})();
