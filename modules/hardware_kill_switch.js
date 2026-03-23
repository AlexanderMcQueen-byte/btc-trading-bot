import fs from 'fs';

/**
 * Checks for the presence of a hardware-level kill switch file.
 * If the file exists, trading should halt immediately.
 * @param {string} path - Path to the kill switch file.
 * @returns {boolean}
 */
export function checkKillSwitch(path = '/tmp/kill_switch') {
    return fs.existsSync(path);
}
