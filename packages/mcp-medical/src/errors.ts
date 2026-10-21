/**
 * A failed upstream call, carrying enough context for the model to act on the
 * failure (retry later, narrow the query, or report that the source is down)
 * without the model ever seeing a stack trace.
 */
export class UpstreamError extends Error {
  readonly service: string;
  readonly status?: number;
  readonly retryAfterMs?: number;
  /** Short, already-bounded excerpt of the response body, for diagnosis. */
  readonly detail?: string;

  constructor(
    service: string,
    message: string,
    options: { status?: number; retryAfterMs?: number; detail?: string } = {},
  ) {
    super(message);
    this.name = 'UpstreamError';
    this.service = service;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
    this.detail = options.detail;
  }
}

/** The upstream answered correctly with zero matches; never surfaced as an error. */
export class EmptyResultError extends Error {
  readonly service: string;

  constructor(service: string, message: string) {
    super(message);
    this.name = 'EmptyResultError';
    this.service = service;
  }
}

const DETAIL_LIMIT = 240;

export function boundDetail(body: string | undefined): string | undefined {
  if (body == null) {
    return undefined;
  }
  const collapsed = body.replace(/\s+/g, ' ').trim();
  if (collapsed.length === 0) {
    return undefined;
  }
  return collapsed.length > DETAIL_LIMIT ? `${collapsed.slice(0, DETAIL_LIMIT)}…` : collapsed;
}

/** A message safe to hand back to the model as tool output. */
export function describeError(error: unknown): string {
  if (error instanceof EmptyResultError) {
    return error.message;
  }
  if (error instanceof UpstreamError) {
    const parts = [`${error.service} lookup failed: ${error.message}`];
    if (error.status != null) {
      parts.push(`(HTTP ${error.status})`);
    }
    if (error.retryAfterMs != null) {
      parts.push(`retry in about ${Math.ceil(error.retryAfterMs / 1000)}s`);
    }
    if (error.detail != null) {
      parts.push(`upstream said: ${error.detail}`);
    }
    return parts.join(' ');
  }
  if (error instanceof Error) {
    return `Request failed before a response was received: ${error.message}`;
  }
  return 'Request failed for an unknown reason.';
}
