/**
 * Minimal reader for the PubMed `efetch` XML payload.
 *
 * Only the elements a citation actually needs are extracted, and only from the
 * stable NLM DTD structure: the upstream is a government publisher with a
 * frozen DTD, so a full XML parser would buy generality this server cannot use.
 * Every accessor is null-safe, because a record missing a section is normal,
 * not an error.
 */

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  ndash: '-',
  mdash: '-',
  deg: '°',
  plusmn: '±',
  micro: 'µ',
  alpha: 'α',
  beta: 'β',
  gamma: 'γ',
  times: '×',
};

export function decodeEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (match, entity: string) => {
    if (entity.startsWith('#x') || entity.startsWith('#X')) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) ? safeFromCodePoint(code, match) : match;
    }
    if (entity.startsWith('#')) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) ? safeFromCodePoint(code, match) : match;
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? match;
  });
}

function safeFromCodePoint(code: number, fallback: string): string {
  try {
    return String.fromCodePoint(code);
  } catch {
    return fallback;
  }
}

function stripTags(fragment: string): string {
  return decodeEntities(fragment.replace(/<[^>]*>/g, ''))
    .replace(/\s+/g, ' ')
    .trim();
}

function firstTagValue(xml: string, tag: string): string | undefined {
  const match = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`).exec(xml);
  return match?.[1] == null ? undefined : stripTags(match[1]);
}

function allTagValues(xml: string, tag: string): string[] {
  const matches = xml.matchAll(new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g'));
  return [...matches].map((match) => stripTags(match[1] ?? ''));
}

export interface ParsedPubmedArticle {
  pmid: string;
  title?: string;
  journal?: string;
  year?: string;
  doi?: string;
  pmcid?: string;
  publicationTypes: string[];
  meshTerms: string[];
  /** Section label to text, e.g. `Results`; an unlabelled abstract uses `Abstract`. */
  abstractSections: Array<{ label: string; text: string }>;
  authors: string[];
}

function attribute(tag: string, name: string): string | undefined {
  const match = new RegExp(`${name}="([^"]*)"`).exec(tag);
  return match?.[1];
}

function parseAuthors(articleXml: string): string[] {
  const block = /<AuthorList(?:\s[^>]*)?>([\s\S]*?)<\/AuthorList>/.exec(articleXml)?.[1];
  if (block == null) {
    return [];
  }
  const authors: string[] = [];
  for (const match of block.matchAll(/<Author(?:\s[^>]*)?>([\s\S]*?)<\/Author>/g)) {
    const inner = match[1] ?? '';
    const last = firstTagValue(inner, 'LastName');
    const initials = firstTagValue(inner, 'Initials');
    const collective = firstTagValue(inner, 'CollectiveName');
    if (collective != null) {
      authors.push(collective);
    } else if (last != null) {
      authors.push(initials != null ? `${last} ${initials}` : last);
    }
  }
  return authors;
}

function parseAbstract(articleXml: string): ParsedPubmedArticle['abstractSections'] {
  const block = /<Abstract(?:\s[^>]*)?>([\s\S]*?)<\/Abstract>/.exec(articleXml)?.[1];
  if (block == null) {
    return [];
  }
  const sections: ParsedPubmedArticle['abstractSections'] = [];
  for (const match of block.matchAll(/<AbstractText([^>]*)>([\s\S]*?)<\/AbstractText>/g)) {
    const label = attribute(match[1] ?? '', 'Label') ?? 'Abstract';
    const text = stripTags(match[2] ?? '');
    if (text.length > 0) {
      sections.push({ label, text });
    }
  }
  return sections;
}

function parseMesh(articleXml: string): string[] {
  const block = /<MeshHeadingList(?:\s[^>]*)?>([\s\S]*?)<\/MeshHeadingList>/.exec(articleXml)?.[1];
  if (block == null) {
    return [];
  }
  const terms: string[] = [];
  for (const match of block.matchAll(/<DescriptorName(?:\s[^>]*)?>([\s\S]*?)<\/DescriptorName>/g)) {
    const term = stripTags(match[1] ?? '');
    if (term.length > 0 && !terms.includes(term)) {
      terms.push(term);
    }
  }
  return terms;
}

