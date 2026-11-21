/**
 * PIN login for the self-hosted web mode (fork addition, not upstream).
 *
 * - The PIN is set on the server computer with `npm run pin` (windows\set-pin.bat); only a salted
 *   scrypt hash is stored, in <dataDir>/auth.json, next to database.json.
 * - A correct PIN gives the browser a signed, HttpOnly cookie. Nothing is kept in memory, so a
 *   server restart doesn't sign anyone out.
 * - When the PIN is asked again: after IDLE_MS without using the app on that device, after MAX_MS
 *   since the PIN was entered (however often it's used), and on every device when the PIN changes
 *   (changing it rotates the signing secret).
 * - Requests from the server computer itself (loopback) never need the PIN.
 * - Wrong PINs: after MAX_FAILS in a row, logins lock for LOCK_MS, doubling on each further
 *   lockout (capped at 24 h) until a correct PIN.
 */
import crypto from 'crypto';
import express, { type Express, type NextFunction, type Request, type Response } from 'express';
import fs from 'fs';
import path from 'path';

export const COOKIE = 'hit_session';
export const IDLE_MS = 14 * 24 * 3600_000;
export const MAX_MS = 90 * 24 * 3600_000;
const MAX_FAILS = 5;
const LOCK_MS = 5 * 60_000;
const MAX_LOCK_MS = 24 * 3600_000;

export interface AuthFile {
    pinHash: string;
    secret: string;
}

export const validPin = (pin: unknown): boolean => /^\d{6,12}$/.test(String(pin));

export function hashPin(pin: string): string {
    const salt = crypto.randomBytes(16).toString('hex');
    return `scrypt:${salt}:${crypto.scryptSync(pin, salt, 32).toString('hex')}`;
}

export function checkPin(pin: string, stored: string): boolean {
    const [kind, salt, hash] = stored.split(':');
    if (kind !== 'scrypt' || !salt || !hash) return false;
    const want = Buffer.from(hash, 'hex');
    const got = crypto.scryptSync(pin, salt, want.length || 32);
    return want.length === got.length && crypto.timingSafeEqual(got, want);
}

export function authPath(dataDir: string): string {
    return path.join(dataDir, 'auth.json');
}

/** Writes a new PIN and a new signing secret (which signs out every device). */
export function writePin(dataDir: string, pin: string): void {
    if (!validPin(pin)) throw new Error('PIN must be 6 to 12 digits');
    fs.mkdirSync(dataDir, { recursive: true });
    const auth: AuthFile = { pinHash: hashPin(pin), secret: crypto.randomBytes(32).toString('hex') };
    const file = authPath(dataDir);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(auth, null, 2));
    fs.renameSync(`${file}.tmp`, file);
}

/** Reads auth.json, re-reading only when it changes, so `npm run pin` works without a restart. */
function authReader(dataDir: string): () => AuthFile | null {
    let cached: { mtimeMs: number; auth: AuthFile | null } | null = null;
    return () => {
        const file = authPath(dataDir);
        let mtimeMs: number;
        try {
            mtimeMs = fs.statSync(file).mtimeMs;
        } catch {
            cached = null;
            return null;
        }
        if (cached && cached.mtimeMs === mtimeMs) return cached.auth;
        let auth: AuthFile | null = null;
        try {
            const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<AuthFile>;
            if (typeof parsed.pinHash === 'string' && typeof parsed.secret === 'string' && parsed.secret) {
                auth = { pinHash: parsed.pinHash, secret: parsed.secret };
            }
        } catch {
            auth = null;
        }
        cached = { mtimeMs, auth };
        return auth;
    };
}

const sign = (secret: string, body: string) =>
    crypto.createHmac('sha256', secret).update(body).digest('base64url');

/** Token: v1.<signedInAt>.<expiresAt>.<hmac>. */
export function makeToken(secret: string, signedInAt: number, now: number): string {
    const expiresAt = Math.min(now + IDLE_MS, signedInAt + MAX_MS);
    const body = `v1.${signedInAt}.${expiresAt}`;
    return `${body}.${sign(secret, body)}`;
}

export function readToken(secret: string, token: string | undefined, now: number): { signedInAt: number; expiresAt: number } | null {
    if (!token) return null;
    const parts = token.split('.');
    if (parts.length !== 4 || parts[0] !== 'v1') return null;
    const body = parts.slice(0, 3).join('.');
    const want = Buffer.from(sign(secret, body));
    const got = Buffer.from(parts[3] ?? '');
    if (want.length !== got.length || !crypto.timingSafeEqual(want, got)) return null;
    const signedInAt = Number(parts[1]);
    const expiresAt = Number(parts[2]);
    if (!Number.isFinite(signedInAt) || !Number.isFinite(expiresAt)) return null;
    if (now >= expiresAt || now >= signedInAt + MAX_MS) return null;
    return { signedInAt, expiresAt };
}

function getCookie(req: Request, name: string): string | undefined {
    for (const part of (req.headers.cookie ?? '').split(';')) {
        const i = part.indexOf('=');
        if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
    }
    return undefined;
}

function setCookie(res: Response, token: string, expiresAt: number, now: number): void {
    res.cookie(COOKIE, token, {
        httpOnly: true,
        sameSite: 'lax',
        path: '/',
        maxAge: Math.max(0, expiresAt - now),
    });
}

export function isLoopback(req: Request): boolean {
    const a = req.socket.remoteAddress ?? '';
    return a === '::1' || a.startsWith('127.') || a.startsWith('::ffff:127.');
}

const escapeHtml = (s: string) =>
    s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] ?? c);

