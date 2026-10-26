# Architecture

Verified against `main` at `be97b2c5e` plus the safety layer added in this audit.
For findings and evidence see [`REPOSITORY_DEEP_AUDIT.md`](./REPOSITORY_DEEP_AUDIT.md).

## 1. System shape

The repository is **LibreChat v0.8.8-rc3** (a general chat platform) with a
**medical MCP server** attached. The medical work is a thin, well-isolated layer:
one workspace package, one seed script, one prompt, one deployment config.

```
┌──────────────── browser ────────────────┐
│  React + Recoil · SSE stream            │
└──────────────────┬──────────────────────┘
                   │ HTTPS (session/JWT)
┌──────────────────▼──────────────────────┐
│  Express API  (api/server)              │  inherited
│  auth · ACL · conversation store        │
├─────────────────────────────────────────┤
│  Agent runtime (packages/api)           │  inherited
│  run admission · provider fencing ·     │
│  MCP client mgmt · streaming            │
└───┬──────────────┬──────────────┬───────┘
    │              │              │
    │ Mongo        │ Redis (opt)  │ stdio (JSON-RPC)
┌───▼────┐   ┌─────▼─────┐  ┌─────▼──────────────────────┐
│MongoDB │   │  Redis    │  │  mcp-medical  (this repo)   │
│convo · │   │ sessions  │  │  33 tools · 12 modules      │
│memory ·│   │ cache     │  │  ┌───────────────────────┐  │
│agents  │   └───────────┘  │  │ emergency_triage_check│  │
└────────┘                  │  │ deterministic safety  │  │
                            │  └───────────────────────┘  │
                            └─────┬───────────────────────┘
                                  │ HTTPS, keyless
                    ┌─────────────▼──────────────┐
                    │ NCBI · Europe PMC · OpenAlex│
                    │ openFDA · DailyMed · RxNav  │
                    │ ChEMBL · PubChem · Monarch  │
                    │ Open Targets · UniProt · OLS│
                    │ ClinicalTrials · WHO · NPPES│
                    └────────────────────────────┘
                                  │
                            ┌─────▼─────┐
                            │ LLM       │ OpenRouter free tier
                            └───────────┘
```

## 2. Why the MCP server is a separate process

Three properties fall out of the stdio boundary, and each is load-bearing:

1. **No user identity reaches the tools.** A stdio MCP server is told nothing
   about the caller. That is why per-user features — `set_memory`, `list_profiles`,
   `read_profile`, `conversation_history`, `conversation_transcript` — are
   **LibreChat built-ins**, not MCP tools. An MCP tool that read memory could not
   scope it to the authenticated user, so a guessed id would leak another person's
   history. Documented in `packages/mcp-medical/README.md`.
2. **The tools cannot write to the application.** They are read-only lookups over
   public APIs; there is no path from a tool result to a database write.
3. **stdout belongs to the protocol.** `src/index.ts` writes diagnostics to
   stderr only, because one stray `console.log` corrupts a JSON-RPC frame and
   takes the session down.

## 3. Request lifecycle (medical turn)

1. **Ingress.** `POST /api/agents/chat` → auth → ACL on the agent resource.
2. **Run admission** (inherited). Resolves the agent, conversation, and provider.
3. **Tool binding.** The MCP client connects to `mcp-medical` over stdio and calls
   `listTools()`. The seeded agent's tool list is `mcp_medical`-suffixed names
   discovered at seed time (`<tool>_mcp_medical`).
4. **Model turn.** The model receives: `instructions.md` (the safety boundary),
   the 33 tool descriptions, the user's message, and — when enabled — dated
   memories plus a memory-profile roster.
5. **Tool calls.** zod validates arguments at the MCP boundary. Each tool calls one
   or more public APIs through `HttpClient` (per-host rate limit → TTL cache →
   bounded retry with backoff → character-budgeted result with a `Sources:` block).
6. **Response.** Composed as markdown, streamed over SSE, persisted to MongoDB.

### The safety path (added in this audit)

```
user message
   │
   ├─► emergency_triage_check          ← model calls this FIRST (instructed)
   │      normalize → concepts → scope → rules → disposition
   │      emergency | urgent | routine | insufficient
   │      returns: call-first line, ordered first aid, limitations, ruleset version
   │
   └─► (only afterwards) lookup tools
```

The screen is pure: no imports, no I/O, no clock, no randomness, ~0.3 ms p99. It
is **model-invoked**, so escalation still depends on the model following the
instruction — see `REPOSITORY_DEEP_AUDIT.md` §F-06 and §H.5 for the host-hook
design that would remove that dependency.

### Disposition semantics

| Disposition | Meaning | Required agent behaviour |
| --- | --- | --- |
| `emergency` | A red-flag rule fired | Deliver call-for-help + first aid in the given order, before anything else. No lookup first. |
| `urgent` | Symptom below an emergency threshold, or a definitional question containing a red flag | Say what needs checking and how soon. Never reassure. |
| `insufficient` | Too short to screen | Ask the returned questions, then re-screen. |
| `routine` | No rule fired | **Not a clearance.** Must be reported with its limitations. |

## 4. Data ownership

| Data | Owner | Retention |
| --- | --- | --- |
| Conversations, messages | LibreChat / MongoDB | indefinite (platform default) |
| Memories, memory profiles | LibreChat / MongoDB, partitioned per (user, agent) / per person | indefinite; user-deletable in Settings → Data → Memories |
| Roles, permissions, sessions | LibreChat / MongoDB (+Redis optional) | session TTL |
| BDDrugBank corpus | `packages/mcp-medical/data/` (763 KB gz, in-repo) | static |
| Upstream responses | in-process TTL cache, 500 entries, default 5 min | volatile |
| Safety verdicts | **not persisted.** Returned to the model; no audit trail. | n/a |

> The absence of a safety-event audit log is a real gap for any clinical
> deployment. It is listed as unresolved in the audit.

## 5. External dependencies and their failure modes

| Dependency | Failure mode | Current handling |
| --- | --- | --- |
| NCBI / Europe PMC / OpenAlex | 429, 5xx, timeout | retry w/ backoff, honour `Retry-After`, named error to model |
| openFDA | 404 on empty, daily cap | 404 → empty result (not an error); cap → 429 → backoff |
| PubChem | 503 "retry in ~30 s" | longer backoff base for 503, up to 3 attempts |
| RxNav / DailyMed / ChEMBL | unversioned schema drift | **fails silently as a well-formed wrong answer** — this is why the daily live smoke workflow exists |
| LLM provider (free tier) | queueing, 429, model removal | **no circuit breaker, no failover** — largest availability risk |
| MongoDB | unavailable | platform-level; not handled here |
| Redis | unavailable | optional; platform degrades |

## 6. Trust boundaries

1. **Browser → API:** untrusted. Session/JWT authenticated.
2. **API → MCP:** trusted local child process, no user identity.
3. **MCP → upstreams:** untrusted content entering model context. **Prompt
   injection is in scope here** and is mitigated only at the instruction level.
4. **Model → tools:** arguments validated by zod; the catalogue is read-only, so a
   compromised model cannot write or delete.

## 7. Deployment topology

- **Compose** (`deploy-compose.yml`): API + MongoDB + Meilisearch (+ optional Redis).
- **Helm** (`helm/`): chart with subcharts for the same.
- **Secrets:** `.env` only; `.env.example` (61 KB) documents every variable with no
  real credentials.
- **Health:** inherited `/health` endpoints in the Express app; the MCP server is
  spawned per agent session and has no standalone health endpoint.
