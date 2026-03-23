/**
 * Advanced Crypto Strategy Engine
 *
 * MARKET KNOWLEDGE BUILT IN:
 *
 * 1. TREND DETECTION
 *    - EMA 20/50/200 alignment reveals short, medium and long-term trend direction
 *    - BTC tends to trend strongly — riding the trend is more reliable than fighting it
 *    - ADX (Average Directional Index) measures trend STRENGTH (>25 = trending, <20 = ranging)
 *
 * 2. MARKET REGIME DETECTION
 *    - Trending markets: momentum and trend-following strategies work best
 *    - Ranging (sideways) markets: mean reversion and oversold/overbought strategies work best
 *    - Using the wrong strategy for the wrong regime is a major cause of losses
 *
 * 3. MOMENTUM INDICATORS
 *    - MACD: reveals whether momentum is accelerating bullish or bearish (crossover system)
 *    - RSI: 0–100 scale — below 30 = oversold, above 70 = overbought
 *    - StochasticRSI: a faster, more sensitive version of RSI, great for spotting momentum shifts
 *    - ROC (Rate of Change): raw price momentum — how fast price is moving
 *
 * 4. VOLATILITY ANALYSIS
 *    - Bollinger Bands: price outside the bands = overextended, likely to revert
 *    - ATR (Average True Range): measures how much BTC moves per candle — used for dynamic
 *      stop-loss placement. Never use a fixed dollar stop; crypto volatility varies wildly.
 *    - Bollinger Band Squeeze: low volatility → big move coming (breakout detector)
 *
 * 5. VOLUME ANALYSIS
 *    - OBV (On-Balance Volume): money flowing in or out. Rising price + falling OBV = weak move
 *    - MFI (Money Flow Index): RSI but weighted by volume — confirms whether bulls or bears
 *      control the market
 *    - Volume confirmation: a breakout without volume behind it is likely a fake-out
 *
 * 6. SIGNAL CONFLUENCE
 *    - No single indicator is reliable alone. We score each condition (+1/-1) and only trade
 *      when multiple signals agree. Requires a minimum score threshold before entry.
 *    - This prevents trading on conflicting or noisy signals — one of the top causes of losses
 *
 * 7. CANDLESTICK PATTERN RECOGNITION
 *    - Bullish patterns (Morning Star, Bullish Engulfing, Three White Soldiers, Hammer) add
 *      confirmation weight to BUY signals
 *    - Bearish patterns (Bearish Engulfing, Evening Star, Three Black Crows, Shooting Star)
 *      add confirmation weight to SELL signals
 *
 * 8. DCA (Dollar Cost Averaging)
 *    - When in a position and price drops significantly, averaging down reduces the cost basis
 *    - Only DCA when the overall trend is still bullish — never average into a confirmed downtrend
 *
 * 9. CRYPTO-SPECIFIC RULES
 *    - BTC is the most liquid crypto — institutional money moves it, creating strong trends
 *    - Avoid trading in extreme fear/panic (very high ATR) without trend confirmation
 *    - Crypto markets are 24/7 — hourly candles are more reliable than shorter timeframes
 *    - High volume on a breakout is essential; crypto fakes breakouts frequently on low volume
 */

import {
    MACD, RSI, EMA, ADX, ATR, BollingerBands, StochasticRSI, OBV, MFI, ROC,
    bullishengulfingpattern, bearishengulfingpattern,
    morningstar, eveningstar,
    threewhitesoldiers, threeblackcrows,
    hammerpattern, shootingstar
} from 'technicalindicators';

export class StrategyEngine {
    constructor({
        macdFast = 12,
        macdSlow = 26,
        macdSignal = 9,
        rsiPeriod = 14,
        rsiOverbought = 70,
        rsiOversold = 30,
        emaFast = 20,
        emaMid = 50,
        emaSlow = 200,
        adxPeriod = 14,
        adxTrendThreshold = 25,
        atrPeriod = 14,
        bbPeriod = 20,
        bbStdDev = 2,
        stochRsiPeriod = 14,
        mfiPeriod = 14,
        rocPeriod = 9,
        dcaDropPct = 0.05,
        minBuyScore = 3,
        minSellScore = 3
    } = {}) {
        this.macdFast = macdFast;
        this.macdSlow = macdSlow;
        this.macdSignal = macdSignal;
        this.rsiPeriod = rsiPeriod;
        this.rsiOverbought = rsiOverbought;
        this.rsiOversold = rsiOversold;
        this.emaFast = emaFast;
        this.emaMid = emaMid;
        this.emaSlow = emaSlow;
        this.adxPeriod = adxPeriod;
        this.adxTrendThreshold = adxTrendThreshold;
        this.atrPeriod = atrPeriod;
        this.bbPeriod = bbPeriod;
        this.bbStdDev = bbStdDev;
        this.stochRsiPeriod = stochRsiPeriod;
        this.mfiPeriod = mfiPeriod;
        this.rocPeriod = rocPeriod;
        this.dcaDropPct = dcaDropPct;
        this.minBuyScore = minBuyScore;
        this.minSellScore = minSellScore;
    }

