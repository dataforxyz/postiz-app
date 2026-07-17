import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import { WebhookTransport } from './webhook.transport';

function response(status: number, chunks: Array<Buffer | string> = []) {
  const incoming = Readable.from(chunks) as any;
  incoming.statusCode = status;
  incoming.headers = {};
  return incoming;
}

function requestFixture(status: number, chunks: Array<Buffer | string> = []) {
  const calls: any[] = [];
  const request = jest.fn((options: any, callback: (res: any) => void) => {
    calls.push(options);
    const req = new EventEmitter() as any;
    req.destroy = jest.fn();
    req.end = jest.fn(() => {
      req.emit('socket', { connecting: false });
      callback(response(status, chunks));
    });
    return req;
  });
  return { request: request as any, calls };
}

describe('WebhookTransport', () => {
  it('pins one DNS resolution with validated dual-stack fallback and correct authority', async () => {
    const resolver = jest
      .fn()
      .mockResolvedValueOnce([
        { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
        { address: '93.184.216.34', family: 4 },
      ])
      .mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }]);
    const fixture = requestFixture(204);
    const transport = new WebhookTransport({
      resolver,
      request: fixture.request,
    });

    await expect(
      transport.sendJson('https://hooks.example.com/events?tenant=secret', {
        state: 'PUBLISHED',
      })
    ).resolves.toEqual({
      ok: true,
      destination: 'https://hooks.example.com',
      status: 204,
    });

    expect(resolver).toHaveBeenCalledTimes(1);
    expect(fixture.calls[0]).toMatchObject({
      hostname: 'hooks.example.com',
      servername: 'hooks.example.com',
      path: '/events?tenant=secret',
      autoSelectFamily: true,
      agent: false,
      rejectUnauthorized: true,
      headers: {
        Host: 'hooks.example.com',
        'Content-Type': 'application/json',
      },
    });
    await expect(
      new Promise((resolve, reject) => {
        fixture.calls[0].lookup(
          'hooks.example.com',
          { all: true },
          (error: Error | null, addresses: unknown) =>
            error ? reject(error) : resolve(addresses)
        );
      })
    ).resolves.toEqual([
      { address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
      { address: '93.184.216.34', family: 4 },
    ]);
  });

  it('rejects a private DNS answer even when the provider opt-out is set', async () => {
    const previousOptOut = process.env.DISABLE_SSRF_PROTECTION;
    process.env.DISABLE_SSRF_PROTECTION = 'true';
    const fixture = requestFixture(204);
    const transport = new WebhookTransport({
      resolver: async () => [{ address: '169.254.169.254', family: 4 }],
      request: fixture.request,
    });

    try {
      await expect(
        transport.sendJson('https://hooks.example.com/events', {})
      ).resolves.toMatchObject({
        ok: false,
        destination: 'https://hooks.example.com',
        error: 'blocked_destination',
      });
      expect(fixture.request).not.toHaveBeenCalled();
    } finally {
      if (previousOptOut === undefined) {
        delete process.env.DISABLE_SSRF_PROTECTION;
      } else {
        process.env.DISABLE_SSRF_PROTECTION = previousOptOut;
      }
    }
  });

  it.each([
    'https://127.1/hook',
    'https://0x7f000001/hook',
    'https://[::ffff:7f00:1]/hook',
    'https://[fc00::1]/hook',
  ])('rejects literal alternate special address %s', async (url) => {
    const fixture = requestFixture(204);
    const transport = new WebhookTransport({ request: fixture.request });

    await expect(transport.sendJson(url, {})).resolves.toMatchObject({
      ok: false,
      error: 'invalid_url',
    });
    expect(fixture.request).not.toHaveBeenCalled();
  });

  it('does not follow redirects, including redirects toward private hosts', async () => {
    const fixture = requestFixture(302);
    const originalRequest = fixture.request;
    fixture.request = jest.fn((options: any, callback: (res: any) => void) => {
      return originalRequest(options, (incoming: any) => {
        incoming.headers.location = 'https://127.0.0.1/private';
        callback(incoming);
      });
    }) as any;
    const transport = new WebhookTransport({
      resolver: async () => [{ address: '93.184.216.34', family: 4 }],
      request: fixture.request,
    });

    await expect(
      transport.sendJson('https://hooks.example.com/events', {})
    ).resolves.toEqual({
      ok: false,
      destination: 'https://hooks.example.com',
      status: 302,
      error: 'redirect_not_allowed',
    });
    expect(fixture.request).toHaveBeenCalledTimes(1);
  });

  it('reports non-success HTTP status truthfully without returning a body', async () => {
    const fixture = requestFixture(503, ['sensitive response body']);
    const transport = new WebhookTransport({
      resolver: async () => [{ address: '93.184.216.34', family: 4 }],
      request: fixture.request,
    });

    await expect(
      transport.sendJson('https://hooks.example.com/private?token=secret', {})
    ).resolves.toEqual({
      ok: false,
      destination: 'https://hooks.example.com',
      status: 503,
      error: 'http_error',
    });
  });

  it('enforces request and response body caps', async () => {
    const requestFixtureValue = requestFixture(200);
    const requestLimited = new WebhookTransport({
      maxRequestBytes: 4,
      resolver: async () => [{ address: '93.184.216.34', family: 4 }],
      request: requestFixtureValue.request,
    });
    await expect(
      requestLimited.sendJson('https://hooks.example.com/', { long: true })
    ).resolves.toMatchObject({ ok: false, error: 'payload_too_large' });
    expect(requestFixtureValue.request).not.toHaveBeenCalled();

    const responseFixture = requestFixture(200, [Buffer.alloc(6)]);
    const responseLimited = new WebhookTransport({
      maxResponseBytes: 5,
      resolver: async () => [{ address: '93.184.216.34', family: 4 }],
      request: responseFixture.request,
    });
    await expect(
      responseLimited.sendJson('https://hooks.example.com/', {})
    ).resolves.toMatchObject({ ok: false, error: 'response_too_large' });
  });

  it('bounds DNS resolution time', async () => {
    const fixture = requestFixture(200);
    const transport = new WebhookTransport({
      dnsTimeoutMs: 5,
      resolver: () => new Promise(() => undefined),
      request: fixture.request,
    });

    await expect(
      transport.sendJson('https://hooks.example.com/', {})
    ).resolves.toMatchObject({ ok: false, error: 'timeout' });
    expect(fixture.request).not.toHaveBeenCalled();
  });

  it('bounds connect and read inactivity time', async () => {
    const connectingRequest = jest.fn(() => {
      const req = new EventEmitter() as any;
      req.destroy = jest.fn();
      req.end = jest.fn(() => {
        req.emit('socket', {
          connecting: true,
          once: jest.fn(),
        });
      });
      return req;
    });
    const connectLimited = new WebhookTransport({
      connectTimeoutMs: 5,
      totalTimeoutMs: 50,
      resolver: async () => [{ address: '93.184.216.34', family: 4 }],
      request: connectingRequest as any,
    });
    await expect(
      connectLimited.sendJson('https://hooks.example.com/', {})
    ).resolves.toMatchObject({ ok: false, error: 'timeout' });

    const stalledResponseRequest = jest.fn(
      (_options: any, callback: (res: any) => void) => {
        const req = new EventEmitter() as any;
        req.destroy = jest.fn();
        req.end = jest.fn(() => {
          req.emit('socket', { connecting: false });
          const incoming = new Readable({ read() {} }) as any;
          incoming.statusCode = 200;
          incoming.headers = {};
          callback(incoming);
        });
        return req;
      }
    );
    const readLimited = new WebhookTransport({
      readTimeoutMs: 5,
      totalTimeoutMs: 50,
      resolver: async () => [{ address: '93.184.216.34', family: 4 }],
      request: stalledResponseRequest as any,
    });
    await expect(
      readLimited.sendJson('https://hooks.example.com/', {})
    ).resolves.toMatchObject({ ok: false, error: 'timeout', status: 200 });
  });
});
