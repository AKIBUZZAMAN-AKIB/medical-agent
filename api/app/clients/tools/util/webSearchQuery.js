/**
 * SearXNG treats a quoted query as one exact phrase. Models often wrap a whole
 * multi-word query in quotes ("WHO guidelines malaria treatment uncomplicated
 * adults"), and an exact phrase that long matches nothing on any engine, so
 * the search comes back empty and the answer has no web sources at all. The
 * same words without the quotes return results.
 *
 * `normalizeSearchQuery` drops quotes that wrap the whole query when it has
 * more than three words. `withQuoteFallback` wraps the web search tool so that
 * a search that still returns nothing while it holds quoted phrases is run once
 * more with every quote removed.
 */

const QUOTE = /["\u201C\u201D\u201E\u201F\u2033]/;
const QUOTES = /["\u201C\u201D\u201E\u201F\u2033]/g;
const WHOLE_QUOTED = /^["\u201C\u201D\u201E\u201F](.+)["\u201C\u201D\u201E\u201F]$/s;

function wordCount(text) {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

function normalizeSearchQuery(query) {
  if (typeof query !== 'string') {
    return query;
  }
  const trimmed = query.trim();
  const whole = trimmed.match(WHOLE_QUOTED);
  if (whole && !QUOTE.test(whole[1]) && wordCount(whole[1]) > 3) {
    return whole[1].trim();
  }
  return trimmed;
}

function stripQuotes(query) {
  return query.replace(QUOTES, ' ').replace(/\s+/g, ' ').trim();
}

function hasQuotes(query) {
  return QUOTE.test(query);
}

/** Number of results a web search tool call returned, from its artifact. */
function countResults(result) {
  const artifact = Array.isArray(result) ? result[1] : result?.artifact;
  const data = artifact?.web_search;
  if (!data) {
    return null;
  }
  return (
    (data.organic?.length ?? 0) +
    (data.topStories?.length ?? 0) +
    (data.news?.length ?? 0) +
    (data.answerBox != null ? 1 : 0) +
    (data.knowledgeGraph != null ? 1 : 0)
  );
}

function withQuoteFallback(searchTool, logger) {
  if (!searchTool || typeof searchTool.func !== 'function') {
    return searchTool;
  }
  const original = searchTool.func;
  searchTool.func = async function (input, runManager, config) {
    const query = input?.query;
    const normalized = normalizeSearchQuery(query);
    const first = normalized === query ? input : { ...input, query: normalized };
    const result = await original.call(this, first, runManager, config);
    if (typeof normalized !== 'string' || !hasQuotes(normalized) || countResults(result) !== 0) {
      return result;
    }
    const unquoted = stripQuotes(normalized);
    if (!unquoted) {
      return result;
    }
    logger?.debug?.(`[web_search] no results for a quoted query, retrying without quotes`);
    return original.call(this, { ...input, query: unquoted }, runManager, config);
  };
  return searchTool;
}

module.exports = { normalizeSearchQuery, stripQuotes, countResults, withQuoteFallback };
