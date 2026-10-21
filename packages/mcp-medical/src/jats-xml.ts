import { decodeEntities } from './pubmed-xml.js';

/**
 * Minimal reader for JATS full text, the XML Europe PMC serves for
 * open-access articles.
 *
 * An abstract tells a reader what a paper claims; a methods section tells a
 * reader what was actually done, and a results table tells a reader how big the
 * effect was. Appraising either is impossible from an abstract, so this parser
 * exists to put the sections in front of the model as text.
 *
 * The body is a tree of `<sec>` elements, each with a `<title>` and a run of
 * `<p>` paragraphs, and `<table-wrap>` blocks that carry the numbers a clinical
 * question usually turns on. Only those are extracted, and the nesting is
 * flattened onto the section that owns the text.
 */
export interface FullTextSection {
  /** Heading as published, e.g. `Methods`, `Results`, `Table 2`. */
  title: string;
  text: string;
}

const SEC_TOKEN = /<sec(?:\s[^>]*)?>|<\/sec>/g;

interface Range {
  start: number;
  end: number;
  depth: number;
}

/** Locates every `<sec>` block with its nesting depth, as JATS nests freely. */
function findSections(xml: string): Range[] {
  const ranges: Range[] = [];
  const open: number[] = [];
  for (const match of xml.matchAll(SEC_TOKEN)) {
    if (match[0] === '</sec>') {
      const start = open.pop();
      if (start != null) {
        ranges.push({ start, end: match.index, depth: open.length + 1 });
      }
    } else {
      open.push(match.index);
    }
  }
  return ranges;
}

function tagText(fragment: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(fragment);
  if (match?.[1] == null) {
    return undefined;
  }
  const text = decodeEntities(
    match[1]
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  );
  return text.length > 0 ? text : undefined;
}

/** Flattens a fragment to text, keeping paragraph breaks as spaces. */
function flatten(fragment: string): string {
  return decodeEntities(
    fragment
      .replace(/<\/(p|title|caption|tr|td|th|li)>/g, ' ')
      .replace(/<[^>]*>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  );
}

/**
 * Removes a nested section's own text, so the parent section does not repeat
 * its children's paragraphs before their own heading appears.
 */
function ownText(fragment: string): string {
  /**
   * The fragment still starts with its own opening `<sec>`, so the children sit
   * one level deeper here than in the document; skipping that first tag makes
   * the depth count comparable.
   */
  const body = fragment.slice(fragment.indexOf('>') + 1);
  const ranges = findSections(body)
    .filter((range) => range.depth === 1)
    .map((range) => body.slice(range.start, range.end));
  let text = body;
  for (const nested of ranges) {
    text = text.replace(nested, ' ');
  }
  return text.replace(/<title[\s\S]*?<\/title>/, ' ');
}

function collectTables(xml: string): FullTextSection[] {
  const tables: FullTextSection[] = [];
  const pattern = /<table-wrap[\s\S]*?<\/table-wrap>/g;
  for (const match of xml.matchAll(pattern)) {
    const fragment = match[0];
    const title = tagText(fragment, 'label') ?? tagText(fragment, 'caption') ?? 'Table';
    const text = flatten(fragment.replace(/<caption[\s\S]*?<\/caption>/, ' '));
    if (text.length > 0) {
      tables.push({ title, text });
    }
  }
  return tables;
}

/**
 * Extracts the body sections of a JATS article, in document order.
 *
 * Sections with no text of their own are dropped: a heading that only introduces
 * subsections carries nothing to appraise.
 */
export function parseFullTextSections(xml: string): FullTextSection[] {
  const body = /<body[\s\S]*?<\/body>/.exec(xml)?.[0] ?? xml;
  const sections: FullTextSection[] = [];
  for (const range of findSections(body)) {
    const fragment = body.slice(range.start, range.end);
    const title = tagText(fragment.slice(0, 1_500), 'title');
    if (title == null) {
      continue;
    }
    const text = flatten(ownText(fragment));
    if (text.length > 0) {
      sections.push({ title, text });
    }
  }
  return sections;
}

/** Article-level metadata a citation needs, read from the front matter. */
export interface FullTextMetadata {
  title?: string;
  journal?: string;
  year?: string;
  doi?: string;
  pmid?: string;
  pmcid?: string;
  licence?: string;
  authors: string[];
}

export function parseFullTextMetadata(xml: string): FullTextMetadata {
  const front = /<front[^>]*>[\s\S]*?<\/front>/.exec(xml)?.[0] ?? xml.slice(0, 20_000);
  const authors = [
    ...new Set(
      [...front.matchAll(/<surname>([\s\S]*?)<\/surname>/g)]
        .map((match) => decodeEntities(match[1]?.trim() ?? ''))
        .filter((name) => name.length > 0),
    ),
  ];
  return {
    title: tagText(front, 'article-title'),
    journal: tagText(front, 'journal-title'),
    year: tagText(front, 'year') ?? tagText(front, 'pub-date'),
    doi: findIdByType(front, 'doi'),
    pmid: /pmid/i.test(front) ? findIdByType(front, 'pmid') : undefined,
    pmcid: findIdByType(front, 'pmc'),
    licence: tagText(front, 'license-p'),
    authors,
  };
}

/** Reads the text of the `<article-id pub-id-type="…">` with the given type. */
function findIdByType(front: string, type: string): string | undefined {
  for (const match of front.matchAll(
    /<article-id[^>]*pub-id-type="([^"]+)"[^>]*>([\s\S]*?)<\/article-id>/g,
  )) {
    if (match[1]?.toLowerCase() === type) {
      const value = decodeEntities(match[2]?.trim() ?? '');
      if (value.length > 0) {
        return value;
      }
    }
  }
  return undefined;
}

/** All table blocks in the article, keyed by their printed label. */
export function parseFullTextTables(xml: string): FullTextSection[] {
  return collectTables(xml);
}
