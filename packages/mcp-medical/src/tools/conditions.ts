import { z } from 'zod';
import type { ToolContext, ToolSpec } from '../types.js';
import type { ToolOutput } from '../format.js';
import type { Upstream } from '../http.js';
import {
  bulletList,
  clampInt,
  composeResult,
  definitionList,
  excerpt,
  heading,
} from '../format.js';
import { EmptyResultError, UpstreamError } from '../errors.js';
import { ncbiUpstream } from './literature.js';
import { defineTool } from '../types.js';

const MONARCH = 'https://api.monarchinitiative.org/v3/api';
const OPENTARGETS = 'https://api.platform.opentargets.org/api/v4/graphql';
const OLS = 'https://www.ebi.ac.uk/ols4/api';
const UNIPROT = 'https://rest.uniprot.org/uniprotkb';
const CLINICALTABLES = 'https://clinicaltables.nlm.nih.gov/api';
const EUTILS = 'https://eutils.ncbi.nlm.nih.gov/entrez/eutils';

const ONE_DAY = 86_400_000;

function monarchUpstream(): Upstream {
  return { service: 'Monarch Initiative', minIntervalMs: 250, cacheTtlMs: ONE_DAY };
}

interface MonarchSearch {
  items?: Array<{
    id?: string;
    name?: string;
    description?: string;
    category?: string;
    xref?: string[];
    synonym?: string[];
  }>;
  total?: number;
}

const conditionLookup = defineTool({
  name: 'condition_lookup',
  group: 'conditions',
  title: 'Resolve a condition',
  readOnly: true,
  description:
    'Resolve a condition name to a curated disease concept (Monarch Initiative, MONDO-based) and return its definition, synonyms, and cross-references to ICD-10, ICD-9, DOID, Orphanet, MedGen and MeSH. Use it to turn a lay or clinical phrase into an identifier, and to check that two names refer to the same disease before comparing evidence. Identification only — it does not return treatments or outcomes.',
  inputSchema: {
    condition: z
      .string()
      .min(2)
      .describe('Condition name, e.g. "atopic dermatitis", "type 2 diabetes".'),
    max_results: z
      .number()
      .int()
      .min(1)
      .max(10)
      .optional()
      .describe('Concepts to list (default 5, max 10).'),
  },
  async handler(args, { env, http }: ToolContext): Promise<ToolOutput> {
    const maxResults = clampInt(args.max_results, 1, 10, 5);
    const response = await http.getJson<MonarchSearch>(`${MONARCH}/search`, monarchUpstream(), {
      query: { q: args.condition, category: 'biolink:Disease', limit: maxResults },
    });

    const items = response.items ?? [];
    if (items.length === 0) {
      throw new EmptyResultError(
        'Monarch Initiative',
        `No disease concept matched "${args.condition}". Try a disease name rather than a symptom, and check spelling.`,
      );
    }

    const body = items
      .map((item) =>
        [
          heading(`${item.name ?? 'unnamed'} (${item.id ?? 'no id'})`),
          excerpt(item.description, 700),
          definitionList([
            ['Synonyms', (item.synonym ?? []).slice(0, 8).join(', ')],
            ['Cross-references', (item.xref ?? []).slice(0, 20).join(', ')],
          ]),
        ]
          .filter((part) => part.length > 0)
          .join('\n'),
      )
      .join('\n\n');

    return composeResult({
      headline: `Monarch Initiative: ${items.length} disease concept(s) for "${args.condition}".`,
      sections: [body],
      sources: items
        .filter((item) => item.id != null)
        .map((item) => ({
          name: item.name ?? item.id ?? 'disease',
          url: `https://monarchinitiative.org/${item.id}`,
        })),
      notices: [
        'Concepts are community-curated and can lag new naming; if two entries look equally valid, say so rather than silently picking one.',
        'A definition is not a diagnosis, and nothing here says how a condition is managed.',
      ],
      env,
    });
  },
});

const EBI_TO_OT_ID = /^(EFO|MONDO|HP|ORDO|DOID|OTAR|OTLP)_\d+$/;

/** Runs one GraphQL document against the Open Targets platform. */
async function openTargets<T>(
  ctx: ToolContext,
  query: string,
  variables: Record<string, unknown>,
): Promise<T> {
  const response = await ctx.http.postJson<{ data?: T; errors?: Array<{ message?: string }> }>(
    OPENTARGETS,
    { service: 'Open Targets Platform', minIntervalMs: 250, cacheTtlMs: ONE_DAY },
    { query, variables },
  );
  if (response.errors != null && response.errors.length > 0) {
    throw new UpstreamError(
      'Open Targets Platform',
      `rejected the query: ${response.errors.map((error) => error.message).join('; ')}`,
    );
  }
  if (response.data == null) {
    throw new UpstreamError('Open Targets Platform', 'returned no data payload');
  }
  return response.data;
}

