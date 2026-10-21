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
import type { ToolOutput } from '../format.js';
import type { Upstream } from '../http.js';
import { defineTool } from '../types.js';
import type { ToolContext, ToolSpec } from '../types.js';

const NPI_REGISTRY = 'https://npiregistry.cms.hhs.gov/api';
const WIKIPEDIA = 'https://en.wikipedia.org/api/rest_v1';
const ONE_DAY = 86_400_000;

function npiUpstream(): Upstream {
  return { service: 'NPPES NPI Registry', minIntervalMs: 300, cacheTtlMs: ONE_DAY };
}

function wikipediaUpstream(): Upstream {
  return { service: 'Wikipedia REST API', minIntervalMs: 300, cacheTtlMs: ONE_DAY };
}

interface NpiResult {
  /** The NPI itself; `basic` carries only the identity fields. */
  number?: string;
  basic?: {
    first_name?: string;
    last_name?: string;
    name?: string;
    credential?: string;
    enumeration_type?: string;
    status?: string;
    enumeration_date?: string;
  };
  taxonomies?: Array<{ desc?: string; code?: string; primary?: boolean; license?: string }>;
  addresses?: Array<{
    address_1?: string;
    city?: string;
    state?: string;
    postal_code?: string;
    country_name?: string;
    telephone_number?: string;
    address_purpose?: string;
  }>;
}

const providerLookup = defineTool({
  name: 'provider_lookup',
  group: 'clinical',
  title: 'Look up a clinician',
  readOnly: true,
  description:
    'Look up US clinicians in the CMS NPI Registry: by NPI number, or by name plus specialty/taxonomy and state. Returns name, credential, taxonomy, NPI, status, and practice address. Use it to check whether a clinician is registered, to find specialists in an area, or to verify a billing identity. A registry record is an administrative claim, not an endorsement of quality, and it carries no patient information.',
  inputSchema: {
    npi: z
      .string()
      .regex(/^\d{10}$/)
      .optional()
      .describe('A 10-digit NPI number.'),
    name: z.string().min(2).optional().describe('Provider name (first, last, or organization).'),
    specialty: z
      .string()
      .min(2)
      .optional()
      .describe('Taxonomy description, e.g. "Cardiology", "Family Medicine".'),
    state: z.string().min(2).max(2).optional().describe('Two-letter US state code, e.g. "CA".'),
    max_results: z
      .number()
      .int()
      .min(1)
      .max(20)
      .optional()
      .describe('Providers to return (default 5, max 20).'),
  },
  async handler(args, { env, http }: ToolContext): Promise<ToolOutput> {
    if (args.npi == null && args.name == null && args.specialty == null) {
      throw new EmptyResultError(
        'NPPES NPI Registry',
        'Provide an `npi` to look up one provider, a `name`, or at least a `specialty` to search by taxonomy and state.',
      );
    }

    const maxResults = clampInt(args.max_results, 1, 20, 5);
    const limit = args.npi != null ? 1 : maxResults;
    /** NPPES matches providers by first and last name; a single token is a first name. */
    const nameParts = args.name?.trim().split(/\s+/) ?? [];
    const response = await http
      .getJson<{ result_count?: number; results?: NpiResult[] }>(
        `${NPI_REGISTRY}/`,
        npiUpstream(),
        {
          query: {
            version: '2.1',
            number: args.npi,
            first_name: nameParts[0],
            last_name: nameParts.length > 1 ? nameParts.slice(1).join(' ') : undefined,
            taxonomy_description: args.specialty,
            state: args.state?.toUpperCase(),
            limit,
          },
        },
      )
      .catch((error) => {
        if (error instanceof UpstreamError && (error.status === 400 || error.status === 404)) {
          throw new EmptyResultError(
            'NPPES NPI Registry',
            `The NPI Registry returned no match for that request${
              args.npi != null ? ` (NPI ${args.npi})` : ` (${args.name})`
            }. NPI numbers are 10 digits; name searches need a first and last name.`,
          );
        }
        throw error;
      });

    const results = response.results ?? [];
    if (results.length === 0) {
      throw new EmptyResultError(
        'NPPES NPI Registry',
        'No registered provider matched. Registry names are legal names as filed, so common nicknames and misspellings return nothing.',
      );
    }

    const rows = results.map((provider) => {
      const address =
        (provider.addresses ?? []).find((entry) => entry.address_purpose === 'LOCATION') ??
        provider.addresses?.[0];
      const primaryTaxonomy =
        (provider.taxonomies ?? []).find((entry) => entry.primary === true) ??
        provider.taxonomies?.[0];
      return [
        heading(
          provider.basic?.name ??
            `${provider.basic?.first_name ?? ''} ${provider.basic?.last_name ?? ''}`.trim() ??
            'provider',
        ),
        definitionList([
          ['Credential', provider.basic?.credential],
          ['NPI', provider.number],
          ['Taxonomy', primaryTaxonomy?.desc],
          ['Taxonomy code', primaryTaxonomy?.code],
          ['Enumeration type', provider.basic?.enumeration_type],
          ['Status', provider.basic?.status],
          ['Enumerated', provider.basic?.enumeration_date],
          [
            'Practice address',
            address == null
              ? undefined
              : [
                  address.address_1,
                  address.city,
                  address.state,
                  address.postal_code,
                  address.country_name,
                ]
                  .filter((part) => !!part)
                  .join(', '),
          ],
          ['Phone', address?.telephone_number],
        ]),
      ].join('\n');
    });

    return composeResult({
      headline: `NPPES: ${results.length} provider record(s)${args.npi != null ? ` for NPI ${args.npi}` : ''}.`,
      sections: [rows.join('\n\n')],
      sources: [
        {
          name: 'NPPES NPI Registry',
          url: `https://npiregistry.cms.hhs.gov/provider-view${args.npi != null ? `?number=${args.npi}` : ''}`,
        },
      ],
      notices: [
        'A registry record is an administrative enrollment, not a quality rating: it does not reflect outcomes, complaints, or whether the provider currently practices.',
        'CMS states that issuance of an NPI does not ensure or validate that a provider is licensed or credentialed. The credential and the taxonomy here are self-declared by the provider, so "Taxonomy: Cardiology" means they registered themselves as a cardiologist — it is not verification, and it is not board certification.',
        'A name search is a name match, not an identity match: there can be more than one person with the same name, and a match says nothing about whether it is the person the user meant. Only an NPI number, or a second detail the user supplies, identifies a specific individual.',
        'Return practice contact details as recorded; verify them with the practice before sharing.',
      ],
      env,
    });
  },
});

