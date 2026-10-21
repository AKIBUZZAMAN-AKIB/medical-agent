import { z } from 'zod';
import { EmptyResultError } from '../errors.js';
import {
  bulletList,
  clampInt,
  composeResult,
  definitionList,
  excerpt,
  heading,
} from '../format.js';
import type { SourceRef, ToolOutput } from '../format.js';
import { parsePubmedArticles } from '../pubmed-xml.js';
import { parseFullTextMetadata, parseFullTextSections, parseFullTextTables } from '../jats-xml.js';
import type { ServerEnv } from '../env.js';
import type { Upstream } from '../http.js';
import { defineTool } from '../types.js';
import type { ToolContext, ToolSpec } from '../types.js';

export const EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';
const EPMC = 'https://www.ebi.ac.uk/europepmc/webservices/rest';

/** NCBI asks for 3 requests/second without a key and 10 with one. */
export function ncbiUpstream(env: ServerEnv, service: string, cacheTtlMs?: number): Upstream {
  return {
    service,
    minIntervalMs: env.ncbiApiKey != null ? 110 : 340,
    cacheTtlMs: cacheTtlMs ?? env.cacheTtlMs,
    emptyOnNotFound: true,
  };
}

export function ncbiParams(env: ServerEnv, extra: Record<string, string | number | undefined>) {
  return {
    tool: 'librechat-mcp-medical',
    email: env.contactEmail,
    api_key: env.ncbiApiKey,
    ...extra,
  };
}

interface EutilsSearchResult {
  esearchresult?: {
    count?: string;
    idlist?: string[];
    ERROR?: string;
    errorlist?: string[];
  };
}

interface EutilsSummary {
  result?: Record<
    string,
    {
      uid?: string;
      title?: string;
      sortpubdate?: string;
      pubdate?: string;
      source?: string;
      pubtype?: string[];
      authors?: Array<{ name?: string }>;
      articleids?: Array<{ idtype?: string; value?: string }>;
    }
  >;
}

function authorLine(authors: Array<{ name?: string }> | undefined): string {
  const names = (authors ?? [])
    .map((author) => author.name)
    .filter((name): name is string => !!name);
  if (names.length === 0) {
    return '';
  }
  if (names.length <= 3) {
    return names.join(', ');
  }
  return `${names.slice(0, 3).join(', ')}, et al.`;
}

function doiOf(
  articleids: Array<{ idtype?: string; value?: string }> | undefined,
): string | undefined {
  return articleids?.find((entry) => entry.idtype === 'doi')?.value;
}

const pubmedSearch = defineTool({
  name: 'pubmed_search',
  group: 'literature',
  title: 'Search PubMed',
  readOnly: true,
  description:
    'Search PubMed/MEDLINE for biomedical literature and return titles, authors, journal, date, publication type, PMID and DOI for each hit. Use it whenever an answer needs published evidence: effectiveness, dosing, adverse events, guidelines, or "what does the literature say". Supports native PubMed syntax in the query (for example: `metformin AND (type:randomized-controlled-trial)`, `"GLP-1"[tiab] AND 2023:2025[dp]`). Returns citations only — call pubmed_article for the abstracts themselves.',
  inputSchema: {
    query: z
      .string()
      .min(2)
      .describe('PubMed query syntax. Plain words work; field tags and filters are honored.'),
    max_results: z
      .number()
      .int()
      .min(1)
      .max(25)
      .optional()
      .describe('How many citations to return (default 8, max 25).'),
    sort: z
      .enum(['relevance', 'most_recent'])
      .optional()
      .describe('`relevance` (default) or `most_recent`.'),
    years_back: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe('Restrict to the last N years, e.g. 5 for 2021-onwards.'),
    publication_types: z
      .array(z.string())
      .max(4)
      .optional()
      .describe(
        'Filter by PubMed publication type, e.g. ["Randomized Controlled Trial"], ["Systematic Review"], ["Meta-Analysis"].',
      ),
  },
  async handler(args, { env, http }: ToolContext): Promise<ToolOutput> {
    const maxResults = clampInt(args.max_results, 1, 25, 8);
    const terms: string[] = [args.query];
    if (args.years_back != null) {
      const fromYear = new Date().getUTCFullYear() - args.years_back + 1;
      terms.push(`("${fromYear}"[dp] : "3000"[dp])`);
    }
    for (const publicationType of args.publication_types ?? []) {
      terms.push(`${publicationType}[pt]`);
    }
    const term = terms.join(' AND ');

    const upstream = ncbiUpstream(env, 'PubMed E-utilities');
    const search = await http.getJson<EutilsSearchResult>(`${EUTILS}/esearch.fcgi`, upstream, {
      query: ncbiParams(env, {
        db: 'pubmed',
        term,
        retmode: 'json',
        retmax: maxResults,
        sort: args.sort === 'most_recent' ? 'date' : 'relevance',
      }),
    });

    const ids = search.esearchresult?.idlist ?? [];
    if (ids.length === 0) {
      throw new EmptyResultError(
        'PubMed',
        search.esearchresult?.ERROR != null
          ? `PubMed rejected the query: ${search.esearchresult.ERROR}. Simplify the syntax and retry.`
          : 'No PubMed records matched. Broaden the terms, drop field tags like [tiab], or widen years_back.',
      );
    }

    const total = Number.parseInt(search.esearchresult?.count ?? `${ids.length}`, 10);
    const summary = await http.getJson<EutilsSummary>(`${EUTILS}/esummary.fcgi`, upstream, {
      query: ncbiParams(env, { db: 'pubmed', id: ids.join(','), retmode: 'json' }),
    });

    const rows = ids.map((id) => {
      const record = summary.result?.[id];
      const doi = doiOf(record?.articleids);
      return {
        id,
        record,
        doi,
      };
    });

    const body = rows
      .map(({ id, record, doi }) => {
        const pmidUrl = `https://pubmed.ncbi.nlm.nih.gov/${id}/`;
        return [
          `[PMID ${id}] ${record?.title ?? 'untitled'}`,
          definitionList([
            ['Authors', authorLine(record?.authors)],
            ['Journal', record?.source],
            ['Date', record?.pubdate ?? record?.sortpubdate],
            ['Type', (record?.pubtype ?? []).join('; ')],
            ['DOI', doi],
          ]),
          record == null ? '' : `Link: ${pmidUrl}`,
        ]
          .filter((part) => part.length > 0)
          .join('\n');
      })
      .join('\n\n');

    const sources: SourceRef[] = [
      { name: 'PubMed', url: `https://pubmed.ncbi.nlm.nih.gov/?term=${encodeURIComponent(term)}` },
      ...rows.map(({ id }) => ({
        name: `PMID ${id}`,
        url: `https://pubmed.ncbi.nlm.nih.gov/${id}/`,
      })),
    ];

    return composeResult({
      headline: `PubMed: ${total.toLocaleString('en-US')} record(s) match; showing ${ids.length}.`,
      sections: [heading('Citations'), body],
      sources,
      notices: [
        'Citation metadata only — no abstracts, no study-quality assessment. Read the abstract (pubmed_article) before relying on any finding.',
        'Publication counts are not evidence quality: read design, sample size, and outcome before reporting a result.',
      ],
      env,
    });
  },
});

