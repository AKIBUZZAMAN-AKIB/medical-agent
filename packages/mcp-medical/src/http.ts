import type { ServerEnv } from './env.js';
import { boundDetail, UpstreamError } from './errors.js';
import { HostCircuitBreaker } from './circuit.js';
import { HostRateLimiter } from './ratelimit.js';
import { TtlCache } from './cache.js';

/** How a caller wants one upstream treated: who it is, and how gently to hit it. */
export interface Upstream {
  /** Human-readable service name, e.g. `openFDA drug labels`. */
  service: string;
  /** Minimum milliseconds between two requests to the same host. */
  minIntervalMs: number;
  /**
   * How long a successful response stays cacheable; 0 disables caching. A tool
   * can override this per call through `Upstream.ttlMs`.
   */
  cacheTtlMs?: number;
  /**
   * Some upstreams answer an empty result with 404 (openFDA does). Those are
   * reported to the caller as an empty result rather than a failure.
   */
  emptyOnNotFound?: boolean;
  /** Overrides `cacheTtlMs` for a single call. */
  ttlMs?: number;
  /**
   * Overrides the attempt count for this call. PubChem answers 503 with "retry
   * in about 30s" often enough that a second try after the backoff is the
   * difference between an answer and an error.
   */
  maxAttempts?: number;
}

export interface RequestOptions {
  /** Extra query parameters; undefined and empty-string values are dropped. */
  query?: Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string>;
  /** Cap on the response body we are willing to buffer. */
  maxBytes?: number;
  timeoutMs?: number;
}

export interface HttpClientOptions {
  env: ServerEnv;
  cache?: TtlCache;
  limiter?: HostRateLimiter;
  breaker?: HostCircuitBreaker;
  fetchImpl?: typeof fetch;
  /** Injected for tests so retry backoff does not sleep for real. */
  sleep?: (ms: number) => Promise<void>;
  /** Injected for tests so the request budget can be checked without waiting. */
  now?: () => number;
}

const RETRYABLE_STATUS = new Set([408, 425, 429, 500, 502, 503, 504]);
const MAX_BUFFERED_BYTES = 12 * 1024 * 1024;
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024;

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

export type QueryParams = Record<string, string | number | boolean | undefined>;

/**
 * Appends parameters to a base URL. Values are encoded, and a parameter whose
 * value is `undefined` or an empty/whitespace-only string is dropped so callers
 * can pass optional filters inline.
 */
