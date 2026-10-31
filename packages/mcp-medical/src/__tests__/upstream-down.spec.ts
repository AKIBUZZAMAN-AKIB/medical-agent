import {
  withDeadline,
  SERVER_INSTRUCTIONS,
  CITATION_MARKER_PARAGRAPH,
  UNAVAILABLE_PARAGRAPH,
} from '../server.js';
import { UpstreamError, describeError } from '../errors.js';
import { HostCircuitBreaker } from '../circuit.js';
import { HttpClient } from '../http.js';
import { loadEnv } from '../env.js';

const openFda = { service: 'openFDA drug labels', minIntervalMs: 0, cacheTtlMs: 0 };
const dailyMed = { service: 'DailyMed', minIntervalMs: 0, cacheTtlMs: 0 };

function timeoutError(): Error {
  const error = new Error('The operation was aborted due to timeout');
  error.name = 'TimeoutError';
  return error;
}

function clientWith(
  fetchImpl: typeof fetch,
  options: { overrides?: Record<string, string>; now?: () => number } = {},
) {
  return new HttpClient({
    env: loadEnv(options.overrides ?? {}),
    fetchImpl,
    sleep: async () => undefined,
    now: options.now,
  });
}

describe('a source that is down fails fast', () => {
  it('does not retry a timeout and reports the source as unavailable', async () => {
    const fetchImpl = jest.fn(async () => {
      throw timeoutError();
    });
    const client = clientWith(fetchImpl as unknown as typeof fetch);

    const error = await client
      .getJson('https://api.fda.gov/drug/label.json?search=omeprazole', openFda)
      .catch((e: unknown) => e);

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(error).toBeInstanceOf(UpstreamError);
    expect(error).toMatchObject({ unavailable: true, message: 'timed out after 10s' });
    const text = describeError(error);
    expect(text).toContain('openFDA drug labels is down or not answering right now');
    expect(text).toContain('Do not call this tool again');
    expect(text).toContain('never quote it');
    expect(text).not.toMatch(/[A-Z]{4,} [A-Z]{4,}/);
    expect(text).toContain('bd_medicine_lookup');
  });

  it('skips a host that just timed out without calling it again', async () => {
    const fetchImpl = jest.fn(async () => {
      throw timeoutError();
    });
    const client = clientWith(fetchImpl as unknown as typeof fetch);

    await expect(
      client.getJson('https://api.fda.gov/drug/label.json?search=omeprazole', openFda),
    ).rejects.toBeInstanceOf(UpstreamError);
    const started = Date.now();
    const second = await client
      .getJson('https://api.fda.gov/drug/event.json?search=omeprazole', openFda)
      .catch((e: unknown) => e);

    expect(Date.now() - started).toBeLessThan(100);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(second).toMatchObject({ unavailable: true });
    expect((second as Error).message).toContain('skipped without waiting');
    expect((second as Error).message).toContain('timed out after 10s');
  });

  it('keeps other hosts reachable while one is down', async () => {
    const fetchImpl = jest.fn(async (url: string) => {
      if (url.includes('api.fda.gov')) {
        throw new TypeError('fetch failed');
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    const client = clientWith(fetchImpl as unknown as typeof fetch);

    await expect(client.getJson('https://api.fda.gov/x', openFda)).rejects.toMatchObject({
      unavailable: true,
    });
    await expect(
      client.getJson('https://dailymed.nlm.nih.gov/dailymed/services/v2/spls.json', dailyMed),
    ).resolves.toEqual({ ok: true });
  });

  it('tries the host again once the cooldown has passed', async () => {
    let now = 1_000_000;
    let down = true;
    const fetchImpl = jest.fn(async () => {
      if (down) {
        throw timeoutError();
      }
      return new Response(JSON.stringify({ back: true }), { status: 200 });
    });
    const client = clientWith(fetchImpl as unknown as typeof fetch, {
      overrides: { MEDICAL_CIRCUIT_OPEN_MS: '60000' },
      now: () => now,
    });

    await expect(client.getJson('https://api.fda.gov/a', openFda)).rejects.toBeInstanceOf(
      UpstreamError,
    );
    now += 30_000;
    await expect(client.getJson('https://api.fda.gov/b', openFda)).rejects.toMatchObject({
      unavailable: true,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);

    down = false;
    now += 31_000;
    await expect(client.getJson('https://api.fda.gov/c', openFda)).resolves.toEqual({
      back: true,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it('does not sleep through a retry-after that does not fit the request budget', async () => {
    const sleep = jest.fn(async () => undefined);
    const fetchImpl = jest.fn(
      async () => new Response('busy', { status: 503, headers: { 'retry-after': '30' } }),
    );
    const client = new HttpClient({
      env: loadEnv({ MEDICAL_REQUEST_BUDGET_MS: '20000' }),
      fetchImpl: fetchImpl as unknown as typeof fetch,
      sleep,
    });

    const error = await client
      .getJson('https://pubchem.ncbi.nlm.nih.gov/x', openFda)
      .catch((e: unknown) => e);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
    expect(error).toMatchObject({ status: 503, unavailable: true });
  });

  it('marks a host down after repeated server errors', () => {
    const breaker = new HostCircuitBreaker({ openMs: 60_000, now: () => 0 });
    breaker.recordServerError('api.fda.gov', 'answered HTTP 500');
    expect(breaker.check('api.fda.gov')).toBeUndefined();
    breaker.recordServerError('api.fda.gov', 'answered HTTP 500');
    expect(breaker.check('api.fda.gov')).toMatchObject({ reason: 'answered HTTP 500' });
    breaker.recordSuccess('api.fda.gov');
    expect(breaker.check('api.fda.gov')).toBeUndefined();
  });

  it('does not treat a client error as the source being down', async () => {
    const fetchImpl = jest.fn(async () => new Response('bad query', { status: 400 }));
    const client = clientWith(fetchImpl as unknown as typeof fetch);
    await expect(client.getJson('https://api.fda.gov/x', openFda)).rejects.toMatchObject({
      unavailable: false,
    });
    await expect(client.getJson('https://api.fda.gov/y', openFda)).rejects.toMatchObject({
      unavailable: false,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });
});

describe('withDeadline', () => {
  it('turns a tool that runs too long into a clear unavailable result', async () => {
    jest.useFakeTimers();
    try {
      const never = new Promise<string>(() => undefined);
      const pending = withDeadline(never, 40_000, 'drug_label').catch((e: unknown) => e);
      jest.advanceTimersByTime(40_000);
      const error = await pending;
      expect(error).toBeInstanceOf(UpstreamError);
      expect(describeError(error)).toContain('drug_label lookup failed: did not finish within 40s');
      expect(describeError(error)).toContain('drug_label is down or not answering right now');
    } finally {
      jest.useRealTimers();
    }
  });

  it('passes a result through when the tool finishes in time', async () => {
    await expect(withDeadline(Promise.resolve('ok'), 40_000, 'drug_label')).resolves.toBe('ok');
  });

  it('stays below the MCP request timeout by default', () => {
    expect(loadEnv({}).toolDeadlineMs).toBeLessThan(60_000);
  });
});

describe('server instructions', () => {
  it('limits citation markers to web search and tells the model how to cite other tools', () => {
    expect(SERVER_INSTRUCTIONS).toContain(CITATION_MARKER_PARAGRAPH);
    expect(CITATION_MARKER_PARAGRAPH).toContain('exist only for web_search results');
    expect(CITATION_MARKER_PARAGRAPH).toContain('[D0051]');
    expect(SERVER_INSTRUCTIONS).not.toMatch(/turn\d+[a-z_]+\d+/);
  });

  it('tells the model to move on when a source is unavailable', () => {
    expect(SERVER_INSTRUCTIONS).toContain(UNAVAILABLE_PARAGRAPH);
    expect(UNAVAILABLE_PARAGRAPH).toContain('bd_medicine_lookup');
  });
});
