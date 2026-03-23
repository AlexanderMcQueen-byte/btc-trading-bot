// Handles partial fills and slippage for order execution
export function handlePartialFill(order, desiredAmount, logger) {
    if (!order) return { filled: 0, slippage: 0 };
    const filled = order.filled || 0;
    const price = order.price || 0;
    const slippage = price && order.avgFillPrice ? Math.abs(order.avgFillPrice - price) / price : 0;
    if (filled < desiredAmount) {
        logger.warn && logger.warn(`Partial fill: wanted ${desiredAmount}, got ${filled}`);
    }
    if (slippage > 0.001) {
        logger.warn && logger.warn(`High slippage detected: ${slippage * 100}%`);
    }
    return { filled, slippage };
}