export function buildUrl(base: string, query?: QueryParams): string {
  if (query == null) {
    return base;
  }
  const url = new URL(base);
  for (const [key, value] of Object.entries(query)) {
    if (value == null) {
      continue;
    }
    if (typeof value === 'string' && value.trim() === '') {
      continue;
    }
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function parseRetryAfter(header: string | null): number | undefined {
  if (header == null) {
    return undefined;
  }
  const seconds = Number.parseInt(header, 10);
  if (Number.isFinite(seconds)) {
    return Math.min(Math.max(seconds, 0) * 1000, 60_000);
  }
  const date = Date.parse(header);
  if (Number.isFinite(date)) {
    return Math.min(Math.max(date - Date.now(), 0), 60_000);
  }
  return undefined;
}

export class HttpClient {
  private readonly env: ServerEnv;
  private readonly cache: TtlCache;
  private readonly limiter: HostRateLimiter;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  readonly breaker: HostCircuitBreaker;

  constructor({ env, cache, limiter, breaker, fetchImpl, sleep, now }: HttpClientOptions) {
    this.env = env;
    this.cache = cache ?? new TtlCache({ maxEntries: env.cacheMaxEntries });
    this.limiter = limiter ?? new HostRateLimiter();
    this.now = now ?? Date.now;
    this.breaker =
      breaker ?? new HostCircuitBreaker({ openMs: env.circuitOpenMs ?? 0, now: this.now });
    this.fetchImpl = fetchImpl ?? globalThis.fetch;
    this.sleep = sleep ?? defaultSleep;
    if (typeof this.fetchImpl !== 'function') {
      throw new Error('global fetch is unavailable; Node 18 or newer is required');
    }
  }

  async getJson<T>(base: string, upstream: Upstream, options: RequestOptions = {}): Promise<T> {
    const url = buildUrl(base, options.query);
    const body = await this.get(url, upstream, options, 'application/json');
    if (body.trim() === '') {
      return {} as T;
    }
    try {
      return JSON.parse(body) as T;
    } catch {
      throw new UpstreamError(upstream.service, 'returned a body that is not valid JSON', {
        detail: boundDetail(body),
      });
    }
  }

  async getText(
    base: string,
    upstream: Upstream,
    options: RequestOptions = {},
    accept = 'text/plain, application/xml;q=0.9, */*;q=0.8',
  ): Promise<string> {
    return this.get(buildUrl(base, options.query), upstream, options, accept);
  }

  async postJson<T>(
    url: string,
    upstream: Upstream,
    payload: unknown,
    options: RequestOptions = {},
  ): Promise<T> {
    const body = await this.send(url, upstream, {
      ...options,
      init: {
        method: 'POST',
        headers: { 'content-type': 'application/json', accept: 'application/json' },
        body: JSON.stringify(payload),
      },
    });
    try {
      return JSON.parse(body) as T;
    } catch {
      throw new UpstreamError(upstream.service, 'returned a body that is not valid JSON', {
        detail: boundDetail(body),
      });
    }
  }

  private async get(
    url: string,
    upstream: Upstream,
    options: RequestOptions,
    accept: string,
  ): Promise<string> {
    const ttlMs = upstream.ttlMs ?? upstream.cacheTtlMs ?? this.env.cacheTtlMs;
    const cached = ttlMs > 0 ? this.cache.get(url) : undefined;
    if (cached != null) {
      return cached;
    }
    const body = await this.send(url, upstream, {
      ...options,
      init: { headers: { accept, ...options.headers }, method: 'GET' },
    });
    if (ttlMs > 0) {
      this.cache.set(url, body, ttlMs);
    }
    return body;
  }

  private async send(
    url: string,
    upstream: Upstream,
    options: RequestOptions & { init: RequestInit },
  ): Promise<string> {
    const host = safeHost(url);
    const maxBytes = Math.min(options.maxBytes ?? DEFAULT_MAX_BYTES, MAX_BUFFERED_BYTES);
    const maxAttempts = upstream.maxAttempts ?? this.env.maxAttempts;
    const timeoutMs = options.timeoutMs ?? this.env.requestTimeoutMs;
    const budgetMs = Math.max(this.env.requestBudgetMs ?? timeoutMs * maxAttempts, timeoutMs);
    const deadline = this.now() + budgetMs;

    const open = this.breaker.check(host);
    if (open != null) {
      throw new UpstreamError(
        upstream.service,
        `is unreachable right now (${open.reason ?? 'it failed moments ago'}); skipped without waiting`,
        { unavailable: true },
      );
    }

    let lastError: unknown;
    let attempts = 0;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      attempts = attempt;
      await this.limiter.acquire(host, upstream.minIntervalMs);
      const attemptTimeoutMs = Math.max(Math.min(timeoutMs, deadline - this.now()), 1_000);
      try {
        const response = await this.fetchImpl(url, {
          ...options.init,
          headers: {
            'user-agent': this.env.userAgent,
            ...(options.init.headers as Record<string, string> | undefined),
            ...options.headers,
          },
          signal: AbortSignal.timeout(attemptTimeoutMs),
          redirect: 'follow',
        });

        if (!response.ok) {
          const detail = await readBounded(response, maxBytes);
          const retryAfterMs = parseRetryAfter(response.headers.get('retry-after'));
          const serverDown = response.status >= 500;
          const error = new UpstreamError(upstream.service, httpMessage(response.status), {
            status: response.status,
            retryAfterMs,
            detail: boundDetail(detail),
            unavailable: serverDown,
          });
          if (response.status === 404 && upstream.emptyOnNotFound === true) {
            this.breaker.recordSuccess(host);
            throw error;
          }
          if (RETRYABLE_STATUS.has(response.status) && attempt < maxAttempts) {
            const waitMs = backoffMs(attempt, retryAfterMs, response.status);
            if (this.now() + waitMs + 1_000 < deadline) {
              lastError = error;
              await this.sleep(waitMs);
              continue;
            }
          }
          if (serverDown) {
            this.breaker.recordServerError(host, `answered HTTP ${response.status}`);
          } else {
            this.breaker.recordSuccess(host);
          }
          throw error;
        }

        const body = await readBounded(response, maxBytes);
        this.breaker.recordSuccess(host);
        return body;
      } catch (error) {
        if (error instanceof UpstreamError) {
          throw error;
        }
        lastError = error;
        /**
         * A timeout means the host is not answering. Retrying would wait out
         * the same timeout again while the user sees nothing, so stop here.
         */
        if (isTimeout(error)) {
          break;
        }
        if (attempt >= maxAttempts) {
          break;
        }
        const waitMs = backoffMs(attempt);
        if (this.now() + waitMs + 1_000 >= deadline) {
          break;
        }
        await this.sleep(waitMs);
      }
    }

    if (lastError instanceof UpstreamError) {
      throw lastError;
    }
    const reason = isTimeout(lastError)
      ? `timed out after ${Math.round(timeoutMs / 1000)}s`
      : `could not be reached (${transportMessage(lastError)})`;
    this.breaker.recordTransportFailure(host, reason);
    throw new UpstreamError(
      upstream.service,
      `${reason}${attempts > 1 ? ` after ${attempts} attempts` : ''}`,
      { unavailable: true },
    );
  }
}

function isTimeout(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  return (
    error.name === 'TimeoutError' ||
    error.name === 'AbortError' ||
    /timed? ?out|UND_ERR_(CONNECT|HEADERS|BODY)_TIMEOUT/i.test(
      `${error.message} ${(error as { cause?: { code?: string } }).cause?.code ?? ''}`,
    )
  );
}

function transportMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return 'unknown transport error';
  }
  const cause = (error as { cause?: { code?: string; message?: string } }).cause;
  const code = cause?.code ?? cause?.message;
  return code != null && code !== error.message ? `${error.message}: ${code}` : error.message;
}

