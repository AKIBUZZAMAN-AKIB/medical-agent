# Disease knowledge base (`disease_knowledge_search`)

A local keyword index over the whole "Global Disease Master Chart" dataset,
exposed by the medical MCP server as the `disease_knowledge_search` tool.

## Files

| Path | What |
| --- | --- |
| `packages/mcp-medical/data/disease-kb/source/Disease_Name_Data.zip` | the dataset as received |
| `packages/mcp-medical/data/disease-kb/source/Disease_Name_Data/` | the same zip, extracted (input of the build) |
| `packages/mcp-medical/scripts/build_disease_kb.py` | the build script |
| `packages/mcp-medical/data/disease-kb/disease-kb.json.gz` | the built index (records, sheet rows, vectors) |
| `packages/mcp-medical/src/tools/diseaseKnowledge.ts` | the tool |
| `packages/mcp-medical/src/tools/diseaseLexicon.ts` | Bangla/Banglish → English lexicon |

All of them are committed. The raw source folder is kept out of the Docker
build context (`.dockerignore`); the image only needs the built index.

## What goes into the index

The zip holds 26 `Global_Disease_Master_Chart*.xlsx` workbooks and the
`Disease_Names/*.txt` name lists. The workbooks are progressive snapshots of one
chart (Read Me versions 0.1 to 2.3): each file repeats the rows of the previous
one and adds a new batch. The `-1`, `-25`, `(2)` suffixes in the file names are
download copies, not versions.

The build reads every workbook and every name list:

- **Master Disease Chart (all 26 files).** Every disease ID becomes its own
  record. Rows that are identical in several files are stored once, with the
  list of workbook versions they appear in (`versions`). An ID whose content
  differs between versions keeps every version: D1300 and D1350 each have a
  current record and an older one keyed `D1300@v…` / `D1350@v…`, marked
  `superseded`. IDs that describe the same disease under different names (for
  example G6PD deficiency, D0291 and D0745) are **not** merged; they are
  cross-linked in `same_name_as`.
- **Name lists.** IDs that exist only in the name lists (D1401–D2000) become
  name-only records (`name_only: true`, name and ID only). A line marked
  "(already noted)" stays on its ID's record in `name_lines`; two unmarked names
  under one ID become two records (`D1547`, `D1547-b`). The D0001–D1400 list is
  checked against the chart names.
- **Other sheets.** Every distinct row of Disease Categories, Source Register,
  Quality Control and Read Me, across all files, is kept in `sheet_rows` with
  the versions it appears in.
- **Text is kept as written**, dose text included. The tool tells the model
  never to take a dose or a treatment choice from the dataset.

Current counts (see `stats` inside the index):

| | |
| --- | --- |
| disease records | 2,003 |
| chart records (IDs D0001–D1400) | 1,402 (1,400 IDs + 2 older versions) |
| name-only records (IDs D1401–D2000) | 601 (600 IDs; D1547 holds two names) |
| sheet rows | 465 (categories, source register, QC, read me) |
| vectors | one per disease record |

### Shifted columns

Some rows of the chart lost or gained a cell, so later cells sit under the
wrong header. The build realigns them and records how in `realigned`:

- 19 rows lost one or two cells, so every later cell moved left. The column
  where the cell went missing was checked by hand against the contents and is
  listed in `LEFT_SHIFT_GAPS` in the build script: an empty cell is put back
  there, so the causes, risk factors, transmission, … and source cells return
  to their own columns. No text is removed.
- D0946: the subcategory was split over two cells; the two are joined.
- D0893: a stray cell ("202") sits before the date; it is kept in `extra_cells`.

Known issues inside the data that the build does not change: from about D0601
the "Additional Important Symptoms or Signs" column often holds treatment
notes, and about 30 diseases appear twice under different names.

## How the tool matches

Input: `keywords` (1–40 strings, required), `question` (optional),
`offset` (optional, for the next page).

1. Each keyword is normalized (lower case, accents removed, punctuation as
   spaces, plain plurals singularized). Bangla and Banglish keywords are also
   read through the lexicon (`lexiconTerms`), e.g. `jor` → `fever`,
   `ডেঙ্গু` → `dengue`, `kalajor` → `visceral leishmaniasis`, `kala-azar`.
   Words that fit every disease ("disease", "symptoms") are skipped with a note.
2. A record matches when any keyword (or a lexicon reading of it) occurs as a
   whole word or phrase in **any** field: name, raw name, alternative names,
   category, definition, symptoms, other signs, causes, risk factors,
   transmission, age group, severity, warning signs, diagnosis, prevention,
   source name, extra cells. Name-only records match on their names.
3. **Every** match is returned with every field. There is no top-k. Order:
   records whose full name is a keyword, then name matches, then matches in
   other fields; within that, more keywords matched first, full records before
   name-only ones, then the dataset order. The order is deterministic, so paging
   is stable.
4. After the disease records come the workbook rows (other sheets) that contain
   a keyword, then up to six "related by meaning" records that matched no
   keyword (medtools multilingual-e5-base embeddings, then the medtools
   reranker, relevance ≥ 0.3).
5. Results are paged to fit the MCP result limit (`MEDICAL_MCP_MAX_RESULT_CHARS`,
   24,000 by default). The first page lists all keyword matches by name. Each
   page ends with either `NEXT PAGE … offset=N` (`next_offset=N` in the
   headline) or `Complete`.

A medtools failure only drops the semantic extras; keyword matching always
works offline.

## What the model is told

The agent instructions (`packages/mcp-medical/agent/instructions.md`), the MCP
server instructions (`src/server.ts`, injected via `serverInstructions: true` in
`librechat.pure-doctor.yaml`) and the sub-agent skill files (`_shared.md` and
each sub-agent that has the tool) say: whenever the user mentions a disease, a
symptom or anything related to a disease, call `disease_knowledge_search`
before answering, with keywords (disease names and symptoms in English plus the
user's Bangla/Banglish words), use all the returned data, and fetch further
pages with `next_offset` until it says Complete. Sub-agents that have the tool:
emergency/first-aid, maternal-peds, tropical-infectious, cardio-renal-endo,
oncology-genomics.

## Rebuilding

```bash
# from the repo root; medtools must be running for the vectors
python3 packages/mcp-medical/scripts/build_disease_kb.py
# keyword-only (no vectors)
python3 packages/mcp-medical/scripts/build_disease_kb.py --no-embed
```

The medtools key is read from `MEDTOOLS_API_KEY` or the repo's `.env`. The
build stops if free RAM drops below `--min-free-mb` (900 MB by default).
Embedding 2,003 records takes about five minutes on the 4-vCPU VM.

Tests: `packages/mcp-medical/src/__tests__/disease-kb.spec.ts` checks the counts,
the versions, the realignment, and that the tool returns exactly the records a
brute-force scan finds, across all pages.
