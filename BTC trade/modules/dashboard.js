/**
 * Live Dashboard — Express.js server with real-time SSE updates.
 *
 * PORT: process.env.DASHBOARD_PORT || 3001
 *
 * Routes:
 *   GET /               → HTML dashboard (Chart.js)
 *   GET /api/status     → Current BOT_STATE as JSON
 *   GET /api/trades     → Recent trade history
 *   GET /api/equity     → Equity curve data points
 *   GET /api/stats      → Aggregate stats from DB
 *   GET /api/export/csv → Download all trades as CSV
 *   GET /api/export/json→ Download all trades as JSON
 *   GET /events         → SSE stream (pushed every 5s)
 */

import express from 'express';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, '..', 'dashboard', 'public');

export function startDashboard({ getBotState, db, logger = console }) {
    const port = parseInt(process.env.DASHBOARD_PORT) || 3001;
    const app  = express();
    const sseClients = new Set();

    app.use(express.json());

    // ── Serve static files ────────────────────────────────────────────────────
    app.use(express.static(PUBLIC_DIR));

    app.get('/', (req, res) => {
        res.sendFile(path.join(PUBLIC_DIR, 'index.html'));
    });

    // ── REST API ──────────────────────────────────────────────────────────────
    app.get('/api/status', (req, res) => {
        res.json(getBotState());
    });

    app.get('/api/trades', (req, res) => {
        const limit = parseInt(req.query.limit) || 100;
        try { res.json(db.getRecentTrades(limit)); }
        catch (e) { res.json([]); }
    });

    app.get('/api/equity', (req, res) => {
        try { res.json(db.getEquityCurve(500)); }
        catch (e) { res.json([]); }
    });

    app.get('/api/stats', (req, res) => {
        try { res.json(db.getStats()); }
        catch (e) { res.json({}); }
    });

    app.get('/api/export/csv', (req, res) => {
        res.setHeader('Content-Type', 'text/csv');
        res.setHeader('Content-Disposition', `attachment; filename="trades_${Date.now()}.csv"`);
        res.send(db.exportToCSV());
    });

    app.get('/api/export/json', (req, res) => {
        res.setHeader('Content-Type', 'application/json');
        res.setHeader('Content-Disposition', `attachment; filename="trades_${Date.now()}.json"`);
        res.send(db.exportToJSON());
    });

    // ── Server-Sent Events (real-time push) ───────────────────────────────────
    app.get('/events', (req, res) => {
        res.setHeader('Content-Type',  'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection',    'keep-alive');
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.flushHeaders();

        sseClients.add(res);
        req.on('close', () => sseClients.delete(res));

        // Send immediate snapshot
        const state = getBotState();
        res.write(`data: ${JSON.stringify(state)}\n\n`);
    });

    // Push state to all SSE clients every 5 seconds
    setInterval(() => {
        if (!sseClients.size) return;
        const state = getBotState();
        const payload = `data: ${JSON.stringify(state)}\n\n`;
        for (const client of sseClients) {
            try { client.write(payload); } catch (_) { sseClients.delete(client); }
        }
    }, 5000);

    // ── Start server ──────────────────────────────────────────────────────────
    app.listen(port, '0.0.0.0', () => {
        logger.info(`📊 Dashboard running at http://0.0.0.0:${port}`);
    });

    // Export push function so main.js can push on-demand (e.g. after a trade)
    return {
        push(state) {
            const payload = `data: ${JSON.stringify(state)}\n\n`;
            for (const client of sseClients) {
                try { client.write(payload); } catch (_) { sseClients.delete(client); }
            }
        }
    };
}