function backoffMs(attempt: number, retryAfterMs?: number, status?: number): number {
  if (retryAfterMs != null && retryAfterMs > 0) {
    return Math.min(retryAfterMs, 30_000);
  }
  /**
   * A 503 means the host is shedding load rather than that the request is bad:
   * PubChem answers with "temporarily unavailable, retry in about 30s". A short
   * backoff just spends the retries inside the same throttle window.
   */
  if (status === 503) {
    return Math.min(3_000 * 3 ** (attempt - 1), 20_000);
  }
  return Math.min(250 * 2 ** (attempt - 1), 4_000);
}

function httpMessage(status: number): string {
  switch (status) {
    case 400:
      return 'rejected the query (400). Narrow or rephrase the search terms.';
    case 404:
      return 'has no record matching that query';
    case 429:
      return 'is rate limiting this client (429)';
    case 500:
    case 502:
    case 503:
    case 504:
      return 'is temporarily unavailable';
    default:
      return `responded with an unexpected status ${status}`;
  }
}

function safeHost(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

async function readBounded(response: Response, maxBytes: number): Promise<string> {
  const declared = Number.parseInt(response.headers.get('content-length') ?? '', 10);
  if (Number.isFinite(declared) && declared > maxBytes) {
    throw new UpstreamError('upstream', `response is larger than the ${maxBytes} byte budget`, {
      status: response.status,
    });
  }
  const text = await response.text();
  if (text.length > maxBytes) {
    throw new UpstreamError('upstream', `response exceeded the ${maxBytes} byte budget`);
  }
  return text;
}
