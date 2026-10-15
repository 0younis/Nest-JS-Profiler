import { createHmac } from 'crypto';
import {
  buildSessionCookie,
  clearSessionCookie,
  createProfilerAuthMiddleware,
  profilerSubPath,
  relativeLoginUrl,
  setProfilerAuthOptions,
  verifySessionCookie,
} from '../../../../libs/nestjs-profiler/src/middleware/profiler-auth.middleware';

const USER = 'admin';
const PASS = 'supersecret';

const cookieHeaderFrom = (setCookie: string) => setCookie.split(';')[0];

const makeReq = (
  originalUrl: string,
  opts: { method?: string; cookie?: string } = {},
) => ({
  method: opts.method || 'GET',
  url: originalUrl,
  originalUrl,
  headers: opts.cookie ? { cookie: opts.cookie } : {},
});

const makeRes = () => {
  const res: any = { statusCode: undefined, headers: {}, body: undefined };
  res.writeHead = jest.fn((code: number, headers: Record<string, string>) => {
    res.statusCode = code;
    res.headers = headers;
  });
  res.end = jest.fn((body?: string) => {
    res.body = body;
  });
  return res;
};

const run = (req: any) => {
  const res = makeRes();
  const next = jest.fn();
  createProfilerAuthMiddleware()(req, res, next);
  return { res, next };
};

