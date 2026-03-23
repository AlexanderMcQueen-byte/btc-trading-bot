// Encrypted secrets management utility (stub)
import fs from 'fs';
import crypto from 'crypto';

const ALGO = 'aes-256-gcm';

export function encryptSecret(secret, password) {
    const iv = crypto.randomBytes(12);
    const key = crypto.scryptSync(password, 'salt', 32);
    const cipher = crypto.createCipheriv(ALGO, key, iv);
    let enc = cipher.update(secret, 'utf8', 'hex');
    enc += cipher.final('hex');
    const tag = cipher.getAuthTag();
    return iv.toString('hex') + ':' + tag.toString('hex') + ':' + enc;
}

export function decryptSecret(enc, password) {
    const [ivHex, tagHex, data] = enc.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const tag = Buffer.from(tagHex, 'hex');
    const key = crypto.scryptSync(password, 'salt', 32);
    const decipher = crypto.createDecipheriv(ALGO, key, iv);
    decipher.setAuthTag(tag);
    let dec = decipher.update(data, 'hex', 'utf8');
    dec += decipher.final('utf8');
    return dec;
}

export function saveEncryptedSecret(file, secret, password) {
    const enc = encryptSecret(secret, password);
    fs.writeFileSync(file, enc);
}

export function loadEncryptedSecret(file, password) {
    const enc = fs.readFileSync(file, 'utf8');
    return decryptSecret(enc, password);
}
