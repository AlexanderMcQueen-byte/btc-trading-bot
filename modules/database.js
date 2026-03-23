import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';

const DB_DIR = path.resolve('data');
const DB_PATH = path.join(DB_DIR, 'bot.db');

export class BotDatabase {
    constructor() {
        if (!fs.existsSync(DB_DIR)) {
            fs.mkdirSync(DB_DIR, { recursive: true });
        }
        this.db = new Database(DB_PATH);
        this._init();
    }

    _init() {
        this.db.exec(`
            CREATE TABLE IF NOT EXISTS trades (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                timestamp TEXT NOT NULL,
                symbol TEXT NOT NULL,
                side TEXT NOT NULL,
                price REAL NOT NULL,
                amount REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS state (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
        `);
    }

    logTrade({ timestamp, symbol, side, price, amount }) {
        const stmt = this.db.prepare(
            'INSERT INTO trades (timestamp, symbol, side, price, amount) VALUES (?, ?, ?, ?, ?)'
        );
        stmt.run(timestamp, symbol, side, price, amount);
    }

    saveState(key, value) {
        const stmt = this.db.prepare(
            'INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
        );
        stmt.run(key, JSON.stringify(value));
    }

    loadState(key) {
        const stmt = this.db.prepare('SELECT value FROM state WHERE key = ?');
        const row = stmt.get(key);
        return row ? JSON.parse(row.value) : null;
    }

    close() {
        this.db.close();
    }
}