describe('profiler auth middleware', () => {
  afterEach(() => {
    jest.useRealTimers();
    setProfilerAuthOptions({});
  });

  describe('auth disabled', () => {
    it('passes everything through when auth is not configured', () => {
      setProfilerAuthOptions({});
      const { res, next } = run(
        makeReq('/__profiler/api/memory/snapshot', { method: 'POST' }),
      );
      expect(next).toHaveBeenCalled();
      expect(res.writeHead).not.toHaveBeenCalled();
    });

    it('passes everything through when auth.enabled is false', () => {
      setProfilerAuthOptions({ auth: { enabled: false } });
      const { res, next } = run(makeReq('/__profiler/view/summary'));
      expect(next).toHaveBeenCalled();
      expect(res.writeHead).not.toHaveBeenCalled();
    });
  });

  describe('auth enabled', () => {
    beforeEach(() => {
      setProfilerAuthOptions({
        auth: { enabled: true, username: USER, password: PASS },
      });
    });

    it('allows requests with a valid session cookie', () => {
      const cookie = cookieHeaderFrom(buildSessionCookie(USER, PASS));
      const page = run(makeReq('/__profiler/view/queries', { cookie }));
      const api = run(
        makeReq('/__profiler/api/memory/gc', {
          method: 'POST',
          cookie: `other=1; ${cookie}`,
        }),
      );
      expect(page.next).toHaveBeenCalled();
      expect(api.next).toHaveBeenCalled();
    });

    it.each([
      '/__profiler/login',
      '/__profiler/login?returnTo=%2F__profiler',
      '/__profiler/logout',
      '/__profiler/assets/logo.png',
      '/__profiler/js/layout.js',
      '/api/gw/__profiler/login',
    ])('allows public path %s without a session', (url) => {
      const { next } = run(makeReq(url));
      expect(next).toHaveBeenCalled();
    });

    it('allows POST api/login without a session', () => {
      const { next } = run(
        makeReq('/__profiler/api/login', { method: 'POST' }),
      );
      expect(next).toHaveBeenCalled();
    });

    it('redirects HTML page requests without a cookie to login with returnTo', () => {
      const { res, next } = run(makeReq('/__profiler/view/summary?x=1'));
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(302);
      expect(res.headers.Location).toBe(
        `../login?returnTo=${encodeURIComponent('/__profiler/view/summary?x=1')}`,
      );
    });

    it.each([
      ['/__profiler', '__profiler/login'],
      ['/__profiler/', 'login'],
      ['/__profiler/abc-123', 'login'],
      ['/__profiler/view/summary', '../login'],
      ['/__profiler/view/logs/live', '../../login'],
    ])('uses a relative login Location for %s', (url, expected) => {
      const { res } = run(makeReq(url));
      expect(res.headers.Location.split('?')[0]).toBe(expected);
    });

    it('redirects relative to a gateway-prefixed URL instead of hardcoding /__profiler', () => {
      const { res } = run(makeReq('/api/gw/__profiler/view/erd'));
      expect(res.statusCode).toBe(302);
      expect(res.headers.Location).not.toMatch(/^\//);
      // Resolved by the browser against the prefixed page URL:
      const resolved = new URL(
        res.headers.Location,
        'https://host/api/gw/__profiler/view/erd',
      );
      expect(resolved.pathname).toBe('/api/gw/__profiler/login');
      expect(resolved.searchParams.get('returnTo')).toBe(
        '/api/gw/__profiler/view/erd',
      );
    });

    it.each([
      ['GET', '/__profiler/api/erd'],
      ['GET', '/__profiler/json'],
      ['GET', '/__profiler/abc-123/json'],
      ['GET', '/__profiler/logs/stream'],
      ['POST', '/__profiler/api/memory/snapshot'],
      ['GET', '/api/gw/__profiler/api/exceptions'],
    ])(
      'returns 401 JSON for API request %s %s without a cookie',
      (method, url) => {
        const { res, next } = run(makeReq(url, { method }));
        expect(next).not.toHaveBeenCalled();
        expect(res.statusCode).toBe(401);
        expect(res.headers['Content-Type']).toBe('application/json');
        expect(JSON.parse(res.body)).toMatchObject({ statusCode: 401 });
      },
    );

    it('rejects an expired cookie', () => {
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-01-01T00:00:00Z'));
      const cookie = cookieHeaderFrom(buildSessionCookie(USER, PASS));
      jest.setSystemTime(new Date('2026-01-02T00:00:01Z'));
      const { res, next } = run(makeReq('/__profiler/api/erd', { cookie }));
      expect(next).not.toHaveBeenCalled();
      expect(res.statusCode).toBe(401);
    });

    it('rejects a tampered cookie (extended expiry, same HMAC)', () => {
      const raw = decodeURIComponent(
        cookieHeaderFrom(buildSessionCookie(USER, PASS)).split('=')[1],
      );
      const [user, expiry, hmac] = raw.split(':');
      const forged = `${user}:${Number(expiry) + 1000}:${hmac}`;
      const { res } = run(
        makeReq('/__profiler/api/erd', {
          cookie: `__profiler_session=${encodeURIComponent(forged)}`,
        }),
      );
      expect(res.statusCode).toBe(401);
    });

    it('rejects a cookie signed with a different password', () => {
      const cookie = cookieHeaderFrom(buildSessionCookie(USER, 'wrong'));
      const { res } = run(makeReq('/__profiler/api/erd', { cookie }));
      expect(res.statusCode).toBe(401);
    });

    it('rejects the client-side localStorage token used as a cookie value', () => {
      const expiresAt = Date.now() + 60_000;
      const token = createHmac('sha256', PASS)
        .update(`${USER}:${expiresAt}`)
        .digest('hex');
      const { res } = run(
        makeReq('/__profiler/api/erd', {
          cookie: `__profiler_session=${token}`,
        }),
      );
      expect(res.statusCode).toBe(401);
    });

    it('rejects a malformed cookie without throwing', () => {
      const { res } = run(
        makeReq('/__profiler/api/erd', {
          cookie: '__profiler_session=%E0%A4%A',
        }),
      );
      expect(res.statusCode).toBe(401);
    });
  });
});

describe('session cookie helpers', () => {
  it('builds an HttpOnly, SameSite=Strict cookie on Path=/ so gateway prefixes still receive it', () => {
    const c = buildSessionCookie(USER, PASS);
    expect(c).toMatch(/^__profiler_session=/);
    expect(c).toContain('HttpOnly');
    expect(c).toContain('SameSite=Strict');
    expect(c).toContain('Path=/;');
    expect(c).toContain('Max-Age=86400');
    expect(c).not.toContain('Secure');
    expect(buildSessionCookie(USER, PASS, { secure: true })).toContain(
      '; Secure',
    );
  });

  it('clears the cookie on the same path', () => {
    expect(clearSessionCookie()).toBe(
      '__profiler_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0',
    );
  });

  it('verifies usernames containing ":"', () => {
    const cookie = cookieHeaderFrom(buildSessionCookie('a:b', PASS));
    expect(verifySessionCookie(cookie, 'a:b', PASS)).toBe(true);
    expect(verifySessionCookie(cookie, 'a', PASS)).toBe(false);
  });

  it('extracts the sub-path below __profiler', () => {
    expect(profilerSubPath('/__profiler')).toBe('');
    expect(profilerSubPath('/gw/__profiler/view/x?a=1')).toBe('/view/x');
    expect(profilerSubPath('/__profiler-other/x')).toBeNull();
    expect(relativeLoginUrl('/a/b/c')).toBe('../../login');
  });
});