function toOpenTargetsId(termId: string): string {
  return termId.replace(':', '_');
}

/**
 * Resolves a disease name to an Open Targets disease id through EBI OLS.
 *
 * Open Targets' own `search` is a semantic index with no score: it returned
 * "cardiac arrest" for "atopic asthma" and nothing at all for "type 2 diabetes".
 * OLS is a curated vocabulary and returns the exact match first, and the
 * platform accepts both the `EFO_` and `MONDO_` namespaces OLS returns.
 */
async function resolveDiseaseId(
  ctx: ToolContext,
  query: string,
): Promise<{ id: string; name: string }> {
  const response = await ctx.http.getJson<{
    response?: { docs?: Array<{ label?: string; obo_id?: string; description?: string[] }> };
  }>(
    `${OLS}/search`,
    { service: 'EBI OLS', minIntervalMs: 250, cacheTtlMs: ONE_DAY },
    {
      query: {
        q: query,
        ontology: 'efo',
        rows: 20,
        fieldList: 'iri,label,obo_id,ontology_name,description',
      },
    },
  );
  const docs = (response.response?.docs ?? []).filter(
    (doc): doc is { label: string; obo_id: string; description?: string[] } =>
      doc.obo_id != null && EBI_TO_OT_ID.test(toOpenTargetsId(doc.obo_id)),
  );
  const normalized = query.trim().toLowerCase();
  const exact =
    docs.find((doc) => doc.label?.trim().toLowerCase() === normalized) ??
    docs.find((doc) => normalized.includes(doc.label?.trim().toLowerCase() ?? ''));
  const hit = exact ?? docs[0];
  if (hit == null) {
    throw new EmptyResultError(
      'EBI OLS',
      `No disease concept matched "${query}". Check the spelling, or look the concept up in another ontology (ontology_search) and pass the identifier.`,
    );
  }
  return { id: toOpenTargetsId(hit.obo_id), name: hit.label ?? query };
}

const MYGENE = 'https://mygene.info/v3';

/**
 * Resolves a gene symbol to an Ensembl gene id through MyGene.
 *
 * Open Targets' semantic search returns interaction partners rather than the
 * gene asked for — "BRCA1" came back as BABAM2 — and a medical tool that
 * silently answers about a different gene is worse than one that admits the
 * lookup failed.
 */
async function resolveGeneId(
  ctx: ToolContext,
  query: string,
): Promise<{ id: string; name: string }> {
  const trimmed = query.trim();
  if (/^ENSG\d{6,}$/i.test(trimmed)) {
    return { id: trimmed.toUpperCase(), name: trimmed.toUpperCase() };
  }
  const response = await ctx.http.getJson<{
    hits?: Array<{ symbol?: string; name?: string; ensembl?: { gene?: string }; taxid?: number }>;
  }>(
    `${MYGENE}/query`,
    { service: 'MyGene.info', minIntervalMs: 250, cacheTtlMs: ONE_DAY },
    {
      query: {
        q: `symbol:${trimmed}`,
        species: 'human',
        size: 5,
        fields: 'symbol,name,ensembl.gene,taxid',
      },
    },
  );
  const human = (response.hits ?? []).filter((hit) => hit.taxid == null || hit.taxid === 9606);
  const exact = human.find((hit) => hit.symbol?.toUpperCase() === trimmed.toUpperCase());
  const hit = exact ?? human[0];
  const ensembl = hit?.ensembl?.gene;
  if (ensembl == null) {
    throw new EmptyResultError(
      'MyGene.info',
      `No human gene matched "${trimmed}". Use an HGNC symbol (for example "BRCA1") or an Ensembl gene ID.`,
    );
  }
  return { id: ensembl, name: hit?.symbol ?? trimmed };
}

interface OtDiseaseData {
  disease?: {
    id?: string;
    name?: string;
    description?: string;
    therapeuticAreas?: Array<{ id?: string; name?: string }>;
    associatedTargets?: {
      count?: number;
      rows?: Array<{
        score?: number;
        target?: { id?: string; approvedSymbol?: string; biotype?: string };
      }>;
    };
    drugAndClinicalCandidates?: {
      count?: number;
      rows?: Array<{
        maxClinicalStage?: string;
        drug?: {
          id?: string;
          name?: string;
          drugType?: string;
          tradeNames?: Array<{ label?: string }>;
          mechanismsOfAction?: {
            rows?: Array<{ actionType?: string; mechanismOfAction?: string; targetName?: string }>;
          };
          drugWarnings?: Array<{ warningType?: string }>;
        };
      }>;
    };
  };
}

