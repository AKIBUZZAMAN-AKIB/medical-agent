import { loadEnv } from '../env.js';
import { EmptyResultError, UpstreamError } from '../errors.js';
import { buildUrl } from '../http.js';
import { allTools } from '../tools/index.js';
import type { ToolContext, ToolSpec } from '../types.js';
import type { HttpClient, RequestOptions, Upstream } from '../http.js';

const env = loadEnv({});

interface Call {
  url: string;
  method: 'GET' | 'POST';
  query?: RequestOptions['query'];
  body?: unknown;
}

type Responder = (url: string, body?: unknown) => { status?: number; body: unknown };

/**
 * A hand-driven HTTP client: every request is recorded, and a responder returns
 * the payload per URL. Tool behaviour that depends on which upstream answered,
 * or on how a query string was built, is testable without a network.
 */
function fakeHttp(responder: Responder): { http: HttpClient; calls: Call[] } {
  const calls: Call[] = [];
  const client = {
    async getJson(base: string, _upstream: Upstream, options: RequestOptions = {}) {
      calls.push({ url: base, method: 'GET', query: options.query });
      return responder(buildUrl(base, options.query)).body as never;
    },
    async getText(base: string, _upstream: Upstream, options: RequestOptions = {}) {
      calls.push({ url: base, method: 'GET', query: options.query });
      return String(responder(buildUrl(base, options.query)).body);
    },
    async postJson(base: string, _upstream: Upstream, body: unknown, options: RequestOptions = {}) {
      calls.push({ url: base, method: 'POST', query: options.query, body });
      return responder(buildUrl(base, options.query), body).body as never;
    },
  };
  return { http: client as unknown as HttpClient, calls };
}

function context(http: HttpClient): ToolContext {
  return { env, http };
}

function tool(name: string): ToolSpec {
  const found = allTools.find((candidate) => candidate.name === name);
  if (found == null) {
    throw new Error(`no such tool: ${name}`);
  }
  return found;
}

const OLDS_WORK = {
  id: 'https://openalex.org/W2158822657',
  doi: 'https://doi.org/10.1056/nejmoa012512',
  title: 'Reduction in the Incidence of Type 2 Diabetes with Lifestyle Intervention or Metformin',
  publication_year: 2002,
  cited_by_count: 19_190,
  ids: { pmid: 'https://pubmed.ncbi.nlm.nih.gov/11832527' },
  referenced_works: [],
  primary_location: { source: { display_name: 'N Engl J Med' } },
};

describe('literature_citations', () => {
  it('resolves a PMID through OpenAlex and reports the real citation count', async () => {
    const { http, calls } = fakeHttp((url) =>
      url.includes('openalex.org/works')
        ? { body: { results: [OLDS_WORK] } }
        : { body: { results: [] } },
    );

    const result = await tool('literature_citations').handler({ pmids: '11832527' }, context(http));

    expect(calls[0]?.query?.filter).toBe('ids.pmid:11832527');
    expect(result.text).toContain('19,190');
    expect(result.text).toContain('Reduction in the Incidence of Type 2 Diabetes');
    expect(result.text).toContain('https://pubmed.ncbi.nlm.nih.gov/11832527/');
  });

  it('lists the most-cited citing works with their own citation counts', async () => {
    const { http } = fakeHttp((url) =>
      url.includes('cites=') || url.includes('cites%3A') || url.includes('cites:')
        ? {
            body: {
              results: [
                {
                  id: 'https://openalex.org/W1',
                  title: 'A later meta-analysis',
                  publication_year: 2011,
                  cited_by_count: 900,
                  ids: { pmid: 'https://pubmed.ncbi.nlm.nih.gov/99999999' },
                  primary_location: { source: { display_name: 'BMJ' } },
                },
              ],
            },
          }
        : { body: { results: [OLDS_WORK] } },
    );

    const result = await tool('literature_citations').handler({ pmids: '11832527' }, context(http));

    expect(result.text).toContain('A later meta-analysis');
    expect(result.text).toContain('cited 900 time(s)');
    expect(result.text).toContain('https://pubmed.ncbi.nlm.nih.gov/99999999/');
  });

  it('accepts a doi.org URL and strips it to a bare DOI', async () => {
    const { http, calls } = fakeHttp(() => ({
      body: { results: [{ ...OLDS_WORK, doi: 'https://doi.org/10.1056/nejmoa012512' }] },
    }));

    await tool('literature_citations').handler(
      { dois: 'https://doi.org/10.1056/NEJMoa012512' },
      context(http),
    );

    expect(calls[0]?.query?.filter).toBe('doi:10.1056/nejmoa012512');
  });

  it('asks for no records when neither a PMID nor a DOI is usable', async () => {
    const { http, calls } = fakeHttp(() => ({ body: { results: [] } }));

    await expect(
      tool('literature_citations').handler({ dois: 'not-a-doi' }, context(http)),
    ).rejects.toBeInstanceOf(EmptyResultError);
    expect(calls).toHaveLength(0);
  });

  it('names the identifiers OpenAlex does not have instead of reporting zero', async () => {
    const { http } = fakeHttp(() => ({ body: { results: [] } }));

    await expect(
      tool('literature_citations').handler({ pmids: '11832527' }, context(http)),
    ).rejects.toBeInstanceOf(EmptyResultError);
  });

  it('warns that a citation count is attention, not validity', async () => {
    const { http } = fakeHttp(() => ({ body: { results: [OLDS_WORK] } }));

    const result = await tool('literature_citations').handler({ pmids: '11832527' }, context(http));

    expect(result.text).toContain('not validity');
  });
});

