import { HttpCollector } from '../../../../libs/nestjs-profiler/src/collectors/http-collector';

describe('HttpCollector fetch support', () => {
  const originalFetch = globalThis.fetch;
  let addHttpCall: jest.Mock;
  let collector: HttpCollector;

  beforeEach(() => {
    addHttpCall = jest.fn();
    collector = new HttpCollector(
      { getCurrentProfile: () => ({}), addHttpCall } as any,
      { collectHttp: true },
    );
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('captures native fetch responses used by @nestjs/http-client', async () => {
    globalThis.fetch = jest.fn().mockResolvedValue(
      new Response('{"ok":true}', {
        status: 201,
        headers: { 'content-type': 'application/json' },
      }),
    );
    (collector as any).patchFetch();

    const response = await fetch('https://api.example.com/users?page=2', {
      method: 'POST',
      headers: { authorization: 'secret', 'x-client': 'nestjs' },
    });

    expect(response.status).toBe(201);
    expect(addHttpCall).toHaveBeenCalledWith(
      expect.objectContaining({
        method: 'POST',
        url: 'https://api.example.com/users?page=2',
        host: 'api.example.com',
        path: '/users?page=2',
        protocol: 'https',
        statusCode: 201,
        requestHeaders: {
          authorization: '[redacted]',
          'x-client': 'nestjs',
        },
        responseHeaders: { 'content-type': 'application/json' },
      }),
    );
  });

  it('captures fetch failures and preserves the rejection', async () => {
    globalThis.fetch = jest
      .fn()
      .mockRejectedValue(new Error('connection failed'));
    (collector as any).patchFetch();

    await expect(fetch('http://api.example.com/users')).rejects.toThrow(
      'connection failed',
    );
    expect(addHttpCall).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'http://api.example.com/users',
        error: 'connection failed',
      }),
    );
  });
});