const conditionTargetsAndDrugs = defineTool({
  name: 'condition_targets_and_drugs',
  group: 'conditions',
  title: 'Targets and drugs for a condition',
  readOnly: true,
  description:
    'For a disease, return the human proteins most strongly associated with it (with association scores), and the drugs and clinical candidates being developed for it, with mechanism of action, trade names, and any black-box warnings. Use it to explain why a drug works for a condition, what else is in the pipeline, and which targets have the strongest genetic or trial evidence. Associations are evidence weights, not proof of causation; drug rows report development stage, not approval for this disease.',
  inputSchema: {
    condition: z
      .string()
      .min(2)
      .describe('Disease name, e.g. "atopic asthma", "rheumatoid arthritis".'),
    max_targets: z
      .number()
      .int()
      .min(1)
      .max(25)
      .optional()
      .describe('Associated targets to list (default 10, max 25).'),
    max_drugs: z
      .number()
      .int()
      .min(1)
      .max(25)
      .optional()
      .describe('Drugs and candidates to list (default 10, max 25).'),
  },
  async handler(args, ctx: ToolContext): Promise<ToolOutput> {
    const { env } = ctx;
    const maxTargets = clampInt(args.max_targets, 1, 25, 10);
    const maxDrugs = clampInt(args.max_drugs, 1, 25, 10);
    const disease = await resolveDiseaseId(ctx, args.condition);

    const data = await openTargets<OtDiseaseData>(
      ctx,
      `query Disease($id: String!, $targetSize: Int!) {
        disease(efoId: $id) {
          id
          name
          description
          therapeuticAreas { id name }
          associatedTargets(page: { index: 1, size: $targetSize }) {
            count
            rows { score target { id approvedSymbol biotype } }
          }
          drugAndClinicalCandidates {
            count
            rows {
              maxClinicalStage
              drug {
                id
                name
                drugType
                tradeNames { label }
                mechanismsOfAction { rows { actionType mechanismOfAction targetName } }
                drugWarnings { warningType }
              }
            }
          }
        }
      }`,
      { id: disease.id, targetSize: maxTargets },
    );

    const record = data.disease;
    if (record == null) {
      throw new EmptyResultError(
        'Open Targets Platform',
        `Open Targets has no record for ${disease.id}. Try a more specific disease name.`,
      );
    }

    const targets = (record.associatedTargets?.rows ?? []).map((row) =>
      definitionList([
        ['Target', `${row.target?.approvedSymbol ?? 'unknown'} (${row.target?.id ?? 'no id'})`],
        ['Biotype', row.target?.biotype],
        ['Association score', row.score?.toFixed(3)],
      ]),
    );

    const drugs = (record.drugAndClinicalCandidates?.rows ?? []).slice(0, maxDrugs).map((row) => {
      const warnings = [
        ...new Set((row.drug?.drugWarnings ?? []).map((warning) => warning.warningType)),
      ];
      const mechanisms = (row.drug?.mechanismsOfAction?.rows ?? [])
        .map((mechanism) =>
          [mechanism.mechanismOfAction, mechanism.targetName].filter((part) => !!part).join(' @ '),
        )
        .join('; ');
      return [
        definitionList([
          ['Drug', `${row.drug?.name ?? 'unknown'} (${row.drug?.id ?? 'no id'})`],
          ['Type', row.drug?.drugType],
          [
            'Trade names',
            (row.drug?.tradeNames ?? [])
              .map((trade) => trade.label)
              .filter(Boolean)
              .join(', '),
          ],
          ['Max clinical stage', row.maxClinicalStage],
          ['Mechanism', mechanisms],
          ['Warnings', warnings.length > 0 ? warnings.join(', ') : undefined],
        ]),
      ].join('\n');
    });

    return composeResult({
      headline: `Open Targets: ${record.name ?? disease.name} — ${
        record.associatedTargets?.count ?? targets.length
      } associated target(s), ${record.drugAndClinicalCandidates?.count ?? drugs.length} drug/candidate row(s).`,
      sections: [
        excerpt(record.description, 600),
        targets.length > 0
          ? `${heading(`Associated targets (top ${targets.length})`)}\n${targets.join('\n\n')}`
          : '',
        drugs.length > 0
          ? `${heading(`Drugs and clinical candidates (top ${drugs.length})`)}\n${drugs.join('\n\n')}`
          : '',
        (record.therapeuticAreas ?? []).length > 0
          ? `${heading('Therapeutic areas')}\n${bulletList(
              (record.therapeuticAreas ?? []).map((area) => area.name ?? area.id),
            )}`
          : '',
      ].filter((section) => section.length > 0),
      sources: [
        {
          name: `Open Targets — ${record.name ?? disease.name}`,
          url: `https://platform.opentargets.org/disease/${record.id ?? disease.id}/associations`,
        },
      ],
      notices: [
        'Target association scores combine genetics, expression, literature and trial evidence; a high score is not proof that targeting the protein treats this disease.',
        'Max clinical stage is the most advanced phase reached for any indication, not for this disease: a phase 3 row may be investigational here.',
        'A black-box warning attached to a drug is a label-level fact about that drug, not about this disease.',
      ],
      env,
    });
  },
});

