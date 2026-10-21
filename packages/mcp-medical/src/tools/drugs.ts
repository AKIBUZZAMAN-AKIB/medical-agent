import { z } from 'zod';
import { EmptyResultError, UpstreamError } from '../errors.js';
import {
  bulletList,
  clampInt,
  composeResult,
  definitionList,
  excerpt,
  heading,
  normalizeText,
} from '../format.js';
import type { ToolOutput } from '../format.js';
import type { ServerEnv } from '../env.js';
import type { HttpClient, Upstream } from '../http.js';
import { defineTool } from '../types.js';
import type { ToolContext, ToolSpec } from '../types.js';
import { extractSplSections, findSplSection } from '../spl-xml.js';

const RXNAV = 'https://rxnav.nlm.nih.gov/REST';
const OPENFDA = 'https://api.fda.gov';
const DAILYMED = 'https://dailymed.nlm.nih.gov/dailymed/services/v2';
const CHEMBL = 'https://www.ebi.ac.uk/chembl/api/data';
const PUBCHEM = 'https://pubchem.ncbi.nlm.nih.gov/rest/pug';
const EPMC = 'https://www.ebi.ac.uk/europepmc/webservices/rest';

const ONE_HOUR = 3_600_000;

function rxnavUpstream(): Upstream {
  return { service: 'RxNorm', minIntervalMs: 200, cacheTtlMs: ONE_HOUR };
}

function openfdaUpstream(service: string): Upstream {
  return { service, minIntervalMs: 260, cacheTtlMs: ONE_HOUR, emptyOnNotFound: true };
}

function dailymedUpstream(): Upstream {
  return { service: 'DailyMed', minIntervalMs: 300, cacheTtlMs: ONE_HOUR };
}

function chemblUpstream(): Upstream {
  return { service: 'ChEMBL', minIntervalMs: 200, cacheTtlMs: ONE_HOUR };
}

function pubchemUpstream(): Upstream {
  /**
   * PubChem throttles a busy client with `PUGREST.ServerBusy` and asks for a
   * wait of about 30 seconds, which does not fit the request budget a tool call
   * has. Two quick attempts, and ChEMBL answers when PubChem is throttling.
   */
  return {
    service: 'PubChem',
    minIntervalMs: 260,
    cacheTtlMs: ONE_HOUR,
    maxAttempts: 2,
  };
}

interface ChemblProperties {
  molecule_properties?: {
    full_mwt?: string;
    molecular_weight?: string;
    alogp?: string;
    hba?: number;
    hbd?: number;
    PSA?: number;
    rtb?: number;
    ro5_violations?: number;
    heavy_atoms?: number;
  };
  molecule_structures?: { canonical_smiles?: string | null };
}

/** ChEMBL's own property block, used when PubChem is throttling this client. */
async function chemblProperties(
  http: HttpClient,
  query: string,
): Promise<{ chemblId: string; properties: ChemblProperties }> {
  const { chemblId } = await resolveChemblId(http, query);
  const molecule = await http.getJson<ChemblProperties>(
    `${CHEMBL}/molecule/${chemblId}.json`,
    chemblUpstream(),
  );
  return { chemblId, properties: molecule };
}

/** openFDA's search grammar wraps terms in quotes, so quotes must not survive. */
function quoted(value: string): string {
  return `"${value.replace(/["\\]/g, ' ').trim()}"`;
}

/**
 * Builds an openFDA `search` expression. The clauses are joined with a space,
 * not a literal `+`: openFDA parses Lucene syntax after the query string is
 * decoded, so an encoded plus sign becomes part of a field name and matches
 * nothing.
 */
function openfdaSearch(...clauses: string[]): string {
  return clauses.length > 1 ? `(${clauses.join(' OR ')})` : (clauses[0] ?? '');
}

/** openFDA indexes labels under generic, brand and substance names. */
function labelSearch(drug: string): string {
  return openfdaSearch(
    `openfda.generic_name:${quoted(drug)}`,
    `openfda.brand_name:${quoted(drug)}`,
    `openfda.substance_name:${quoted(drug)}`,
  );
}

function openfdaKey(env: ServerEnv): Record<string, string> {
  return env.openfdaApiKey != null ? { api_key: env.openfdaApiKey } : {};
}

/** An openFDA 404 means "no record matched", which is an answer, not a failure. */
async function asEmpty<T>(service: string, run: () => Promise<T>, hint: string): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof UpstreamError && error.status === 404) {
      throw new EmptyResultError(service, hint);
    }
    throw error;
  }
}

interface RxNavApproximate {
  approximateGroup?: {
    candidate?: Array<{
      rxcui?: string;
      name?: string;
      termType?: string;
      score?: number;
      source?: string;
    }>;
  };
}

interface RxNavRelated {
  relatedGroup?: Record<string, { rxcui?: string; name?: string; tty?: string }[]>;
}

interface OpenFdaLabel {
  results?: Array<Record<string, unknown> & { openfda?: Record<string, string[]> }>;
  error?: { code?: string; message?: string };
}

const LABEL_SECTIONS: Record<string, { key: string; label: string }[]> = {
  indications: [{ key: 'indications_and_usage', label: 'Indications and usage' }],
  dosage: [{ key: 'dosage_and_administration', label: 'Dosage and administration' }],
  forms: [{ key: 'dosage_forms_and_strengths', label: 'Dosage forms and strengths' }],
  boxed_warning: [{ key: 'boxed_warning', label: 'Boxed warning' }],
  warnings: [{ key: 'warnings_and_cautions', label: 'Warnings and cautions' }],
  contraindications: [{ key: 'contraindications', label: 'Contraindications' }],
  interactions: [{ key: 'drug_interactions', label: 'Drug interactions' }],
  adverse_reactions: [{ key: 'adverse_reactions', label: 'Adverse reactions' }],
  populations: [
    { key: 'use_in_specific_populations', label: 'Use in specific populations' },
    { key: 'pediatric_use', label: 'Pediatric use' },
    { key: 'geriatric_use', label: 'Geriatric use' },
    { key: 'pregnancy', label: 'Pregnancy' },
  ],
  mechanism: [{ key: 'mechanism_of_action', label: 'Mechanism of action' }],
  pharmacology: [{ key: 'clinical_pharmacology', label: 'Clinical pharmacology' }],
  overdosage: [{ key: 'overdosage', label: 'Overdosage' }],
  patient_information: [{ key: 'information_for_patients', label: 'Information for patients' }],
};

const DEFAULT_SECTIONS = [
  'indications',
  'dosage',
  'boxed_warning',
  'contraindications',
  'interactions',
  'adverse_reactions',
  'populations',
] as const;

/**
 * DailyMed names its sections in regulatory prose (`INDICATIONS & USAGE SECTION`)
 * where openFDA uses field names (`indications_and_usage`), so the two vocabularies
 * are kept apart rather than guessed at call time.
 */
