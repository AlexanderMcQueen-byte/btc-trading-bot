import ccxt from 'ccxt';
import 'dotenv/config';

(async () => {
  const exchange = new ccxt.binance({
    apiKey: process.env.API_KEY,
    secret: process.env.API_SECRET,
    enableRateLimit: true,
    options: { defaultType: 'spot' },
    urls: {
      ...ccxt.binance.urls,
      api: {
        public: 'https://testnet.binance.vision/api',
        private: 'https://testnet.binance.vision/api',
      }
    }
  });
  try {
    const balance = await exchange.fetchBalance();
    console.error('Testnet balance:', balance);
  } catch (err) {
    console.error('Testnet API error:', err.message, err.response ? err.response.body : '');
  }
})();