interface OtTargetData {
  target?: {
    id?: string;
    approvedSymbol?: string;
    approvedName?: string;
    biotype?: string;
    /** Open Targets returns the curated summary as one string, not a list. */
    functionDescriptions?: string;
    geneticConstraint?: { constraintType?: string; score?: number } | null;
    tractability?: Array<{ label?: string; modality?: string; value?: string }>;
    associatedDiseases?: {
      count?: number;
      rows?: Array<{ score?: number; disease?: { id?: string; name?: string } }>;
    };
  };
}

const geneLookup = defineTool({
  name: 'gene_lookup',
  group: 'conditions',
  title: 'Look up a gene',
  readOnly: true,
  description:
    'Resolve a gene symbol to its Open Targets record: approved name, biotype, function summary, genetic constraint, clinical tractability modalities, and the diseases with the strongest target-disease associations. Use it to answer "what does this gene do" and "what conditions is it linked to". Associations are evidence weights, not diagnoses; a constrained gene is not automatically disease-causing in a given person.',
  inputSchema: {
    gene: z.string().min(1).describe('HGNC gene symbol, e.g. "BRCA1", or an Ensembl gene ID.'),
    max_diseases: z
      .number()
      .int()
      .min(1)
      .max(25)
      .optional()
      .describe('Associated diseases to list (default 10, max 25).'),
  },
  async handler(args, ctx: ToolContext): Promise<ToolOutput> {
    const { env } = ctx;
    const maxDiseases = clampInt(args.max_diseases, 1, 25, 10);
    const target = await resolveGeneId(ctx, args.gene);

    const data = await openTargets<OtTargetData>(
      ctx,
      `query Target($id: String!, $diseaseSize: Int!) {
        target(ensemblId: $id) {
          id
          approvedSymbol
          approvedName
          biotype
          functionDescriptions
          geneticConstraint { constraintType score }
          tractability { label modality value }
          associatedDiseases(page: { index: 1, size: $diseaseSize }) {
            count
            rows { score disease { id name } }
          }
        }
      }`,
      { id: target.id, diseaseSize: maxDiseases },
    );

    const record = data.target;
    if (record == null) {
      throw new EmptyResultError(
        'Open Targets Platform',
        `Open Targets has no target record for ${target.id}. Use an HGNC-approved symbol.`,
      );
    }

    const diseases = (record.associatedDiseases?.rows ?? []).map((row) =>
      definitionList([
        ['Disease', `${row.disease?.name ?? 'unknown'} (${row.disease?.id ?? 'no id'})`],
        ['Association score', row.score?.toFixed(3)],
      ]),
    );

    return composeResult({
      headline: `Open Targets: ${record.approvedSymbol ?? target.name} (${record.id ?? target.id}).`,
      sections: [
        definitionList([
          ['Approved name', record.approvedName],
          ['Biotype', record.biotype],
          [
            'Genetic constraint',
            record.geneticConstraint
              ? `${record.geneticConstraint.constraintType}: ${record.geneticConstraint.score}`
              : undefined,
          ],
          [
            'Tractability',
            (record.tractability ?? [])
              .map((entry) => `${entry.label ?? entry.modality}: ${entry.value}`)
              .join('; '),
          ],
        ]),
        excerpt(record.functionDescriptions, 1_200),
        diseases.length > 0
          ? `${heading(
              `Associated diseases (top ${diseases.length} of ${record.associatedDiseases?.count ?? diseases.length})`,
            )}\n${diseases.join('\n\n')}`
          : '',
      ].filter((section) => section.length > 0),
      sources: [
        {
          name: `Open Targets — ${record.approvedSymbol ?? target.name}`,
          url: `https://platform.opentargets.org/target/${record.id ?? target.id}/associations`,
        },
      ],
      notices: [
        'Target-disease associations are aggregated evidence scores across datasources, not clinical findings in a patient.',
        'A genetic-constraint score is a population-level depletion measure; it is not a personalized risk estimate.',
      ],
      env,
    });
  },
});