describe('entity resolution', () => {
  it('resolves a gene symbol through MyGene instead of guessing from search hits', async () => {
    const { http, calls } = fakeHttp((url, body) => {
      if (url.includes('mygene.info')) {
        return {
          body: {
            hits: [
              { symbol: 'BABAM2', ensembl: { gene: 'ENSG00000158019' }, taxid: 9606 },
              { symbol: 'BRCA1', ensembl: { gene: 'ENSG00000012048' }, taxid: 9606 },
            ],
          },
        };
      }
      const variables = (body as { variables?: { id?: string } } | undefined)?.variables;
      return {
        body: {
          data: {
            target: {
              id: variables?.id,
              approvedSymbol: 'BRCA1',
              approvedName: 'BRCA1 DNA repair associated',
              biotype: 'protein_coding',
              functionDescriptions: ['DNA repair'],
              tractability: [],
              associatedDiseases: { count: 0, rows: [] },
            },
          },
        },
      };
    });

    const result = await tool('gene_lookup').handler({ gene: 'BRCA1' }, context(http));

    expect(calls[0]?.query?.q).toBe('symbol:BRCA1');
    expect(result.text).toContain('BRCA1');
    expect(result.text).not.toContain('BABAM2');
  });

  it('reports a gene that resolves to nothing rather than answering about another gene', async () => {
    const { http, calls } = fakeHttp((url) =>
      url.includes('mygene.info') ? { body: { hits: [] } } : { body: { data: {} } },
    );

    await expect(
      tool('gene_lookup').handler({ gene: 'NOTAGENE' }, context(http)),
    ).rejects.toBeInstanceOf(EmptyResultError);
    expect(calls).toHaveLength(1);
  });

  it('resolves a disease name to the EBI concept, not to whatever sorts first', async () => {
    const { http, calls } = fakeHttp((url, body) => {
      if (url.includes('ols4')) {
        return {
          body: {
            response: {
              docs: [
                { label: 'atopic march', obo_id: 'EFO:0007755' },
                { label: 'atopic asthma', obo_id: 'EFO:0010638' },
              ],
            },
          },
        };
      }
      const variables = (body as { variables?: { id?: string } } | undefined)?.variables;
      return {
        body: {
          data: {
            disease: {
              id: variables?.id,
              name: 'atopic asthma',
              description: 'A chronic inflammatory disease of the airways',
              therapeuticAreas: [],
              associatedTargets: { count: 0, rows: [] },
              drugAndClinicalCandidates: { count: 0, rows: [] },
            },
          },
        },
      };
    });

    const result = await tool('condition_targets_and_drugs').handler(
      { condition: 'atopic asthma' },
      context(http),
    );

    expect(calls[0]?.query?.ontology).toBe('efo');
    expect((calls[1]?.body as { variables?: { id?: string } } | undefined)?.variables?.id).toBe(
      'EFO_0010638',
    );
    expect(result.text).toContain('atopic asthma');
    expect(result.text).not.toContain('atopic march');
  });
});