    generateSignal(ohlcv, currentPosition, averageEntry) {
        // Need at least 200 candles for EMA200 to be meaningful
        if (!ohlcv || ohlcv.length < this.emaSlow) {
            return {
                signal: 'HOLD',
                reason: `Warming up — need ${this.emaSlow} candles, have ${ohlcv ? ohlcv.length : 0}`,
                score: 0,
                indicators: {}
            };
        }

        const closes = ohlcv.map(c => (typeof c.close !== 'undefined' ? c.close : c[4]));
        const highs  = ohlcv.map(c => (typeof c.high  !== 'undefined' ? c.high  : c[2]));
        const lows   = ohlcv.map(c => (typeof c.low   !== 'undefined' ? c.low   : c[3]));
        const volumes= ohlcv.map(c => (typeof c.volume!== 'undefined' ? c.volume: c[5]));
        const currentPrice = closes[closes.length - 1];

        // ── 1. TREND: EMA alignment ──────────────────────────────────────
        const ema20Arr  = EMA.calculate({ values: closes, period: this.emaFast });
        const ema50Arr  = EMA.calculate({ values: closes, period: this.emaMid });
        const ema200Arr = EMA.calculate({ values: closes, period: this.emaSlow });
        const ema20  = ema20Arr[ema20Arr.length - 1];
        const ema50  = ema50Arr[ema50Arr.length - 1];
        const ema200 = ema200Arr[ema200Arr.length - 1];

        const bullTrend = ema20 > ema50 && ema50 > ema200;   // Full bullish alignment
        const bearTrend = ema20 < ema50 && ema50 < ema200;   // Full bearish alignment
        const aboveEma20 = currentPrice > ema20;
        const belowEma20 = currentPrice < ema20;

        // ── 2. MARKET REGIME: ADX ────────────────────────────────────────
        const adxResult = ADX.calculate({ high: highs, low: lows, close: closes, period: this.adxPeriod });
        const adx = adxResult.length ? adxResult[adxResult.length - 1].adx : 0;
        const isTrending = adx > this.adxTrendThreshold;
        const isRanging  = adx < 20;

        // ── 3. MOMENTUM: MACD ────────────────────────────────────────────
        const macdResult = MACD.calculate({
            values: closes,
            fastPeriod: this.macdFast,
            slowPeriod: this.macdSlow,
            signalPeriod: this.macdSignal,
            SimpleMAOscillator: false,
            SimpleMASignal: false
        });
        const macd = macdResult.length ? macdResult[macdResult.length - 1] : null;
        const prevMacd = macdResult.length > 1 ? macdResult[macdResult.length - 2] : null;
        const macdBullishCross = macd && prevMacd &&
            macd.MACD > macd.signal && prevMacd.MACD <= prevMacd.signal;
        const macdBearishCross = macd && prevMacd &&
            macd.MACD < macd.signal && prevMacd.MACD >= prevMacd.signal;
        const macdBullish = macd && macd.MACD > macd.signal;
        const macdBearish = macd && macd.MACD < macd.signal;

        // ── 4. MOMENTUM: RSI ─────────────────────────────────────────────
        const rsiArr = RSI.calculate({ values: closes, period: this.rsiPeriod });
        const rsi = rsiArr.length ? rsiArr[rsiArr.length - 1] : 50;
        const prevRsi = rsiArr.length > 1 ? rsiArr[rsiArr.length - 2] : 50;
        const rsiOversold  = rsi < this.rsiOversold;
        const rsiOverbought = rsi > this.rsiOverbought;
        const rsiRisingFromOversold = prevRsi < this.rsiOversold && rsi >= this.rsiOversold;
        const rsiFallingFromOverbought = prevRsi > this.rsiOverbought && rsi <= this.rsiOverbought;

        // ── 5. MOMENTUM: StochasticRSI ───────────────────────────────────
        const stochRsiArr = StochasticRSI.calculate({
            values: closes,
            rsiPeriod: this.stochRsiPeriod,
            stochasticPeriod: 14,
            kPeriod: 3,
            dPeriod: 3
        });
        const stochRsi = stochRsiArr.length ? stochRsiArr[stochRsiArr.length - 1] : { k: 50, d: 50 };
        const stochOversold  = stochRsi.k < 20;
        const stochOverbought = stochRsi.k > 80;

        // ── 6. VOLATILITY: Bollinger Bands ───────────────────────────────
        const bbArr = BollingerBands.calculate({
            values: closes,
            period: this.bbPeriod,
            stdDev: this.bbStdDev
        });
        const bb = bbArr.length ? bbArr[bbArr.length - 1] : null;
        const bbWidth = bb ? (bb.upper - bb.lower) / bb.middle : 0;
        const priceNearLowerBand = bb && currentPrice <= bb.lower * 1.01;
        const priceNearUpperBand = bb && currentPrice >= bb.upper * 0.99;
        const bbSqueeze = bbWidth < 0.04; // Low volatility — breakout incoming

        // ── 7. VOLATILITY: ATR (for stop-loss sizing) ────────────────────
        const atrArr = ATR.calculate({ high: highs, low: lows, close: closes, period: this.atrPeriod });
        const atr = atrArr.length ? atrArr[atrArr.length - 1] : 0;
        const highVolatility = atr / currentPrice > 0.03; // ATR > 3% of price = extreme volatility

        // ── 8. VOLUME: OBV ───────────────────────────────────────────────
        const obvArr = OBV.calculate({ close: closes, volume: volumes });
        const obvLen = obvArr.length;
        const obv = obvLen ? obvArr[obvLen - 1] : 0;
        const obvPrev5Avg = obvLen > 5
            ? obvArr.slice(obvLen - 6, obvLen - 1).reduce((a, b) => a + b, 0) / 5
            : obv;
        const obvRising = obv > obvPrev5Avg;
        const obvFalling = obv < obvPrev5Avg;

        // ── 9. VOLUME: MFI ───────────────────────────────────────────────
        const mfiArr = MFI.calculate({ high: highs, low: lows, close: closes, volume: volumes, period: this.mfiPeriod });
        const mfi = mfiArr.length ? mfiArr[mfiArr.length - 1] : 50;
        const mfiBullish = mfi > 50;
        const mfiBearish = mfi < 50;
        const mfiOversold  = mfi < 20;
        const mfiOverbought = mfi > 80;

        // ── 10. MOMENTUM: ROC ────────────────────────────────────────────
        const rocArr = ROC.calculate({ values: closes, period: this.rocPeriod });
        const roc = rocArr.length ? rocArr[rocArr.length - 1] : 0;

        // ── 11. CANDLESTICK PATTERNS ─────────────────────────────────────
        const candleInput = ohlcv.slice(-10).map(c => ({
            open:  typeof c.open  !== 'undefined' ? c.open  : c[1],
            high:  typeof c.high  !== 'undefined' ? c.high  : c[2],
            low:   typeof c.low   !== 'undefined' ? c.low   : c[3],
            close: typeof c.close !== 'undefined' ? c.close : c[4]
        }));

        let bullishPattern = false;
        let bearishPattern = false;
        let patternName = '';

        try {
            if (bullishengulfingpattern(candleInput)) { bullishPattern = true; patternName = 'Bullish Engulfing'; }
            else if (morningstar(candleInput))          { bullishPattern = true; patternName = 'Morning Star'; }
            else if (threewhitesoldiers(candleInput))   { bullishPattern = true; patternName = 'Three White Soldiers'; }
            else if (hammerpattern(candleInput))         { bullishPattern = true; patternName = 'Hammer'; }

            if (bearishengulfingpattern(candleInput)) { bearishPattern = true; patternName = 'Bearish Engulfing'; }
            else if (eveningstar(candleInput))          { bearishPattern = true; patternName = 'Evening Star'; }
            else if (threeblackcrows(candleInput))      { bearishPattern = true; patternName = 'Three Black Crows'; }
            else if (shootingstar(candleInput))          { bearishPattern = true; patternName = 'Shooting Star'; }
        } catch (_) { /* pattern detection is optional */ }

        // ── 12. SUPPORT & RESISTANCE (recent swing highs/lows) ───────────
        const lookback = 20;
        const recentHighs = highs.slice(-lookback);
        const recentLows  = lows.slice(-lookback);
        const resistance = Math.max(...recentHighs);
        const support    = Math.min(...recentLows);
        const nearResistance = currentPrice > resistance * 0.98;
        const nearSupport    = currentPrice < support * 1.02;

        // ── 13. DCA CHECK ────────────────────────────────────────────────
        if (currentPosition > 0 && averageEntry > 0) {
            const priceDrop = (averageEntry - currentPrice) / averageEntry;
            // Only DCA if overall trend is still bullish (EMA alignment + ADX)
            if (priceDrop >= this.dcaDropPct && bullTrend && !highVolatility) {
                return {
                    signal: 'BUY_DCA',
                    reason: `DCA: Price down ${(priceDrop * 100).toFixed(1)}% from avg entry $${averageEntry.toFixed(0)} | Trend still bullish | ATR: $${atr.toFixed(0)}`,
                    score: 0,
                    indicators: { rsi, adx, atr, ema20, ema50, ema200, mfi }
                };
            }
        }

        // ════════════════════════════════════════════════════════════════
        // SIGNAL SCORING — Each condition adds or subtracts a point.
        // We only BUY when buyScore >= minBuyScore,
        // and only SELL when sellScore >= minSellScore.
        // This prevents acting on weak, isolated signals.
        // ════════════════════════════════════════════════════════════════

        const buyReasons  = [];
        const sellReasons = [];
        let buyScore  = 0;
        let sellScore = 0;

        // ── TREND CONDITIONS ─────────────────────────────────────────────
        if (bullTrend) {
            buyScore++;
            buyReasons.push('EMA20>50>200 (bull trend)');
        }
        if (bearTrend) {
            sellScore++;
            sellReasons.push('EMA20<50<200 (bear trend)');
        }
        if (aboveEma20) {
            buyScore++;
            buyReasons.push('Price above EMA20');
        }
        if (belowEma20) {
            sellScore++;
            sellReasons.push('Price below EMA20');
        }

        // ── MACD CONDITIONS ──────────────────────────────────────────────
        if (macdBullishCross) {
            buyScore += 2; // Cross is stronger signal than just being bullish
            buyReasons.push('MACD bullish crossover');
        } else if (macdBullish) {
            buyScore++;
            buyReasons.push('MACD bullish');
        }
        if (macdBearishCross) {
            sellScore += 2;
            sellReasons.push('MACD bearish crossover');
        } else if (macdBearish) {
            sellScore++;
            sellReasons.push('MACD bearish');
        }

        // ── RSI CONDITIONS ───────────────────────────────────────────────
        if (rsiOversold || rsiRisingFromOversold) {
            buyScore += 2;
            buyReasons.push(`RSI oversold (${rsi.toFixed(1)})`);
        } else if (rsi < 55) {
            buyScore++;
            buyReasons.push(`RSI neutral-bullish (${rsi.toFixed(1)})`);
        }
        if (rsiOverbought || rsiFallingFromOverbought) {
            sellScore += 2;
            sellReasons.push(`RSI overbought (${rsi.toFixed(1)})`);
        } else if (rsi > 60) {
            sellScore++;
            sellReasons.push(`RSI elevated (${rsi.toFixed(1)})`);
        }

        // ── STOCHASTIC RSI ───────────────────────────────────────────────
        if (stochOversold) {
            buyScore++;
            buyReasons.push(`StochRSI oversold (${stochRsi.k.toFixed(1)})`);
        }
        if (stochOverbought) {
            sellScore++;
            sellReasons.push(`StochRSI overbought (${stochRsi.k.toFixed(1)})`);
        }

        // ── BOLLINGER BAND CONDITIONS ────────────────────────────────────
        if (priceNearLowerBand) {
            buyScore++;
            buyReasons.push('Price at lower Bollinger Band (oversold zone)');
        }
        if (priceNearUpperBand) {
            sellScore++;
            sellReasons.push('Price at upper Bollinger Band (overbought zone)');
        }
        if (nearResistance) {
            sellScore++;
            sellReasons.push(`Near resistance ($${resistance.toFixed(0)})`);
        }
        if (nearSupport) {
            buyScore++;
            buyReasons.push(`Near support ($${support.toFixed(0)})`);
        }

        // ── VOLUME CONDITIONS ────────────────────────────────────────────
        if (obvRising && mfiBullish) {
            buyScore++;
            buyReasons.push(`Volume bullish (OBV rising, MFI ${mfi.toFixed(0)})`);
        }
        if (mfiOversold) {
            buyScore++;
            buyReasons.push(`MFI oversold (${mfi.toFixed(0)}) — smart money buying`);
        }
        if (obvFalling && mfiBearish) {
            sellScore++;
            sellReasons.push(`Volume bearish (OBV falling, MFI ${mfi.toFixed(0)})`);
        }
        if (mfiOverbought) {
            sellScore++;
            sellReasons.push(`MFI overbought (${mfi.toFixed(0)}) — distribution`);
        }

        // ── CANDLESTICK PATTERN ──────────────────────────────────────────
        if (bullishPattern) {
            buyScore++;
            buyReasons.push(`Pattern: ${patternName}`);
        }
        if (bearishPattern) {
            sellScore++;
            sellReasons.push(`Pattern: ${patternName}`);
        }

        // ── PENALTY: Extreme volatility — reduce confidence ──────────────
        if (highVolatility) {
            buyScore  = Math.max(0, buyScore  - 1);
            sellScore = Math.max(0, sellScore - 1);
            buyReasons.push(`⚠️ High volatility (ATR ${(atr/currentPrice*100).toFixed(1)}%)`);
        }

        // ── PENALTY: Don't buy near resistance in trending market ─────────
        if (isTrending && nearResistance && !bullishPattern) {
            buyScore = Math.max(0, buyScore - 1);
        }

        // ── MARKET REGIME ADJUSTMENTS ─────────────────────────────────────
        if (isRanging) {
            // In ranging markets, oversold/overbought signals are more reliable
            if (rsiOversold) buyScore++;
            if (rsiOverbought) sellScore++;
        }
        if (isTrending && bullTrend && macdBullish) {
            // In a strong uptrend, add a bonus for trend confirmation
            buyScore++;
            buyReasons.push(`Strong uptrend confirmed (ADX ${adx.toFixed(0)})`);
        }
        if (isTrending && bearTrend && macdBearish) {
            sellScore++;
            sellReasons.push(`Strong downtrend confirmed (ADX ${adx.toFixed(0)})`);
        }

        // ── DECISION ──────────────────────────────────────────────────────
        const indicators = {
            price: currentPrice,
            ema20: +ema20.toFixed(2),
            ema50: +ema50.toFixed(2),
            ema200: +ema200.toFixed(2),
            rsi: +rsi.toFixed(1),
            macd: macd ? +macd.MACD.toFixed(2) : 0,
            adx: +adx.toFixed(1),
            atr: +atr.toFixed(2),
            mfi: +mfi.toFixed(1),
            stochK: +stochRsi.k.toFixed(1),
            bbWidth: +(bbWidth * 100).toFixed(2),
            obv: obvRising ? 'rising' : 'falling',
            regime: isTrending ? `TRENDING (ADX ${adx.toFixed(0)})` : isRanging ? `RANGING (ADX ${adx.toFixed(0)})` : `NEUTRAL (ADX ${adx.toFixed(0)})`,
            roc: +roc.toFixed(2)
        };

        if (buyScore >= this.minBuyScore && buyScore > sellScore) {
            return {
                signal: 'BUY',
                reason: `[Score ${buyScore}] ${buyReasons.join(' | ')}`,
                score: buyScore,
                indicators
            };
        }

        if (sellScore >= this.minSellScore && sellScore > buyScore) {
            return {
                signal: 'SELL',
                reason: `[Score ${sellScore}] ${sellReasons.join(' | ')}`,
                score: sellScore,
                indicators
            };
        }

        return {
            signal: 'HOLD',
            reason: `No confluence — Buy score: ${buyScore}, Sell score: ${sellScore} | ${buyReasons.concat(sellReasons).join(' | ') || 'No signals triggered'}`,
            score: 0,
            indicators
        };
    }

    /**
     * Calculate ATR-based dynamic stop loss price.
     * Places stop 2x ATR away from entry — adapts to current volatility.
     */
    getAtrStopLoss(ohlcv, entryPrice, side, multiplier = 2) {
        const highs  = ohlcv.map(c => (typeof c.high  !== 'undefined' ? c.high  : c[2]));
        const lows   = ohlcv.map(c => (typeof c.low   !== 'undefined' ? c.low   : c[3]));
        const closes = ohlcv.map(c => (typeof c.close !== 'undefined' ? c.close : c[4]));
        const atrArr = ATR.calculate({ high: highs, low: lows, close: closes, period: this.atrPeriod });
        const atr = atrArr.length ? atrArr[atrArr.length - 1] : entryPrice * 0.02;
        if (side === 'BUY') return entryPrice - multiplier * atr;
        return entryPrice + multiplier * atr;
    }
}