const proteinLookup = defineTool({
  name: 'protein_lookup',
  group: 'conditions',
  title: 'Look up a protein',
  readOnly: true,
  description:
    'Search reviewed UniProtKB (Swiss-Prot) entries for a protein or gene and return accession, recommended name, gene names, sequence length, function, and curator-annotated disease involvement. Use it when the question is about the protein itself: what it does, where it sits in the cell, and which diseases curators have linked to it.',
  inputSchema: {
    protein: z
      .string()
      .min(1)
      .describe('Protein name or gene symbol, e.g. "CFTR", "insulin receptor".'),
    max_results: z
      .number()
      .int()
      .min(1)
      .max(10)
      .optional()
      .describe('Entries to list (default 3, max 10).'),
  },
  async handler(args, { env, http }: ToolContext): Promise<ToolOutput> {
    const maxResults = clampInt(args.max_results, 1, 10, 3);
    const query = `(${args.protein}) AND (organism_id:9606) AND (reviewed:true)`;
    const upstream: Upstream = { service: 'UniProt', minIntervalMs: 250, cacheTtlMs: ONE_DAY };
    const response = await http
      .getJson<{
        results?: Array<{
          primaryAccession?: string;
          uniProtkbId?: string;
          proteinDescription?: {
            recommendedName?: { fullName?: { value?: string } };
            submissionNames?: Array<{ fullName?: { value?: string } }>;
          };
          genes?: Array<{ geneName?: { value?: string }; synonyms?: Array<{ value?: string }> }>;
          sequence?: { length?: number; molWeight?: number };
          comments?: Array<{ commentType?: string; texts?: Array<{ value?: string }> }>;
        }>;
      }>(`${UNIPROT}/search`, upstream, {
        query: {
          query,
          size: maxResults,
          format: 'json',
          fields:
            'accession,id,protein_name,gene_names,length,cc_function,cc_disease,organism_name',
        },
      })
      .catch((error) => {
        if (error instanceof UpstreamError && error.status === 400) {
          throw new EmptyResultError(
            'UniProt',
            `UniProt could not parse the query for "${args.protein}". Use a protein name or gene symbol, e.g. "CFTR".`,
          );
        }
        throw error;
      });

    const results = response.results ?? [];
    if (results.length === 0) {
      throw new EmptyResultError(
        'UniProt',
        `No reviewed human UniProt entry matched "${args.protein}". This server only searches curated (Swiss-Prot) human entries.`,
      );
    }

    const commentText = (
      comments: Array<{ commentType?: string; texts?: Array<{ value?: string }> }> | undefined,
      type: string,
    ): string =>
      (comments ?? [])
        .filter((comment) => comment.commentType === type)
        .flatMap((comment) => comment.texts ?? [])
        .map((text) => excerpt(text.value, 1_500))
        .join('\n\n');

    const body = results
      .map((entry) => {
        const name =
          entry.proteinDescription?.recommendedName?.fullName?.value ??
          entry.proteinDescription?.submissionNames?.[0]?.fullName?.value;
        return [
          heading(
            `${name ?? entry.uniProtkbId ?? entry.primaryAccession} — ${entry.primaryAccession}`,
          ),
          definitionList([
            ['Entry name', entry.uniProtkbId],
            [
              'Gene',
              (entry.genes ?? [])
                .map((gene) => gene.geneName?.value)
                .filter(Boolean)
                .join(', '),
            ],
            [
              'Gene synonyms',
              (entry.genes ?? [])
                .flatMap((gene) => gene.synonyms ?? [])
                .map((synonym) => synonym.value)
                .filter(Boolean)
                .join(', '),
            ],
            ['Length', entry.sequence?.length],
            ['Molecular weight', entry.sequence?.molWeight],
          ]),
          commentText(entry.comments, 'FUNCTION').length > 0
            ? `Function: ${commentText(entry.comments, 'FUNCTION')}`
            : '',
          commentText(entry.comments, 'DISEASE').length > 0
            ? `Disease involvement (UniProt annotation): ${commentText(entry.comments, 'DISEASE')}`
            : '',
        ]
          .filter((part) => part.length > 0)
          .join('\n');
      })
      .join('\n\n');

    return composeResult({
      headline: `UniProt (reviewed human entries): ${results.length} match(es) for "${args.protein}".`,
      sections: [body],
      sources: results
        .filter((entry) => entry.primaryAccession != null)
        .map((entry) => ({
          name: entry.primaryAccession ?? 'entry',
          url: `https://www.uniprot.org/uniprotkb/${entry.primaryAccession}/entry`,
        })),
      notices: [
        'UniProt function and disease annotations are curator summaries of the literature; treat them as a well-sourced map, not as clinical guidance.',
        'Only reviewed human entries are searched, so an obscure or very new protein may return nothing.',
      ],
      env,
    });
  },
});

