# `@librechat/mcp-medical`

A local stdio MCP server that answers biomedical questions by looking them up
in live public databases. It bundles no clinical content: no condition list, no
dose table, no interaction matrix, no review abstracts. Every fact in an answer
came back from an upstream API during the conversation, with a link to the
record it came from.

33 read-only tools across 11 domain groups, no API keys required. None of them
decides urgency: there is no triage tool and no red-flag keyword list (see below).

## What it is for

Answering the questions a careful colleague would look up before a clinician
makes a decision — what a label actually says, what a regional/Bangladeshi brand
formulation contains and costs across bioequivalent manufacturers, what CPIC
pharmacogenomics guidelines recommend, what an exact clinical equation or lab
panel computes to without LLM arithmetic error, what a variant's classification
rests on, what is in a trial, what a population's burden looks like — and
refusing the parts that are not lookup work: diagnosing a person, prescribing,
clearing a combination, triaging.
The agent seeded alongside this server
([`agent/instructions.md`](agent/instructions.md)) is where that boundary and
the research method are written down.

## Tools

| Group              | Tools                                                                                                                                                                                     | Upstreams / Verified Corpora                                                                       |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `formulary`        | `bd_medicine_lookup`                                                                                                                                                                      | BDDrugBank v1.0.0 (`24,725` Bangladeshi brands, `1,553` generics, BDT MRP), WHO EML 2025, BD NEML  |
| `pharmacogenomics` | `pharmacogenomics_guideline`                                                                                                                                                              | CPIC REST API v1.55 (`api.cpicpgx.org/v1`) — pairs, levels, testing status and phenotype recommendations read from the API; no locally typed allele list |
| `calculators`      | `clinical_calculator`, `lab_result_interpreter`                                                                                                                                           | 14 deterministic MedCalc equations (`ckd_epi_2021`, `cockcroft_gault`, `meld_na`, etc.) & Lab Panel |
| `orchestration`    | `specialist_subagent_blueprint`                                                                                                                                                           | Dynamic `agent_dyn_*` specialist sub-agent blueprint & HealthBench context-seeking generator       |
| `literature`       | `pubmed_search`, `pubmed_article`, `read_full_text`, `europe_pmc_search`, `literature_citations`                                                                                          | NCBI E-utilities, Europe PMC (search and JATS full text), OpenAlex                                 |
| `drugs`            | `drug_lookup`, `drug_label`, `drug_interaction_check`, `drug_safety_actions`, `drug_adverse_event_summary`, `drug_class_atc`, `drug_bioactivity`, `compound_properties`, `drug_lactation` | RxNav, DailyMed SPL, openFDA (labels, enforcement, FAERS), ChEMBL, PubChem, LactMed via Europe PMC |
| `conditions`       | `condition_lookup`, `condition_targets_and_drugs`, `gene_lookup`, `protein_lookup`, `ontology_search`, `icd10cm_code`, `variant_clinical_significance`                                    | Monarch Initiative, Open Targets, UniProt, EBI OLS4, NLM Clinical Tables, ClinVar                  |
| `trials`           | `clinical_trials`                                                                                                                                                                         | ClinicalTrials.gov API v2                                                                          |
| `epidemiology`     | `health_statistics`                                                                                                                                                                       | WHO Global Health Observatory                                                                      |
| `devices`          | `device_approval`, `safety_recalls`                                                                                                                                                       | openFDA 510(k), device recall and food enforcement                                                 |
| `clinical`         | `provider_lookup`, `plain_language_summary`                                                                                                                                                | NPPES NPI Registry v2.1, Wikipedia |

Group the tools any way the deployment needs — see `MEDICAL_TOOL_GROUPS` below.

### Urgency is the model's judgement, not a word list

The server has no emergency triage tool, no red-flag knowledge base and no
keyword or regex rule that labels a message as an emergency. Earlier revisions
had both a word list and a classifier-backed triage tool; both were removed
because a word match cannot tell "what is a seizure" from "my child is having a
seizure now". The model reads the whole message and decides; the agent
instructions say when to open with the one 999 line and when not to.

- **Emergencies get actions, not a phone number.**

## Continuity: what the agent remembers

The 33 tools above answer questions about medicine. They know nothing about the
person asking, so the agent also gets three LibreChat built-ins, seeded
alongside the MCP tools. They are built-ins rather than MCP tools on purpose: a
stdio MCP server is never told which user called it, so it could not enforce
per-user scoping on what it read.

