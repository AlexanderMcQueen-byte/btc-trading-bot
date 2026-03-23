// API key rotation utility (manual trigger)
import fs from 'fs';

export function rotateApiKeys(newKey, newSecret, envPath = '.env') {
    let env = fs.readFileSync(envPath, 'utf-8');
    env = env.replace(/API_KEY=.*/g, `API_KEY=${newKey}`);
    env = env.replace(/API_SECRET=.*/g, `API_SECRET=${newSecret}`);
    fs.writeFileSync(envPath, env);
}
