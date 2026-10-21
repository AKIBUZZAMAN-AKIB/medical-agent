import { z } from 'zod';
import { EmptyResultError } from '../errors.js';
import { bulletList, clampInt, composeResult, definitionList, heading } from '../format.js';
import type { ToolOutput } from '../format.js';
import type { Upstream } from '../http.js';
import { defineTool } from '../types.js';
import type { ToolContext, ToolSpec } from '../types.js';

const GHO = 'https://ghoapi.azureedge.net/api';
const ONE_DAY = 86_400_000;

function ghoUpstream(): Upstream {
  return { service: 'WHO Global Health Observatory', minIntervalMs: 300, cacheTtlMs: ONE_DAY };
}

interface GhoCollection<T> {
  value?: T[];
}

interface GhoIndicator {
  IndicatorCode?: string;
  IndicatorName?: string;
}

interface GhoValue {
  IndicatorCode?: string;
  SpatialDim?: string;
  SpatialDimType?: string;
  TimeDim?: number;
  Value?: string | number;
  Dim1?: string;
  Dim1Type?: string;
  Dim2?: string;
  NumericValue?: number;
  Low?: number;
  High?: number;
}

const healthStatistics = defineTool({
  name: 'health_statistics',
  group: 'epidemiology',
  title: 'WHO health statistics',
  readOnly: true,
  description:
    'Query WHO Global Health Observatory data in two modes. With `search_indicators: true`, list indicator codes whose name matches a keyword (for example "maternal mortality", "tuberculosis incidence", "measles vaccination"). Otherwise, fetch the values of an indicator code, optionally for a country (ISO3, e.g. "IND", "USA") and year. Use it for population-level burden, coverage, and trend questions; it is not a source for individual risk.',
  inputSchema: {
    indicator: z
      .string()
      .min(2)
      .describe('Indicator code (e.g. "SH.DYN.MORT") or, with search_indicators, a keyword.'),
    search_indicators: z
      .boolean()
      .optional()
      .describe('Set true to search indicator names instead of fetching values.'),
    country: z
      .string()
      .min(2)
      .max(4)
      .optional()
      .describe('ISO3 country code filter, e.g. "IND", "USA", "BRA".'),
    year: z.number().int().min(1990).max(2035).optional().describe('Filter to a single year.'),
    max_results: z
      .number()
      .int()
      .min(1)
      .max(100)
      .optional()
      .describe('Rows to return (default 20, max 100).'),
  },
  async handler(args, { env, http }: ToolContext): Promise<ToolOutput> {
    const upstream = ghoUpstream();
    const maxResults = clampInt(args.max_results, 1, 100, 20);

    if (args.search_indicators === true) {
      const response = await http.getJson<GhoCollection<GhoIndicator>>(
        `${GHO}/Indicator`,
        upstream,
        {
          query: {
            $filter: `contains(IndicatorName, '${args.indicator.replace(/'/g, "''")}')`,
            $top: maxResults,
          },
        },
      );
      const indicators = response.value ?? [];
      if (indicators.length === 0) {
        throw new EmptyResultError(
          'WHO GHO',
          `No WHO indicator name contains "${args.indicator}". Try a shorter keyword such as "mortality", "incidence", or "coverage".`,
        );
      }
      return composeResult({
        headline: `WHO GHO: ${indicators.length} indicator(s) matching "${args.indicator}".`,
        sections: [
          bulletList(
            indicators.map(
              (indicator) => `${indicator.IndicatorCode} — ${indicator.IndicatorName}`,
            ),
          ),
        ],
        sources: [
          {
            name: 'WHO GHO indicator catalogue',
            url: 'https://www.who.int/data/gho/data/indicators',
          },
        ],
        notices: [
          'GHO indicator codes are the WHO’s own series; a code with no recent value may have been discontinued rather than report zero.',
        ],
        env,
      });
    }

    if (args.indicator.length > 40 || /\s/.test(args.indicator)) {
      throw new EmptyResultError(
        'WHO GHO',
        `"${args.indicator}" looks like a name, not a code. Call this tool again with search_indicators: true to find the code first.`,
      );
    }

    const filters = [`IndicatorCode eq '${args.indicator.replace(/'/g, "''")}'`];
    if (args.country != null) {
      filters.push(`SpatialDim eq '${args.country.toUpperCase()}'`);
    }
    if (args.year != null) {
      filters.push(`TimeDim eq ${args.year}`);
    }

    const response = await http.getJson<GhoCollection<GhoValue>>(
      `${GHO}/${args.indicator}`,
      upstream,
      {
        query: { $filter: filters.join(' and '), $orderby: 'TimeDim desc', $top: maxResults },
      },
    );
    const values = response.value ?? [];
    if (values.length === 0) {
      throw new EmptyResultError(
        'WHO GHO',
        `WHO GHO returned no rows for ${args.indicator}${
          args.country != null ? ` in ${args.country.toUpperCase()}` : ''
        }${args.year != null ? ` for ${args.year}` : ''}. Check the code, the country code, and whether the series covers that year.`,
      );
    }

    const rows = values.map((value) =>
      definitionList([
        ['Country', value.SpatialDim],
        ['Spatial type', value.SpatialDimType],
        ['Year', value.TimeDim],
        ['Dimension 1', value.Dim1 != null ? `${value.Dim1} (${value.Dim1Type ?? ''})` : undefined],
        ['Dimension 2', value.Dim2],
        ['Value', value.Value],
        ['Numeric', value.NumericValue],
      ]),
    );

    return composeResult({
      headline: `WHO GHO ${args.indicator}: ${values.length} row(s).`,
      sections: [heading('Observations'), rows.join('\n\n')],
      sources: [
        {
          name: `WHO GHO ${args.indicator}`,
          url: `https://www.who.int/data/gho/data/indicators/indicator-details/${args.indicator}`,
        },
      ],
      notices: [
        'National estimates carry the reporting country’s own methodology and uncertainty; read the interval, not just the point estimate.',
        'Ecological data describe populations: they do not estimate an individual’s risk, and differences between countries often reflect ascertainment rather than disease.',
      ],
      env,
    });
  },
});

export const epidemiologyTools: ToolSpec[] = [healthStatistics];
