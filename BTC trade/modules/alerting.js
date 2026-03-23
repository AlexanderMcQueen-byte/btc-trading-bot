// Simple alerting module for critical errors (email/Slack integration placeholder)
import fs from 'fs';
import path from 'path';

const LOG_DIR = path.resolve('logs');
const ALERTS_PATH = path.join(LOG_DIR, 'alerts.log');

if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
}

export function sendAlert(message) {
    fs.appendFileSync(ALERTS_PATH, `[${new Date().toISOString()}] ${message}\n`);
}
