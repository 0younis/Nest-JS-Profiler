// `pg` is an optional peer dep that postgres-collector imports at top level;
// stub it so this suite runs without the driver installed.
jest.mock('pg', () => ({}), { virtual: true });

import { ProfilerController } from '../../../../libs/nestjs-profiler/src/controllers/profiler.controller';

describe('ProfilerController auth routes', () => {
  const auth = {
    enabled: true as const,
    username: 'admin',
    password: 'secret',
  };
  const viewService = { render: jest.fn().mockReturnValue('<LOGIN/>') } as any;
  const makeCtrl = (options: any) =>
    new ProfilerController(
      {} as any,
      viewService,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      options,
    );
  const makeRes = () => {
    const res: any = { headers: {} as Record<string, string> };
    res.setHeader = jest.fn((k: string, v: string) => {
      res.headers[k] = v;
      return res;
    });
    res.header = jest.fn((k: string, v: string) => {
      res.headers[k] = v;
      return res;
    });
    res.status = jest.fn((c: number) => {
      res.statusCode = c;
      return res;
    });
    res.json = jest.fn((b: any) => {
      res.body = b;
      return res;
    });
    res.send = jest.fn((b: any) => {
      res.body = b;
      return res;
    });
    return res;
  };

  it('api/login sets an HttpOnly session cookie on success', async () => {
    const res = makeRes();
    await makeCtrl({ auth }).apiLogin({ headers: {} } as any, res, {
      username: 'admin',
      password: 'secret',
    });
    expect(res.headers['Set-Cookie']).toMatch(
      /^__profiler_session=.+; HttpOnly; SameSite=Strict; Path=\//,
    );
    expect(res.headers['Set-Cookie']).not.toContain('Secure');
    expect(res.body.token).toBeDefined();
  });

  it('api/login marks the cookie Secure behind an HTTPS proxy', async () => {
    const res = makeRes();
    await makeCtrl({ auth }).apiLogin(
      { headers: { 'x-forwarded-proto': 'https' } } as any,
      res,
      { username: 'admin', password: 'secret' },
    );
    expect(res.headers['Set-Cookie']).toContain('; Secure');
  });

  it('api/login sets no cookie on bad credentials', async () => {
    const res = makeRes();
    await makeCtrl({ auth }).apiLogin({ headers: {} } as any, res, {
      username: 'admin',
      password: 'nope',
    });
    expect(res.statusCode).toBe(401);
    expect(res.setHeader).not.toHaveBeenCalled();
  });

  it('logout clears the session cookie', async () => {
    const res = makeRes();
    await makeCtrl({ auth }).logout({ headers: {} } as any, res);
    expect(res.headers['Set-Cookie']).toContain('Max-Age=0');
  });

  it('login page only lets the client auto-skip when the server session is valid', async () => {
    viewService.render.mockClear();
    await makeCtrl({ auth }).loginPage({ headers: {} } as any, makeRes());
    expect(viewService.render).toHaveBeenLastCalledWith(
      'login',
      expect.objectContaining({ sessionValid: 'false' }),
    );

    await makeCtrl({}).loginPage({ headers: {} } as any, makeRes());
    expect(viewService.render).toHaveBeenLastCalledWith(
      'login',
      expect.objectContaining({ sessionValid: 'true' }),
    );
  });
});
