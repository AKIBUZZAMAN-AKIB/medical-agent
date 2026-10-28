import { logger } from '@librechat/data-schemas';
import { Tokenizer as AiTokenizer } from 'ai-tokenizer';

export type EncodingName = 'o200k_base' | 'claude';

type EncodingData = ConstructorParameters<typeof AiTokenizer>[0];

/**
 * Token counts are always produced by the real tokenizer. There is no
 * character-ratio or byte-length estimate any more: both inflated the budget
 * (a 45 KB system prompt that is ~10.8k real tokens was charged as ~46k).
 *
 * Long text is tokenized in pieces only to keep the cost linear. BPE is
 * quadratic inside one pre-token (e.g. 64k identical characters with no
 * whitespace take seconds), so:
 *  - pieces are cut just BEFORE a space/tab run that follows a non-whitespace
 *    character (never before CR/LF, which o200k can join onto punctuation).
 *    The pre-tokenizer does not merge across that point (the whitespace
 *    belongs to the next word), so the sum equals the
 *    whole-text count for ordinary prose, JSON and code;
 *  - a single non-whitespace run longer than MAX_RUN_CHARS (base64 blobs,
 *    `____…`) is cut every MAX_RUN_CHARS characters, which can differ from the
 *    whole-text count by at most ~1 token per cut.
 */
const MAX_RUN_CHARS = 4 * 1024;
const TARGET_PIECE_CHARS = 16 * 1024;