describe('provider_lookup', () => {
  it('searches by specialty and state without a provider name', async () => {
    const { http, calls } = fakeHttp(() => ({
      body: {
        result_count: 1,
        results: [
          {
            number: 1234567893,
            basic: { first_name: 'Ada', last_name: 'Lovelace', credential: 'MD' },
            addresses: [{ state: 'MA', city: 'Boston' }],
            taxonomies: [{ desc: 'Internal Medicine', code: '207R00000X' }],
          },
        ],
      },
    }));

    const result = await tool('provider_lookup').handler(
      { specialty: 'internal medicine', state: 'ma' },
      context(http),
    );

    expect(calls[0]?.query?.taxonomy_description).toBe('internal medicine');
    expect(calls[0]?.query?.state).toBe('MA');
    expect(calls[0]?.query?.first_name).toBeUndefined();
    expect(result.text).toContain('1234567893');
  });

  it('refuses a request with nothing to search on', async () => {
    const { http, calls } = fakeHttp(() => ({ body: { results: [] } }));

    await expect(tool('provider_lookup').handler({}, context(http))).rejects.toBeInstanceOf(
      EmptyResultError,
    );
    expect(calls).toHaveLength(0);
  });
});

describe('openFDA query construction', () => {
  it('joins alternative fields with a space so Lucene reads OR, not a literal term', async () => {
    const { http, calls } = fakeHttp(() => ({
      body: { results: [{ safetyrecallid: '1', recallingfirm: 'Acme' }] },
    }));

    await tool('drug_safety_actions').handler({ drug: 'amoxicillin' }, context(http));

    const search = String(calls[0]?.query?.search ?? '');
    expect(search).toContain(' OR ');
    expect(search).not.toContain('+OR+');
    expect(search).toContain('amoxicillin');
  });
});

describe('ChEMBL', () => {
  const molecule = {
    molecule_chembl_id: 'CHEMBL1431',
    pref_name: 'METFORMIN',
    max_phase: '4.0',
    first_approval: 1995,
    atc_classifications: ['A10BA02'],
  };

  it('reads the ATC code off the molecule instead of the filter ChEMBL ignores', async () => {
    const { http, calls } = fakeHttp((url) => {
      if (url.includes('atc_class')) {
        return {
          body: {
            atc: [
              {
                level5: 'A10BA02',
                who_name: 'metformin',
                level4: 'A10BA',
                level4_description: 'Biguanides',
                level3: 'A10B',
                level3_description: 'Blood glucose lowering drugs, excl. insulins',
                level1: 'A',
                level1_description: 'ALIMENTARY TRACT AND METABOLISM',
              },
            ],
          },
        };
      }
      return { body: { molecules: [molecule] } };
    });

    const result = await tool('drug_class_atc').handler({ drug: 'metformin' }, context(http));

    const atcCall = calls.find((call) => call.url.includes('atc_class'));
    expect(atcCall?.query).toMatchObject({ level5: 'A10BA02' });
    expect(atcCall?.query?.molecule_chembl_id).toBeUndefined();
    expect(result.text).toContain('A10BA02');
    expect(result.text).toContain('Biguanides');
  });

  it('reads a mechanism filed against the parent molecule', async () => {
    const { http, calls } = fakeHttp((url) => {
      if (url.includes('mechanism.json')) {
        if (!url.includes('parent_molecule_chembl_id')) {
          return { body: { mechanisms: [] } };
        }
        return {
          body: {
            mechanisms: [
              {
                mechanism_of_action: 'BCR-ABL inhibitor',
                action_type: 'INHIBITOR',
                target_chembl_id: 'CHEMBL1862',
                max_phase: 4,
                molecule_chembl_id: 'CHEMBL1201585',
              },
            ],
          },
        };
      }
      if (url.includes('target.json')) {
        return { body: { targets: [{ target_chembl_id: 'CHEMBL1862', pref_name: 'ABL1' }] } };
      }
      return { body: { activities: [] } };
    });

    const result = await tool('drug_bioactivity').handler({ drug: 'CHEMBL941' }, context(http));

    expect(calls.some((call) => call.query?.parent_molecule_chembl_id === 'CHEMBL941')).toBe(true);
    expect(result.text).toContain('BCR-ABL inhibitor');
    expect(result.text).toContain('ABL1 (CHEMBL1862)');
  });
});