const SPL_SECTION_NAMES: Record<string, string> = {
  indications_and_usage: 'INDICATIONS',
  dosage_and_administration: 'DOSAGE',
  dosage_forms_and_strengths: 'DOSAGE FORMS',
  boxed_warning: 'BOXED WARNING',
  warnings_and_cautions: 'WARNINGS',
  contraindications: 'CONTRAINDICATIONS',
  drug_interactions: 'DRUG INTERACTIONS',
  adverse_reactions: 'ADVERSE REACTIONS',
  use_in_specific_populations: 'POPULATIONS',
  pediatric_use: 'PEDIATRIC USE',
  geriatric_use: 'GERIATRIC USE',
  pregnancy: 'PREGNANCY',
  mechanism_of_action: 'MECHANISM OF ACTION',
  clinical_pharmacology: 'CLINICAL PHARMACOLOGY',
  overdosage: 'OVERDOSAGE',
  information_for_patients: 'INFORMATION FOR PATIENTS',
};

async function fetchOpenFdaLabel(
  ctx: ToolContext,
  drug: string,
): Promise<{
  record: Record<string, unknown> & { openfda?: Record<string, string[]> };
  url: string;
}> {
  const { env, http } = ctx;
  const search = labelSearch(drug);
  const response = await asEmpty(
    'openFDA drug labels',
    () =>
      http.getJson<OpenFdaLabel>(
        `${OPENFDA}/drug/label.json`,
        openfdaUpstream('openFDA drug labels'),
        {
          query: { search, limit: 1, ...openfdaKey(env) },
        },
      ),
    `openFDA has no drug label matching "${drug}". Try the generic (non-brand) name, or check the spelling and whether the product is a combination (for example "amoxicillin clavulanate").`,
  );
  const record = response.results?.[0];
  if (record == null) {
    throw new EmptyResultError(
      'openFDA drug labels',
      `openFDA returned an empty label set for "${drug}". Try the generic name.`,
    );
  }
  return {
    record,
    url: `https://open.fda.gov/apis/drug/label.json?search=${encodeURIComponent(search)}`,
  };
}

function labelSectionText(record: Record<string, unknown>, keys: string[]): string {
  const parts: string[] = [];
  for (const key of keys) {
    const value = record[key];
    if (Array.isArray(value)) {
      for (const entry of value) {
        const text = normalizeText(typeof entry === 'string' ? entry : JSON.stringify(entry));
        if (text.length > 0) {
          parts.push(text);
        }
      }
    } else if (typeof value === 'string') {
      const text = normalizeText(value);
      if (text.length > 0) {
        parts.push(text);
      }
    }
  }
  return parts.join('\n\n');
}

const drugLookup = defineTool({
  name: 'drug_lookup',
  group: 'drugs',
  title: 'Resolve a drug name',
  readOnly: true,
  description:
    'Resolve a drug name to US normalized RxNorm concepts (RxCUI): generic, brand, clinical drug, dose form, and NDC product codes, with the synonym list RxNorm records. Use it as the first step whenever a question involves a specific medicine, so that label, interaction, and trial lookups target one unambiguous product. It resolves names only — it does not return dosing or safety information.',
  inputSchema: {
    drug: z
      .string()
      .min(2)
      .describe(
        'Drug name, brand or generic, e.g. "semaglutide", "Ozempic", "amoxicillin 500 mg".',
      ),
    max_candidates: z
      .number()
      .int()
      .min(1)
      .max(10)
      .optional()
      .describe('How many RxNorm candidates to list (default 5, max 10).'),
  },
  async handler(args, { env, http }: ToolContext): Promise<ToolOutput> {
    const maxCandidates = clampInt(args.max_candidates, 1, 10, 5);
    const response = await http.getJson<RxNavApproximate>(
      `${RXNAV}/approximateTerm.json`,
      rxnavUpstream(),
      { query: { term: args.drug, maxEntries: maxCandidates, option: 1 } },
    );

    const candidates = response.approximateGroup?.candidate ?? [];
    if (candidates.length === 0) {
      throw new EmptyResultError(
        'RxNorm',
        `RxNorm has no concept close to "${args.drug}". Check the spelling, use the generic name, or drop the strength and dosage form.`,
      );
    }

    const best = [...candidates].sort((a, b) => (b.score ?? 0) - (a.score ?? 0))[0];
    let related: RxNavRelated = {};
    let ndcs: Array<{ ndc?: string }> = [];
    if (best?.rxcui != null) {
      const rxcui = best.rxcui;
      const [relatedResponse, ndcResponse] = await Promise.all([
        http
          .getJson<RxNavRelated>(`${RXNAV}/rxcui/${rxcui}/related.json`, rxnavUpstream(), {
            query: { tty: 'SCD+SBD+BN+SY+SCDF+PIN' },
          })
          .catch(() => ({}) as RxNavRelated),
        http
          .getJson<{
            ndcs?: Array<{ ndc?: string }>;
          }>(`${RXNAV}/rxcui/${rxcui}/ndcs.json`, rxnavUpstream())
          .catch(() => ({ ndcs: [] })),
      ]);
      related = relatedResponse;
      ndcs = ndcResponse.ndcs ?? [];
    }

    const candidateRows = candidates.map((candidate) =>
      definitionList([
        ['Name', candidate.name],
        ['RxCUI', candidate.rxcui],
        ['Term type', candidate.termType],
        ['Match score', candidate.score],
        ['Source', candidate.source],
      ]),
    );

    const relatedGroups = related.relatedGroup ?? {};
    const namedGroup = (tty: string, limit = 12): string =>
      bulletList(
        (relatedGroups[tty] ?? [])
          .map((entry) => entry.name)
          .filter(Boolean)
          .slice(0, limit),
      );
    const ndcList = ndcs.map((entry) => entry.ndc).filter((ndc): ndc is string => !!ndc);

    return composeResult({
      headline: `RxNorm: ${candidates.length} candidate concept(s) for "${args.drug}".`,
      sections: [
        heading('Candidates'),
        candidateRows.join('\n\n'),
        heading('Related concepts for the best match'),
        definitionList([
          ['Brands', namedGroup('BN')],
          ['Clinical drugs (ingredient + form + strength)', namedGroup('SCD')],
          ['Precise ingredients', namedGroup('PIN')],
          ['Synonyms', namedGroup('SY', 15)],
          [
            'NDC products',
            ndcList.length > 0
              ? `${ndcList.length} code(s), e.g. ${ndcList.slice(0, 5).join(', ')}`
              : 'none returned',
          ],
        ]),
      ],
      sources: [
        {
          name: 'RxNorm approximateTerm',
          url: `${RXNAV}/approximateTerm.json?term=${encodeURIComponent(args.drug)}&maxEntries=${maxCandidates}`,
        },
        { name: 'RxNorm browser', url: `https://www.nlm.nih.gov/research/umls/rxnorm/` },
      ],
      notices: [
        'RxNorm covers US products only; a name with no candidate is often a non-US product, a supplement, or a device.',
        'Take the RxCUI from this call and pass the drug name to drug_label, drug_interaction_check, or clinical_trials — do not guess identifiers.',
      ],
      env,
    });
  },
});

