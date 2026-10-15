import { Injectable, NestMiddleware } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'crypto';
import { ProfilerOptions } from '../common/profiler-options.interface';

/** 24-hour session TTL in milliseconds */
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const COOKIE_NAME = '__profiler_session';

/**
 * Module-level variable — set synchronously in ProfilerModule.forRoot() before
 * any DI or configure() logic runs. This guarantees the middleware always sees
 * the real options, regardless of NestJS's dynamic-module merge timing.
 */
let _authOptions: ProfilerOptions = {};

export function setProfilerAuthOptions(options: ProfilerOptions): void {
    _authOptions = options;
}

// ─── Cookie helpers ────────────────────────────────────────────────────────

function parseCookies(
    cookieHeader: string | undefined,
): Record<string, string> {
    if (!cookieHeader) return {};
    return Object.fromEntries(
        cookieHeader.split(';').map((pair) => {
            const idx = pair.indexOf('=');
            if (idx === -1) return [pair.trim(), ''];
            return [
                pair.slice(0, idx).trim(),
                decodeURIComponent(pair.slice(idx + 1).trim()),
            ];
        }),
    );
}

function signToken(username: string, expiry: number, password: string): string {
    return createHmac('sha256', password)
        .update(`${username}:${expiry}`)
        .digest('hex');
}

export interface SessionCookieOptions {
    /** Add the `Secure` attribute (set when the dashboard is served over HTTPS). */
    secure?: boolean;
}

// Path=/ so the cookie is still sent when the dashboard sits behind a gateway
// path prefix (e.g. /api/gw/__profiler) that the server cannot see. The value is
// HttpOnly + SameSite=Strict, and the profiler redacts Cookie headers in profiles.
function cookieAttributes(
    maxAgeSeconds: number,
    opts: SessionCookieOptions,
): string {
    return `HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAgeSeconds}${opts.secure ? '; Secure' : ''}`;
}

export function buildSessionCookie(
    username: string,
    password: string,
    opts: SessionCookieOptions = {},
): string {
    const expiry = Date.now() + SESSION_TTL_MS;
    const hmac = signToken(username, expiry, password);
    const token = encodeURIComponent(`${username}:${expiry}:${hmac}`);
    return `${COOKIE_NAME}=${token}; ${cookieAttributes(SESSION_TTL_MS / 1000, opts)}`;
}

export function clearSessionCookie(opts: SessionCookieOptions = {}): string {
    return `${COOKIE_NAME}=; ${cookieAttributes(0, opts)}`;
}

/** True when the request reached us over HTTPS (directly or via a TLS-terminating proxy). */
export function isSecureRequest(req: any): boolean {
    if (req?.secure === true || req?.protocol === 'https') return true;
    const proto = req?.headers?.['x-forwarded-proto'];
    return (
        typeof proto === 'string' &&
        proto.split(',')[0].trim().toLowerCase() === 'https'
    );
}

export function verifySessionCookie(
    cookieHeader: string | undefined,
    username: string,
    password: string,
): boolean {
    try {
        const cookies = parseCookies(cookieHeader);
        const raw = cookies[COOKIE_NAME];
        if (!raw) return false;

        // username may itself contain ':' — expiry and HMAC are always the last two parts
        const parts = raw.split(':');
        if (parts.length < 3) return false;

        const cookieHmac = parts[parts.length - 1];
        const expiry = parseInt(parts[parts.length - 2], 10);
        const cookieUser = parts.slice(0, -2).join(':');

        if (isNaN(expiry) || Date.now() > expiry) return false;
        if (cookieUser !== username) return false;

        const expected = signToken(username, expiry, password);
        const expectedBuf = Buffer.from(expected, 'hex');
        const actualBuf = Buffer.from(cookieHmac, 'hex');

        if (expectedBuf.length !== actualBuf.length) return false;
        return timingSafeEqual(expectedBuf, actualBuf);
    } catch {
        return false;
    }
}

// ─── Middleware factory ────────────────────────────────────────────────────

const PROFILER_SEGMENT = /\/__profiler(?=\/|$)/;

/**
 * Path of the request below the `__profiler` segment, without query string.
 * `/__profiler` → '', `/__profiler/` → '/', `/gw/__profiler/view/x?a=1` → '/view/x'.
 * Returns null when the path does not contain a `__profiler` segment.
 */
export function profilerSubPath(url: string): string | null {
    const pathname = (url || '').split('?')[0].split('#')[0];
    const match = PROFILER_SEGMENT.exec(pathname);
    if (!match) return null;
    return pathname.slice(match.index + match[0].length);
}

/**
 * Relative URL from the current request to the login page. Relative so the
 * browser resolves it against whatever path prefix a gateway put in front.
 */
export function relativeLoginUrl(subPath: string): string {
    if (subPath === '') return '__profiler/login';
    const depth = subPath.split('/').length - 2;
    return '../'.repeat(Math.max(depth, 0)) + 'login';
}

function isPublicPath(subPath: string): boolean {
    return (
        subPath === '/login' ||
        subPath === '/login/' ||
        subPath === '/logout' ||
        subPath === '/api/login' ||
        subPath.startsWith('/assets/') ||
        subPath.startsWith('/js/')
    );
}

function isApiRequest(subPath: string, method: string): boolean {
    if (method !== 'GET' && method !== 'HEAD') return true;
    return (
        subPath.startsWith('/api/') ||
        subPath === '/json' ||
        subPath.endsWith('/json') ||
        subPath.startsWith('/logs/stream') ||
        subPath.startsWith('/debug/')
    );
}

/**
 * Returns a plain Express middleware function that reads from the module-level
 * _authOptions variable. No parameters needed — options were set by forRoot().
 *
 * Without a valid session cookie, page requests are redirected to the login page
 * and API requests get a 401 JSON response.
 */
export function createProfilerAuthMiddleware() {
    return function profilerAuthMiddleware(
        req: any,
        res: any,
        next: () => void,
    ) {
        const auth = _authOptions?.auth;

        // Auth disabled (default) — pass through
        if (!auth || auth.enabled !== true) {
            return next();
        }

        const url: string = req.originalUrl || req.url || '';
        const subPath = profilerSubPath(url) ?? (req.url || '').split('?')[0];

        // Login page, login API, logout and static assets must stay reachable
        if (isPublicPath(subPath)) {
            return next();
        }

        if (
            verifySessionCookie(
                req.headers?.cookie,
                auth.username,
                auth.password,
            )
        ) {
            return next();
        }

        const method = String(req.method || 'GET').toUpperCase();
        if (isApiRequest(subPath, method)) {
            res.writeHead(401, { 'Content-Type': 'application/json' });
            res.end(
                JSON.stringify({
                    statusCode: 401,
                    error: 'Unauthorized',
                    message: 'Profiler login required.',
                }),
            );
            return;
        }

        // Redirect to login, preserving the intended destination. The login page
        // re-bases returnTo onto its own path prefix and rejects anything else.
        const returnTo = encodeURIComponent(url || '/__profiler');
        res.writeHead(302, {
            Location: `${relativeLoginUrl(subPath)}?returnTo=${returnTo}`,
        });
        res.end();
    };
}

/**
 * Stub class kept so the DI token resolves cleanly in the controller.
 * Actual auth work is done by the factory-based functional middleware above.
 */
@Injectable()
export class ProfilerAuthMiddleware implements NestMiddleware {
    use(_req: any, _res: any, next: () => void) {
        next();
    }
}
