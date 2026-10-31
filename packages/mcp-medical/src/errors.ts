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
  /**
   * The source is down or unreachable (timeout, refused connection, repeated
   * 5xx, or skipped by the circuit breaker). The model is told not to call it
   * again for this answer and to use another source.
   */
  readonly unavailable: boolean;

  constructor(
    service: string,
    message: string,
    options: {
      status?: number;
      retryAfterMs?: number;
      detail?: string;
      unavailable?: boolean;
    } = {},
  ) {
    super(message);
    this.name = 'UpstreamError';
    this.service = service;
    this.status = options.status;
    this.retryAfterMs = options.retryAfterMs;
    this.detail = options.detail;
    this.unavailable = options.unavailable === true;
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
    if (error.retryAfterMs != null && !error.unavailable) {
      parts.push(`retry in about ${Math.ceil(error.retryAfterMs / 1000)}s`);
    }
    if (error.detail != null) {
      parts.push(`upstream said: ${error.detail}`);
    }
    if (error.unavailable) {
      parts.push(unavailableAdvice(error.service));
    }
    return parts.join(' ');
  }
  if (error instanceof Error) {
    return `Request failed before a response was received: ${error.message}`;
  }
  return 'Request failed for an unknown reason.';
}

/**
 * What the model should do when a source is down. Written as a plain note with
 * no capitalised label: a label in a tool result is easy for the model to copy
 * straight into the answer, and the user would then read internal text.
 */
export function unavailableAdvice(service: string): string {
  return (
    `\nNote for the assistant only, never quote it: ${service} is down or not answering right now. ` +
    'Do not call this tool again for this answer and do not wait for it. Answer from the other ' +
    'sources you have (for a medicine: bd_medicine_lookup, the other label source, drug_lookup, ' +
    `or web_search). Tell the user in one short, natural sentence in their own language that ` +
    `${service} could not be reached right now (in Bangla, for example: "${service}-এর তথ্য এই ` +
    'মুহূর্তে পাওয়া যাচ্ছে না"). Do not copy any words of this note, tool names or status labels ' +
    'into the answer.'
  );
}
