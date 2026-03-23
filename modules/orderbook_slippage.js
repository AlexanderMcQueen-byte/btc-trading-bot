// Order book depth and slippage calculation (stub)
import ccxt from 'ccxt';

export async function getOrderBookSlippage(exchange, symbol, amount, side = 'buy') {
    const orderbook = await exchange.fetchOrderBook(symbol);
    let filled = 0, cost = 0;
    const book = side === 'buy' ? orderbook.asks : orderbook.bids;
    for (const [price, qty] of book) {
        const fill = Math.min(qty, amount - filled);
        cost += fill * price;
        filled += fill;
        if (filled >= amount) break;
    }
    const avgPrice = filled ? cost / filled : 0;
    return { avgPrice, slippage: avgPrice - book[0][0] };
}