const drugLabel = defineTool({
  name: 'drug_label',
  group: 'drugs',
  title: 'Read the official drug label',
  readOnly: true,
  description:
    'Return verbatim sections of the current regulatory label: indications, dosage, boxed warning, contraindications, drug interactions, adverse reactions, use in specific populations, mechanism, and overdosage. This is the authoritative source for how a medicine must be used — prefer it over any recall from memory for dosing, contraindications, pregnancy, renal adjustment, and interactions. `source` selects openFDA (default, structured SPL fields) or DailyMed (the labeler’s own current document).',
  inputSchema: {
    drug: z.string().min(2).describe('Generic or brand drug name, e.g. "warfarin".'),
    sections: z
      .array(z.string())
      .max(8)
      .optional()
      .describe(
        'Any of: indications, dosage, forms, boxed_warning, warnings, contraindications, interactions, adverse_reactions, populations, mechanism, pharmacology, overdosage, patient_information. Default: indications, dosage, boxed_warning, contraindications, interactions, adverse_reactions, populations.',
      ),
    source: z
      .enum(['openfda', 'dailymed'])
      .optional()
      .describe('`openfda` (default) or `dailymed`.'),
  },
  async handler(args, { env, http }: ToolContext): Promise<ToolOutput> {
    const requested = (args.sections ?? [...DEFAULT_SECTIONS]).map((name) => name.toLowerCase());
    const unknown = requested.filter((name) => !(name in LABEL_SECTIONS));
    if (unknown.length > 0) {
      throw new EmptyResultError(
        'label sections',
        `Unknown section(s): ${unknown.join(', ')}. Valid sections: ${Object.keys(LABEL_SECTIONS).join(', ')}.`,
      );
    }

    if (args.source === 'dailymed') {
      return dailymedLabel(args.drug, requested, { env, http });
    }

    const { record, url } = await fetchOpenFdaLabel({ env, http }, args.drug);
    const openfda = record.openfda ?? {};
    const blocks: string[] = [];
    for (const name of requested) {
      const definition = LABEL_SECTIONS[name];
      if (definition == null) {
        continue;
      }
      for (const { key, label } of definition) {
        const text = labelSectionText(record, [key]);
        if (text.length > 0) {
          blocks.push(`${heading(`${label} (${name})`)}\n${text}`);
        }
      }
    }

    if (blocks.length === 0) {
      throw new EmptyResultError(
        'openFDA drug labels',
        `The label for "${args.drug}" has none of the requested sections. This is common for older or animal/veterinary labels — try fewer sections, or a different product name.`,
      );
    }

    const effectiveTime =
      typeof record.effective_time === 'string' ? record.effective_time : undefined;
    return composeResult({
      headline: `Label for ${args.drug}${
        effectiveTime != null ? ` (FDA effective ${formatFdaDate(effectiveTime)})` : ''
      }.`,
      sections: [
        definitionList([
          ['Brand names', (openfda.brand_name ?? []).join(', ')],
          ['Generic names', (openfda.generic_name ?? []).join(', ')],
          ['Route', (openfda.route ?? []).join(', ')],
          ['Strengths and forms', labelSectionText(record, ['dosage_forms_and_strengths'])],
          ['RxCUI', (openfda.rxcui ?? []).join(', ')],
        ]),
        blocks.join('\n\n'),
      ],
      sources: [
        { name: 'openFDA drug label API', url },
        {
          name: 'openFDA',
          url: `https://open.fda.gov/apis/drug/label/`,
          note: 'keyless tier: 240 requests/minute, 1,000/day',
        },
      ],
      notices: [
        "Label text is regulatory text, not advice, and applying it to one person is a prescriber's job: report what the label says, name the patient factors a prescriber weighs (age, pregnancy, renal and hepatic function, other medicines), and stop there rather than working out what this individual should take.",
        'Combination products are labelled under the combination name; a single-ingredient label may not describe the product actually dispensed.',
        'The label shown is the most recent FDA-effective version returned by the API, which is not necessarily the newest version a pharmacy holds.',
      ],
      env,
    });
  },
});

async function dailymedLabel(
  drug: string,
  requested: string[],
  { env, http }: ToolContext,
): Promise<ToolOutput> {
  const listing = await http.getJson<{
    data?: Array<{ setid?: string; title?: string; published_date?: string; spl_version?: number }>;
  }>(`${DAILYMED}/spls.json`, dailymedUpstream(), {
    query: { drug_name: drug, pagesize: 5 },
  });
  const items = (listing.data ?? []).filter((item) => item.setid != null);
  if (items.length === 0) {
    throw new EmptyResultError(
      'DailyMed',
      `DailyMed has no label matching "${drug}". Try the labeler or brand name exactly as printed on the package.`,
    );
  }

  const wanted = new Map<string, string>();
  for (const name of requested) {
    for (const { key, label } of LABEL_SECTIONS[name] ?? []) {
      wanted.set(key, `${label} (${name})`);
    }
  }

  for (const item of items.slice(0, 3)) {
    const xml = await http.getText(
      `${DAILYMED}/spls/${item.setid}.xml`,
      dailymedUpstream(),
      {},
      'application/xml, text/xml;q=0.9',
    );
    const sections = extractSplSections(xml);
    const found: string[] = [];
    const seen = new Set<string>();
    for (const [key, label] of wanted) {
      /** SPL section names read `INDICATIONS & USAGE SECTION`, not the openFDA field name. */
      const needle = SPL_SECTION_NAMES[key] ?? key.replace(/_/g, ' ');
      const section = findSplSection(sections, needle);
      if (section == null || seen.has(section.name)) {
        continue;
      }
      seen.add(section.name);
      found.push(`${heading(`${label} — DailyMed "${section.name}"`)}\n${section.text}`);
    }
    if (found.length > 0) {
      return composeResult({
        headline: `DailyMed label for ${item.title ?? drug} (published ${item.published_date ?? 'unknown'}).`,
        sections: [
          definitionList([
            ['Label', item.title],
            ['Set ID', item.setid],
            ['Published', item.published_date],
            ['Version', item.spl_version],
          ]),
          found.join('\n\n'),
        ],
        sources: [
          {
            name: 'DailyMed label',
            url: `https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=${item.setid}`,
          },
        ],
        notices: [
          'DailyMed serves the current label as filed by the labeler; a manufacturer update may not be reflected everywhere yet.',
          'Where this differs from drug_label source=openfda, treat DailyMed as the label of record and say which one you used.',
        ],
        env,
      });
    }
  }

  throw new EmptyResultError(
    'DailyMed',
    `None of the ${items.length} DailyMed label(s) for "${drug}" contain the requested sections. Try fewer sections (for example: indications, warnings, interactions).`,
  );
}

function formatFdaDate(value: string): string {
  if (/^\d{8}$/.test(value)) {
    return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  }
  return value;
}