| Tool                           | Reads                                                                              | Needs                                 |
| ------------------------------ | ---------------------------------------------------------------------------------- | ------------------------------------- |
| `set_memory` / `delete_memory` | Durable facts about one person, injected with their write date on every request    | a `memory:` block in `librechat.yaml` |
| `list_profiles`                | Who is on file for this user, with a fact count each; no facts                     | `memory_profiles: true`               |
| `read_profile`                 | One person's stored facts, each dated                                              | the same                              |
| `conversation_history`         | This user's own past conversations, newest first, filterable by date and full text | the `conversation_history` capability |
| `conversation_transcript`      | One session's messages in order, each dated, paged                                 | the same capability                   |

`conversation_history` is a new opt-in capability
(`endpoints.agents.capabilities`), off by default, because it hands a model the
user's message history. Every read is scoped to the authenticated user, so a
guessed conversation id returns nothing rather than somebody else's history.

The agent document the seed writes sets three fields that make this a continuity
agent rather than a stateless one:

- `memory_scope: 'agent'` — its memories are partitioned per (user, agent), so
  what the medical agent remembers is not handed to the user's other agents.
- `memory_policy: 'proactive'` — it may record a durable, dated fact
  (a condition, a medicine, an allergy) without being asked to. The default
  guard stores only on explicit request, which is right for a general
  assistant and wrong here: a patient who has to restate their history at every
  session is being treated worse, not better. The proactive guard still refuses
  identifiers and anything that would not change a future answer.
- `memory_profiles: true` — one memory record per person. The prompt carries
  only the list of who is on file and a count per person; the facts themselves
  arrive only when the model calls `read_profile` for the person the question
  is about. A patient talking about their father and themselves in one message
  is the normal case, and a pooled history turns that into a wrong answer about
  the wrong person's medication. The agent may open a record for a relative
  only after asking once and being told yes, and never delays emergency help
  for that question.

`memory_profiles` is the lever to reach for anywhere a user talks about more
than one person — a family health question, a carer looking after a parent, a
teacher tracking a class. It is off by default, and an agent without it never
learns that anyone else is on file.

The consent has a matching exit. Settings → Data → Memories lists everyone with
a record, how many facts are held about each, and removes a person along with
everything stored about them. Each fact is badged with whose it is, so a row
about a relative is never read as the user's own.

What it will not do is look a clinical fact up in memory. Dosing, interactions
and evidence are looked up live and cited every time; only the user's own
history is recalled. See the "Two kinds of knowledge" section of
[`agent/instructions.md`](./agent/instructions.md), which is where that
distinction is enforced.

## Running it

```bash
npm install --workspace @librechat/mcp-medical
npm run build --workspace @librechat/mcp-medical
node packages/mcp-medical/dist/index.js   # speaks MCP over stdio
```

Wire it into LibreChat under `mcpServers` in `librechat.yaml` (see
[`librechat.example.yaml`](../../librechat.example.yaml) for a working entry):

```yaml
mcpServers:
  medical:
    command: node
    args: ['/absolute/path/to/packages/mcp-medical/dist/index.js']
    env:
      MEDICAL_CONTACT_EMAIL: 'you@example.org'
```

Then seed the agent that carries the safety and method instructions:

```bash
npm run seed-medical-agent -- --dry-run     # prints the discovered tools, writes nothing
npm run seed-medical-agent                   # upserts agent id "agent_medical_research"
```

The seed script starts the MCP server as a real client first, so a server that
does not boot is reported before anything is written. It upserts on the agent id
from `agent/agent.json` and therefore _overwrites_ an existing agent with that
id — edit `agent/agent.json` and `agent/instructions.md` rather than the agent in
the database, then re-run. Ownership goes to `--author=<email|username>`, or to
the oldest `ADMIN` when that is omitted; the agent is visible only to its owner
unless you pass `--share-with-role=<role identifier>`.

## Configuration

Everything is optional. With no configuration the server uses every tool and
needs no credentials.