const OLS_ONTOLOGIES: Record<string, string> = {
  hp: 'Human Phenotype Ontology (phenotypes)',
  mondo: 'Monarch Disease Ontology (diseases)',
  ncit: 'NCI Thesaurus (cancer and clinical terms)',
  efo: 'Experimental Factor Ontology',
  doid: 'Human Disease Ontology',
};

const ontologySearch = defineTool({
  name: 'ontology_search',
  group: 'conditions',
  title: 'Search a biomedical ontology',
  readOnly: true,
  description:
    'Search the EBI Ontology Lookup Service for a term and return the matched concept, its identifier, definition, and synonyms, restricted to one ontology. Use it to standardize a phenotype or disease term: `hp` for Human Phenotype Ontology, `mondo` for disease concepts, `ncit` for cancer and clinical terms, `efo` for experimental factors, `doid` for diseases. Useful before a phenotype-based lookup so the same concept is named the same way twice.',
  inputSchema: {
    term: z.string().min(2).describe('Term to look up, e.g. "seizure", "atopy", "hypertension".'),
    ontology: z
      .enum(['hp', 'mondo', 'ncit', 'efo', 'doid'])
      .optional()
      .describe('Ontology to search (default `hp`).'),
    max_results: z
      .number()
      .int()
      .min(1)
      .max(20)
      .optional()
      .describe('Concepts to list (default 5, max 20).'),
  },
  async handler(args, { env, http }: ToolContext): Promise<ToolOutput> {
    const ontology = args.ontology ?? 'hp';
    const rows = clampInt(args.max_results, 1, 20, 5);
    const response = await http.getJson<{
      response?: {
        numFound?: number;
        docs?: Array<{
          label?: string;
          obo_id?: string;
          description?: string[];
          exact_synonyms?: string[];
          related_synonyms?: string[];
          ontology_prefix?: string;
          ontology_name?: string;
          iri?: string;
        }>;
      };
    }>(
      `${OLS}/search`,
      { service: 'EBI OLS', minIntervalMs: 250, cacheTtlMs: ONE_DAY },
      {
        query: { q: args.term, ontology, rows },
      },
    );

    const docs = response.response?.docs ?? [];
    if (docs.length === 0) {
      throw new EmptyResultError(
        'EBI OLS',
        `No ${OLS_ONTOLOGIES[ontology] ?? ontology} term matched "${args.term}". Try a simpler or more general term.`,
      );
    }

    const body = docs
      .map((doc) =>
        [
          heading(`${doc.label ?? 'unnamed'} (${doc.obo_id ?? 'no id'})`),
          (doc.description ?? [])
            .slice(0, 2)
            .map((definition) => excerpt(definition, 500))
            .join(' '),
          definitionList([
            ['Ontology', doc.ontology_name ?? doc.ontology_prefix],
            ['Exact synonyms', (doc.exact_synonyms ?? []).slice(0, 8).join(', ')],
            ['Related synonyms', (doc.related_synonyms ?? []).slice(0, 8).join(', ')],
          ]),
        ]
          .filter((part) => part.length > 0)
          .join('\n'),
      )
      .join('\n\n');

    return composeResult({
      headline: `EBI OLS (${OLS_ONTOLOGIES[ontology] ?? ontology}): ${
        response.response?.numFound ?? docs.length
      } match(es) for "${args.term}".`,
      sections: [body],
      sources: docs
        .filter((doc) => doc.obo_id != null)
        .map((doc) => ({
          name: `${doc.label ?? doc.obo_id} (${doc.obo_id})`,
          url:
            doc.iri != null
              ? `https://www.ebi.ac.uk/ols4/ontologies/${doc.ontology_name}/classes/${encodeURIComponent(doc.iri)}`
              : `https://www.ebi.ac.uk/ols4/search?q=${encodeURIComponent(args.term)}`,
        })),
      notices: [
        'Ontology terms are vocabulary, not evidence: a mapped term says how a concept is labelled, not how often it occurs or how it should be managed.',
        'OLS search is fuzzy, so re-read the definition before reusing a term as if it were the user’s exact wording.',
      ],
      env,
    });
  },
});

