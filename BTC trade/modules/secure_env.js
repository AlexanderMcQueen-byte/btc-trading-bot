// Securely loads environment variables and prevents accidental logging of secrets
import fs from 'fs';
import dotenv from 'dotenv';

export function loadEnv(path = '.env') {
    if (fs.existsSync(path)) {
        // Load .env file if present (local dev / Replit / VPS with file)
        const env = dotenv.parse(fs.readFileSync(path));
        for (const key in env) {
            // dotenv respects existing env vars — only set if not already defined
            if (!process.env[key]) process.env[key] = env[key];
        }
        return env;
    }

    // No .env file — rely on environment variables already set by the host
    // (Pterodactyl CUSTOM_ENVIRONMENT_VARIABLES, Docker --env-file, systemd, etc.)
    const required = ['BINANCE_API_KEY', 'BINANCE_SECRET_KEY'];
    const missing  = required.filter(k => !process.env[k]);

    if (missing.length > 0) {
        console.warn(`[secure_env] No .env file found and missing env vars: ${missing.join(', ')}`);
        console.warn('[secure_env] Bot will run in simulation mode — set env vars or provide a .env file for live trading.');
    } else {
        console.log('[secure_env] No .env file — using environment variables provided by host.');
    }

    return {};
}
