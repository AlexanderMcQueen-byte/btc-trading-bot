import winston from 'winston';
import path from 'path';

const LOG_DIR = path.resolve('logs');
const LOG_PATH = path.join(LOG_DIR, 'trading.log');

const logger = winston.createLogger({
    level: 'info',
    format: winston.format.json(),
    transports: [
        new winston.transports.File({ filename: LOG_PATH, maxsize: 10485760, maxFiles: 5 }),
        new winston.transports.Console({ format: winston.format.simple() })
    ]
});

export default logger;
