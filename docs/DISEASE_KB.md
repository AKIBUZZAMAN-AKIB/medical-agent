# Disease knowledge base (RAG)

The `disease_knowledge_search` tool in `packages/mcp-medical` answers general
disease questions (symptoms, causes, danger signs, tests, prevention) from a
local knowledge base built from the "Global Disease Master Chart" spreadsheet.
The agent searches it first, then checks treatment and dose questions against
drug labels / PubMed and current events (outbreaks, DGHS notices) with web
search, and cites records as `Global Disease Master Chart [D0051]` plus the
original source (WHO, CDC, NHS, NIH ...).

The raw spreadsheet and the built index are **not** committed: the source has
no stated author or licence. Only the ingestion script is in the repo.

## Build the index

```bash
# medtools must be running (default http://127.0.0.1:4134) for embeddings
python3 packages/mcp-medical/scripts/build_disease_kb.py --xlsx /path/to/Global_Disease_Master_Chart.xlsx
# --no-embed builds a keyword-only index
# output: packages/mcp-medical/data/disease-kb/disease-kb.json.gz (git-ignored)
```

What the script does:

- Use the most complete copy when you have several versions of the same
  workbook (they are incremental exports).
- Removes duplicate diseases and follows "already covered – replaced with: …"
  rows to the right record. 1,400 rows (D0001–D1400) become 910 diseases.
- Repairs rows whose cells are shifted by one column.
- Replaces explicit drug doses with `[dose omitted]`. Doses come from drug
  labels, never from this dataset.
- Skips name-only rows (D1401–D2000 have no content).
- One chunk per disease: names and aliases, symptoms, causes, danger signs,
  tests, prevention, sources.
- Embeds each chunk with `multilingual-e5` through the medtools service, in
  batches of 16 to keep memory flat.

Re-run the script whenever a new version of the workbook arrives; the tool
loads the new index on the next restart of the MCP server.

## Search pipeline

1. Bangla and Banglish terms are mapped to English medical terms
   (`src/tools/diseaseLexicon.ts`, e.g. `kalajor` → kala-azar,
   `jokkha` → tuberculosis, `khos pachra` → scabies).
2. Hybrid retrieval: keyword (BM25-style) and semantic (e5 embeddings),
   merged with reciprocal rank fusion.
3. The medtools cross-encoder reranks the top hits.
4. Weak matches are flagged as such so the agent does not over-trust them.
5. If medtools is down, the tool falls back to keyword search only.

## Known data limits

- Quality is uneven: "Prevention" often holds treatment text, "Emergency"
  often holds complications, records after D0800 are terse, many sources
  point to a site home page rather than a specific page.
- Some diseases are missing (Nipah, hepatitis A/E, acute diarrhoea) and a
  few appear twice under near-identical names (e.g. varicella).
- Use it for orientation, not as evidence on its own; the agent instructions
  require a second source for anything clinical.
