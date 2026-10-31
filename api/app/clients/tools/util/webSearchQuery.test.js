const {
  normalizeSearchQuery,
  stripQuotes,
  countResults,
  withQuoteFallback,
} = require('./webSearchQuery');

const found = (n) => ['out', { web_search: { organic: Array.from({ length: n }, () => ({})) } }];

describe('normalizeSearchQuery', () => {
  it('drops quotes that wrap a long query', () => {
    expect(normalizeSearchQuery('"WHO guidelines malaria treatment uncomplicated adults"')).toBe(
      'WHO guidelines malaria treatment uncomplicated adults',
    );
    expect(normalizeSearchQuery('\u201Cdengue warning signs in adults\u201D')).toBe(
      'dengue warning signs in adults',
    );
  });

  it('keeps short exact phrases and inner phrases', () => {
    expect(normalizeSearchQuery('"dengue shock syndrome"')).toBe('"dengue shock syndrome"');
    expect(normalizeSearchQuery('"dengue warning signs" WHO')).toBe('"dengue warning signs" WHO');
    expect(normalizeSearchQuery('"a" and "b c" d e')).toBe('"a" and "b c" d e');
  });

  it('leaves non-strings alone', () => {
    expect(normalizeSearchQuery(undefined)).toBeUndefined();
  });
});

describe('stripQuotes / countResults', () => {
  it('removes every quote', () => {
    expect(stripQuotes('"dengue warning signs" WHO')).toBe('dengue warning signs WHO');
  });
  it('counts results from the artifact', () => {
    expect(countResults(found(3))).toBe(3);
    expect(countResults(['out', { web_search: {} }])).toBe(0);
    expect(countResults('plain')).toBeNull();
  });
});

describe('withQuoteFallback', () => {
  it('searches the unquoted query when a long query was wrapped in quotes', async () => {
    const func = jest.fn(async () => found(4));
    const tool = withQuoteFallback({ func });
    await tool.func({ query: '"WHO guidelines malaria treatment uncomplicated adults"' }, null, {});
    expect(func).toHaveBeenCalledTimes(1);
    expect(func.mock.calls[0][0].query).toBe(
      'WHO guidelines malaria treatment uncomplicated adults',
    );
  });

  it('retries once without quotes when a quoted search finds nothing', async () => {
    const func = jest.fn().mockResolvedValueOnce(found(0)).mockResolvedValueOnce(found(5));
    const tool = withQuoteFallback({ func }, { debug: jest.fn() });
    const result = await tool.func({ query: '"dengue warning signs" WHO', news: false }, null, {});
    expect(func).toHaveBeenCalledTimes(2);
    expect(func.mock.calls[1][0]).toEqual({ query: 'dengue warning signs WHO', news: false });
    expect(countResults(result)).toBe(5);
  });

  it('does not retry when results came back or there were no quotes', async () => {
    const func = jest.fn().mockResolvedValue(found(0));
    const tool = withQuoteFallback({ func });
    await tool.func({ query: 'rare disease nobody wrote about' }, null, {});
    expect(func).toHaveBeenCalledTimes(1);

    const func2 = jest.fn().mockResolvedValue(found(2));
    await withQuoteFallback({ func: func2 }).func({ query: '"dengue shock" Dhaka' }, null, {});
    expect(func2).toHaveBeenCalledTimes(1);
  });

  it('returns tools without a func unchanged', () => {
    const tool = { name: 'x' };
    expect(withQuoteFallback(tool)).toBe(tool);
  });
});
