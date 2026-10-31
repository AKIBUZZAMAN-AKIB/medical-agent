import { HttpClient, buildUrl } from '../http.js';
import { UpstreamError } from '../errors.js';
import { loadEnv } from '../env.js';

const env = loadEnv({});

const upstream = { service: 'test', minIntervalMs: 0, cacheTtlMs: 0 };

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(typeof body === 'string' ? body : JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
    ...init,
  });
}

function clientWith(fetchImpl: typeof fetch, overrides: Record<string, string> = {}) {
  return new HttpClient({
    env: loadEnv(overrides),
    fetchImpl,
    sleep: async () => undefined,
  });
}

describe('buildUrl', () => {
  it('encodes parameters and drops the ones that carry no value', () => {
    const url = buildUrl('https://example.org/api', {
      term: 'type 2 diabetes & CKD',
      limit: 5,
      flag: true,
      empty: '',
      blank: '   ',
      missing: undefined,
    });
    expect(url).toBe('https://example.org/api?term=type+2+diabetes+%26+CKD&limit=5&flag=true');
  });

  it('returns the base URL unchanged when there is nothing to add', () => {
    expect(buildUrl('https://example.org/api', undefined)).toBe('https://example.org/api');
    expect(buildUrl('https://example.org/api', { a: undefined })).toBe('https://example.org/api');
  });
});

describe('HttpClient', () => {
  it('sends a descriptive user agent, which several public APIs require', async () => {
    const fetchImpl = jest.fn(async (_url: string, init?: RequestInit) => {
      expect(new Headers(init?.headers).get('user-agent')).toBe(env.userAgent);
      return jsonResponse({ ok: true });
    });
    const client = clientWith(fetchImpl as unknown as typeof fetch);
    await expect(client.getJson('https://example.org', upstream)).resolves.toEqual({ ok: true });
  });

  it('caches a successful response and does not re-request it', async () => {
    const fetchImpl = jest.fn(async () => jsonResponse({ value: 1 }));
    const client = clientWith(fetchImpl as unknown as typeof fetch, {
      MEDICAL_CACHE_TTL_MS: '60000',
    });
    const cached = { service: 'test', minIntervalMs: 0, cacheTtlMs: 60_000 };
    await client.getJson('https://example.org/a', cached);
    await client.getJson('https://example.org/a', cached);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('does not cache when the upstream declares a zero lifetime', async () => {
    const fetchImpl = jest.fn(async () => jsonResponse({ value: 1 }));
    const client = clientWith(fetchImpl as unknown as typeof fetch, {
      MEDICAL_CACHE_TTL_MS: '60000',
    });
    await client.getJson('https://example.org/b', upstream);
    await client.getJson('https://example.org/b', upstream);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('retries a 429 and reports the retry window when it never recovers', async () => {
    const fetchImpl = jest.fn(
      async () => new Response('slow down', { status: 429, headers: { 'retry-after': '1' } }),
    );
    const client = clientWith(fetchImpl as unknown as typeof fetch, { MEDICAL_MAX_ATTEMPTS: '2' });
    await expect(client.getJson('https://example.org', upstream)).rejects.toMatchObject({
      name: 'UpstreamError',
      status: 429,
      retryAfterMs: 1_000,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('retries a 503 and succeeds on the next attempt', async () => {
    const fetchImpl = jest
      .fn<Promise<Response>, [string, RequestInit?]>()
      .mockResolvedValueOnce(new Response('nope', { status: 503 }))
      .mockResolvedValueOnce(jsonResponse({ recovered: true }));
    const client = clientWith(fetchImpl as unknown as typeof fetch, { MEDICAL_MAX_ATTEMPTS: '3' });
    await expect(client.getJson('https://example.org', upstream)).resolves.toEqual({
      recovered: true,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('waits out a 503 rather than spending its retries inside the throttle', async () => {
    const delays: number[] = [];
    /** A fresh Response per call: a consumed body would fail the read instead. */
    const fetchImpl = jest.fn(async () => new Response('temporarily unavailable', { status: 503 }));
    const client = new HttpClient({
      env: loadEnv({ MEDICAL_MAX_ATTEMPTS: '3' }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep: async (ms) => {
        delays.push(ms);
      },
    });
    await expect(client.getJson('https://example.org', upstream)).rejects.toBeInstanceOf(
      UpstreamError,
    );
    /** The per-host rate limiter also waits, so keep only the retry backoffs. */
    expect(delays.filter((delay) => delay >= 3_000)).toEqual([3_000, 9_000]);
  });

  it('lets an upstream ask for more attempts than the default', async () => {
    const fetchImpl = jest.fn(async () => new Response('temporarily unavailable', { status: 503 }));
    const client = clientWith(fetchImpl as unknown as typeof fetch, {
      MEDICAL_MAX_ATTEMPTS: '2',
      MEDICAL_REQUEST_BUDGET_MS: '180000',
    });
    await expect(
      client.getJson('https://example.org', { ...upstream, maxAttempts: 4 }),
    ).rejects.toBeInstanceOf(UpstreamError);
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('reports the effective upstream maxAttempts on transport failures', async () => {
    const fetchImpl = jest.fn(async () => {
      throw new TypeError('socket hang up');
    });
    const client = clientWith(fetchImpl as unknown as typeof fetch, {
      MEDICAL_MAX_ATTEMPTS: '2',
      MEDICAL_REQUEST_BUDGET_MS: '180000',
    });
    await expect(
      client.getJson('https://example.org', { ...upstream, maxAttempts: 4 }),
    ).rejects.toMatchObject({
      name: 'UpstreamError',
      message: 'could not be reached (socket hang up) after 4 attempts',
      unavailable: true,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(4);
  });

  it('does not retry a client error', async () => {
    const fetchImpl = jest.fn(async () => new Response('bad query', { status: 400 }));
    const client = clientWith(fetchImpl as unknown as typeof fetch, { MEDICAL_MAX_ATTEMPTS: '3' });
    await expect(client.getJson('https://example.org', upstream)).rejects.toBeInstanceOf(
      UpstreamError,
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('surfaces an unparseable body as an error rather than crashing the tool', async () => {
    const fetchImpl = jest.fn(async () => jsonResponse('<html>maintenance</html>'));
    const client = clientWith(fetchImpl as unknown as typeof fetch);
    await expect(client.getJson('https://example.org', upstream)).rejects.toMatchObject({
      name: 'UpstreamError',
    });
  });

  it('refuses a body larger than the byte budget', async () => {
    const fetchImpl = jest.fn(
      async () => new Response('x', { status: 200, headers: { 'content-length': '9999999' } }),
    );
    const client = clientWith(fetchImpl as unknown as typeof fetch);
    await expect(
      client.getJson('https://example.org', upstream, { maxBytes: 1_000 }),
    ).rejects.toMatchObject({ name: 'UpstreamError' });
  });
});
