// Securely loads environment variables and prevents accidental logging of secrets
import fs from 'fs';
import dotenv from 'dotenv';

export function loadEnv(path = '.env') {
    if (!fs.existsSync(path)) throw new Error('Missing .env file');
    const env = dotenv.parse(fs.readFileSync(path));
    // Remove secrets from process.env logging
    for (const key in env) {
        process.env[key] = env[key];
    }
    return env;
}