const icd10cmCode = defineTool({
  name: 'icd10cm_code',
  group: 'conditions',
  title: 'Expand an ICD-10-CM code',
  readOnly: true,
  description:
    'Expand an ICD-10-CM code or code prefix into matching codes with their official descriptions, using the NLM Clinical Tables service. Use it to expand a code to its subcategories (for example `E11` to its `.00`–`.9` children), or to confirm what a code means. This service matches on code text, so pass a code, not a disease name — use condition_lookup for names.',
  inputSchema: {
    code_prefix: z
      .string()
      .min(1)
      .describe('ICD-10-CM code or prefix, e.g. "E11", "J45.4", "I10".'),
    max_results: z
      .number()
      .int()
      .min(1)
      .max(50)
      .optional()
      .describe('Codes to return (default 10, max 50).'),
  },
  async handler(args, { env, http }: ToolContext): Promise<ToolOutput> {
    const maxResults = clampInt(args.max_results, 1, 50, 10);
    const response = await http.getJson<[number, string[] | null, unknown, string[][] | null]>(
      `${CLINICALTABLES}/icd10cm/v3/search`,
      { service: 'NLM Clinical Tables', minIntervalMs: 250, cacheTtlMs: ONE_DAY },
      { query: { terms: args.code_prefix.toUpperCase(), maxList: maxResults } },
    );

    const codes = response[1] ?? [];
    const rows = response[3] ?? [];
    if (codes.length === 0) {
      throw new EmptyResultError(
        'NLM Clinical Tables',
        `No ICD-10-CM code starts with "${args.code_prefix}". This lookup matches code text only — look the condition up by name with condition_lookup or ontology_search first.`,
      );
    }

    return composeResult({
      headline: `ICD-10-CM: ${response[0]} code(s) match "${args.code_prefix.toUpperCase()}"; showing ${codes.length}.`,
      sections: [bulletList(rows.map((row) => `${row[0]} — ${row[1] ?? ''}`.trim()))],
      sources: [
        {
          name: 'NLM Clinical Tables — ICD-10-CM',
          url: `${CLINICALTABLES}/icd10cm/v3/search?terms=${encodeURIComponent(args.code_prefix)}`,
        },
      ],
      notices: [
        'A code identifies a billing category, not a diagnosis: codes are assigned after a clinician has assessed the patient.',
        'ICD-10-CM is the US coding system; other countries use ICD-10 WHO or ICD-11, whose codes differ.',
      ],
      env,
    });
  },
});

