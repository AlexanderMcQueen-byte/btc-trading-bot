import fs from 'fs';
import path from 'path';

const LOG_DIR = path.resolve('logs');
const AUDIT_LOG_PATH = path.join(LOG_DIR, 'audit.log');

if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
}

export function logApiUsage({ endpoint, params, status, timestamp = new Date().toISOString() }) {
    const entry = JSON.stringify({ timestamp, endpoint, params, status }) + '\n';
    fs.appendFileSync(AUDIT_LOG_PATH, entry);
}
