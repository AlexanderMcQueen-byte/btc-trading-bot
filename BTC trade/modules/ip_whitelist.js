// IP whitelisting utility (for cloud deployments)
import os from 'os';
import fs from 'fs';

export function isIpWhitelisted(ip, whitelistPath = 'ip_whitelist.txt') {
    if (!fs.existsSync(whitelistPath)) return false;
    const whitelist = fs.readFileSync(whitelistPath, 'utf-8').split(/\r?\n/).filter(Boolean);
    return whitelist.includes(ip);
}

export function getServerIp() {
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return null;
}