const variantClinicalSignificance = defineTool({
  name: 'variant_clinical_significance',
  group: 'conditions',
  title: 'Check a variant in ClinVar',
  readOnly: true,
  description:
    "Search ClinVar for a gene or variant and return each record's accession, variant name, germline and clinical-impact classifications, review status, genes, and protein change. Use it to describe what is known about a variant's clinical significance. ClinVar classifies condition associations reported in the literature — it does not interpret a patient's result, and a \"pathogenic\" classification is a literature consensus, not a diagnosis.",
  inputSchema: {
    gene_or_variant: z
      .string()
      .min(2)
      .describe(
        'Gene symbol (e.g. "BRCA1"), a variant term, or an HGVS string, e.g. "NM_007294.4:c.68_69delAG".',
      ),
    max_results: z
      .number()
      .int()
      .min(1)
      .max(20)
      .optional()
      .describe('Records to return (default 5, max 20).'),
  },
  async handler(args, { env, http }: ToolContext): Promise<ToolOutput> {
    const maxResults = clampInt(args.max_results, 1, 20, 5);
    const upstream = ncbiUpstream(env, 'ClinVar via NCBI E-utilities');
    const query = args.gene_or_variant.trim();
    /**
     * ClinVar indexes far more than variants for a gene: an all-fields search
     * for BRCA1 returned 85,000 records, because large copy-number and
     * structural records carry the symbol too. Tagging a symbol with [gene]
     * asks for the gene's variants; an HGVS expression has to go through
     * untouched, and anything else stays a free-text search.
     */
    const isGeneSymbol = /^[A-Z][A-Z0-9-]{0,14}$/.test(query) && query === query.toUpperCase();
    /**
     * Entrez translates an untagged phrase itself — "CFTR F508del" becomes
     * `CFTR[All Fields] AND F508del[All Fields]` and matches, where appending
     * the tag by hand made the whole phrase one term and matched nothing.
     */
    const term = isGeneSymbol ? `${query}[gene]` : query;
    /**
     * A gene search is dominated by large copy-number and structural records
     * that carry no classification, and ClinVar's relevance sort puts them
     * first. More rows are fetched than are shown so that the displayed rows are
     * the ones with a classification to report.
     */
    const fetchSize = Math.min(Math.max(maxResults * 5, 25), 100);

    const search = await http.getJson<{
      esearchresult?: { idlist?: string[]; count?: string };
    }>(`${EUTILS}/esearch.fcgi`, upstream, {
      query: {
        db: 'clinvar',
        term,
        retmode: 'json',
        retmax: fetchSize,
        sort: 'relevance',
        tool: 'librechat-mcp-medical',
        email: env.contactEmail,
        api_key: env.ncbiApiKey,
      },
    });

    const ids = search.esearchresult?.idlist ?? [];
    if (ids.length === 0) {
      throw new EmptyResultError(
        'ClinVar',
        `ClinVar has no record matching "${args.gene_or_variant}". Check the HGVS string, or search the gene symbol instead.`,
      );
    }

    const summary = await http.getJson<{
      result?: Record<
        string,
        {
          accession_version?: string;
          title?: string;
          obj_type?: string;
          germline_classification?: {
            description?: string;
            review_status?: string;
            last_evaluated?: string;
          };
          clinical_impact_classification?: { description?: string; review_status?: string };
          record_status?: string;
          genes?: Array<{ symbol?: string; description?: string }>;
          protein_change?: string;
        }
      >;
    }>(`${EUTILS}/esummary.fcgi`, upstream, {
      query: {
        db: 'clinvar',
        id: ids.join(','),
        retmode: 'json',
        tool: 'librechat-mcp-medical',
        email: env.contactEmail,
        api_key: env.ncbiApiKey,
      },
    });

    const recordOf = (id: string) => summary.result?.[id];
    const hasClassification = (id: string) => {
      const record = recordOf(id);
      const description = record?.germline_classification?.description;
      return (
        description != null &&
        description.trim() !== '' &&
        !/^no classification/i.test(description.trim())
      );
    };
    const classified = ids.filter(hasClassification);
    const unclassified = ids.length - classified.length;
    const shown = (classified.length > 0 ? classified : ids).slice(0, maxResults);

    const body = shown
      .map((id) => {
        const record = recordOf(id);
        return [
          heading(
            `${record?.accession_version ?? id}${record?.title != null ? ` — ${record.title}` : ''}`,
          ),
          definitionList([
            ['Type', record?.obj_type],
            [
              'Gene',
              (record?.genes ?? [])
                .map((gene) => gene.symbol)
                .filter(Boolean)
                .join(', '),
            ],
            ['Protein change', record?.protein_change],
            ['Germline classification', record?.germline_classification?.description],
            ['Germline review status', record?.germline_classification?.review_status],
            ['Last evaluated', record?.germline_classification?.last_evaluated],
            ['Clinical impact', record?.clinical_impact_classification?.description],
            ['Record status', record?.record_status],
          ]),
          `Link: https://www.ncbi.nlm.nih.gov/clinvar/variation/${record?.accession_version ?? id}/`,
        ].join('\n');
      })
      .join('\n\n');

    const total = Number(search.esearchresult?.count ?? ids.length);
    return composeResult({
      headline:
        `ClinVar: ${total.toLocaleString('en-US')} record(s) for "${args.gene_or_variant}"; ` +
        `showing ${shown.length}` +
        (unclassified > 0
          ? ` classified record(s) and leaving out ${unclassified} with no classification.`
          : '.'),
      sections: [body],
      sources: [
        {
          name: 'ClinVar search',
          url: `https://www.ncbi.nlm.nih.gov/clinvar/?term=${encodeURIComponent(term)}`,
        },
      ],
      notices: [
        'ClinVar aggregates submitters’ assertions; conflicting interpretations are common, so always report the review status and the number of submitters behind a classification.',
        'A variant classification is not a patient result. Clinical interpretation needs the person’s own report, family history, and a qualified genetics professional.',
        'Germline and clinical-impact classifications answer different questions and are not interchangeable. Germline means a constitutional finding about the person; clinical impact usually comes from tumour sequencing. A tumour report with no germline entry is not a negative hereditary result, and a pathogenic germline entry is not a diagnosis of a hereditary condition in someone whose result was somatic.',
        ...(isGeneSymbol && total > 5_000
          ? [
              'A gene-symbol query also matches large copy-number and structural records, so the count is larger than the number of small variants. Records without any classification are left out of the list above; filter the ClinVar search by record type when that distinction matters.',
            ]
          : []),
        ...(classified.length === 0 && ids.length > 0
          ? [
              'None of the records returned carry a germline classification, which usually means the gene has no submitted assertions yet rather than that the gene is benign or disease-free.',
            ]
          : []),
      ],
      env,
    });
  },
});

export const conditionTools: ToolSpec[] = [
  conditionLookup,
  conditionTargetsAndDrugs,
  geneLookup,
  proteinLookup,
  ontologySearch,
  icd10cmCode,
  variantClinicalSignificance,
];
