/**
 * Pterodactyl / VPS entry point.
 * Installs bot dependencies and starts the bot from the correct working directory.
 * CMD_RUN = node deploy_start.js
 */
import { execSync, spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const botDir    = path.join(__dirname, 'BTC trade');

console.log('[deploy] Bot directory:', botDir);
console.log('[deploy] Installing dependencies...');

try {
    execSync('npm install --omit=dev', { cwd: botDir, stdio: 'inherit' });
} catch (e) {
    console.error('[deploy] npm install failed:', e.message);
    process.exit(1);
}

console.log('[deploy] Starting bot...');

const bot = spawn('node', ['main.js'], {
    cwd:   botDir,
    stdio: 'inherit',
    env:   process.env
});

bot.on('error', (err) => {
    console.error('[deploy] Failed to start:', err.message);
    process.exit(1);
});

bot.on('exit', (code) => {
    console.log('[deploy] Bot exited with code', code);
    process.exit(code ?? 0);
});
