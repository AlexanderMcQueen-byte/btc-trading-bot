import ccxt from 'ccxt';

/**
 * Retry wrapper for exchange API calls with exponential backoff.
 * @param {Function} fn - The async function to call (should return a Promise).
 * @param {Array} args - Arguments to pass to the function.
 * @param {number} maxRetries - Maximum number of retries.
 * @param {Object} logger - Logger instance (must have .error()).
 */
export async function withRetry(fn, args = [], maxRetries = 5, logger = console) {
    let attempt = 0;
    let delay = 1000;
    while (attempt < maxRetries) {
        try {
            return await fn(...args);
        } catch (err) {
            if (
                err instanceof ccxt.NetworkError ||
                err instanceof ccxt.DDoSProtection ||
                (err.message && err.message.toLowerCase().includes('rate limit'))
            ) {
                logger.error(`API error (attempt ${attempt + 1}): ${err.message}. Retrying in ${delay}ms...`);
                await new Promise(res => setTimeout(res, delay));
                delay *= 2; // Exponential backoff
                attempt++;
            } else {
                throw err;
            }
        }
    }
    throw new Error('Max retries reached for API call');
}
