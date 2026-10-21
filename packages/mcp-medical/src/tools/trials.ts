import { z } from 'zod';
import { EmptyResultError, UpstreamError } from '../errors.js';
import {
  bulletList,
  clampInt,
  composeResult,
  definitionList,
  excerpt,
  heading,
} from '../format.js';
import type { SourceRef, ToolOutput } from '../format.js';
import type { Upstream } from '../http.js';
import { defineTool } from '../types.js';
import type { ToolContext, ToolSpec } from '../types.js';

const CLINICAL_TRIALS = 'https://clinicaltrials.gov/api/v2';
const ONE_HOUR = 3_600_000;

function trialsUpstream(): Upstream {
  return { service: 'ClinicalTrials.gov', minIntervalMs: 250, cacheTtlMs: ONE_HOUR };
}

type Study = Record<string, unknown>;

function textAt(study: Study, ...path: string[]): string | undefined {
  let current: unknown = study;
  for (const key of path) {
    if (current == null || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return typeof current === 'string' ? current : undefined;
}

function sections(study: Study, ...path: string[]): unknown[] {
  let current: unknown = study;
  for (const key of path) {
    if (current == null || typeof current !== 'object') {
      return [];
    }
    current = (current as Record<string, unknown>)[key];
  }
  return Array.isArray(current) ? current : [];
}

interface TrialsResponse {
  studies?: Study[];
  totalCount?: number;
  nextPageToken?: string;
}

function summarizeStudy(study: Study): string {
  const phases = sections(study, 'protocolSection', 'designModule', 'phases');
  const statuses = sections(study, 'protocolSection', 'statusModule', 'overallStatus');
  const conditions = sections(study, 'protocolSection', 'conditionsModule', 'conditions');
  const interventions = sections(
    study,
    'protocolSection',
    'armsInterventionsModule',
    'interventions',
  )
    .map((intervention) => {
      const record = intervention as { type?: string; name?: string };
      return [record.type, record.name].filter((part) => !!part).join(': ');
    })
    .slice(0, 6);
  const enrollment = textAt(study, 'protocolSection', 'designModule', 'enrollmentInfo', 'count');
  const locations = sections(study, 'protocolSection', 'contactsLocationsModule', 'locations')
    .map((location) => {
      const record = location as {
        facility?: string;
        city?: string;
        country?: string;
        status?: string;
      };
      return [record.facility, record.city, record.country, record.status]
        .filter((part) => !!part)
        .join(', ');
    })
    .slice(0, 5);

  return [
    textAt(study, 'protocolSection', 'identificationModule', 'nctId') != null
      ? heading(
          `${textAt(study, 'protocolSection', 'identificationModule', 'nctId')} — ${
            textAt(study, 'protocolSection', 'identificationModule', 'briefTitle') ?? 'untitled'
          }`,
        )
      : '',
    excerpt(textAt(study, 'protocolSection', 'descriptionModule', 'briefSummary'), 600),
    definitionList([
      ['Status', statuses.join(', ')],
      ['Phase', phases.join(', ')],
      ['Conditions', conditions.join('; ')],
      ['Interventions', interventions.join('; ')],
      ['Enrollment', enrollment],
      ['Start', textAt(study, 'protocolSection', 'statusModule', 'startDateStruct', 'date')],
      [
        'Completion',
        textAt(study, 'protocolSection', 'statusModule', 'completionDateStruct', 'date'),
      ],
      [
        'Sponsor',
        textAt(study, 'protocolSection', 'sponsorCollaboratorsModule', 'leadSponsor', 'name'),
      ],
    ]),
    locations.length > 0 ? `Locations: ${locations.join(' | ')}` : '',
    `Link: https://clinicaltrials.gov/study/${
      textAt(study, 'protocolSection', 'identificationModule', 'nctId') ?? ''
    }`,
  ]
    .filter((part) => part.length > 0)
    .join('\n');
}

const clinicalTrials = defineTool({
  name: 'clinical_trials',
  group: 'trials',
  title: 'Search clinical trials',
  readOnly: true,
  description:
    'Search the ClinicalTrials.gov registry (API v2) by condition, intervention, or free text, filtered by recruitment status and phase; or pass an `nct_id` to read one trial in full, including eligibility criteria, arms, outcome measures, and contacts. Use it for "is this being studied", "what is the evidence base for", and "who can enrol". Registry status is self-reported by sponsors and lags in updates; a registered trial is not a positive result.',
  inputSchema: {
    query: z
      .string()
      .min(2)
      .optional()
      .describe(
        'Condition, intervention, or free-text search, e.g. "semaglutide obesity" or "GLP-1 receptor agonist".',
      ),
    nct_id: z
      .string()
      .regex(/^NCT\d{8}$/i)
      .optional()
      .describe('A single trial ID, e.g. "NCT03574597".'),
    status: z
      .enum([
        'RECRUITING',
        'NOT_YET_RECRUITING',
        'ENROLLING_BY_INVITATION',
        'ACTIVE_NOT_RECRUITING',
        'COMPLETED',
        'TERMINATED',
        'SUSPENDED',
        'WITHDRAWN',
      ])
      .optional()
      .describe('Restrict to a recruitment status.'),
    phase: z
      .enum(['EARLY_PHASE1', 'PHASE1', 'PHASE2', 'PHASE3', 'PHASE4', 'NA'])
      .optional()
      .describe('Restrict to a trial phase.'),
    max_results: z
      .number()
      .int()
      .min(1)
      .max(30)
      .optional()
      .describe('Studies to return (default 8, max 30).'),
  },
  async handler(args, { env, http }: ToolContext): Promise<ToolOutput> {
    const upstream = trialsUpstream();

    if (args.nct_id != null) {
      const nctId = args.nct_id.toUpperCase();
      let study: Study;
      try {
        study = await http.getJson<Study>(`${CLINICAL_TRIALS}/studies/${nctId}`, upstream);
      } catch (error) {
        if (error instanceof UpstreamError && error.status === 404) {
          throw new EmptyResultError(
            'ClinicalTrials.gov',
            `No study is registered under ${nctId}. Check the ID, or search with a query instead.`,
          );
        }
        throw error;
      }
      const eligibility =
        sections(study, 'protocolSection', 'eligibilityModule').length > 0
          ? excerpt(
              textAt(study, 'protocolSection', 'eligibilityModule', 'eligibilityCriteria'),
              2_500,
            )
          : '';
      const outcomes = sections(study, 'protocolSection', 'outcomesModule', 'primaryOutcomes')
        .map((outcome) => {
          const record = outcome as { measure?: string; timeFrame?: string };
          return [record.measure, record.timeFrame].filter((part) => !!part).join(' — ');
        })
        .slice(0, 8);
      return composeResult({
        headline: `ClinicalTrials.gov ${nctId}: ${textAt(study, 'protocolSection', 'identificationModule', 'briefTitle') ?? 'untitled'}.`,
        sections: [
          summarizeStudy(study),
          ...(eligibility.length > 0 ? [`${heading('Eligibility criteria')}\n${eligibility}`] : []),
          ...(outcomes.length > 0
            ? [`${heading('Primary outcomes')}\n${bulletList(outcomes)}`]
            : []),
        ],
        sources: [
          { name: `ClinicalTrials.gov ${nctId}`, url: `https://clinicaltrials.gov/study/${nctId}` },
        ],
        notices: [
          'Sponsors self-report status and results; a "completed" trial here may have no posted results, and a terminated trial may have failed for reasons never recorded.',
          'Registration is not publication: prefer pubmed_search for the results.',
        ],
        env,
      });
    }

    if (args.query == null) {
      throw new EmptyResultError(
        'ClinicalTrials.gov',
        'Provide either a `query` to search the registry or an `nct_id` to read one study.',
      );
    }

    const maxResults = clampInt(args.max_results, 1, 30, 8);
    /**
     * `query.term` searches every indexed field and is combined with itself
     * rather than with `query.cond`/`query.intr`: the registry ANDs different
     * query keys, so sending the same text as both a condition and an
     * intervention would return nothing for any term that is only one of them.
     */
    const params: Record<string, string | number> = {
      'query.term': args.query,
      pageSize: maxResults,
      format: 'json',
    };
    if (args.status != null) {
      params.filter = `overallStatus:${args.status}`;
    }
    if (args.phase != null) {
      params['filter.advanced'] = `AREA[Phase]${args.phase}`;
    }

    const response = await http.getJson<TrialsResponse>(`${CLINICAL_TRIALS}/studies`, upstream, {
      query: params,
    });
    const studies = response.studies ?? [];
    if (studies.length === 0) {
      throw new EmptyResultError(
        'ClinicalTrials.gov',
        `No registered study matched "${args.query}". Try a broader condition or intervention name, and drop the status filter.`,
      );
    }

    const sources: SourceRef[] = studies
      .map((study) => textAt(study, 'protocolSection', 'identificationModule', 'nctId'))
      .filter((id): id is string => id != null)
      .map((id) => ({ name: id, url: `https://clinicaltrials.gov/study/${id}` }));

    return composeResult({
      headline: `ClinicalTrials.gov: ${(response.totalCount ?? studies.length).toLocaleString('en-US')} study/ies match "${args.query}"; showing ${studies.length}.`,
      sections: studies.map((study) => summarizeStudy(study)),
      sources: [
        {
          name: 'ClinicalTrials.gov search',
          url: `https://clinicaltrials.gov/search?term=${encodeURIComponent(args.query)}`,
        },
        ...sources,
      ],
      notices: [
        'A registered trial is a plan, not evidence: read the results (pubmed_search) before treating a therapy as established.',
        'Recruitment status changes without notice; verify at the registry link before advising anyone to enrol.',
      ],
      env,
    });
  },
});

export const trialTools: ToolSpec[] = [clinicalTrials];
