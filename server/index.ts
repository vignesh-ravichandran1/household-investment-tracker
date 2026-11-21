import express, { type Express } from 'express';
import http from 'http';
import net from 'net';
import path from 'path';
import {
    ALLOWED_ORIGIN,
    dataPaths,
    HOST,
    PORT,
    type Distribution,
} from './config.js';
import { createDbStore, db } from './lib/db.js';
import { applyPinAuth } from './middleware/pin.js';
import { applyRateLimiters, applySecurityMiddleware, errorHandler } from './middleware/security.js';
import { createDividendsRouter } from './routes/dividends.js';
import { createMarketRouter } from './routes/market.js';
import { createPortfolioRouter } from './routes/portfolio.js';
import { createStateRouter } from './routes/state.js';
import { createTaxRouter } from './routes/tax.js';
import { createVersionRouter } from './routes/version.js';

export function createApp(options?: {
    store?: typeof db;
    allowedOrigin?: string | string[];
    enableRateLimit?: boolean;
    staticDir?: string;
    currentVersion?: string;
    distribution?: Distribution;
    /** Fork addition: require the PIN (auth.json in this folder) for everything except loopback. */
    pinAuthDataDir?: string;
}): Express {
    const store = options?.store ?? db;
    const app = express();

    applySecurityMiddleware(app, options?.allowedOrigin ?? ALLOWED_ORIGIN);
    if (options?.pinAuthDataDir) {
        applyPinAuth(app, { dataDir: options.pinAuthDataDir });
    }
    if (options?.enableRateLimit !== false) {
        applyRateLimiters(app);
    }

    app.use('/api', createStateRouter(store));
    app.use('/api', createTaxRouter(store));
    app.use('/api', createPortfolioRouter());
    app.use('/api', createMarketRouter());
    app.use('/api', createDividendsRouter(store));
    app.use(
        '/api',
        createVersionRouter({
            currentVersion: options?.currentVersion,
            distribution: options?.distribution,
        })
    );

    if (options?.staticDir) {
        const staticDir = path.resolve(options.staticDir);
        const indexHtml = path.join(staticDir, 'index.html');
        app.use(express.static(staticDir));
        app.get(/^(?!\/api(?:\/|$)).*/, (_req, res) => {
            res.sendFile(indexHtml);
        });
    }

    app.use(errorHandler);
    return app;
}

function isPortFree(port: number, host: string): Promise<boolean> {
    return new Promise((resolve) => {
        const tester = net.createServer();
        tester.once('error', () => resolve(false));
        tester.once('listening', () => {
            tester.close(() => resolve(true));
        });
        tester.listen(port, host);
    });
}

async function findAvailablePort(
    preferredPort: number,
    host: string,
    strictPort = false
): Promise<number> {
    if (strictPort || preferredPort === 0) {
        return preferredPort;
    }
    if (await isPortFree(preferredPort, host)) {
        return preferredPort;
    }
    // Preferred port is occupied: fall back to an ephemeral OS-assigned port
    return new Promise((resolve, reject) => {
        const probe = net.createServer();
        probe.once('error', reject);
        probe.once('listening', () => {
            const addr = probe.address();
            const port = typeof addr === 'object' && addr ? addr.port : 0;
            probe.close(() => resolve(port));
        });
        probe.listen(0, host);
    });
}

export interface RunningServer {
    port: number;
    origin: string;
    store: typeof db;
    close: () => Promise<void>;
}

export async function startServer(options: {
    port: number;
    host?: string;
    strictPort?: boolean;
    dataDir?: string;
    staticDir?: string;
    currentVersion?: string;
    distribution?: Distribution;
    enableRateLimit?: boolean;
    /** Fork addition: require the PIN; needs dataDir. */
    requirePin?: boolean;
}): Promise<RunningServer> {
    if (options.requirePin && !options.dataDir) {
        throw new Error('requirePin needs dataDir (where auth.json lives)');
    }
    const host = options.host ?? HOST;
    const requestedPort = await findAvailablePort(options.port, host, options.strictPort);

    const store = options.dataDir ? createDbStore(dataPaths(options.dataDir)) : db;
    store.init();

    const allowedOrigins: string[] = [ALLOWED_ORIGIN];
    if (requestedPort > 0) {
        allowedOrigins.push(`http://${host}:${requestedPort}`);
    }

    const app = createApp({
        store,
        allowedOrigin: allowedOrigins,
        enableRateLimit: options.enableRateLimit,
        staticDir: options.staticDir,
        currentVersion: options.currentVersion,
        distribution: options.distribution,
        pinAuthDataDir: options.requirePin ? options.dataDir : undefined,
    });

    const server = await new Promise<http.Server>((resolve, reject) => {
        const s = app.listen(requestedPort, host, () => resolve(s));
        s.once('error', reject);
    });

    const addr = server.address();
    const boundPort = typeof addr === 'object' && addr ? addr.port : requestedPort;
    const origin = `http://${host}:${boundPort}`;
    if (!allowedOrigins.includes(origin)) {
        allowedOrigins.push(origin);
    }

    console.log(`Server listening on ${origin}`);

    let closed = false;
    return {
        port: boundPort,
        origin,
        store,
        close: async () => {
            if (closed) return;
            closed = true;
            await new Promise<void>((resolve) => {
                server.close(() => resolve());
            });
            await store.flush();
        },
    };
}

const isDirectRun =
    !process.versions.electron &&
    Boolean(
        process.argv[1] &&
            (process.argv[1].endsWith('index.ts') || process.argv[1].endsWith('index.js'))
    );

if (isDirectRun) {
    startServer({ port: PORT, strictPort: true, distribution: 'diy' }).then((running) => {
        const shutdown = async () => {
            await running.close();
            process.exit(0);
        };
        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);
    });
}
