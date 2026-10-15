import * as fs from 'fs';
import * as path from 'path';
import * as vm from 'vm';

/**
 * Runs the returnTo validator inlined in views/login.html in a sandbox with a
 * fake `location`, so the exact shipped code is under test.
 */
const loginHtml = fs.readFileSync(
  path.join(__dirname, '../../../../libs/nestjs-profiler/src/views/login.html'),
  'utf-8',
);
const validatorSrc =
  /<script>\s*(window\.__profilerSafeReturnTo[\s\S]*?)<\/script>/.exec(
    loginHtml,
  )![1];

const safeReturnTo = (
  raw: string | null,
  loginUrl = 'https://app.test/__profiler/login',
) => {
  const loc = new URL(loginUrl);
  const sandbox: any = { window: {}, location: loc, URL };
  vm.runInNewContext(validatorSrc, sandbox);
  return sandbox.window.__profilerSafeReturnTo(raw) as string;
};

describe('login.html returnTo validation', () => {
  it.each([
    ['/__profiler/view/summary', '/__profiler/view/summary'],
    ['/__profiler/view/logs?page=2#top', '/__profiler/view/logs?page=2#top'],
    ['/__profiler', '/__profiler'],
  ])('accepts same-origin dashboard path %s', (raw, expected) => {
    expect(safeReturnTo(raw)).toBe(expected);
  });

  it.each([
    null,
    '',
    'https://evil.example/__profiler',
    '//evil.example/__profiler',
    '/\\evil.example/__profiler',
    '\\\\evil.example/__profiler',
    'javascript:alert(1)//__profiler',
    'JaVaScRiPt:alert(document.cookie)',
    'data:text/html,<script>alert(1)</script>',
    '/some/other/page',
    '/__profiler-evil/x',
    '/__profiler/../evil',
    '/__profiler/view\t/x',
    '__profiler/view/summary',
  ])('falls back to the dashboard root for %p', (raw) => {
    expect(safeReturnTo(raw as any)).toBe('/__profiler');
  });

  it('re-bases returnTo onto the gateway prefix the login page is served under', () => {
    const login = 'https://app.test/api/gw/__profiler/login';
    expect(safeReturnTo('/api/gw/__profiler/view/erd', login)).toBe(
      '/api/gw/__profiler/view/erd',
    );
    // Server behind a prefix-stripping gateway only knows the unprefixed path
    expect(safeReturnTo('/__profiler/view/erd', login)).toBe(
      '/api/gw/__profiler/view/erd',
    );
    expect(safeReturnTo('https://evil.example/', login)).toBe(
      '/api/gw/__profiler',
    );
  });

  it('never produces a protocol-relative URL from a "//host" page path', () => {
    const out = safeReturnTo(
      '/__profiler/view/summary',
      'https://app.test//evil.example/__profiler/login',
    );
    expect(out.startsWith('//')).toBe(false);
    expect(out).toBe('/evil.example/__profiler/view/summary');
  });
});