const pubmedArticle = defineTool({
  name: 'pubmed_article',
  group: 'literature',
  title: 'Read PubMed abstracts',
  readOnly: true,
  description:
    'Fetch full abstracts for up to 10 PMIDs, returning each abstract section (Background, Methods, Results, Conclusions), MeSH terms, publication type, and DOI. Use it after pubmed_search to ground a claim in what a study actually did and found. Abstracts only — full text is not available through this tool.',
  inputSchema: {
    pmids: z
      .string()
      .min(3)
      .describe('One or more PMIDs, comma- or space-separated, e.g. "31212753, 22846631".'),
    max_abstract_chars: z
      .number()
      .int()
      .min(200)
      .max(20_000)
      .optional()
      .describe('Per-abstract character cap (default 3000).'),
  },
  async handler(args, { env, http }: ToolContext): Promise<ToolOutput> {
    const pmids = [
      ...new Set(
        args.pmids
          .split(/[\s,]+/)
          .map((value) => value.trim())
          .filter((value) => value.length > 0),
      ),
    ]
      .filter((value) => /^\d{1,9}$/.test(value))
      .slice(0, 10);

    if (pmids.length === 0) {
      throw new EmptyResultError(
        'PubMed',
        'No valid PMIDs were supplied. PMIDs are numeric, e.g. "31212753".',
      );
    }

    const upstream = ncbiUpstream(env, 'PubMed E-utilities');
    const xml = await http.getText(
      `${EUTILS}/efetch.fcgi`,
      upstream,
      {
        query: ncbiParams(env, {
          db: 'pubmed',
          id: pmids.join(','),
          retmode: 'xml',
          rettype: 'abstract',
        }),
      },
      'application/xml, text/xml;q=0.9',
    );

    const articles = parsePubmedArticles(xml);
    if (articles.length === 0) {
      throw new EmptyResultError(
        'PubMed',
        'PubMed returned no parseable record for those PMIDs. Double-check the identifiers.',
      );
    }

    const maxChars = clampInt(args.max_abstract_chars, 200, 20_000, 3_000);
    const body = articles
      .map((article) => {
        const abstract = article.abstractSections
          .map((section) => {
            const text = excerpt(section.text, maxChars);
            return `${section.label}: ${text}`;
          })
          .join('\n');
        return [
          heading(`PMID ${article.pmid}${article.title != null ? ` — ${article.title}` : ''}`),
          definitionList([
            ['Authors', article.authors.slice(0, 6).join(', ')],
            ['Journal', article.journal],
            ['Year', article.year],
            ['Publication type', article.publicationTypes.join('; ')],
            ['MeSH', article.meshTerms.slice(0, 12).join('; ')],
            ['DOI', article.doi],
          ]),
          abstract.length > 0 ? abstract : 'No abstract is available in PubMed for this record.',
          `Link: https://pubmed.ncbi.nlm.nih.gov/${article.pmid}/`,
        ]
          .filter((part) => part.length > 0)
          .join('\n');
      })
      .join('\n\n');

    return composeResult({
      headline: `PubMed abstracts for ${articles.length} record(s).`,
      sections: [body],
      sources: articles.map((article) => ({
        name: `PMID ${article.pmid}`,
        url: `https://pubmed.ncbi.nlm.nih.gov/${article.pmid}/`,
      })),
      notices: [
        'An abstract is the authors’ own summary, not an independent appraisal. Check the study design and conflicts before relying on it.',
        'Never read a dose, interaction, or contraindication out of an abstract alone — confirm against drug_label or drug_interaction_check.',
      ],
      env,
    });
  },
});

