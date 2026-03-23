/**
 * Fear & Greed Index — alternative.me (free, no auth)
 *
 * WHY THIS MATTERS:
 * Extreme Fear = market panic = historically excellent BUY zones for BTC
 * Extreme Greed = euphoria = historically excellent SELL/reduce zones
 * Professional bots like Stoic.ai and Cryptohopper integrate sentiment
 * signals because price alone misses the psychology driving large moves.
 *
 * Scale: 0 = Extreme Fear, 100 = Extreme Greed
 * Sweet spot to buy: 0–25 (Extreme Fear)
 * Sweet spot to reduce: 75–100 (Extreme Greed)
 */

let _cached = null;
let _cacheTime = 0;
const CACHE_TTL_MS = 60 * 60 * 1000; // Refresh every hour (API updates once/day)

export async function getFearGreedIndex() {
    const now = Date.now();
    if (_cached && (now - _cacheTime) < CACHE_TTL_MS) {
        return _cached;
    }

    try {
        const res = await fetch('https://api.alternative.me/fng/?limit=2', {
            signal: AbortSignal.timeout(5000)
        });
        const data = await res.json();
        const current = data.data[0];
        const previous = data.data[1] || current;

        _cached = {
            value: parseInt(current.value),
            classification: current.value_classification,
            previousValue: parseInt(previous.value),
            trend: parseInt(current.value) > parseInt(previous.value) ? 'rising' : 'falling',
            extremeFear:  parseInt(current.value) <= 25,
            fear:         parseInt(current.value) <= 40,
            neutral:      parseInt(current.value) > 40 && parseInt(current.value) < 60,
            greed:        parseInt(current.value) >= 60,
            extremeGreed: parseInt(current.value) >= 75,
            available: true
        };
        _cacheTime = now;
        return _cached;
    } catch (_) {
        return {
            value: 50,
            classification: 'Neutral',
            previousValue: 50,
            trend: 'flat',
            extremeFear: false,
            fear: false,
            neutral: true,
            greed: false,
            extremeGreed: false,
            available: false
        };
    }
}