function isWhitespace(code: number): boolean {
  if (code === 32 || (code >= 9 && code <= 13)) {
    return true;
  }
  if (code < 128) {
    return false;
  }
  return /\s/.test(String.fromCharCode(code));
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** Splits text into pieces whose token counts sum to the whole-text count. */
export function splitForTokenCounting(text: string): string[] {
  if (text.length <= MAX_RUN_CHARS) {
    return [text];
  }
  const pieces: string[] = [];
  let start = 0;
  let boundary = -1;
  let runStart = 0;
  let prevWs = isWhitespace(text.charCodeAt(0));
  for (let i = 1; i < text.length; i++) {
    const code = text.charCodeAt(i);
    const ws = isWhitespace(code);
    if (ws) {
      /** Not before CR/LF: o200k joins trailing newlines onto punctuation (`,\n`). */
      if (!prevWs && code !== 10 && code !== 13) {
        boundary = i;
      }
      runStart = i + 1;
      prevWs = true;
      continue;
    }
    prevWs = false;
    if (i - runStart >= MAX_RUN_CHARS && !isLowSurrogate(code)) {
      pieces.push(text.slice(start, i));
      start = i;
      runStart = i;
      boundary = -1;
      continue;
    }
    if (i - start >= TARGET_PIECE_CHARS && boundary > start) {
      pieces.push(text.slice(start, boundary));
      start = boundary;
      boundary = -1;
    }
  }
  pieces.push(text.slice(start));
  return pieces;
}

function countWithTokenizer(tokenizer: AiTokenizer, text: string): number {
  if (text.length <= MAX_RUN_CHARS) {
    return tokenizer.count(text);
  }
  let total = 0;
  for (const piece of splitForTokenCounting(text)) {
    total += tokenizer.count(piece);
  }
  return total;
}

/** Synchronous load, so a count is never answered with a guess on cold start. */
function loadEncodingSync(encoding: EncodingName): EncodingData {
  if (encoding === 'claude') {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return require('ai-tokenizer/encoding/claude') as EncodingData;
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('ai-tokenizer/encoding/o200k_base') as EncodingData;
}

class Tokenizer {
  private tokenizersCache: Partial<Record<EncodingName, AiTokenizer>> = {};
  private loadingPromises: Partial<Record<EncodingName, Promise<void>>> = {};

  /** Pre-loads an encoding so that subsequent getTokenCount calls are accurate. */
  async initEncoding(encoding: EncodingName): Promise<void> {
    if (this.tokenizersCache[encoding]) {
      return;
    }
    if (this.loadingPromises[encoding]) {
      return this.loadingPromises[encoding];
    }
    this.loadingPromises[encoding] = (async () => {
      const data: EncodingData =
        encoding === 'claude'
          ? await import('ai-tokenizer/encoding/claude')
          : await import('ai-tokenizer/encoding/o200k_base');
      this.tokenizersCache[encoding] = new AiTokenizer(data);
    })();
    return this.loadingPromises[encoding];
  }

  /** Returns a counter that always uses the real tokenizer (long text in exact pieces). */
  async createExactTokenCounter(encoding: EncodingName): Promise<(text: string) => number> {
    await this.initEncoding(encoding);
    const tokenizer = this.tokenizersCache[encoding];
    if (!tokenizer) {
      throw new Error(`Tokenizer encoding failed to initialize: ${encoding}`);
    }
    return (text: string): number => {
      try {
        return countWithTokenizer(tokenizer, text);
      } catch (error) {
        this.handleCountError(encoding, tokenizer, error);
        throw error;
      }
    };
  }

  private getOrLoadSync(encoding: EncodingName): AiTokenizer {
    const cached = this.tokenizersCache[encoding];
    if (cached) {
      return cached;
    }
    const tokenizer = new AiTokenizer(loadEncodingSync(encoding));
    this.tokenizersCache[encoding] = tokenizer;
    return tokenizer;
  }

  /** Real token count. Loads the encoding synchronously if needed; never estimates. */
  getTokenCount(text: string, encoding: EncodingName = 'o200k_base'): number {
    if (!text) {
      return 0;
    }
    const tokenizer = this.getOrLoadSync(encoding);
    try {
      return countWithTokenizer(tokenizer, text);
    } catch (error) {
      this.handleCountError(encoding, tokenizer, error);
      return countWithTokenizer(this.getOrLoadSync(encoding), text);
    }
  }

  /**
   * Token count for content that must not be estimated, or `undefined` when it
   * cannot be produced, so the caller can omit a figure instead of publishing a
   * guess. Used for a value that is ADDED to exact provider accounting — see the
   * retained tool results of a turn stopped at the tool-call limit — where
   * even a one-token seam difference must not enter the sum.
   *
   * The input is tokenized whole in one pass (no pieces at all). It costs
   * ~60 ms/MB, so the caller decides how much content is worth counting
   * (`endpoints.agents.maxRetainedToolCountChars`) rather than a bound here.
   */
  countExactTokens(text: string, encoding: EncodingName = 'o200k_base'): number | undefined {
    if (text.length === 0) {
      return 0;
    }
    let tokenizer: AiTokenizer;
    try {
      tokenizer = this.getOrLoadSync(encoding);
    } catch (error) {
      logger.error(`[Tokenizer] Error loading ${encoding} encoding:`, error);
      return undefined;
    }
    try {
      return tokenizer.count(text);
    } catch (error) {
      this.handleCountError(encoding, tokenizer, error);
      return undefined;
    }
  }

  private handleCountError(encoding: EncodingName, tokenizer: AiTokenizer, error: unknown): void {
    logger.error('[Tokenizer] Error getting token count:', error);
    if (this.tokenizersCache[encoding] !== tokenizer) {
      return;
    }
    delete this.tokenizersCache[encoding];
    delete this.loadingPromises[encoding];
    void this.initEncoding(encoding).catch((initError: unknown) => {
      logger.error(`[Tokenizer] Error reloading ${encoding} encoding:`, initError);
    });
  }
}

const TokenizerSingleton: Tokenizer = new Tokenizer();

/**
 * Counts the number of tokens in a given text using ai-tokenizer with o200k_base encoding.
 * @param text - The text to count tokens in. Defaults to an empty string.
 * @returns The number of tokens in the provided text.
 */
export async function countTokens(text = ''): Promise<number> {
  await TokenizerSingleton.initEncoding('o200k_base');
  return TokenizerSingleton.getTokenCount(text, 'o200k_base');
}

export default TokenizerSingleton;