describe('compound_properties', () => {
  it('answers from ChEMBL and names the failure when PubChem is throttling', async () => {
    const { http } = fakeHttp((url) => {
      if (url.includes('pubchem')) {
        throw new UpstreamError('PubChem', 'is temporarily unavailable', { status: 503 });
      }
      if (url.includes('molecule/search.json')) {
        return { body: { molecules: [{ molecule_chembl_id: 'CHEMBL25', pref_name: 'ASPIRIN' }] } };
      }
      return {
        body: {
          molecule_properties: { full_mwt: '180.16', alogp: '1.31', hba: 4, hbd: 1, PSA: 63.6 },
          molecule_structures: { canonical_smiles: 'CC(=O)OC1=CC=CC=C1C(=O)O' },
        },
      };
    });

    const result = await tool('compound_properties').handler(
      { compound: 'aspirin' },
      context(http),
    );

    expect(result.text).toContain('ChEMBL CHEMBL25');
    expect(result.text).toContain('PubChem could not be reached');
    expect(result.text).toContain('180.16');
  });

  it('reports an unknown compound as an empty result rather than falling back', async () => {
    const { http } = fakeHttp((url) =>
      url.includes('pubchem') ? { body: { Fault: { Code: 'PUGREST.NotFound' } } } : { body: {} },
    );

    await expect(
      tool('compound_properties').handler({ compound: 'zzzznotacompound' }, context(http)),
    ).rejects.toBeInstanceOf(EmptyResultError);
  });
});
describe('drug_lactation', () => {
  /**
   * Shaped from a real Europe PMC response. The journal papers are first in
   * relevance order and the monograph is not obviously privileged, which is
   * exactly why selection is done by inspection rather than by position.
   */
  const METFORMIN_RESPONSE = {
    resultList: {
      result: [
        {
          id: '30000079',
          pmid: '30000079',
          title: 'Metformin',
          hasBook: 'Y',
          bookid: 'NBK501020',
          pubYear: '2006',
          abstractText:
            "Data from well-conducted studies indicate that metformin levels in milk are low and infants would receive less than 0.5% of their mother's weight-adjusted dosage.",
          fullTextUrlList: {
            fullTextUrl: [
              { url: 'http://europepmc.org/books/NBK501020' },
              { url: 'https://www.ncbi.nlm.nih.gov/books/NBK501020' },
            ],
          },
        },
        {
          id: '42630468',
          pmid: '42630468',
          title: 'GABA as an Overlooked Mediator of Metformin Action',
          journalTitle: 'Annals of neurosciences',
          pubYear: '2026',
        },
        {
          id: '30000365',
          pmid: '30000365',
          title: 'Bromocriptine',
          hasBook: 'Y',
          bookid: 'NBK501306',
        },
      ],
    },
  };

  it('returns the monograph for the drug that was asked about', async () => {
    const { http, calls } = fakeHttp(() => ({ body: METFORMIN_RESPONSE }));

    const result = await tool('drug_lactation').handler({ drug: 'metformin' }, context(http));

    expect(calls[0]?.query?.query).toBe('TITLE:"metformin" AND SRC:MED');
    expect(result.text).toContain('less than 0.5%');
    expect(result.text).toContain('https://www.ncbi.nlm.nih.gov/books/NBK501020');
    /** The paper about metformin is a real record, and reporting it here would
     *  be a confident answer to a different question. */
    expect(result.text).not.toContain('GABA as an Overlooked Mediator');
    expect(result.text).not.toContain('Bromocriptine');
  });

  it('refuses to substitute a different monograph for a missing one', async () => {
    const { http } = fakeHttp(() => ({ body: METFORMIN_RESPONSE }));

    await expect(
      tool('drug_lactation').handler({ drug: 'Dulaglutide' }, context(http)),
    ).rejects.toBeInstanceOf(EmptyResultError);
  });

  it('names the monographs it did find when the drug is not on file', async () => {
    const { http } = fakeHttp(() => ({ body: METFORMIN_RESPONSE }));

    /** The near-miss is a pointer, never a substitute: the error has to tell
     *  the caller what exists so it can ask again by name. */
    const error = await tool('drug_lactation')
      .handler({ drug: 'Bromocriptine Inhalation Powder' }, context(http))
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(EmptyResultError);
    expect((error as Error).message).toContain('Bromocriptine');
  });

  it('folds a formulation suffix onto the base-name monograph', async () => {
    const { http } = fakeHttp(() => ({ body: METFORMIN_RESPONSE }));

    const result = await tool('drug_lactation').handler(
      { drug: 'Bromocriptine ER 2.5 mg' },
      context(http),
    );

    expect(result.text).toContain('LactMed: Bromocriptine');
  });

  it('matches a salt to the base-name monograph', async () => {
    const { http } = fakeHttp(() => ({ body: METFORMIN_RESPONSE }));

    const result = await tool('drug_lactation').handler(
      { drug: 'Metformin hydrochloride' },
      context(http),
    );

    expect(result.text).toContain('LactMed: Metformin');
  });

  it('does not equate two drugs that differ only in a capital letter', async () => {
    /** The matcher folds case by lower-casing first. A character class that
     *  only admits lower case would otherwise delete the capitals and report a
     *  match between two unrelated monographs. */
    const { http } = fakeHttp(() => ({
      body: {
        resultList: {
          result: [
            { id: '1', title: 'FORMTerol', hasBook: 'Y', bookid: 'NBK501306' },
            { id: '2', title: 'Bromocriptine', hasBook: 'Y', bookid: 'NBK501307' },
          ],
        },
      },
    }));

    await expect(
      tool('drug_lactation').handler({ drug: 'formoterol' }, context(http)),
    ).rejects.toBeInstanceOf(EmptyResultError);
  });

  it('reports no monograph rather than an empty answer for an unknown substance', async () => {
    const { http } = fakeHttp(() => ({ body: { resultList: { result: [] } } }));

    const error = await tool('drug_lactation')
      .handler({ drug: 'zzzznotasubstance' }, context(http))
      .catch((thrown: unknown) => thrown);
    expect(error).toBeInstanceOf(EmptyResultError);
    expect((error as Error).message).toContain('resolve the generic name');
  });

  it('falls back to NCBI Entrez LactMed Bookshelf records when Europe PMC returns 503', async () => {
    const { http } = fakeHttp((url) => {
      if (url.includes('europepmc')) {
        throw new UpstreamError('Europe PMC', 'is temporarily unavailable', { status: 503 });
      }
      if (url.includes('esearch.fcgi')) {
        return { body: { esearchresult: { idlist: ['30000250'] } } };
      }
      return {
        body: `<PubmedArticleSet><PubmedBookArticle><BookDocument>
          <PMID>30000250</PMID>
          <ArticleIdList><ArticleId IdType="bookaccession">NBK501191</ArticleId></ArticleIdList>
          <ArticleTitle>Sertraline</ArticleTitle>
          <Abstract><AbstractText>Low levels of sertraline in breastmilk are usually not detected in infant serum.</AbstractText></Abstract>
        </BookDocument></PubmedBookArticle></PubmedArticleSet>`,
      };
    });

    const result = await tool('drug_lactation').handler({ drug: 'sertraline' }, context(http));

    expect(result.text).toContain('LactMed: Sertraline.');
    expect(result.text).toContain('not detected in infant serum');
    expect(result.text).toContain('https://www.ncbi.nlm.nih.gov/books/NBK501191/');
    expect(result.text).toContain('Europe PMC search could not be reached');
  });
});

