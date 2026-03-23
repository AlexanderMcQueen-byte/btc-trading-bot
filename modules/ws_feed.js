import WebSocket from 'ws';

/**
 * Subscribe to Binance WebSocket trade feed for a symbol.
 * Respects TESTNET env var — connects to testnet stream when enabled.
 * @param {string} symbol - e.g. 'btcusdt'
 * @param {function} onMessage - Callback for each message.
 * @returns {WebSocket}
 */
export function subscribeTicker(symbol, onMessage) {
    const isTestnet = process.env.TESTNET === 'true';
    const host = isTestnet
        ? 'wss://testnet.binance.vision/ws'
        : 'wss://stream.binance.com:9443/ws';
    const ws = new WebSocket(`${host}/${symbol.toLowerCase()}@trade`);
    ws.on('message', data => onMessage(JSON.parse(data)));
    ws.on('error', err => console.error('WebSocket error:', err));
    return ws;
}