/** Maps a published section heading onto the coarse name the tool accepts. */
function sectionKey(title: string): string {
  const normalized = title.toLowerCase();
  /**
   * Reviews and meta-analyses publish their evidence under their own
   * vocabulary — "Review", "Synthesis", "Evidence summary" — and that section
   * carries their results, while their data-collection section is their method.
   */
  if (/\b(review|synthesis|evidence summary|summary of evidence|our findings)/.test(normalized)) {
    return 'results';
  }
  if (
    /\b(data collection|data extraction|data source|eligibility|participants|population|setting|statistic|analysis)/.test(
      normalized,
    )
  ) {
    return 'methods';
  }
  if (/\b(method|material|design|procedure|intervention|measurement)/.test(normalized)) {
    return 'methods';
  }
  if (/\b(result|findings?|outcome)/.test(normalized)) {
    return 'results';
  }
  if (/\b(discussion|limitation|strengths?)/.test(normalized)) {
    return 'discussion';
  }
  if (/\b(conclusion)/.test(normalized)) {
    return 'conclusion';
  }
  if (/\b(introduction|background|overview)/.test(normalized)) {
    return 'introduction';
  }
  return 'other';
}

const readFullText = defineTool({
  name: 'read_full_text',
  group: 'literature',
  title: 'Read the full text of an open-access paper',
  readOnly: true,
  description:
    'Fetch the published full text of one open-access article (one PMID or PMCID at a time) from Europe PMC and return its named sections — Methods, Results, Discussion, or any other section the paper uses — plus its tables with the numbers in them. Use it after pubmed_article whenever a claim depends on how the study was done or what the actual numbers were: the sample that was analysed, the comparator, the effect size with its interval, the exclusions, the follow-up, the conflicts. Available for the open-access subset only; for anything else it says so and the abstract remains what can be read.',
  inputSchema: {
    id: z.string().min(3).describe('One PMID (e.g. "31212753") or one PMCID (e.g. "PMC8379165").'),
    sections: z
      .array(
        z.enum([
          'introduction',
          'methods',
          'results',
          'discussion',
          'conclusion',
          'other',
          'tables',
        ]),
      )
      .min(1)
      .max(7)
      .optional()
      .describe(
        'Which parts to return (default methods, results, discussion, tables). A paper publishes under its own headings, so if the result says a part was "Not read", ask for it by the name listed under "Sections available", or pass "other" to get every remaining named section.',
      ),
    max_section_chars: z
      .number()
      .int()
      .min(500)
      .max(40_000)
      .optional()
      .describe('Per-section character cap (default 6000).'),
  },
  async handler(args, { env, http }: ToolContext): Promise<ToolOutput> {
    const wanted = new Set(args.sections ?? ['methods', 'results', 'discussion', 'tables']);
    const maxSectionChars = clampInt(args.max_section_chars, 500, 40_000, 6_000);
    const raw = args.id.trim();
    const pmcidMatch = /^PMC\d+$/i.exec(raw);
    const pmidMatch = /^\d{1,9}$/.test(raw) ? raw : undefined;

    if (pmcidMatch == null && pmidMatch == null) {
      throw new EmptyResultError(
        'Europe PMC',
        `"${raw}" is neither a PMID nor a PMCID. PubMed identifiers are numeric, and a PMCID looks like PMC8379165.`,
      );
    }

    let pmcid: string;
    const pmid = pmidMatch;
    if (pmcidMatch != null) {
      pmcid = pmcidMatch[0].toUpperCase();
    } else if (pmid != null) {
      /**
       * The full text is served under the PMCID, not the PMID, and only the
       * PubMed summary knows which article has one. Resolving it here is what
       * lets the tool answer "not open access" instead of returning nothing.
       */
      const summary = await http.getJson<{
        result?: Record<string, { articleids?: Array<{ idtype?: string; value?: string }> }>;
      }>(`${EUTILS}/esummary.fcgi`, ncbiUpstream(env, 'PubMed E-utilities'), {
        query: ncbiParams(env, { db: 'pubmed', id: pmid, retmode: 'json' }),
      });
      const record = summary.result?.[pmid];
      const found = record?.articleids?.find((id) => id.idtype === 'pmc')?.value;
      if (found == null) {
        throw new EmptyResultError(
          'PubMed and Europe PMC',
          `PMID ${pmid} is not in the open-access subset, so its full text cannot be read here — the publisher's paywall or licence is not something this server will work around. pubmed_article returns the abstract, and the result of a paper behind a paywall has to be read at the library or on site.`,
        );
      }
      pmcid = found.toUpperCase();
    } else {
      throw new EmptyResultError(
        'Europe PMC',
        `"${raw}" is neither a PMID nor a PMCID. PubMed identifiers are numeric, and a PMCID looks like PMC8379165.`,
      );
    }

    const upstream: Upstream = {
      service: 'Europe PMC full text',
      minIntervalMs: 200,
      cacheTtlMs: env.cacheTtlMs,
      /** A 404 here means the article is not in the OA full-text archive. */
      emptyOnNotFound: true,
    };
    const xml = await http
      .getText(`${EPMC}/${pmcid}/fullTextXML`, upstream, {}, 'application/xml, text/xml;q=0.9')
      .catch(() => {
        throw new EmptyResultError(
          'Europe PMC full text',
          `Europe PMC has no full text for ${pmcid}. The article exists in PubMed but its full text is not in the open-access archive; the abstract from pubmed_article is what can be read.`,
        );
      });

    const metadata = parseFullTextMetadata(xml);
    const sections = parseFullTextSections(xml);
    const tables = parseFullTextTables(xml);
    if (sections.length === 0) {
      throw new EmptyResultError(
        'Europe PMC full text',
        `${pmcid} has a full-text record but no parseable body sections. This is usually a scanned or typeset-only deposit, which this reader does not handle.`,
      );
    }

    const blocks: string[] = [];
    const listed: string[] = [];
    const matched = new Set<string>();
    for (const section of sections) {
      const key = sectionKey(section.title);
      if (!wanted.has(key)) {
        continue;
      }
      matched.add(key);
      listed.push(section.title);
      blocks.push([heading(section.title), excerpt(section.text, maxSectionChars)].join('\n'));
    }
    if (wanted.has('tables')) {
      for (const table of tables) {
        listed.push(table.title);
        blocks.push([heading(table.title), excerpt(table.text, maxSectionChars)].join('\n'));
      }
    }

    if (blocks.length === 0) {
      const available = [...new Set(sections.map((section) => sectionKey(section.title)))];
      throw new EmptyResultError(
        'Europe PMC full text',
        `${pmcid} has no section matching ${[...wanted].join(', ')}. This article's sections are: ${available.join(', ')}${tables.length > 0 ? ', plus tables' : ''}.`,
      );
    }
    /**
     * Papers publish under their own headings, so a request for "methods" can
     * miss even a paper that has them. A partial answer plus the list of what
     * this article actually calls its sections is more useful than an error,
     * because the next call can ask for the right name.
     */
    const missing = [...wanted].filter((key) => key !== 'tables' && !matched.has(key));

    return composeResult({
      headline:
        `Full text of ${pmcid}${metadata.title != null ? `: ${metadata.title}` : ''} — ` +
        `${listed.length} part(s) read${metadata.licence != null ? `, ${excerpt(metadata.licence, 120)}` : ''}.`,
      sections: [
        definitionList([
          ['Authors', metadata.authors.slice(0, 8).join(', ')],
          ['Journal', metadata.journal],
          ['Year', metadata.year],
          ['DOI', metadata.doi],
          ['PMID', metadata.pmid ?? pmid],
          ['PMCID', pmcid],
          ['Sections available', sections.map((section) => section.title).join('; ')],
          ...(missing.length > 0 ? [['Not read', missing.join(', ')] as [string, string]] : []),
        ]),
        ...blocks,
      ],
      sources: [
        {
          name: `Full text ${pmcid}`,
          url: `https://europepmc.org/article/PMC/${pmcid.replace(/^PMC/, '')}`,
        },
        ...(pmid != null
          ? [{ name: `PMID ${pmid}`, url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` }]
          : []),
      ],
      notices: [
        'This is the published full text, so it can be cited as read evidence rather than as an abstract. Cite the PMCID or DOI, and say which part you read.',
        'Full text is only available for the open-access subset. "Not open access" is a licensing fact, not evidence that a paper is weak, and it is not a reason to summarise the abstract as if it were the study.',
        'Methods and results are what make a claim checkable: check the analysed sample, the comparator, the effect size with its interval, the pre-specified outcome, the follow-up, and the declared conflicts before reporting a finding.',
        'A table flattened to text loses its layout, footnotes, and symbols, so read a number here as approximate and confirm it in the article before using it in anything consequential.',
      ],
      env,
    });
  },
});

interface EpmcSearchResponse {
  hitCount?: number;
  resultList?: {
    result?: Array<{
      id?: string;
      source?: string;
      pmid?: string;
      pmcid?: string;
      doi?: string;
      title?: string;
      authorString?: string;
      journalTitle?: string;
      pubYear?: string;
      pubType?: string;
      citedByCount?: number;
      isOpenAccess?: string;
      abstractText?: string;
    }>;
  };
}

/** A Europe PMC hit, reduced to the fields a citation link needs. */
type EpmcRecord = NonNullable<NonNullable<EpmcSearchResponse['resultList']>['result']>[number];

/** Labels a Europe PMC hit the way a reader would ask for it. */
function europePmcName(record: EpmcRecord): string {
  if (record.pmid != null) {
    return `PMID ${record.pmid}`;
  }
  if (record.source === 'MED') {
    return `Europe PMC ${record.id ?? 'record'}`;
  }
  return record.id ?? 'record';
}

/** Prefers the DOI, then PubMed, then the Europe PMC article page. */
function europePmcUrl(record: EpmcRecord): string {
  if (record.doi != null) {
    return `https://doi.org/${record.doi}`;
  }
  if (record.pmid != null) {
    return `https://pubmed.ncbi.nlm.nih.gov/${record.pmid}/`;
  }
  return `https://europepmc.org/article/${record.source}/${record.id}`;
}

const europePmcSearch = defineTool({
  name: 'europe_pmc_search',
  group: 'literature',
  title: 'Search Europe PMC',
  readOnly: true,
  description:
    'Search Europe PMC, which indexes PubMed plus preprints, agricola, patents and more, and can return abstracts inline. Use it for a second independent pass over the literature, for preprints, or when a PubMed search came back thin. Supports Europe PMC query syntax (for example: `TITLE:"myocardial infarction" AND SRC:MED AND (PUB_YEAR:[2023 TO 2025])`). Returns abstracts, citation counts, and open-access status.',
  inputSchema: {
    query: z.string().min(2).describe('Europe PMC query syntax.'),
    max_results: z
      .number()
      .int()
      .min(1)
      .max(25)
      .optional()
      .describe('Results to return (default 8, max 25).'),
    sort: z
      .enum(['relevance', 'most_cited', 'most_recent'])
      .optional()
      .describe('`relevance` (default), `most_cited`, or `most_recent`.'),
    open_access_only: z
      .boolean()
      .optional()
      .describe('Restrict to open-access records, whose full text may be readable.'),
  },
  async handler(args, { env, http }: ToolContext): Promise<ToolOutput> {
    const maxResults = clampInt(args.max_results, 1, 25, 8);
    const sortByQuery: Record<string, string | undefined> = {
      most_cited: 'CITED desc',
      most_recent: 'FIRST_PDATE_D desc',
    };
    const sortParam =
      args.sort != null && sortByQuery[args.sort] != null ? { sort: sortByQuery[args.sort] } : {};

    const query = args.open_access_only === true ? `(${args.query}) AND OPEN_ACCESS:y` : args.query;
    const upstream: Upstream = {
      service: 'Europe PMC',
      minIntervalMs: 200,
      cacheTtlMs: env.cacheTtlMs,
      maxAttempts: 2,
    };
    let response: EpmcSearchResponse;
    try {
      response = await http.getJson<EpmcSearchResponse>(`${EPMC}/search`, upstream, {
        query: {
          query,
          format: 'json',
          pageSize: maxResults,
          resultType: 'core',
          ...sortParam,
        },
      });
    } catch (error) {
      if (!(error instanceof EmptyResultError)) {
        return composeOpenAlexSearch(args, { env, http, cause: error });
      }
      throw error;
    }

    const results = response.resultList?.result ?? [];
    if (results.length === 0) {
      throw new EmptyResultError(
        'Europe PMC',
        'No Europe PMC records matched. Broaden the query or drop the source/field restrictions.',
      );
    }

    const body = results
      .map((record) => {
        const id = record.pmid != null ? `PMID ${record.pmid}` : (record.id ?? 'record');
        return [
          heading(`${id}${record.title != null ? ` — ${record.title}` : ''}`),
          definitionList([
            ['Authors', record.authorString],
            [
              'Journal',
              `${record.journalTitle ?? ''}${record.pubYear != null ? ` (${record.pubYear})` : ''}`,
            ],
            ['Source', record.source],
            ['Type', record.pubType],
            ['Cited by', record.citedByCount],
            ['Open access', record.isOpenAccess === 'Y' ? 'yes' : 'no'],
            ['DOI', record.doi],
          ]),
          record.abstractText != null ? `Abstract: ${excerpt(record.abstractText, 2_500)}` : '',
        ]
          .filter((part) => part.length > 0)
          .join('\n');
      })
      .join('\n\n');

    return composeResult({
      headline: `Europe PMC: ${(response.hitCount ?? results.length).toLocaleString('en-US')} record(s) match; showing ${results.length}.`,
      sections: [body],
      sources: [
        {
          name: 'Europe PMC search',
          url: `https://europepmc.org/search?query=${encodeURIComponent(query)}`,
        },
        ...results
          .filter((record) => record.doi != null || record.pmid != null || record.id != null)
          .map((record) => {
            const name = europePmcName(record);
            return { name, url: europePmcUrl(record) };
          }),
      ],
      notices: [
        'Preprints are indexed here but are not peer reviewed; label them as such.',
        'A high citation count reflects attention, not validity.',
      ],
      env,
    });
  },
});

const OPENALEX = 'https://api.openalex.org/works';

const OPENALEX_WORK_SELECT = [
  'id',
  'doi',
  'title',
  'publication_year',
  'cited_by_count',
  'ids',
  'referenced_works',
  'primary_location',
].join(',');

const OPENALEX_LINK_SELECT = 'id,doi,title,publication_year,cited_by_count,ids,primary_location';

interface OpenAlexWork {
  id?: string;
  doi?: string | null;
  title?: string | null;
  publication_year?: number | null;
  cited_by_count?: number | null;
  type?: string | null;
  open_access?: { is_oa?: boolean | null } | null;
  authorships?: Array<{ author?: { display_name?: string | null } | null }>;
  abstract_inverted_index?: Record<string, number[]> | null;
  ids?: { pmid?: string | null; doi?: string | null; pmcid?: string | null };
  referenced_works?: string[];
  primary_location?: { source?: { display_name?: string | null } | null } | null;
}

function reconstructInvertedAbstract(
  index: Record<string, number[]> | null | undefined,
): string | undefined {
  if (index == null) {
    return undefined;
  }
  const positioned: Array<[number, string]> = [];
  for (const [word, offsets] of Object.entries(index)) {
    for (const pos of offsets) {
      positioned.push([pos, word]);
    }
  }
  if (positioned.length === 0) {
    return undefined;
  }
  positioned.sort((a, b) => a[0] - b[0]);
  return positioned.map((entry) => entry[1]).join(' ');
}

function parseOpenAlexFallbackQuery(raw: string): { search: string; yearFilter?: string } {
  const yearRange = /\bPUB_YEAR\s*:\s*\[\s*(\d{4})\s+TO\s+(\d{4})\s*\]/i.exec(raw);
  const yearSingle = /\bPUB_YEAR\s*:\s*(\d{4})\b/i.exec(raw);
  let yearFilter: string | undefined;
  if (yearRange != null) {
    yearFilter = `publication_year:${yearRange[1]}-${yearRange[2]}`;
  } else if (yearSingle != null) {
    yearFilter = `publication_year:${yearSingle[1]}`;
  }

  const cleaned = raw
    .replace(/\bPUB_YEAR\s*:\s*(?:\[\s*\d{4}\s+TO\s+\d{4}\s*\]|\d{4})/gi, ' ')
    .replace(/\b(?:SRC|OPEN_ACCESS|HAS_FT|IN_EPMC|IN_PMC)\s*:\s*[^\s)]+/gi, ' ')
    .replace(/\b(?:TITLE|ABSTRACT|AUTH|JOURNAL|KW)\s*:/gi, ' ')
    .replace(/[()]/g, ' ')
    .replace(/\b(?:AND|OR|NOT)\b/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  return { search: cleaned.length > 0 ? cleaned : raw.trim(), yearFilter };
}

/**
 * Answers `europe_pmc_search` through OpenAlex when EMBL-EBI's Solr search
 * cluster sheds load with HTTP 503 ("Search service is temporarily unavailable").
 * OpenAlex indexes PubMed, Europe PMC, and preprints with citation counts,
 * open-access status, and inverted-index abstracts, and the notice states
 * explicitly which upstream served the results.
 */
async function composeOpenAlexSearch(
  args: {
    query: string;
    max_results?: number;
    sort?: 'relevance' | 'most_cited' | 'most_recent';
    open_access_only?: boolean;
  },
  { env, http, cause }: ToolContext & { cause: unknown },
): Promise<ToolOutput> {
  const maxResults = clampInt(args.max_results, 1, 25, 8);
  const { search, yearFilter } = parseOpenAlexFallbackQuery(args.query);
  const filters: string[] = [];
  if (args.open_access_only === true) {
    filters.push('is_oa:true');
  }
  if (yearFilter != null) {
    filters.push(yearFilter);
  }
  const sortByMode: Record<string, string | undefined> = {
    most_cited: 'cited_by_count:desc',
    most_recent: 'publication_date:desc',
  };
  const upstream: Upstream = {
    service: 'OpenAlex',
    minIntervalMs: 150,
    cacheTtlMs: env.cacheTtlMs,
  };
  const mailto = env.contactEmail != null ? { mailto: env.contactEmail } : {};
  const response = await http.getJson<{ meta?: { count?: number }; results?: OpenAlexWork[] }>(
    OPENALEX,
    upstream,
    {
      query: {
        search,
        per_page: maxResults,
        select:
          'id,doi,title,publication_year,cited_by_count,type,open_access,authorships,abstract_inverted_index,ids,primary_location',
        ...(filters.length > 0 ? { filter: filters.join(',') } : {}),
        ...(args.sort != null && sortByMode[args.sort] != null
          ? { sort: sortByMode[args.sort] }
          : {}),
        ...mailto,
      },
    },
  );

  const results = response.results ?? [];
  if (results.length === 0) {
    throw new EmptyResultError(
      'OpenAlex (Europe PMC fallback)',
      'Europe PMC was temporarily unavailable and OpenAlex matched no records for that query. Broaden the search terms.',
    );
  }

  const body = results
    .map((work) => {
      const pmid = shortId(work.ids?.pmid);
      const idLabel = pmid != null ? `PMID ${pmid}` : (openAlexId(work) ?? 'record');
      const authors = (work.authorships ?? [])
        .map((entry) => entry.author?.display_name)
        .filter((name): name is string => !!name)
        .slice(0, 6)
        .join(', ');
      const doi = work.doi?.replace(/^https?:\/\/doi\.org\//, '') ?? shortId(work.ids?.doi);
      const abstract = reconstructInvertedAbstract(work.abstract_inverted_index);
      const journal = work.primary_location?.source?.display_name ?? '';
      return [
        heading(`${idLabel}${work.title != null ? ` — ${work.title}` : ''}`),
        definitionList([
          ['Authors', authors],
          [
            'Journal',
            `${journal}${work.publication_year != null ? ` (${work.publication_year})` : ''}`,
          ],
          ['Source', pmid != null ? 'MED (via OpenAlex)' : 'OpenAlex'],
          ['Type', work.type ?? undefined],
          ['Cited by', work.cited_by_count ?? undefined],
          ['Open access', work.open_access?.is_oa === true ? 'yes' : 'no'],
          ['DOI', doi],
        ]),
        abstract != null ? `Abstract: ${excerpt(abstract, 2_500)}` : '',
      ]
        .filter((part) => part.length > 0)
        .join('\n');
    })
    .join('\n\n');

  const reason = cause instanceof Error ? cause.message : 'upstream unreachable';
  return composeResult({
    headline: `Europe PMC (via OpenAlex fallback): ${(response.meta?.count ?? results.length).toLocaleString('en-US')} record(s) match; showing ${results.length}.`,
    sections: [body],
    sources: [
      {
        name: 'OpenAlex works search',
        url: `https://openalex.org/works?page=1&filter=default.search:${encodeURIComponent(search)}`,
      },
      ...results
        .map((work) => {
          const id = openAlexId(work);
          return id != null ? openAlexLink(work, id) : null;
        })
        .filter((entry): entry is SourceRef => entry != null),
    ],
    notices: [
      `Europe PMC search could not be reached (${reason}), so this search ran against OpenAlex (which indexes PubMed, Europe PMC, and preprints).`,
      'Preprints are indexed here as well (`type: posted-content` / `preprint`) and are not peer reviewed; label them as such.',
      'A high citation count reflects attention, not validity.',
    ],
    env,
  });
}

function openAlexId(work: OpenAlexWork): string | undefined {
  return work.id?.split('/').pop();
}

function openAlexLink(work: OpenAlexWork, fallback: string): SourceRef {
  const pmid = work.ids?.pmid?.split('/').pop();
  const doi = work.doi?.replace(/^https?:\/\/doi\.org\//, '') ?? work.ids?.doi?.split('/').pop();
  if (pmid != null) {
    return { name: `PMID ${pmid}`, url: `https://pubmed.ncbi.nlm.nih.gov/${pmid}/` };
  }
  if (doi != null) {
    return { name: doi, url: `https://doi.org/${doi}` };
  }
  return { name: `OpenAlex ${fallback}`, url: `https://openalex.org/${fallback}` };
}

/** Strips the `https://openalex.org/` prefix from an id list entry. */
function shortId(value: string | null | undefined): string | undefined {
  return value?.split('/').pop();
}

const literatureCitations = defineTool({
  name: 'literature_citations',
  group: 'literature',
  title: 'Trace citation links',
  readOnly: true,
  description:
    'Given PMIDs and/or DOIs, return how often each work has been cited and which later papers cite it (`direction: "cited_by"`), or which works it cites (`direction: "references"`), with titles, journals, years and links. Use it to check whether a finding was replicated, to find the trial a guideline or review is based on, or to trace a claim back to primary evidence before relying on it. Counts come from OpenAlex, where coverage of non-English, very old, and unindexed journals is partial.',
  inputSchema: {
    pmids: z.string().optional().describe('Up to 8 PMIDs, comma- or space-separated.'),
    dois: z
      .string()
      .optional()
      .describe(
        'Up to 8 DOIs, comma- or space-separated. "10.1056/NEJMoa2001233" or a doi.org URL.',
      ),
    direction: z
      .enum(['cited_by', 'references'])
      .optional()
      .describe(
        '`cited_by` for later papers citing these (default), `references` for their own references.',
      ),
    max_results: z
      .number()
      .int()
      .min(1)
      .max(25)
      .optional()
      .describe('Linked papers to list per work (default 6, max 25).'),
  },
  async handler(args, { env, http }: ToolContext): Promise<ToolOutput> {
    const pmids = [
      ...new Set(
        (args.pmids ?? '')
          .split(/[\s,]+/)
          .map((value) => value.trim())
          .filter((value) => /^\d{1,9}$/.test(value)),
      ),
    ].slice(0, 8);
    const dois = [
      ...new Set(
        (args.dois ?? '')
          .split(/[\s,]+/)
          .map((value) => value.replace(/^(https?:\/\/)?(dx\.)?doi\.org\//i, '').trim())
          .filter((value) => /^10\.\d{4,9}\/[^\s|]+$/.test(value)),
      ),
    ].slice(0, 8);
    if (pmids.length === 0 && dois.length === 0) {
      throw new EmptyResultError(
        'OpenAlex',
        'Provide at least one PMID or DOI, for example `pmids: "26751893"` or `dois: "10.1056/NEJMoa2001233"`.',
      );
    }

    const maxResults = clampInt(args.max_results, 1, 25, 6);
    const direction = args.direction ?? 'cited_by';
    /** OpenAlex asks for a contact address in the polite pool and throttles bursts. */
    const upstream: Upstream = {
      service: 'OpenAlex',
      minIntervalMs: 150,
      cacheTtlMs: env.cacheTtlMs,
    };
    const mailto = env.contactEmail != null ? { mailto: env.contactEmail } : {};

    const requested: Array<{ label: string; resolve: OpenAlexWork }> = [];
    const found = new Map<string, OpenAlexWork>();
    const searchWorks = async (filter: string, key: (work: OpenAlexWork) => string | undefined) => {
      if (filter.length === 0) {
        return;
      }
      const response = await http.getJson<{ results?: OpenAlexWork[] }>(OPENALEX, upstream, {
        query: { filter, per_page: 25, select: OPENALEX_WORK_SELECT, ...mailto },
      });
      for (const work of response.results ?? []) {
        const id = key(work);
        if (id != null && !found.has(id)) {
          found.set(id, work);
        }
      }
    };

    if (pmids.length > 0) {
      await searchWorks(`ids.pmid:${pmids.join('|')}`, (work) => shortId(work.ids?.pmid));
    }
    if (dois.length > 0) {
      await searchWorks(
        `doi:${dois.join('|').toLowerCase()}`,
        (work) => work.doi?.replace(/^https?:\/\/doi\.org\//, '') ?? shortId(work.ids?.doi),
      );
    }

    const blocks: string[] = [];
    const sources: SourceRef[] = [];
    const totals: Array<{ label: string; count: number; work: OpenAlexWork }> = [];
    let linked = 0;

    for (const [label, work] of found) {
      const workId = openAlexId(work);
      if (workId == null) {
        continue;
      }
      requested.push({ label, resolve: work });
      const citationCount = work.cited_by_count ?? 0;
      totals.push({ label, count: citationCount, work });

      const header = heading(
        `${direction === 'cited_by' ? 'Cited by' : 'References of'} ${work.title ?? label} — ${citationCount.toLocaleString('en-US')} citation(s)${
          work.publication_year != null ? `, published ${work.publication_year}` : ''
        }`,
      );
      const identity = definitionList([
        ['PMID', shortId(work.ids?.pmid) ?? 'not indexed'],
        ['DOI', work.doi?.replace(/^https?:\/\/doi\.org\//, '') ?? 'none'],
        ['Source', work.primary_location?.source?.display_name ?? 'unknown'],
        ['Open citations', String(citationCount)],
      ]);

      if (citationCount === 0) {
        blocks.push([header, identity, 'No citing works are indexed in OpenAlex.'].join('\n'));
        continue;
      }

      if (direction === 'references') {
        const referenced = (work.referenced_works ?? [])
          .map((id) => shortId(id))
          .filter((id): id is string => id != null)
          .slice(0, maxResults);
        if (referenced.length === 0) {
          blocks.push([header, identity, 'No reference list is indexed in OpenAlex.'].join('\n'));
          continue;
        }
        const response = await http.getJson<{ results?: OpenAlexWork[] }>(OPENALEX, upstream, {
          query: {
            filter: `openalex_id:${referenced.join('|')}`,
            per_page: referenced.length,
            select: OPENALEX_LINK_SELECT,
            ...mailto,
          },
        });
        const references = response.results ?? [];
        linked += references.length;
        blocks.push(
          [
            header,
            identity,
            `References indexed: ${references.length.toLocaleString('en-US')} of ${(work.referenced_works?.length ?? references.length).toLocaleString('en-US')}`,
            bulletList(
              references.map((reference) =>
                [
                  reference.title ?? 'untitled',
                  `${reference.primary_location?.source?.display_name ?? 'source n/a'}${
                    reference.publication_year != null ? ` ${reference.publication_year}` : ''
                  } — cited ${(reference.cited_by_count ?? 0).toLocaleString('en-US')} time(s)`,
                ].join(' — '),
              ),
            ),
          ].join('\n'),
        );
        for (const reference of references) {
          const id = openAlexId(reference);
          if (id != null) {
            sources.push(openAlexLink(reference, id));
          }
        }
        continue;
      }

      const citing = await http.getJson<{ results?: OpenAlexWork[] }>(OPENALEX, upstream, {
        query: {
          filter: `cites:${workId}`,
          sort: 'cited_by_count:desc',
          per_page: maxResults,
          select: OPENALEX_LINK_SELECT,
          ...mailto,
        },
      });
      const citingWorks = citing.results ?? [];
      linked += citingWorks.length;
      blocks.push(
        [
          header,
          identity,
          bulletList(
            citingWorks.map((citingWork) =>
              [
                citingWork.title ?? 'untitled',
                `${citingWork.primary_location?.source?.display_name ?? 'source n/a'}${
                  citingWork.publication_year != null ? ` ${citingWork.publication_year}` : ''
                } — cited ${(citingWork.cited_by_count ?? 0).toLocaleString('en-US')} time(s)`,
              ].join(' — '),
            ),
          ),
        ].join('\n'),
      );
      for (const citingWork of citingWorks) {
        const id = openAlexId(citingWork);
        if (id != null) {
          sources.push(openAlexLink(citingWork, id));
        }
      }
    }

    if (found.size === 0) {
      throw new EmptyResultError(
        'OpenAlex',
        `OpenAlex has no record for ${[...pmids.map((pmid) => `PMID ${pmid}`), ...dois.map((doi) => `DOI ${doi}`)].join(', ')}. Check the identifiers, or search by title with pubmed_search.`,
      );
    }

    const missing = [
      ...pmids.filter((pmid) => !found.has(pmid)).map((pmid) => `PMID ${pmid}`),
      ...dois.filter((doi) => !found.has(doi.toLowerCase())).map((doi) => `DOI ${doi}`),
    ];
    const mostCited = totals.reduce<{ label: string; count: number } | null>(
      (best, entry) =>
        best == null || entry.count > best.count
          ? { label: entry.label, count: entry.count }
          : best,
      null,
    );

    return composeResult({
      headline:
        `Citation trace for ${found.size} of ${pmids.length + dois.length} requested work(s): ` +
        `${totals.reduce((sum, entry) => sum + entry.count, 0).toLocaleString('en-US')} total citation(s), ` +
        `${linked.toLocaleString('en-US')} linked record(s) listed` +
        (mostCited != null
          ? `; most cited is ${mostCited.label} (${mostCited.count.toLocaleString('en-US')}).`
          : '.'),
      sections: blocks,
      sources: [...requested.map((entry) => openAlexLink(entry.resolve, entry.label)), ...sources],
      notices: [
        'A citation count measures attention, not validity: a widely cited paper can later be retracted or superseded. Check pubmed_search for retractions and later corrections before leaning on a finding.',
        direction === 'cited_by'
          ? 'The works listed are the most-cited citing papers, not a random sample and not a quality ranking; absence of later citations is not evidence against a result.'
          : "The reference list is what the authors cited, which may include background reading rather than the evidence supporting the paper's own claims.",
        'OpenAlex coverage of non-English journals, very old papers, and unindexed venues is partial; a zero here means "not indexed", not "never cited".',
        ...(missing.length > 0
          ? [`Not found in OpenAlex, so left out: ${missing.join(', ')}.`]
          : []),
      ],
      env,
    });
  },
});

export const literatureTools: ToolSpec[] = [
  pubmedSearch,
  pubmedArticle,
  readFullText,
  europePmcSearch,
  literatureCitations,
];
