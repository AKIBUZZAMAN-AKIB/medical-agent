import { Tokenizer as AiTokenizer } from 'ai-tokenizer';
import Tokenizer, { splitForTokenCounting } from './tokenizer';

jest.mock('@librechat/data-schemas', () => ({
  logger: {
    error: jest.fn(),
  },
}));

describe('Tokenizer', () => {
  it('should be a singleton (same instance)', async () => {
    const AnotherTokenizer = await import('./tokenizer');
    expect(Tokenizer).toBe(AnotherTokenizer.default);
  });

  describe('initEncoding', () => {
    it('counts real tokens on cold start instead of a character estimate', () => {
      const text = 'Cold start token count';
      const exact = new AiTokenizer(require('ai-tokenizer/encoding/o200k_base')).count(text);
      expect(Tokenizer.getTokenCount(text, 'o200k_base')).toBe(exact);
    });

    it('should load o200k_base encoding', async () => {
      await Tokenizer.initEncoding('o200k_base');
      const count = Tokenizer.getTokenCount('Hello, world!', 'o200k_base');
      expect(count).toBeGreaterThan(0);
    });

    it('should load claude encoding', async () => {
      await Tokenizer.initEncoding('claude');
      const count = Tokenizer.getTokenCount('Hello, world!', 'claude');
      expect(count).toBeGreaterThan(0);
    });

    it('should deduplicate concurrent init calls', async () => {
      const [, , count] = await Promise.all([
        Tokenizer.initEncoding('o200k_base'),
        Tokenizer.initEncoding('o200k_base'),
        Tokenizer.initEncoding('o200k_base').then(() =>
          Tokenizer.getTokenCount('test', 'o200k_base'),
        ),
      ]);
      expect(count).toBeGreaterThan(0);
    });
  });

  describe('getTokenCount', () => {
    beforeAll(async () => {
      await Tokenizer.initEncoding('o200k_base');
      await Tokenizer.initEncoding('claude');
    });

    it('should return the number of tokens in the given text', () => {
      const count = Tokenizer.getTokenCount('Hello, world!', 'o200k_base');
      expect(count).toBeGreaterThan(0);
    });

    it('should count tokens using claude encoding', () => {
      const count = Tokenizer.getTokenCount('Hello, world!', 'claude');
      expect(count).toBeGreaterThan(0);
    });

    it.each([
      { label: 'prose', text: 'The patient reports mild fever and cough.  '.repeat(800) },
      { label: 'pretty JSON', text: JSON.stringify(Array.from({ length: 400 }, (_, i) => ({ name: `tool_${i}`, type: 'object' })), null, 2) },
      { label: 'Bengali', text: 'আমার মাথা ব্যথা করছে।\n\n  '.repeat(800) },
    ])('counts long $label exactly (same as one whole pass)', ({ text }) => {
      const whole = new AiTokenizer(require('ai-tokenizer/encoding/o200k_base')).count(text);
      expect(Tokenizer.getTokenCount(text, 'o200k_base')).toBe(whole);
      expect(Tokenizer.getTokenCount(text, 'o200k_base')).toBeLessThan(Buffer.byteLength(text, 'utf8'));
    });

    it('keeps pathological runs linear by cutting them into bounded pieces', () => {
      const text = '_'.repeat(64 * 1024);
      const pieces = splitForTokenCounting(text);
      expect(pieces.join('')).toBe(text);
      expect(Math.max(...pieces.map((p) => p.length))).toBeLessThanOrEqual(4 * 1024 + 1);
      expect(Tokenizer.getTokenCount(text, 'o200k_base')).toBeGreaterThan(0);
    });
  });

  describe('createExactTokenCounter', () => {
    it('throws instead of returning a fallback estimate after a tokenizer failure', async () => {
      const counter = await Tokenizer.createExactTokenCounter('o200k_base');
      const count = jest.spyOn(AiTokenizer.prototype, 'count').mockImplementationOnce(() => {
        throw new Error('tokenizer failed');
      });
      try {
        expect(() => counter('Stable cached context')).toThrow('tokenizer failed');
      } finally {
        count.mockRestore();
        await Tokenizer.initEncoding('o200k_base');
      }
    });

    it('uses the real tokenizer for long input', async () => {
      const counter = await Tokenizer.createExactTokenCounter('o200k_base');
      const text = 'word '.repeat(4096);
      expect(counter(text)).toBe(Tokenizer.countExactTokens(text, 'o200k_base'));
    });
  });

  describe('countExactTokens', () => {
    beforeAll(async () => {
      await Tokenizer.initEncoding('o200k_base');
    });

    it('tokenizes oversized input whole instead of falling back to byte length', () => {
      /** Naive fixed-size slices can split a BPE merge at a seam, so this
       *  caller tokenizes the whole input in one pass. */
      const text = 'word '.repeat(4096);
      const exact = Tokenizer.countExactTokens(text, 'o200k_base');
      expect(exact).toBeGreaterThan(0);
      expect(exact).toBe(Tokenizer.getTokenCount(text, 'o200k_base'));
      const bound = 4 * 1024;
      let sliced = 0;
      for (let index = 0; index < text.length; index += bound) {
        sliced += Tokenizer.countExactTokens(text.slice(index, index + bound), 'o200k_base') ?? 0;
      }
      expect(exact).toBeLessThan(sliced);
    });

    it('matches the tokenizer for input inside the fast-path bound', () => {
      const text = 'Hello, world!';
      expect(Tokenizer.countExactTokens(text, 'o200k_base')).toBe(
        Tokenizer.getTokenCount(text, 'o200k_base'),
      );
      expect(Tokenizer.countExactTokens('', 'o200k_base')).toBe(0);
    });

    it('loads the encoding synchronously on cold start', () => {
      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const cold = require('./tokenizer').default as typeof Tokenizer;
        expect(cold.countExactTokens('Uncounted tool result', 'o200k_base')).toBeGreaterThan(0);
      });
    });
  });
});
