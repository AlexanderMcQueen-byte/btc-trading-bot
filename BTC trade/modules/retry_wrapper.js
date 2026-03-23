import ccxt from 'ccxt';

function isGeoRestrictionError(err) {
    const msg = (err.message || '').toLowerCase();
    return (
        msg.includes('451') ||
        msg.includes('restricted location') ||
        msg.includes('eligibility') ||
        msg.includes('service unavailable from a restricted')
    );
}

/**
 * Retry wrapper for exchange API calls with exponential backoff.
 *
 * DOES NOT retry:
 *   - Geo-restriction (451) errors — retrying won't change the server's location
 *   - Authentication errors — retrying with bad keys is pointless
 *   - Bad request errors — the request itself is wrong
 *
 * RETRIES:
 *   - Network errors (timeouts, connection drops)
 *   - DDoS protection / rate limit responses
 */
export async function withRetry(fn, args = [], maxRetries = 5, logger = console) {
    let attempt = 0;
    let delay = 1000;
    while (attempt < maxRetries) {
        try {
            return await fn(...args);
        } catch (err) {
            // Never retry geo-restriction (451) — no amount of retrying changes geography
            if (isGeoRestrictionError(err)) {
                throw err;
            }

            if (
                err instanceof ccxt.NetworkError ||
                err instanceof ccxt.DDoSProtection ||
                (err.message && err.message.toLowerCase().includes('rate limit'))
            ) {
                logger.error(`API error (attempt ${attempt + 1}): ${err.message}. Retrying in ${delay}ms...`);
                await new Promise(res => setTimeout(res, delay));
                delay *= 2;
                attempt++;
            } else {
                throw err;
            }
        }
    }
    throw new Error('Max retries reached for API call');
}