const plainLanguageSummary = defineTool({
  name: 'plain_language_summary',
  group: 'clinical',
  title: 'Plain-language background',
  readOnly: true,
  description:
    'Return an encyclopedia summary of a topic or condition in plain language, plus links to related sources. Use it to orient a layperson before the technical detail, or to check what a term means in general use. It is general background from Wikipedia, not a clinical source, and it must never be used for dosing, interactions, or management.',
  inputSchema: {
    topic: z
      .string()
      .min(2)
      .describe('Topic or condition name, e.g. "Type 2 diabetes", "Atrial fibrillation".'),
  },
  async handler(args, { env, http }: ToolContext): Promise<ToolOutput> {
    const topic = args.topic.trim();
    const title = topic.replace(/ /g, '_');
    let response: {
      title?: string;
      extract?: string;
      description?: string;
      content_urls?: { desktop?: { page?: string } };
    };
    try {
      response = await http.getJson<typeof response>(
        `${WIKIPEDIA}/page/summary/${encodeURIComponent(title)}`,
        wikipediaUpstream(),
      );
    } catch (error) {
      if (error instanceof UpstreamError && error.status === 404) {
        throw new EmptyResultError(
          'Wikipedia',
          `No article matches "${topic}". Try the more common name of the condition, and check the spelling.`,
        );
      }
      throw error;
    }

    return composeResult({
      headline: `Plain-language background: ${response.title ?? topic}.`,
      sections: [
        excerpt(response.extract, 3_000),
        response.content_urls?.desktop?.page != null
          ? bulletList([`Read more: ${response.content_urls.desktop.page}`])
          : '',
      ].filter((section) => section.length > 0),
      sources:
        response.content_urls?.desktop?.page != null
          ? [
              {
                name: `Wikipedia — ${response.title ?? topic}`,
                url: response.content_urls.desktop.page,
              },
            ]
          : [
              {
                name: 'Wikipedia',
                url: `https://en.wikipedia.org/wiki/${encodeURIComponent(title)}`,
              },
            ],
      notices: [
        'This is general background, not clinical guidance: never use it for diagnosis, dosing, interactions, or management.',
        'If the topic is a medicine rather than a condition, use drug_lookup and drug_label instead.',
      ],
      env,
    });
  },
});

export const clinicalTools: ToolSpec[] = [providerLookup, plainLanguageSummary];
