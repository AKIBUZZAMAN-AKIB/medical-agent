import { z } from 'zod';
import type { ToolContext, ToolSpec } from '../types.js';
import type { ToolOutput } from '../format.js';
import type { Upstream } from '../http.js';
import { clampInt, composeResult, definitionList, excerpt, heading } from '../format.js';
import { EmptyResultError, UpstreamError } from '../errors.js';
import { defineTool } from '../types.js';

const OPENFDA = 'https://api.fda.gov';
const ONE_HOUR = 3_600_000;

function openfdaUpstream(service: string): Upstream {
  return { service, minIntervalMs: 260, cacheTtlMs: ONE_HOUR, emptyOnNotFound: true };
}

function quoted(value: string): string {
  return `"${value.replace(/["\\]/g, ' ').trim()}"`;
}

function openfdaKey(env: { openfdaApiKey?: string }): Record<string, string> {
  return env.openfdaApiKey != null ? { api_key: env.openfdaApiKey } : {};
}

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

const deviceApproval = defineTool({
  name: 'device_approval',
  group: 'devices',
  title: 'Check device clearance and classification',
  readOnly: true,
  description:
    'Search FDA device databases by device name: 510(k) clearances (applicant, device name, decision date, product code, statement of equivalence) and device classifications (device class I/II/III, regulation number, review panel, definition). Use it for "is this device cleared", "what class is it", and "who made it". Clearance is not approval: 510(k) means substantially equivalent to a predicate, and only class III devices go through premarket approval.',
  inputSchema: {
    device: z
      .string()
      .min(2)
      .describe('Device name or type, e.g. "cardiac pacemaker", "continuous glucose monitor".'),
    database: z
      .enum(['510k', 'classification'])
      .optional()
      .describe('`510k` (default) for clearances, `classification` for class and regulation.'),
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
    const is510k = (args.database ?? '510k') === '510k';
    const service = is510k ? 'openFDA 510(k)' : 'openFDA device classification';
    const field = is510k ? 'device_name' : 'device_name';
    const search = `${field}:${quoted(args.device)}`;

    const response = await asEmpty(
      service,
      () =>
        http.getJson<{ results?: Array<Record<string, unknown>> }>(
          `${OPENFDA}/device/${is510k ? '510k' : 'classification'}.json`,
          openfdaUpstream(service),
          {
            query: is510k
              ? { search, limit: maxResults, sort: 'decision_date:desc', ...openfdaKey(env) }
              : { search, limit: maxResults, ...openfdaKey(env) },
          },
        ),
      `${service} has no record matching "${args.device}". openFDA matches on the device name as filed; try a shorter generic term such as "pacemaker" or "glucose monitor".`,
    );

    const results = response.results ?? [];
    const rows = results.map((record) =>
      is510k
        ? [
            definitionList([
              ['K number', record.k_number],
              ['Device', record.device_name],
              ['Applicant', record.applicant],
              ['Decision date', record.decision_date],
              ['Decision', record.decision_description],
              ['Product code', record.product_code],
              ['Review panel', record.review_panel],
            ]),
            excerpt(record.statement_or_summary, 400),
            `Link: https://www.accessdata.fda.gov/scripts/cdrh/cfdocs/cfpmn/pmn.cfm?ID=${record.k_number}`,
          ].join('\n')
        : [
            definitionList([
              ['Device', record.device_name],
              ['Device class', record.device_class],
              ['Regulation number', record.device_regulation_number],
              ['Review panel', record.review_panel],
              ['Implant flag', record.implant_flag],
              ['Definition', excerpt(record.device_definition, 400)],
            ]),
            `Link: https://www.accessdata.fda.gov/scripts/cdrh/cfdocs/cfPCD/classification.cfm?ID=${String(
              record.device_regulation_number ?? '',
            )}`,
          ].join('\n'),
    );

    return composeResult({
      headline: `${service}: ${results.length} record(s) for "${args.device}".`,
      sections: [
        heading(is510k ? '510(k) clearances' : 'Device classifications'),
        rows.join('\n\n'),
      ],
      sources: [
        {
          name: service,
          url: `${OPENFDA}/device/${is510k ? '510k' : 'classification'}.json?search=${encodeURIComponent(search)}`,
        },
      ],
      notices: [
        '510(k) clearance means substantially equivalent to a predicate device, not that FDA found it safe and effective through premarket review.',
        'Off-label use is common and is not what these records describe; a cleared indication says nothing about use outside it.',
      ],
      env,
    });
  },
});