function parseArticle(articleXml: string): ParsedPubmedArticle | null {
  const pmid = firstTagValue(articleXml, 'PMID');
  if (pmid == null || pmid.length === 0) {
    return null;
  }
  const articleBlock =
    /<Article(?:\s[^>]*)?>([\s\S]*?)<\/Article>/.exec(articleXml)?.[1] ?? articleXml;
  const journalBlock = /<Journal(?:\s[^>]*)?>([\s\S]*?)<\/Journal>/.exec(articleXml)?.[1] ?? '';
  const pubDate = /<PubDate(?:\s[^>]*)?>([\s\S]*?)<\/PubDate>/.exec(journalBlock)?.[1] ?? '';
  const doi = findTaggedValue(articleXml, 'ELocationID', 'EIdType', 'doi');

  return {
    pmid,
    title: firstTagValue(articleBlock, 'ArticleTitle'),
    journal: firstTagValue(journalBlock, 'Title') ?? firstTagValue(journalBlock, 'ISOAbbreviation'),
    year: firstTagValue(pubDate, 'Year') ?? firstTagValue(pubDate, 'MedlineDate')?.slice(0, 4),
    doi,
    pmcid: findTaggedValue(articleXml, 'ArticleId', 'IdType', 'pmc'),
    publicationTypes: allTagValues(articleXml, 'PublicationType'),
    meshTerms: parseMesh(articleXml),
    abstractSections: parseAbstract(articleXml),
    authors: parseAuthors(articleXml),
  };
}

/** Returns the text of the first `<tag>` whose attribute matches, e.g. `EIdType="doi"`. */
function findTaggedValue(
  xml: string,
  tag: string,
  attributeName: string,
  attributeValue: string,
): string | undefined {
  for (const match of xml.matchAll(
    new RegExp(`<${tag}((?:\\s[^>]*)?)>([\\s\\S]*?)</${tag}>`, 'g'),
  )) {
    if (attribute(match[1] ?? '', attributeName) === attributeValue) {
      const value = stripTags(match[2] ?? '');
      if (value.length > 0) {
        return value;
      }
    }
  }
  return undefined;
}

/** Parses a `PubmedArticleSet` payload into one record per article. */
export function parsePubmedArticles(xml: string): ParsedPubmedArticle[] {
  const articles: ParsedPubmedArticle[] = [];
  for (const match of xml.matchAll(/<PubmedArticle(?:\s[^>]*)?>([\s\S]*?)<\/PubmedArticle>/g)) {
    const parsed = parseArticle(match[1] ?? '');
    if (parsed != null) {
      articles.push(parsed);
    }
  }
  return articles;
}

export interface ParsedPubmedBookArticle {
  pmid: string;
  bookId?: string;
  bookTitle?: string;
  title?: string;
  year?: string;
  abstractText?: string;
}

/**
 * Parses `<PubmedBookArticle>` monographs returned by `efetch.fcgi?db=pubmed`
 * (such as NLM/NICHD LactMed records on NCBI Bookshelf).
 */
export function parsePubmedBookArticles(xml: string): ParsedPubmedBookArticle[] {
  const records: ParsedPubmedBookArticle[] = [];
  for (const match of xml.matchAll(
    /<PubmedBookArticle(?:\s[^>]*)?>([\s\S]*?)<\/PubmedBookArticle>/g,
  )) {
    const inner = match[1] ?? '';
    const doc = /<BookDocument(?:\s[^>]*)?>([\s\S]*?)<\/BookDocument>/.exec(inner)?.[1] ?? inner;
    const pmid = firstTagValue(doc, 'PMID');
    if (pmid == null || pmid.length === 0) {
      continue;
    }
    const contribDate = /<ContributionDate(?:\s[^>]*)?>([\s\S]*?)<\/ContributionDate>/.exec(
      doc,
    )?.[1];
    const pubDate = /<PubDate(?:\s[^>]*)?>([\s\S]*?)<\/PubDate>/.exec(doc)?.[1];
    const sections = parseAbstract(doc);
    records.push({
      pmid,
      bookId: findTaggedValue(doc, 'ArticleId', 'IdType', 'bookaccession'),
      bookTitle: firstTagValue(doc, 'BookTitle'),
      title: firstTagValue(doc, 'ArticleTitle'),
      year:
        (contribDate != null ? firstTagValue(contribDate, 'Year') : undefined) ??
        (pubDate != null ? firstTagValue(pubDate, 'Year') : undefined),
      abstractText:
        sections.length > 0 ? sections.map((entry) => entry.text).join('\n\n') : undefined,
    });
  }
  return records;
}