| Variable                     | Default               | Effect                                                                                                |
| ---------------------------- | --------------------- | ----------------------------------------------------------------------------------------------------- |
| `MEDICAL_TOOL_GROUPS`        | all                   | Publish only these groups, e.g. `literature,drugs`. Small free models degrade badly against 25 tools. |
| `MEDICAL_TOOL_EXCLUDE`       | none                  | Hide individual tools, e.g. `MEDICAL_TOOL_EXCLUDE=plain_language_summary`.                            |
| `NCBI_API_KEY`               | unset                 | Raises E-utilities from 3 to 10 requests/second.                                                      |
| `OPENFDA_API_KEY`            | unset                 | Raises the openFDA daily cap from 1,000 to 100,000 requests.                                          |
| `MEDICAL_CONTACT_EMAIL`      | unset                 | Contact address sent to NCBI and the polite pools. Set it.                                            |
| `MEDICAL_USER_AGENT`         | LibreChat MCP Medical | Identification string several public APIs require.                                                    |
| `MEDICAL_REQUEST_TIMEOUT_MS` | `20000`               | Per-request budget.                                                                                   |
| `MEDICAL_MAX_ATTEMPTS`       | `3`                   | Total attempts per request, including the first.                                                      |
| `MEDICAL_CACHE_TTL_MS`       | `300000`              | How long a successful GET stays cacheable.                                                            |
| `MEDICAL_CACHE_MAX_ENTRIES`  | `500`                 | In-memory cache bound.                                                                                |
| `MEDICAL_MAX_RESULT_CHARS`   | `24000`               | Hard cap on characters returned to the model per result.                                              |

## Behaviour that matters

- **No clinical content is bundled.** A missing answer is a lookup failure with
  a named upstream, never a plausible sentence from the model's memory.
- **Entity resolution is verified, not guessed.** `gene_lookup` resolves a
  symbol through MyGene, and `condition_targets_and_drugs` resolves a disease
  through EBI OLS, because Open Targets' own semantic search returns whatever
  sorts first — "BRCA1" once came back as BABAM2, and "atopic asthma" as
  dermatitis. A medical tool that answers about a different gene is worse than
  one that reports the lookup failed.
- **Label text is passed on as regulatory text.** `drug_label` and
  `drug_interaction_check` return what the label says, with the label's
  effective date; neither is a clearance or a recommendation.
- **Spontaneous reports are counts, never rates.** `drug_adverse_event_summary`
  reads FAERS, which has no denominator; the result says so.
- **Full text is read, not just the abstract.** `read_full_text` returns the methods,
  results, discussion and tables of an open-access paper, so a claim can be checked
  against the analysed sample, the comparator and the actual effect size. A paper
  outside the open-access subset says so instead of returning something thinner.
- **Citation counts are attention.** `literature_citations` reports OpenAlex
  counts and the most-cited citing works, and says in the result that a count is
  not a validity judgement.
- **Results are truncated, never silently.** A result cut for length is
  labelled `[truncated]`; an empty result names the databases and queries used
  instead of returning a guess.
- **Every request names itself.** A descriptive user agent, per-host rate
  limiting, bounded retries with backoff, and a short-TTL cache.
- **Emergencies get actions, not a phone number.** The agent instructions put
  bystander first aid in the same reply as the call for help — CPR and AED,
  choking, bleeding control, anaphylaxis, stroke timing, burns, seizures,
  poisoning, recovery position, diabetic and heat emergencies — and still stop
  short of diagnosis and prescribing. Telling someone only to hang up and dial
  is the wrong answer when help is minutes away.
- **Under-triage is the error that is not symmetric.** Measured against
  clinician triage, current consumer health AI under-triages true emergencies
  at roughly 50% and over-triages the routine, and the two failures are not
  equivalent: a wasted visit delays nothing. The instructions therefore make
  "when you cannot tell, refer at the higher level of urgency" explicit, forbid
  closing a message with unearned reassurance, require a timeframe with every
  referral, and refuse "monitor it" as a substitute for being seen when the
  agent is uncertain.
- **It holds its ground under pressure.** Evaluations of clinical LLMs under
  sustained patient persuasion find acquiescence with unindicated care ranging
  from near 0% to nearly 100% across models, uncorrelated with model scale, with
  the highest rates on imaging and antibiotics requests. The instructions
  require the same answer on the second and third ask, refuse "my doctor said
  so" and friend-of-a-nurse as reasons to change a fact, and require the user
  to verify any study they quote before it is repeated — patients cite papers
  that do not exist, and repeating one is how a fabrication becomes a fact.