function loginPage(message: string, next: string): string {
    return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Investment Tracker: sign in</title>
<style>
  :root { color-scheme: light dark; --bg:#f4f5f7; --card:#fff; --fg:#111827; --muted:#6b7280; --line:#d1d5db; --accent:#2563eb; --err:#b91c1c; }
  @media (prefers-color-scheme: dark) { :root { --bg:#0f172a; --card:#1e293b; --fg:#f1f5f9; --muted:#94a3b8; --line:#334155; --accent:#60a5fa; --err:#f87171; } }
  * { box-sizing: border-box; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:var(--bg); color:var(--fg);
         font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; padding:16px; }
  form { background:var(--card); border:1px solid var(--line); border-radius:12px; padding:28px; width:100%; max-width:340px; }
  h1 { font-size:1.25rem; margin:0 0 4px; }
  p { margin:0 0 20px; color:var(--muted); font-size:.9rem; }
  input { width:100%; font-size:1.5rem; letter-spacing:.3em; text-align:center; padding:12px; border-radius:8px;
          border:1px solid var(--line); background:transparent; color:var(--fg); }
  button { width:100%; margin-top:14px; padding:12px; font-size:1rem; font-weight:600; border:0; border-radius:8px;
           background:var(--accent); color:#fff; cursor:pointer; }
  .msg { color:var(--err); margin:14px 0 0; font-size:.9rem; }
</style></head>
<body><form method="post" action="/login">
  <h1>Household Investment Tracker</h1>
  <p>Enter the PIN to continue.</p>
  <input name="pin" type="password" inputmode="numeric" autocomplete="current-password" pattern="[0-9]*" required autofocus aria-label="PIN">
  <input type="hidden" name="next" value="${escapeHtml(next)}">
  <button type="submit">Unlock</button>
  ${message ? `<p class="msg" role="alert">${escapeHtml(message)}</p>` : ''}
</form></body></html>`;
}

/** Only same-site relative paths, so the login form can't redirect elsewhere. */
function safeNext(next: unknown): string {
    const s = typeof next === 'string' ? next : '/';
    return s.startsWith('/') && !s.startsWith('//') && !s.startsWith('/\\') ? s : '/';
}

export function applyPinAuth(app: Express, options: { dataDir: string; now?: () => number }): void {
    const readAuth = authReader(options.dataDir);
    const now = options.now ?? Date.now;
    let fails = 0;
    let lockouts = 0;
    let lockedUntil = 0;

    // Helmet's default Referrer-Policy (no-referrer) makes browsers send "Origin: null" on POSTs from
    // our pages (the PIN form, and saves from the app), which CORS then rejects as "Origin not allowed".
    // same-origin still sends no referrer to other sites but lets same-site POSTs carry the real origin.
    app.use((_req, res, next) => {
        res.set('Referrer-Policy', 'same-origin');
        next();
    });

    const noPinMessage = 'No PIN set yet. On the server computer run windows\\set-pin.bat (or npm run pin).';

    app.get('/login', (req, res) => {
        res.set('Cache-Control', 'no-store');
        res.type('html').send(loginPage(readAuth() ? '' : noPinMessage, safeNext(req.query.next)));
    });

    app.post('/login', express.urlencoded({ extended: false, limit: '2kb' }), (req, res) => {
        const t = now();
        const next = safeNext(req.body?.next);
        const send = (status: number, message: string) => {
            res.set('Cache-Control', 'no-store');
            res.status(status).type('html').send(loginPage(message, next));
        };
        const auth = readAuth();
        if (!auth) return send(503, noPinMessage);
        if (t < lockedUntil) {
            return send(429, `Too many wrong PINs. Try again in ${Math.ceil((lockedUntil - t) / 60_000)} min.`);
        }
        const pin = String(req.body?.pin ?? '');
        if (!validPin(pin) || !checkPin(pin, auth.pinHash)) {
            fails += 1;
            if (fails >= MAX_FAILS) {
                lockedUntil = t + Math.min(LOCK_MS * 2 ** lockouts, MAX_LOCK_MS);
                lockouts += 1;
                fails = 0;
                console.warn(`[PIN] ${MAX_FAILS} wrong PINs from ${req.socket.remoteAddress}; locked until ${new Date(lockedUntil).toISOString()}`);
                return send(429, `Too many wrong PINs. Try again in ${Math.ceil((lockedUntil - t) / 60_000)} min.`);
            }
            return send(401, 'Wrong PIN.');
        }
        fails = 0;
        lockouts = 0;
        const token = makeToken(auth.secret, t, t);
        setCookie(res, token, Math.min(t + IDLE_MS, t + MAX_MS), t);
        res.redirect(303, next);
    });

    app.get('/logout', (_req, res) => {
        res.clearCookie(COOKIE, { path: '/' });
        res.redirect(303, '/login');
    });

    app.use((req: Request, res: Response, next: NextFunction) => {
        if (isLoopback(req)) return next();
        const t = now();
        const auth = readAuth();
        const session = auth ? readToken(auth.secret, getCookie(req, COOKIE), t) : null;
        if (auth && session) {
            // Slide the idle window forward, at most once an hour per device.
            if (session.expiresAt - t < IDLE_MS - 3600_000) {
                const token = makeToken(auth.secret, session.signedInAt, t);
                setCookie(res, token, Math.min(t + IDLE_MS, session.signedInAt + MAX_MS), t);
            }
            return next();
        }
        if (req.path === '/api' || req.path.startsWith('/api/')) {
            res.status(401).json({ error: 'PIN required', login: '/login' });
            return;
        }
        if (req.method === 'GET' || req.method === 'HEAD') {
            res.redirect(303, `/login?next=${encodeURIComponent(req.originalUrl)}`);
            return;
        }
        res.status(401).type('text').send('PIN required');
    });
}