const safetyRecalls = defineTool({
  name: 'safety_recalls',
  group: 'devices',
  title: 'Check device and food recalls',
  readOnly: true,
  description:
    'Search FDA recall and enforcement reports for `domain: "device"` (device recalls, with device class, firm, reason, and dates) or `domain: "food"` (food enforcement reports, with product, hazard, classification, and distribution). Use it to answer whether a product is under recall and why. Always report the classification, the recalling firm, and the date: a recall is usually lot- or date-specific.',
  inputSchema: {
    product: z
      .string()
      .min(2)
      .describe('Product, brand, or food name, e.g. "infant formula", "silicone implant".'),
    domain: z.enum(['device', 'food']).optional().describe('`device` (default) or `food`.'),
    max_results: z
      .number()
      .int()
      .min(1)
      .max(20)
      .optional()
      .describe('Reports to return (default 5, max 20).'),
  },
  async handler(args, { env, http }: ToolContext): Promise<ToolOutput> {
    const maxResults = clampInt(args.max_results, 1, 20, 5);
    const isFood = args.domain === 'food';
    const service = isFood ? 'openFDA food enforcement' : 'openFDA device recall';
    const endpoint = isFood ? 'food/enforcement.json' : 'device/recall.json';
    const search = isFood
      ? `product_description:${quoted(args.product)}`
      : `product_description:${quoted(args.product)} OR generic_name:${quoted(args.product)}`;

    const response = await asEmpty(
      service,
      () =>
        http.getJson<{ results?: Array<Record<string, unknown>> }>(
          `${OPENFDA}/${endpoint}`,
          openfdaUpstream(service),
          {
            query: {
              search,
              limit: maxResults,
              sort: isFood ? 'report_date:desc' : 'date_initiated:desc',
              ...openfdaKey(env),
            },
          },
        ),
      `${service} has no report matching "${args.product}". A product with no report here is not proof of safety: enforcement data covers recalls reported to FDA, and coverage varies by category.`,
    );

    const results = response.results ?? [];
    const rows = results.map((record) =>
      [
        definitionList([
          ['Recall number', isFood ? record.recall_number : record.res_event_number],
          ['Classification', record.classification],
          ['Status', record.status],
          ['Product', record.product_description ?? record.generic_name],
          ['Hazard / reason', isFood ? record.reason_for_recall : record.reason_for_recall],
          ['Initiated', isFood ? record.recall_initiation_date : record.date_initiated],
          ['Firm', record.recalling_firm ?? record.firm],
          ['Distribution', record.distribution_pattern],
        ]),
      ].join('\n'),
    );

    return composeResult({
      headline: `${service}: ${results.length} report(s) for "${args.product}".`,
      sections: [heading('Reports'), rows.join('\n\n')],
      sources: [
        { name: service, url: `${OPENFDA}/${endpoint}?search=${encodeURIComponent(search)}` },
      ],
      notices: [
        'Recall classification matters: Class I is a reasonable probability of serious harm or death, Class II is temporary or medically reversible harm.',
        'A recall usually covers specific lots, dates, or sizes. Check the product description before telling anyone whether their unit is affected.',
      ],
      env,
    });
  },
});

export const deviceTools: ToolSpec[] = [deviceApproval, safetyRecalls];
