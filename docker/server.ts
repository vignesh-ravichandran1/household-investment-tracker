import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { startServer } from '../server/index.js';

const port = Number.parseInt(process.env.PORT ?? '3001', 10);
const host = process.env.HOST ?? '0.0.0.0';
const dataDir = process.env.HIT_DATA_DIR ?? '/data';
const staticDir = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../dist'
);

if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid PORT value: ${process.env.PORT}`);
}

const running = await startServer({
    port,
    host,
    strictPort: true,
    dataDir,
    staticDir,
    distribution: 'diy',
    // Fork addition: PIN login on by default; HIT_REQUIRE_PIN=0 turns it off.
    requirePin: process.env.HIT_REQUIRE_PIN !== '0',
});

let shuttingDown = false;

async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`[Docker] Received ${signal}; flushing data and shutting down.`);
    try {
        await running.close();
        process.exit(0);
    } catch (error) {
        console.error('[Docker] Shutdown failed:', error);
        process.exit(1);
    }
}

process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