const drugInteractionCheck = defineTool({
  name: 'drug_interaction_check',
  group: 'drugs',
  title: 'Check two drugs against each other',
  readOnly: true,
  description:
    'Given two drugs, return each drug’s regulatory `Drug Interactions` and `Contraindications` label sections verbatim, and report whether the other drug is actually named in that text. Use it whenever two medicines are combined, when renal/hepatic dosing matters, or before adding anything to a regimen. It reads the official labels — it is not a curated interaction database, so an unmentioned pair is NOT a cleared pair: say that explicitly rather than implying safety.',
  inputSchema: {
    drug_a: z.string().min(2).describe('First drug, generic or brand name.'),
    drug_b: z.string().min(2).describe('Second drug, generic or brand name.'),
    max_chars_per_section: z
      .number()
      .int()
      .min(500)
      .max(20_000)
      .optional()
      .describe('Character cap per label section (default 4000).'),
  },
  async handler(args, { env, http }: ToolContext): Promise<ToolOutput> {
    const cap = clampInt(args.max_chars_per_section, 500, 20_000, 4_000);
    const sides: Array<{ role: string; drug: string; text: string; url: string; rxcui: string }> =
      [];

    for (const [role, drug] of [
      ['drug_a', args.drug_a],
      ['drug_b', args.drug_b],
    ] as const) {
      const { record, url } = await fetchOpenFdaLabel({ env, http }, drug);
      const text = labelSectionText(record, ['drug_interactions', 'contraindications']);
      sides.push({
        role,
        drug,
        text,
        url,
        rxcui: (record.openfda?.rxcui ?? []).join(', '),
      });
    }

    const findings = sides.flatMap((side) => {
      const other = sides.find((candidate) => candidate !== side);
      if (other == null) {
        return [];
      }
      const haystack = side.text.toLowerCase();
      const terms = [other.drug, ...other.drug.split(/[\s-]+/)].filter((term) => term.length > 3);
      const named = terms.some((term) =>
        new RegExp(`\\b${term.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(
          haystack,
        ),
      );
      return named
        ? [
            `${side.drug}'s label text names ${other.drug}: quote the passage and treat it as a labelled interaction until a pharmacist rules otherwise.`,
          ]
        : [
            `${side.drug}'s interaction and contraindication text does not mention ${other.drug}. That is an unlabelled pair, not a cleared one — report it as such.`,
          ];
    });

    return composeResult({
      headline: `Label-based interaction read for ${args.drug_a} + ${args.drug_b}.`,
      sections: sides.map((side) =>
        [
          heading(`${side.drug} (${side.role})`),
          excerpt(side.text, cap) ||
            'No interaction or contraindication section in the retrieved label.',
        ].join('\n'),
      ),
      sources: sides.map((side) => ({ name: `openFDA label — ${side.drug}`, url: side.url })),
      notices: [
        'This is a label text lookup, not an interaction engine: a pair can interact without either label naming the other (e.g. pharmacodynamic, additive QT, or transporter-mediated effects).',
        'For any real regimen change, state that a pharmacist or prescriber must confirm; this tool cannot clear a combination.',
        ...findings,
      ],
      env,
    });
  },
});

const drugSafetyActions = defineTool({
  name: 'drug_safety_actions',
  group: 'drugs',
  title: 'Check recalls and approval status',
  readOnly: true,
  description:
    'Check FDA regulatory action on a drug: `action: "recalls"` returns enforcement reports (classification, reason, lot-level product description, status, date), and `action: "approvals"` returns Drugs@FDA applications with sponsor, dosage form, marketing status, and submission history including withdrawals. Use it to answer "is this product recalled", "who markets it", or "was it withdrawn".',
  inputSchema: {
    drug: z.string().min(2).describe('Generic or brand drug name.'),
    action: z
      .enum(['recalls', 'approvals'])
      .optional()
      .describe('`recalls` (default) or `approvals`.'),
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
    const action = args.action ?? 'recalls';

    if (action === 'recalls') {
      const search = labelSearch(args.drug);
      const response = await asEmpty(
        'openFDA drug enforcement',
        () =>
          http.getJson<{
            results?: Array<Record<string, unknown>>;
          }>(`${OPENFDA}/drug/enforcement.json`, openfdaUpstream('openFDA drug enforcement'), {
            query: {
              search,
              limit: maxResults,
              sort: 'recall_initiation_date:desc',
              ...openfdaKey(env),
            },
          }),
        `openFDA has no enforcement report matching "${args.drug}". That means no recall on file for this name in this dataset, not a guarantee that none exists.`,
      );
      const results = response.results ?? [];
      const rows = results.map((record) =>
        [
          definitionList([
            ['Recall number', record.recall_number],
            ['Classification', record.classification],
            ['Status', record.status],
            ['Initiated', formatFdaDate(String(record.recall_initiation_date ?? ''))],
            ['Recalling firm', record.recalling_firm],
            ['Product', record.product_description],
            ['Reason', record.reason_for_recall],
            ['Distribution', record.distribution_pattern],
            ['Voluntary / mandated', record.voluntary_mandated],
          ]),
        ].join('\n'),
      );
      return composeResult({
        headline: `openFDA enforcement: ${results.length} record(s) for "${args.drug}".`,
        sections: [heading('Recalls and enforcement reports'), rows.join('\n\n')],
        sources: [
          {
            name: 'openFDA drug enforcement',
            url: `${OPENFDA}/drug/enforcement.json?search=${encodeURIComponent(search)}`,
          },
        ],
        notices: [
          'Enforcement reports are firm-initiated and self-reported; lots and dates are as filed and are not independently verified.',
          'A recall on one lot or one manufacturer says nothing about other lots. Always report the class, the lot, and the firm.',
        ],
        env,
      });
    }

    const search = labelSearch(args.drug);
    const response = await asEmpty(
      'openFDA Drugs@FDA',
      () =>
        http.getJson<{
          results?: Array<{
            application_number?: string;
            sponsor_name?: string;
            products?: Array<Record<string, unknown>>;
            submissions?: Array<Record<string, unknown>>;
          }>;
        }>(`${OPENFDA}/drug/drugsfda.json`, openfdaUpstream('openFDA Drugs@FDA'), {
          query: { search, limit: maxResults, ...openfdaKey(env) },
        }),
      `Drugs@FDA has no application matching "${args.drug}".`,
    );

    const results = response.results ?? [];
    const blocks = results.map((application) => {
      const products = (application.products ?? []).slice(0, 6).map((product) =>
        definitionList([
          ['Brand', product.brand_name],
          ['Dosage form', product.dosage_form],
          ['Route', product.route],
          ['Marketing status', product.marketing_status],
          ['Active ingredients', formatIngredients(product.active_ingredients)],
        ]),
      );
      const submissions = (application.submissions ?? [])
        .slice(0, 12)
        .map((submission) =>
          [
            `${String(submission.submission_type ?? '')} ${String(submission.submission_number ?? '')}`.trim(),
            String(submission.submission_status ?? ''),
            formatFdaDate(String(submission.submission_status_date ?? '')),
            submission.submission_class_code_description ?? submission.submission_class_code,
          ]
            .filter((part) => part != null && String(part).length > 0)
            .join(' — '),
        );
      const withdrawn = (application.submissions ?? []).filter((submission) =>
        /withdraw/i.test(String(submission.submission_status ?? '')),
      );
      return [
        heading(
          `${application.application_number ?? 'application'} — ${application.sponsor_name ?? 'sponsor n/a'}`,
        ),
        withdrawn.length > 0
          ? `WITHDRAWAL on file: ${withdrawn
              .map(
                (submission) =>
                  `${submission.submission_type}/${submission.submission_number} (${formatFdaDate(String(submission.submission_status_date ?? ''))})`,
              )
              .join(', ')}`
          : 'No withdrawal submission in the returned history.',
        products.length > 0 ? `${heading('Products')}\n${products.join('\n\n')}` : '',
        submissions.length > 0
          ? `${heading('Recent submissions')}\n${bulletList(submissions)}`
          : '',
      ]
        .filter((part) => part.length > 0)
        .join('\n');
    });

    return composeResult({
      headline: `Drugs@FDA: ${results.length} application(s) for "${args.drug}".`,
      sections: [blocks.join('\n\n')],
      sources: [
        {
          name: 'openFDA Drugs@FDA',
          url: `${OPENFDA}/drug/drugsfda.json?search=${encodeURIComponent(search)}`,
        },
      ],
      notices: [
        'A marketing status of "Discontinued" or "Withdrawn" is specific to that application and labeler; another generic may still be on the market.',
        'Approval history is not an efficacy judgement, and a supplement approval is often a labeling change rather than new evidence.',
      ],
      env,
    });
  },
});

function formatIngredients(value: unknown): string {
  if (!Array.isArray(value)) {
    return '';
  }
  return value
    .map((ingredient) => {
      const record = ingredient as { name?: string; strength?: string };
      return [record.name, record.strength].filter((part) => !!part).join(' ');
    })
    .filter((part) => part.length > 0)
    .join('; ');
}

const drugAdverseEventSummary = defineTool({
  name: 'drug_adverse_event_summary',
  group: 'drugs',
  title: 'Summarize reported adverse events',
  readOnly: true,
  description:
    'Return the most frequently reported MedDRA reaction terms in FDA FAERS spontaneous reports for a drug, as counts only. Use it to see which adverse effects are reported often enough to look up in the label. Counts are spontaneous reports with no denominator, heavy duplication, and no causality assessment — never present a count as an incidence or a risk.',
  inputSchema: {
    drug: z.string().min(2).describe('Drug name as recorded on reports; generic name works best.'),
    top_n: z
      .number()
      .int()
      .min(1)
      .max(30)
      .optional()
      .describe('How many reaction terms to return (default 10, max 30).'),
  },
  async handler(args, { env, http }: ToolContext): Promise<ToolOutput> {
    const topN = clampInt(args.top_n, 1, 30, 10);
    const search = openfdaSearch(
      `patient.drug.medicinalproduct:${quoted(args.drug)}`,
      `patient.drug.openfda.generic_name:${quoted(args.drug)}`,
    );
    const response = await asEmpty(
      'openFDA FAERS',
      () =>
        http.getJson<{ results?: Array<{ term?: string; count?: number }> }>(
          `${OPENFDA}/drug/event.json`,
          openfdaUpstream('openFDA FAERS'),
          {
            query: {
              search,
              count: 'patient.reaction.reactionmeddrapt.exact',
              limit: topN,
              ...openfdaKey(env),
            },
          },
        ),
      `FAERS has no reports matching "${args.drug}". Free-text product names in reports are inconsistent; try the generic name or a different spelling.`,
    );
    const results = response.results ?? [];
    return composeResult({
      headline: `FAERS: most reported reaction terms for "${args.drug}" (${results.length} term(s)).`,
      sections: [
        heading('Reported reaction terms'),
        bulletList(
          results.map(
            (row) =>
              `${row.term ?? 'unknown'}: ${row.count?.toLocaleString('en-US') ?? 0} report(s)`,
          ),
        ),
      ],
      sources: [
        {
          name: 'openFDA FAERS (drug/event)',
          url: `${OPENFDA}/drug/event.json?search=${encodeURIComponent(search)}`,
        },
      ],
      notices: [
        'These are spontaneous reports, not a controlled comparison: there is no denominator, the same case can be reported repeatedly, and a report is not proof of causation.',
        'Absence from this list is not absence of risk. For risk, use the label (drug_label) and, for a patient, the treating clinician.',
        'Report any suspected adverse reaction to the national pharmacovigilance programme; this tool does not file reports.',
      ],
      env,
    });
  },
});

interface ChemblMolecule {
  molecule_chembl_id?: string;
  pref_name?: string;
  max_phase?: number | string;
  first_approval?: number | string;
  withdrawn_flag?: string;
  atc_classifications?: string[];
}

async function resolveChemblId(
  http: HttpClient,
  query: string,
): Promise<{
  chemblId: string;
  name?: string;
  maxPhase?: unknown;
  firstApproval?: unknown;
  withdrawn?: boolean;
  atcCodes: string[];
}> {
  const search = await asEmpty(
    'ChEMBL',
    () =>
      http.getJson<{ molecules?: ChemblMolecule[] }>(
        `${CHEMBL}/molecule/search.json`,
        chemblUpstream(),
        {
          query: { q: query, limit: 5 },
        },
      ),
    `ChEMBL has no molecule matching "${query}". Try a chemical name, a brand name, or a ChEMBL ID.`,
  );
  const candidates = (search.molecules ?? []).filter(
    (molecule) => typeof molecule.molecule_chembl_id === 'string',
  );
  const best = candidates[0];
  if (best?.molecule_chembl_id == null) {
    throw new EmptyResultError('ChEMBL', `No usable ChEMBL molecule for "${query}".`);
  }
  return {
    chemblId: String(best.molecule_chembl_id),
    name: typeof best.pref_name === 'string' ? best.pref_name : undefined,
    maxPhase: best.max_phase,
    firstApproval: best.first_approval,
    withdrawn: best.withdrawn_flag === 'Y',
    atcCodes: Array.isArray(best.atc_classifications) ? best.atc_classifications : [],
  };
}

const drugClassAtc = defineTool({
  name: 'drug_class_atc',
  group: 'drugs',
  title: 'Look up a drug’s ATC class',
  readOnly: true,
  description:
    'Resolve a drug to its ChEMBL molecule and return its WHO ATC classification at every level (therapeutic class and pharmacological subgroup), plus the molecule’s maximum development phase, first approval year, and withdrawn flag. Use it for "what class is this drug in" and to find other members of a class by searching the class with drug_class_atc or a literature search.',
  inputSchema: {
    drug: z.string().min(2).describe('Drug name or ChEMBL ID.'),
  },
  async handler(args, { env, http }: ToolContext): Promise<ToolOutput> {
    const { chemblId, name, maxPhase, firstApproval, withdrawn, atcCodes } = await resolveChemblId(
      http,
      args.drug,
    );
    /**
     * ChEMBL's `atc_class` endpoint ignores `molecule_chembl_id` and answers with a
     * whole ATC level — asked for metformin it returned twenty unrelated
     * dental fluoride codes. The molecule record carries the codes assigned to
     * it, so each of those is resolved back to its own hierarchy.
     */
    const classes: Array<Record<string, string>> = [];
    for (const code of atcCodes.slice(0, 5)) {
      const rows = await http
        .getJson<{ atc?: Array<Record<string, string>> }>(
          `${CHEMBL}/atc_class.json`,
          chemblUpstream(),
          {
            query: { level5: code, limit: 1 },
          },
        )
        .catch(() => ({ atc: [] as Array<Record<string, string>> }));
      const row = rows.atc?.[0];
      if (row != null) {
        classes.push({ ...row, level5: row.level5 ?? code });
      }
    }
    return composeResult({
      headline:
        `ChEMBL ${chemblId}${name != null ? ` (${name})` : ''}: ` +
        (classes.length > 0
          ? `ATC ${classes.map((entry) => entry.level5).join(', ')}.`
          : 'no ATC code recorded.'),
      sections: [
        definitionList([
          ['Max phase', maxPhase],
          ['First approval', firstApproval],
          ['Withdrawn flag', withdrawn === true ? 'Y' : undefined],
        ]),
        ...classes.map((entry) =>
          [
            heading(`ATC ${entry.level5}${entry.who_name != null ? ` — ${entry.who_name}` : ''}`),
            definitionList([
              [
                'Pharmacological subgroup',
                `${entry.level4} ${entry.level4_description ?? ''}`.trim(),
              ],
              ['Therapeutic class', `${entry.level3} ${entry.level3_description ?? ''}`.trim()],
              ['Anatomical group', `${entry.level1} ${entry.level1_description ?? ''}`.trim()],
            ]),
          ].join('\n'),
        ),
        ...(classes.length === 0 && atcCodes.length > 0
          ? [
              `ChEMBL lists ${atcCodes.join(', ')} for this molecule but the hierarchy is not resolvable through the ChEMBL API.`,
            ]
          : []),
        ...(classes.length === 0 && atcCodes.length === 0
          ? [
              'ChEMBL has no ATC assignment for this molecule. ATC coverage in ChEMBL is partial: an unassigned code means "not recorded here", not "unclassified".',
            ]
          : []),
      ],
      sources: [
        {
          name: `ChEMBL molecule ${chemblId}`,
          url: `https://www.ebi.ac.uk/chembl/explore/compound/${chemblId}`,
        },
        ...(classes.length > 0
          ? [
              {
                name: `WHO ATC ${classes[0].level5}`,
                url: `https://atcddd.fhi.no/atc_ddd_index/?code=${classes[0].level5}`,
              },
            ]
          : []),
      ],
      notices: [
        'ATC is a classification, not a recommendation: a shared class implies neither similar efficacy nor interchangeability.',
        'Max phase and approval year describe regulatory history for the molecule, not for any specific formulation.',
      ],
      env,
    });
  },
});

const drugBioactivity = defineTool({
  name: 'drug_bioactivity',
  group: 'drugs',
  title: 'Look up mechanism and bioactivity',
  readOnly: true,
  description:
    'For a drug or ChEMBL ID, return its curated mechanism of action (action type, target, direct interaction, curator comment) and measured bioactivities against specific targets (assay, standard type/value/units, pChEMBL). Use it for "how does it work", "what does it hit", and to judge whether a target effect is potent enough to matter. Bioactivity is experimental, not clinical.',
  inputSchema: {
    drug: z.string().min(2).describe('Drug name or ChEMBL ID.'),
    max_activities: z
      .number()
      .int()
      .min(1)
      .max(25)
      .optional()
      .describe('Bioactivity rows to return (default 8, max 25).'),
  },
  async handler(args, { env, http }: ToolContext): Promise<ToolOutput> {
    const maxActivities = clampInt(args.max_activities, 1, 25, 8);
    const chemblId = /^CHEMBL\d+$/i.test(args.drug)
      ? args.drug.toUpperCase()
      : (await resolveChemblId(http, args.drug)).chemblId;

    const mechanismQuery = async (field: string) =>
      http
        .getJson<{
          mechanisms?: Array<Record<string, unknown>>;
        }>(`${CHEMBL}/mechanism.json`, chemblUpstream(), {
          query: { [field]: chemblId, limit: 10 },
        })
        .then((response) => response.mechanisms ?? [])
        .catch(() => [] as Array<Record<string, unknown>>);

    /**
     * ChEMBL files a curated mechanism against the salt or the exact form it was
     * described for, so imatinib (CHEMBL941) has no row of its own and the
     * record sits under the parent. Asking only for the molecule id reported
     * "no mechanism" for drugs whose mechanism ChEMBL does hold.
     */
    let mechanismRowsIn = (await mechanismQuery('molecule_chembl_id')) as Array<
      Record<string, unknown>
    >;
    let mechanismFromParent = false;
    if (mechanismRowsIn.length === 0) {
      const parent = await mechanismQuery('parent_molecule_chembl_id');
      mechanismRowsIn = parent;
      mechanismFromParent = parent.length > 0;
    }

    const activities = await http
      .getJson<{
        activities?: Array<Record<string, unknown>>;
      }>(`${CHEMBL}/activity.json`, chemblUpstream(), {
        query: { molecule_chembl_id: chemblId, limit: maxActivities },
      })
      .catch(() => ({ activities: [] as Array<Record<string, unknown>> }));

    /**
     * Mechanism rows carry a target id and no name, and the target is the point
     * of the record, so the distinct ids are resolved in one batched request.
     */
    const targetIds = [
      ...new Set(
        mechanismRowsIn
          .map((entry) => entry.target_chembl_id)
          .filter((id): id is string => typeof id === 'string'),
      ),
    ].slice(0, 20);
    const targetNames = new Map<string, string>();
    if (targetIds.length > 0) {
      const targets = await http
        .getJson<{
          targets?: Array<{ target_chembl_id?: string; pref_name?: string }>;
        }>(`${CHEMBL}/target.json`, chemblUpstream(), {
          query: { target_chembl_id__in: targetIds.join(','), limit: targetIds.length },
        })
        .catch(() => ({ targets: [] as Array<{ target_chembl_id?: string; pref_name?: string }> }));
      for (const target of targets.targets ?? []) {
        if (target.target_chembl_id != null && target.pref_name != null) {
          targetNames.set(target.target_chembl_id, target.pref_name);
        }
      }
    }

    const mechanismRows = mechanismRowsIn.map((entry) => {
      const targetId = typeof entry.target_chembl_id === 'string' ? entry.target_chembl_id : null;
      const targetName = targetId != null ? targetNames.get(targetId) : undefined;
      return definitionList([
        ['Mechanism', entry.mechanism_of_action],
        ['Action type', entry.action_type],
        [
          'Target',
          targetName != null
            ? `${targetName}${targetId != null ? ` (${targetId})` : ''}`
            : (targetId ?? entry.target_name),
        ],
        ['Direct interaction', entry.direct_interaction],
        ['Max phase', entry.max_phase],
        ['Curator comment', entry.mechanism_comment],
      ]);
    });

    const activityRows = (activities.activities ?? []).map((entry) =>
      definitionList([
        ['Target', entry.target_pref_name ?? entry.target_organism],
        ['Type', entry.standard_type],
        ['Value', `${entry.standard_value ?? 'n/a'} ${entry.standard_units ?? ''}`.trim()],
        ['pChEMBL', entry.pchembl_value],
        ['Assay', excerpt(entry.assay_description, 160)],
      ]),
    );

    if (mechanismRows.length === 0 && activityRows.length === 0) {
      throw new EmptyResultError(
        'ChEMBL',
        `ChEMBL has no mechanism or bioactivity data for ${chemblId}. It may be a biologic without small-molecule bioactivity, or a compound outside ChEMBL's scope.`,
      );
    }

    return composeResult({
      headline: `ChEMBL ${chemblId}: ${mechanismRows.length} mechanism record(s), ${activityRows.length} bioactivity row(s).`,
      sections: [
        mechanismRows.length > 0
          ? `${heading('Mechanism of action')}\n${mechanismRows.join('\n\n')}`
          : '',
        activityRows.length > 0 ? `${heading('Bioactivity')}\n${activityRows.join('\n\n')}` : '',
      ].filter((section) => section.length > 0),
      sources: [
        {
          name: `ChEMBL ${chemblId}`,
          url: `https://www.ebi.ac.uk/chembl/explore/compound/${chemblId}`,
        },
      ],
      notices: [
        'Bioactivity values are assay measurements, often in cell or in vitro systems; potency in an assay does not predict clinical effect or a safe dose.',
        'The mechanism record is curated by ChEMBL from the literature and the label; it can lag recent evidence.',
        ...(mechanismFromParent
          ? [
              'ChEMBL files this mechanism under the parent molecule rather than this exact entry, so the record describes the parent compound.',
            ]
          : []),
        ...(mechanismRows.length === 0
          ? [
              'ChEMBL curates mechanism records for a subset of drugs only; "no mechanism record" means this database has none, not that the drug has no known mechanism.',
            ]
          : []),
      ],
      env,
    });
  },
});

interface CompoundContext extends ToolContext {
  cause?: unknown;
}

/** Names the upstream failure briefly enough to sit inside a notice. */
function describeCause(cause: unknown): string {
  if (cause instanceof UpstreamError) {
    return cause.status != null ? `${cause.message} (HTTP ${cause.status})` : cause.message;
  }
  return cause instanceof Error ? cause.message : 'the request failed';
}

/**
 * Answers the compound question from ChEMBL when PubChem is unavailable, and
 * names the failure rather than passing a ChEMBL figure off as a PubChem one.
 */
async function composeChemblProperties(
  compound: string,
  context: CompoundContext,
): Promise<ToolOutput> {
  const { chemblId, properties } = await chemblProperties(context.http, compound);
  const values = properties.molecule_properties ?? {};
  return composeResult({
    headline: `ChEMBL ${chemblId}: physicochemical properties (PubChem did not answer).`,
    sections: [
      definitionList([
        ['Molecular weight (full)', values.full_mwt],
        ['Molecular weight (parent)', values.molecular_weight],
        ['ALogP', values.alogp],
        ['H-bond acceptors', values.hba],
        ['H-bond donors', values.hbd],
        ['Polar surface area (Å²)', values.PSA],
        ['Rotatable bonds', values.rtb],
        ['Lipinski rule-of-five violations', values.ro5_violations],
        ['Heavy atoms', values.heavy_atoms],
        ['Canonical SMILES', properties.molecule_structures?.canonical_smiles],
      ]),
    ],
    sources: [
      {
        name: `ChEMBL molecule ${chemblId}`,
        url: `https://www.ebi.ac.uk/chembl/explore/compound/${chemblId}`,
      },
    ],
    notices: [
      `PubChem could not be reached for "${compound}" (${describeCause(context.cause)}), so these values come from ChEMBL instead. They describe the parent molecule ChEMBL curates, which may be a different salt or stereoisomer than the compound asked for.`,
      'ChEMBL properties are computed descriptors, not measured values, and carry no clinical dosing or interaction data — use drug_label for that.',
    ],
    env: context.env,
  });
}

const compoundProperties = defineTool({
  name: 'compound_properties',
  group: 'drugs',
  title: 'Look up a chemical compound',
  readOnly: true,
  description:
    'Resolve a compound name to a PubChem CID and return formula, molecular weight, IUPAC name, canonical SMILES, InChI/InChIKey, XLogP, topological polar surface area, hydrogen-bond donors/acceptors, rotatable bonds, formal charge, and synonyms. Use it to check identity, salt vs free form, or physicochemical plausibility.',
  inputSchema: {
    compound: z.string().min(2).describe('Compound name, or a PubChem CID.'),
    max_synonyms: z
      .number()
      .int()
      .min(0)
      .max(30)
      .optional()
      .describe('Synonyms to list (default 8, max 30).'),
  },
  async handler(args, { env, http }: ToolContext): Promise<ToolOutput> {
    /** A throttled PubChem answers 503 immediately, so fail fast rather than hold the call. */
    const upstream = { ...pubchemUpstream(), maxAttempts: 2 };
    const pubchemRequest = { timeoutMs: 8_000 };
    const maxSynonyms = clampInt(args.max_synonyms, 0, 30, 8);
    let cid: string;
    try {
      if (/^\d+$/.test(args.compound)) {
        cid = args.compound;
      } else {
        const resolution = await asEmpty(
          'PubChem',
          () =>
            http.getJson<{ IdentifierList?: { CID?: number[] } }>(
              `${PUBCHEM}/compound/name/${encodeURIComponent(args.compound)}/cids/JSON`,
              upstream,
              pubchemRequest,
            ),
          `PubChem has no compound named "${args.compound}". Try a chemical name, an IUPAC fragment, or a CID.`,
        );
        const found = resolution.IdentifierList?.CID?.[0];
        if (found == null) {
          throw new EmptyResultError('PubChem', `No CID resolved for "${args.compound}".`);
        }
        cid = String(found);
      }
    } catch (error) {
      /**
       * PubChem answers a throttled client with `PUGREST.ServerBusy` rather
       * than a slower answer, and a tool that fails whenever one host is busy is
       * not a tool a clinician can rely on. ChEMBL carries the same
       * physicochemical block for a curated drug, and the result says so.
       */
      if (!(error instanceof EmptyResultError)) {
        return composeChemblProperties(args.compound, { env, http, cause: error });
      }
      throw error;
    }

    let properties: { PropertyTable?: { Properties?: Array<Record<string, unknown>> } };
    try {
      properties = await http.getJson<{
        PropertyTable?: { Properties?: Array<Record<string, unknown>> };
      }>(
        `${PUBCHEM}/compound/cid/${cid}/property/Title,MolecularFormula,MolecularWeight,IUPACName,CanonicalSMILES,InChI,InChIKey,XLogP,TPSA,HBondDonorCount,HBondAcceptorCount,RotatableBondCount,Charge/JSON`,
        upstream,
        pubchemRequest,
      );
    } catch (error) {
      return composeChemblProperties(args.compound, { env, http, cause: error });
    }
    const record = properties.PropertyTable?.Properties?.[0] ?? {};

    const synonyms =
      maxSynonyms > 0
        ? await http
            .getJson<{ InformationList?: { Information?: Array<{ Synonym?: string[] }> } }>(
              `${PUBCHEM}/compound/cid/${cid}/synonyms/JSON`,
              upstream,
              pubchemRequest,
            )
            .then((response) => response.InformationList?.Information?.[0]?.Synonym ?? [])
            .catch(() => [] as string[])
        : [];

    return composeResult({
      headline: `PubChem CID ${cid}: ${String(record.Title ?? args.compound)}.`,
      sections: [
        definitionList([
          ['Formula', record.MolecularFormula],
          ['Molecular weight', record.MolecularWeight],
          ['IUPAC name', record.IUPACName],
          ['SMILES', record.CanonicalSMILES],
          ['InChIKey', record.InChIKey],
          ['XLogP', record.XLogP],
          ['TPSA (Å²)', record.TPSA],
          ['H-bond donors', record.HBondDonorCount],
          ['H-bond acceptors', record.HBondAcceptorCount],
          ['Rotatable bonds', record.RotatableBondCount],
          ['Formal charge', record.Charge],
        ]),
        synonyms.length > 0
          ? `${heading('Synonyms')}\n${bulletList(synonyms.slice(0, maxSynonyms))}`
          : '',
      ].filter((section) => section.length > 0),
      sources: [
        { name: `PubChem CID ${cid}`, url: `https://pubchem.ncbi.nlm.nih.gov/compound/${cid}` },
      ],
      notices: [
        'A CID identifies a specific structure and salt/stereo form; two names can share a CID only when they are the same structure.',
        'PubChem does not carry clinical dosing or interaction data — use drug_label for that.',
      ],
      env,
    });
  },
});

/**
 * A Europe PMC hit that is a Bookshelf monograph rather than a journal article.
 * Europe PMC indexes the whole of NCBI Bookshelf, which is how LactMed is
 * reachable: the NLM runs no API of its own, and Bookshelf's Entrez records
 * carry no text through efetch.
 */
interface LactMedRecord {
  id?: string;
  pmid?: string;
  title?: string;
  abstractText?: string;
  hasBook?: string;
  bookid?: string;
  pubYear?: string;
  fullTextUrlList?: { fullTextUrl?: Array<{ url?: string; documentStyle?: string }> };
}

/**
 * Reduces a name to the form two drug names must share to be the same drug.
 * Salt, formulation and dose fragments are dropped because LactMed files a
 * monograph per substance under the base name ("Norfloxacin"), while a caller
 * hands over whatever it has — "Norfloxacin 400 mg tablets", "metformin HCl",
 * "bromocriptine ER 2.5 mg". Insisting on the exact string would report those
 * as missing records for drugs the database plainly covers, which is how a
 * lookup tool teaches its caller to stop trusting it.
 *
 * The character classes are lower-case only, so this folds case first: an
 * upper-case-only class would delete capitals rather than fold them, and would
 * quietly equate two unrelated drugs differing only in a capital letter.
 */
function lactMedKey(value: string): string {
  return normalizeText(value)
    .toLowerCase()
    .replace(
      /\b(sodium|potassium|calcium|magnesium|chloride|hydrochloride|hcl|sulfate|sulphate|succinate|tartrate|besylate|mesylate|maleate|citrate|acetate|phosphate|dihydrate|monohydrate|er|sr|dr|xl|la)\b/g,
      '',
    )
    .replace(/\b\d+(?:[.,]\d+)?\s*(?:mg|mcg|ug|µg|g|ml|dl|iu|units?|%|mmol)\b/g, '')
    .replace(
      /\b(?:tablets?|capsules?|cap|mcg|mg|qd|bid|tid|po|iv|oral|topical|cream|injection|solution|suspension)\b/g,
      '',
    )
    .replace(/[^a-z0-9]/g, '');
}

const drugLactation = defineTool({
  name: 'drug_lactation',
  group: 'drugs',
  title: 'Check a medicine for breastfeeding',
  readOnly: true,
  description:
    "Look a medicine up in LactMed, the NLM/NICHD peer-reviewed Drugs and Lactation Database, and return its summary of use during breastfeeding: how much reaches the milk, what the infant receives, and what effects have been reported. Use it for any question about a medicine and breastfeeding, a breastfed infant, or whether to pump and discard. LactMed covers a substance at a time and says nothing about the mother's dose, the infant's age or prematurity, or a combination product's other ingredient; the label and the prescriber decide the clinical use.",
  inputSchema: {
    drug: z
      .string()
      .min(2)
      .describe('Substance name, e.g. "metformin", "sertraline", "ibuprofen". One at a time.'),
  },
  async handler(args, { env, http }: ToolContext): Promise<ToolOutput> {
    const requested = args.drug.trim();
    const key = lactMedKey(requested);
    const upstream: Upstream = {
      service: 'Europe PMC (LactMed via NCBI Bookshelf)',
      minIntervalMs: 200,
      cacheTtlMs: env.cacheTtlMs,
    };

    /**
     * A title search brings back thousands of papers about the drug, and the
     * LactMed monograph is only one of them. It happens to sort first, but
     * "happens to" is not a selection rule: the record is chosen by requiring
     * that it is a Bookshelf monograph whose title resolves to the same drug,
     * and nothing else is ever returned in its place. Returning a paper about
     * metformin when asked about LactMed would be a confident answer to the
     * wrong question, which is the failure this package treats as worst.
     */
    const response = await http.getJson<{
      resultList?: { result?: LactMedRecord[] };
    }>(`${EPMC}/search`, upstream, {
      query: {
        query: `TITLE:"${requested.replace(/"/g, '')}" AND SRC:MED`,
        format: 'json',
        pageSize: 25,
        resultType: 'core',
      },
    });

    const candidates = (response.resultList?.result ?? []).filter(
      (record) => record.hasBook === 'Y' && (record.bookid ?? '').startsWith('NBK'),
    );
    const exact = candidates.find((record) => lactMedKey(record.title ?? '') === key);
    if (exact == null) {
      /**
       * Near-misses are the useful failure here. A caller who asked for a
       * combination product or a salt is usually one token away from a record
       * that exists, and naming it is more useful than an empty result — but
       * naming it is not the same as answering with it.
       */
      const nearby = candidates
        .map((record) => record.title)
        .filter((title): title is string => title != null)
        .slice(0, 8);
      throw new EmptyResultError(
        'LactMed (via Europe PMC)',
        nearby.length > 0
          ? `LactMed has no monograph titled "${requested}". Monographs in these results: ${nearby.join(', ')}. Ask about one of those by name, or check the combination product's ingredients separately.`
          : `LactMed has no monograph for "${requested}". It covers individual substances, so a combination product, a brand-only name, or a supplement will not be found — resolve the generic name with drug_lookup and ask again.`,
      );
    }

    const bookUrl =
      exact.fullTextUrlList?.fullTextUrl?.find((entry) =>
        entry.url?.includes('ncbi.nlm.nih.gov/books'),
      )?.url ?? `https://www.ncbi.nlm.nih.gov/books/${exact.bookid}/`;

    return composeResult({
      headline: `LactMed: ${exact.title}.`,
      sections: [
        `${heading('Summary of use during lactation')}\n${
          exact.abstractText != null && exact.abstractText.trim().length > 0
            ? excerpt(exact.abstractText, 4_000)
            : 'LactMed returned no summary text for this monograph; open the record for the full text.'
        }`,
        `Full record, including measured levels in milk and in infant blood: ${bookUrl}`,
      ],
      sources: [
        {
          name: `LactMed — ${exact.title} (NCBI Bookshelf ${exact.bookid})`,
          url: bookUrl,
        },
      ],
      notices: [
        'LactMed is a peer-reviewed database maintained by NLM with NICHD, built from the published literature and reviewed by experts; the summary above is its conclusion on the evidence, not a recommendation for this person.',
        "The measured levels, the studies behind them, and the record's last revision date are on the full record — read them there before reporting how much of a drug reaches milk as a precise figure.",
        'A "compatible with breastfeeding" summary is not a clearance for a specific infant. Weight, prematurity, postnatal age, the mother\'s dose, and the indication all change the decision, and that decision belongs to the prescriber and pharmacist.',
        'LactMed covers one substance at a time. For a combination product, look up each active ingredient; the safety of the combination is not implied by its parts.',
        'This says nothing about pregnancy. LactMed is a breastfeeding database; for pregnancy, use the label.',
      ],
      env,
    });
  },
});

export const drugTools: ToolSpec[] = [
  drugLookup,
  drugLabel,
  drugInteractionCheck,
  drugSafetyActions,
  drugAdverseEventSummary,
  drugClassAtc,
  drugBioactivity,
  compoundProperties,
  drugLactation,
];
