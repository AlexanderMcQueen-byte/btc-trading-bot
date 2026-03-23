import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const DB_DIR  = path.resolve('data');
const DB_PATH = path.join(DB_DIR, 'bot.db');

export class BotDatabase {
    constructor() {
        if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });
        this.db = new Database(DB_PATH);
        this.db.pragma('journal_mode = WAL');
        this._init();
    }

    _init() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS trades (
                id          INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp   TEXT    NOT NULL,
                symbol      TEXT    NOT NULL,
                side        TEXT    NOT NULL,
                price       REAL    NOT NULL,
                amount      REAL    NOT NULL,
                fee         REAL    DEFAULT 0,
                pnl         REAL    DEFAULT NULL,
                balance     REAL    DEFAULT NULL,
                signal_score INTEGER DEFAULT NULL,
                notes       TEXT    DEFAULT NULL
            );
            CREATE TABLE IF NOT EXISTS state (
                key   TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS equity_snapshots (
                id        INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TEXT  NOT NULL,
                balance   REAL  NOT NULL,
                position  REAL  DEFAULT 0,
                btc_price REAL  DEFAULT 0,
                portfolio REAL  NOT NULL
            );
        `);

        // Migrate older schemas that lack new columns (safe to run repeatedly)
        const cols = this.db.prepare("PRAGMA table_info(trades)").all().map(c => c.name);
        if (!cols.includes('fee'))          this.db.exec("ALTER TABLE trades ADD COLUMN fee REAL DEFAULT 0");
        if (!cols.includes('pnl'))          this.db.exec("ALTER TABLE trades ADD COLUMN pnl REAL DEFAULT NULL");
        if (!cols.includes('balance'))      this.db.exec("ALTER TABLE trades ADD COLUMN balance REAL DEFAULT NULL");
        if (!cols.includes('signal_score')) this.db.exec("ALTER TABLE trades ADD COLUMN signal_score INTEGER DEFAULT NULL");
        if (!cols.includes('notes'))        this.db.exec("ALTER TABLE trades ADD COLUMN notes TEXT DEFAULT NULL");
    }

    // ── TRADE LOGGING ─────────────────────────────────────────────────────────

    logTrade({ timestamp, symbol, side, price, amount, fee = 0, pnl = null, balance = null, signalScore = null, notes = null }) {
        this.db.prepare(`
            INSERT INTO trades (timestamp, symbol, side, price, amount, fee, pnl, balance, signal_score, notes)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(timestamp, symbol, side, price, amount, fee, pnl, balance, signalScore, notes);
    }

    // ── EQUITY SNAPSHOTS ──────────────────────────────────────────────────────

    recordEquitySnapshot({ balance, position = 0, btcPrice = 0 }) {
        const portfolio = balance + position * btcPrice;
        this.db.prepare(`
            INSERT INTO equity_snapshots (timestamp, balance, position, btc_price, portfolio)
            VALUES (?, ?, ?, ?, ?)
        `).run(new Date().toISOString(), balance, position, btcPrice, portfolio);
    }

    getEquityCurve(limit = 500) {
        return this.db.prepare(`
            SELECT timestamp, portfolio FROM equity_snapshots
            ORDER BY id DESC LIMIT ?
        `).all(limit).reverse();
    }

    // ── QUERY TRADES ──────────────────────────────────────────────────────────

    getRecentTrades(limit = 50) {
        return this.db.prepare(`
            SELECT * FROM trades ORDER BY id DESC LIMIT ?
        `).all(limit).reverse();
    }

    getAllTrades() {
        return this.db.prepare('SELECT * FROM trades ORDER BY id ASC').all();
    }

    getStats() {
        const trades = this.getAllTrades();
        const closed = trades.filter(t => t.pnl !== null);
        const wins   = closed.filter(t => t.pnl > 0);
        const losses = closed.filter(t => t.pnl <= 0);
        const totalPnL       = closed.reduce((s, t) => s + t.pnl, 0);
        const totalFees      = trades.reduce((s, t) => s + (t.fee || 0), 0);
        const totalWinPnL    = wins.reduce((s, t) => s + t.pnl, 0);
        const totalLossPnL   = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
        const profitFactor   = totalLossPnL > 0 ? totalWinPnL / totalLossPnL : null;
        const avgWin         = wins.length   ? totalWinPnL  / wins.length   : 0;
        const avgLoss        = losses.length ? totalLossPnL / losses.length : 0;
        const expectancy     = closed.length ? totalPnL / closed.length : 0;
        return {
            totalTrades: trades.length,
            closedTrades: closed.length,
            wins: wins.length,
            losses: losses.length,
            winRate: closed.length ? (wins.length / closed.length * 100).toFixed(1) : '0.0',
            totalPnL: totalPnL.toFixed(2),
            totalFees: totalFees.toFixed(2),
            profitFactor: profitFactor ? profitFactor.toFixed(3) : 'N/A',
            avgWin: avgWin.toFixed(2),
            avgLoss: avgLoss.toFixed(2),
            expectancy: expectancy.toFixed(2)
        };
    }

    // ── EXPORT ────────────────────────────────────────────────────────────────

    exportToCSV() {
        const trades = this.getAllTrades();
        if (!trades.length) return 'No trades recorded.';
        const headers = Object.keys(trades[0]).join(',');
        const rows = trades.map(t => Object.values(t).map(v => (v === null ? '' : String(v).replace(/,/g, ';'))).join(','));
        return [headers, ...rows].join('\n');
    }

    exportToJSON() {
        return JSON.stringify(this.getAllTrades(), null, 2);
    }

    // ── STATE ─────────────────────────────────────────────────────────────────

    saveState(key, value) {
        this.db.prepare(`
            INSERT INTO state (key, value) VALUES (?, ?)
            ON CONFLICT(key) DO UPDATE SET value=excluded.value
        `).run(key, JSON.stringify(value));
    }

    loadState(key) {
        const row = this.db.prepare('SELECT value FROM state WHERE key = ?').get(key);
        return row ? JSON.parse(row.value) : null;
    }

    close() { this.db.close(); }
}