- **Retired regulatory conventions are called out.** FDA's pregnancy letter
  categories (A–X) were removed by the Pregnancy and Lactation Labeling Rule
  effective 30 June 2015 in favour of a narrative Risk Summary; the agent is
  told never to report a letter as a current risk rating, and to explain the
  current format when a patient or a doctor asks in letters.
- **The safety rules are themselves tested.** `src/__tests__/instructions.spec.ts`
  asserts the presence of each load-bearing rule and that no two rules
  contradict. The prompt is the only thing standing between this agent and a
  confidently wrong answer, so editing it without noticing should fail a build,
  the same way breaking a function would.
- **Not every source may carry every claim.** The instructions grade sources by
  what each is competent to establish: a regulatory record is the authority for
  what is permitted; a registry records what someone asserted, not what was
  verified; a curated database is right about terms and relationships and is not
  evidence of efficacy; a tertiary source never supplies a number or a clinical
  claim; only the paper supports a claim about a study. This is the single
  distinction behind most wrong answers — a good source used for a job it is not
  qualified for — and it is what stops a CMS registry record from reading as a
  credential check.
- **Tool notices are audited against the instructions**, not just written to be
  helpful. The `drug_label` notice used to tell the agent to "apply it to the
  specific patient in front of you", which is the exact boundary the
  instructions forbid. Notices are injected into context beside the
  instructions, so a contradiction there is as dangerous as one in the prompt,
  and the test suite asserts the contradiction is absent.
- **Breastfeeding has a real source.** `drug_lactation` reads LactMed, the
  NLM/NICHD peer-reviewed Drugs and Lactation Database, reached through Europe
  PMC — NLM runs no API of its own, and Bookshelf's Entrez records carry no text
  through `efetch`. A title search for "metformin" returns the LactMed monograph
  _and_ seventeen other drugs that merely mention it, so the record is selected
  by requiring a Bookshelf monograph whose title resolves to the same substance;
  nothing is ever returned in its place, and a near miss is reported as a pointer
  rather than answered with. "Compatible with breastfeeding" is passed on with
  its own framing, never as a clearance for a specific mother and infant.
- **Two layers of tests, because they answer different questions.** The jest
  suite proves the tools parse upstreams correctly and that the safety rules are
  still written down. `eval/` is the only thing that measures whether a model
  _follows_ those rules: 19 adversarial cases drawn from published evaluation of
  models in this role (sycophancy, under-triage, self-harm alerting, retired
  conventions, over-refusal), run against a real model. The grader itself is
  unit-tested, because an evaluation that silently passes everything is worse
  than none. See [eval/README.md](eval/README.md).
- **Upstream health is checked on a schedule.** `.github/workflows/medical-mcp-upstreams.yml`
  runs the live smoke test daily and on demand. The unit suite asserts against
  fixtures captured on a day the upstreams were healthy, so it keeps passing
  while the live path rots — and since none of these APIs are versioned, a
  renamed field fails silently as a well-formatted wrong answer rather than an
  error.

## Development

```bash
npm run typecheck --workspace @librechat/mcp-medical
npm run test:ci --workspace @librechat/mcp-medical
npm run build --workspace @librechat/mcp-medical
npm run smoke --workspace @librechat/mcp-medical          # live, hits every tool
node packages/mcp-medical/scripts/smoke.mjs drugs         # one group
```

The smoke script starts the built server over stdio as a real MCP client and
calls all 33 tools against the live upstreams. Run it after an upstream moves
an endpoint, which public APIs do without notice.

## Why these upstreams

Every one is public, keyless, and intended for machine access:

- **NCBI E-utilities** — MEDLINE and PubMed, with `NCBI_API_KEY` optional.
- **Europe PMC** — wider journal coverage than PubMed alone.
- **OpenAlex** — citation counts and citing works, which Europe PMC's
  reference index does not cover reliably.
- **RxNav / DailyMed / openFDA** — drug identity, the label of record,
  enforcement actions, and spontaneous adverse-event reports.
- **ChEMBL / PubChem** — mechanism and bioactivity, and compound properties.
- **Monarch Initiative / EBI OLS4** — disease and phenotype vocabulary.
- **Open Targets / UniProt / ClinVar** — gene function, target–disease
  associations with evidence weights, protein function, variant
  classification.
- **ClinicalTrials.gov / WHO GHO** — registered studies and population
  statistics.
- **NPPES NPI Registry** — provider identity and taxonomy.

## License

MIT, as part of the LibreChat repository.