describe('europe_pmc_search', () => {
  it('falls back to OpenAlex with reconstructed abstract and explicit notice when Europe PMC returns 503', async () => {
    const { http, calls } = fakeHttp((url) => {
      if (url.includes('europepmc')) {
        throw new UpstreamError('Europe PMC', 'is temporarily unavailable', { status: 503 });
      }
      return {
        body: {
          meta: { count: 42 },
          results: [
            {
              id: 'https://openalex.org/W3182424616',
              doi: 'https://doi.org/10.1056/NEJMoa2032183',
              title: 'Once-Weekly Semaglutide in Adults with Overweight or Obesity',
              publication_year: 2021,
              cited_by_count: 4200,
              type: 'article',
              open_access: { is_oa: true },
              ids: { pmid: 'https://pubmed.ncbi.nlm.nih.gov/33567185' },
              primary_location: { source: { display_name: 'N Engl J Med' } },
              authorships: [{ author: { display_name: 'Wilding JPH' } }],
              abstract_inverted_index: { Semaglutide: [0], reduced: [1], body: [2], weight: [3] },
            },
          ],
        },
      };
    });

    const result = await tool('europe_pmc_search').handler(
      { query: 'semaglutide AND SRC:MED', max_results: 3, open_access_only: true },
      context(http),
    );

    const oaCall = calls.find((call) => call.url.includes('openalex.org'));
    expect(oaCall?.query?.search).toBe('semaglutide');
    expect(oaCall?.query?.filter).toBe('is_oa:true');
    expect(result.text).toContain('PMID 33567185');
    expect(result.text).toContain('Semaglutide reduced body weight');
    expect(result.text).toContain('Europe PMC search could not be reached');
  });
});
