import express from 'express';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { applyPinAuth, checkPin, hashPin, IDLE_MS, makeToken, MAX_MS, readToken, validPin, writePin } from './pin.js';

describe('PIN helpers', () => {
    it('hashes and checks PINs', () => {
        const h = hashPin('123456');
        expect(checkPin('123456', h)).toBe(true);
        expect(checkPin('654321', h)).toBe(false);
        expect(checkPin('123456', 'garbage')).toBe(false);
    });

    it('requires 6-12 digits', () => {
        expect(validPin('12345')).toBe(false);
        expect(validPin('123456')).toBe(true);
        expect(validPin('12345a')).toBe(false);
        expect(validPin('1234567890123')).toBe(false);
    });

    it('expires tokens after the idle window and the absolute max', () => {
        const t0 = 1_000_000_000_000;
        const tok = makeToken('s', t0, t0);
        expect(readToken('s', tok, t0 + 1000)).not.toBeNull();
        expect(readToken('other', tok, t0 + 1000)).toBeNull();
        expect(readToken('s', tok, t0 + IDLE_MS)).toBeNull();
        // Refreshed every 10 days, it still ends at MAX_MS.
        let token = tok;
        let t = t0;
        while (t + 10 * 86400_000 < t0 + MAX_MS) {
            t += 10 * 86400_000;
            expect(readToken('s', token, t)).not.toBeNull();
            token = makeToken('s', t0, t);
        }
        expect(readToken('s', token, t0 + MAX_MS)).toBeNull();
    });
});

describe('applyPinAuth', () => {
    const cleanups: Array<() => void> = [];
    afterEach(() => cleanups.splice(0).forEach((fn) => fn()));

    // Tests connect over loopback, which is exempt, so pretend requests come from the LAN.
    async function start(dataDir: string) {
        const app = express();
        app.use((req, _res, next) => {
            if (req.headers['x-test-lan']) {
                Object.defineProperty(req.socket, 'remoteAddress', { value: '192.168.2.50', configurable: true });
            }
            next();
        });
        applyPinAuth(app, { dataDir });
        app.get('/api/state', (_req, res) => {
            res.json({ ok: true });
        });
        app.get('/', (_req, res) => {
            res.send('app');
        });
        const server = await new Promise<http.Server>((resolve) => {
            const s = app.listen(0, '127.0.0.1', () => resolve(s));
        });
        cleanups.push(() => server.close());
        const addr = server.address();
        return `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
    }

    function tmp() {
        const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hit-pin-'));
        cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }));
        return dir;
    }

    const lan = { 'x-test-lan': '1' };
    const form = (pin: string) => ({
        method: 'POST',
        redirect: 'manual' as const,
        headers: { ...lan, 'content-type': 'application/x-www-form-urlencoded' },
        body: `pin=${pin}&next=%2F`,
    });

    it('lets loopback through without a PIN', async () => {
        const base = await start(tmp());
        expect((await fetch(`${base}/api/state`)).status).toBe(200);
    });

    it('blocks LAN requests until the PIN is entered, then allows them', async () => {
        const dir = tmp();
        writePin(dir, '246810');
        const base = await start(dir);

        expect((await fetch(`${base}/api/state`, { headers: lan })).status).toBe(401);
        const page = await fetch(`${base}/`, { headers: lan, redirect: 'manual' });
        expect(page.status).toBe(303);
        expect(page.headers.get('location')).toBe('/login?next=%2F');

        expect((await fetch(`${base}/login`, form('111111'))).status).toBe(401);

        const ok = await fetch(`${base}/login`, form('246810'));
        expect(ok.status).toBe(303);
        const cookie = (ok.headers.get('set-cookie') ?? '').split(';')[0] ?? '';
        expect(cookie).toMatch(/^hit_session=/);
        expect((await fetch(`${base}/api/state`, { headers: { ...lan, cookie } })).status).toBe(200);

        // Changing the PIN signs the device out.
        writePin(dir, '135790');
        expect((await fetch(`${base}/api/state`, { headers: { ...lan, cookie } })).status).toBe(401);
    });

    it('locks out after 5 wrong PINs, even for the right one', async () => {
        const dir = tmp();
        writePin(dir, '246810');
        const base = await start(dir);
        for (let i = 0; i < 4; i++) expect((await fetch(`${base}/login`, form('000000'))).status).toBe(401);
        expect((await fetch(`${base}/login`, form('000000'))).status).toBe(429);
        expect((await fetch(`${base}/login`, form('246810'))).status).toBe(429);
    });

    it('blocks LAN requests when no PIN is set', async () => {
        const base = await start(tmp());
        expect((await fetch(`${base}/api/state`, { headers: lan })).status).toBe(401);
        expect((await fetch(`${base}/login`, form('246810'))).status).toBe(503);
    });
});
