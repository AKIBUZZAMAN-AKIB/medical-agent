# Memory, persistence and long-run capability

Deep analysis of how the medical agent remembers, why it stops remembering, and
what that costs a patient who uses it for months. Every claim cites
`file:line` and was verified by reading the code.

The question this document answers is not "does memory work?" — it does — but
**"what happens on the 200th conversation?"**

---

## 1. The memory model, as built

### 1.1 Storage

One Mongo collection, `MemoryEntry`
(`packages/data-schemas/src/schema/memory.ts`):

| Field | Type | Purpose |
| --- | --- | --- |
| `userId` | ObjectId, indexed | owner |
| `key` | String, `/^[a-z_]+$/` | the *slot* name |
| `value` | String | the fact(s) in that slot |
| `agentId` | String? | agent partition; absent = shared personal pool |
| `profileId` | String? | **subject** partition; absent = the user themselves |
| `tokenCount` | Number | cached size |
| `updated_at` | Date | **injected into the prompt with every read** |
| `tenantId` | String, indexed | tenant isolation |

Unique index: `{ userId, agentId, profileId, key }`
(`memory.ts:52`) — so a key is unique *per partition*, which is what makes
per-person records work.

### 1.2 The three partitions

```
(user, agent, profile) ── unique key namespace
```

`partitionFilter()` (`packages/data-schemas/src/methods/memory.ts:19-22`) uses
`{ agentId: agentId ?? null, profileId: profileId ?? null }`. Because Mongo's
`null` matches an **absent** field, every row written before partitions existed
falls into the self/no-agent partition with **no migration**. That is a genuinely
elegant choice and it is why the scoping can never leak across people: a filter
for a named profile cannot match a row that has no `profileId`.

### 1.3 Two writers, two policies

| Writer | When | Identity |
| --- | --- | --- |
| Inline tools `set_memory` / `delete_memory` | during the agent turn, model-invoked | `packages/api/src/agents/memory.ts:139`, `:387` |
| Automatic extraction (`processMemory`) | **after** the turn, a second LLM call | `packages/api/src/agents/memory.ts:1002` |

The medical agent enables **both**: the seed sets `memory_policy: proactive`
(`config/seed-medical-agent.js:372`) and the deployment config enables the
extraction agent (`librechat.pure-doctor.yaml`).

### 1.4 What a read looks like

Memories are injected into the prompt **with their write date**
(`packages/data-schemas/src/methods/memory.ts:5-7` formats `YYYY-MM-DD`). This
matters clinically: a dated fact can be reasoned about ("recorded 8 months ago"),
an undated one cannot. The instructions then state that a stored memory is "a
record of what was said, on a date, by someone reporting on themselves. It is not
a verified fact."

---

## 2. Finding M-01 — memory is a hard wall, and it does not warn

**Severity: P2 · certain · NOT FIXED (needs a product decision)**

### The mechanism

`createMemoryTool` refuses to write once the budget is gone
(`packages/api/src/agents/memory.ts:288-300`):

```ts
if (tokenLimit && remainingTokens <= 0) {
  return [`Memory storage exceeded. Cannot save new memories.`, errorArtifact];
}
```

and again if the write *would* exceed it (`:275-287`): `"Memory storage would
exceed limit. Cannot save this memory."`

### There is no eviction anywhere

```bash
grep -rniE "prune|evict|expire|consolidat|decay" \
  packages/data-schemas/src/methods/memory.ts \
  packages/api/src/agents/memory.ts \
  packages/api/src/memory/*.ts
# → no matches
```

Combined with the README's own statement that nothing expires, the long-run
behaviour is:

```
month 1..N   memories accumulate
month N+1    budget full → every new write fails, forever
```

### Why this is worse for a medical agent than for a general assistant

1. **The facts that arrive last are the ones that matter most.** A new allergy, a
   new anticoagulant, a new diagnosis — these are the highest-value facts in the
   record and they are exactly the writes that fail.
2. **The failure is invisible to the patient.** The refusal is a *tool result* the
   model receives; it appears in the UI only as a memory-call artifact. A patient
   has no reason to look.
3. **It degrades silently and permanently.** A general assistant that forgets your
   favourite colour is a minor annoyance. An assistant that has silently stopped
   recording that you are on warfarin will confidently advise on ibuprofen.

### Measured capacity

A realistic synthetic clinical snapshot, measured in this audit:

```
Chronic conditions: type 2 diabetes since 2014, hypertension, CKD stage 3a
(eGFR 52). Takes metformin 1g BD, amlodipine 5mg OD, atorvastatin 20mg nocte.
Allergic to penicillin (rash).
→ 183 chars ≈ 46 tokens
```

At `tokenLimit: 12000`: **≈ 262 such facts**. That is generous for one person and
tight for a carer tracking a family, and it is a *ceiling with no recycling*.

### The secondary trap: overwrite semantics

`setMemory` is an upsert keyed on `(userId, agentId, profileId, key)`. There are
**8 slots**, not 8 lists. So `chronic_conditions` is one string, and writing it
replaces it. Nothing in storage merges. Merging depends entirely on the model
re-including the old content, which it can only do if the old content is in its
context (`buildInlineMemoryContext`, `memory.ts:724`).

Consequence: **a rewrite that omits a condition deletes that condition.** There is
no version history, no tombstone, no audit diff.

A single `charLimit` (default **10,000 chars ≈ 2,500 tokens**) also means 8 full
slots could hold ~20,000 tokens against a 12,000-token limit — the limit, not the
slot count, is what binds.

### What would fix it (not implemented — a policy decision, not a code fix)

| Option | Trade-off |
| --- | --- |
| Surface pressure to the user | Show "memory 92% full — 3 records could be archived" in the UI. Safe, no data loss, needs a decision about what to drop. |
| Recency-weighted eviction | Automatic, but silently deleting a 5-year-old anaphylaxis allergy to make room for a new food preference is exactly the wrong trade. **Not acceptable without a clinical rule that protects high-severity categories.** |
| Append-only journal + summarisation | Right long-run answer: keep every fact, inject a summary, retrieve the rest on demand. Largest change; needs an embedding store. |
| Raise `tokenLimit` | Postpones, does not solve; costs prompt budget on every turn. |

**Recommendation:** implement (1) now — it is UI-only and cannot lose data — and
(4) as a stopgap, then (3) as the real design. Do **not** ship (2).

---

## 3. Finding M-02 — `validKeys` was defeating `memory_profiles` · **FIXED**

**Severity: P2 · certain**

### The defect

`validKeys` is enforced **before** the profile partition is resolved
(`packages/api/src/agents/memory.ts:217-225`, then `:227-231`). It is therefore a
**global key namespace**, not a per-person one.

The deployment config shipped these keys:

```yaml
validKeys:
  - 'patient_profile'
  - 'family_member_mother'      # ← slot inside the USER's own record
  - 'family_member_father'      # ← slot inside the USER's own record
  - 'allergies_and_adverse_reactions'
  ...
```

Meanwhile the seed enables `memory_profiles: true`
(`config/seed-medical-agent.js:373`), whose entire purpose — stated in the package
README — is that "a patient talking about their father and themselves in one
message is the normal case, and a pooled history turns that into a wrong answer
about the wrong person's medication."

So the config provided **the mechanism the feature exists to prevent**: a key that
lives in the self partition but is documented to hold a relative's history. A model
calling `set_memory({ key: 'family_member_mother', … })` with no `profile`
argument writes the mother's allergy into the user's own record, where it will be
injected as *the user's* allergy on every future turn.

It is also unbounded in the wrong dimension: there are two such keys, so a
grandfather, an uncle, a daughter or a second child has no slot at all.

### The fix

Removed the per-person keys; family members now use the **same vocabulary inside
their own partition** (`profileId`), which is the design the schema already
supports:

```yaml
validKeys:
  - 'patient_profile'
  - 'allergies_and_adverse_reactions'
  - 'chronic_conditions'
  - 'active_medications'
  - 'lab_results'
  - 'clinical_preferences'
```

Migration consequence, stated because it is real: rows previously written under
`family_member_mother` / `family_member_father` **still exist and are still read**
(they are injected into context), but they can no longer be written. They are not
lost; they are frozen. An operator should migrate them by copying each value into
the correct person's partition — `delete_memory` + `set_memory` with `profile` —
and that is a manual, reviewable step, deliberately not automated here.

Also renamed `recent_lab_results` → `lab_results`, because memories never expire:
a key promising recency is false six months later. The row keeps its write date,
which is the honest way to convey freshness.

### Guard

`config/medical-deployment-config.spec.js` — 7 tests that fail if the deployment
config reintroduces a per-person key, drops the per-person vocabulary entirely,
reintroduces a recency claim in a key name, removes the memory bounds, or hides
the extraction-agent risk. These are *configuration* tests, which is unusual and
deliberate: every finding in this section is valid YAML that loads fine and
degrades the agent over months.

---

## 4. Finding M-03 — the extraction agent is a second, unmonitored model · **NOT FIXED**

**Severity: P2 · probable**

`memory.agent.enabled: true` runs `processMemory` after the turn
(`packages/api/src/agents/memory.ts:1278`). It is configured to the **same
free-tier OpenRouter model** as the chat agent
(`librechat.pure-doctor.yaml`).

Long-run consequences:

1. **Consolidation stops when the provider rotates the model**, while chat keeps
   working. The agent appears healthy and simply stops learning. There is no
   metric, no health check, and no user-visible signal.
2. **Two free-tier dependencies multiply the outage rate.** If either fails, some
   capability is lost.
3. `messageWindowSize: 8` means extraction only ever sees the last 8 messages. In
   a 40-message consultation, a fact stated at message 3 is captured only if
   extraction ran at that turn. It is not re-read later.

Mitigation applied: the risk is now written **in the config file** where an
operator reads it, and asserted by a governance test. The real fix is a paid model
plus a memory-write counter metric — deployment work, not code.

---

## 5. Finding M-04 — no safety audit trail · **NOT FIXED**

Triage decisions are returned to the model and discarded. Nothing records that a
message was assessed, at what severity, by which policy version, or what the agent
did with it.

For a clinical deployment this is the gap that makes incident review impossible:
after an under-triage you cannot answer "was it screened? was the severity
`unknown`? did the model ignore it?".

The framework now makes this **cheap to add correctly**, because
`TriageDecision` (`src/safety/triage.ts`) already carries `policy`, `classifier`,
`severity`, `decided`, and the evidence codes — none of which contain message
text. A PHI-free audit row is:

```json
{ "ts": "...", "conversationId": "...", "severity": "unknown",
  "decided": false, "policy": "kb:v3", "classifier": "llm:model-x",
  "codes": ["classifier_absent"] }
```

Recommended before any patient-facing use. Not implemented here because it needs
a retention decision and a place to store it, both of which are policy.

---

## 6. What genuinely works well (verified, not assumed)

1. **Partition isolation is sound.** The `null`-matches-absent trick
   (`methods/memory.ts:19-22`) means no row can leak between people, and no
   backfill is needed. This is better than most multi-tenant memory designs.
2. **Memories are dated on read.** A fact can be reasoned about in time.
3. **Clinical facts are kept out of memory by instruction.** The "two kinds of
   knowledge" rule forbids looking a dose or interaction up in memory — and
   `instructions.spec.ts` fails the build if that rule is deleted. This is the
   single most important memory-safety property in the repo.
4. **Consent is explicit and once.** Writing about a non-user requires a clear
   yes; declining stores nothing.
5. **There is a real exit.** Settings → Data → Memories lists people, fact counts,
   and deletes a person with everything stored about them. GDPR Article 17 has a
   working implementation here, which is more than most projects can say.
6. **Bounds are enforced in three places** — inline tool, REST route, and storage
   layer — so a client cannot bypass them.
7. **`conversation_history` is opt-in and user-scoped.** A guessed conversation id
   returns nothing.

---

## 7. Long-run capability: what actually degrades over months

| Horizon | What degrades | Mechanism | Status |
| --- | --- | --- | --- |
| 1 session | Early facts in a long chat | extraction window = 8 messages | documented |
| Days | Nothing much | cache TTLs are short, upstreams cacheable | fine |
| Weeks | Slot overwrites lose facts | upsert with no merge (M-01b) | **open** |
| Months | New writes rejected | hard token wall, no eviction (M-01) | **open** |
| Model rotation | Silent stop of consolidation | free-tier model (M-03) | **open** |
| Years | No way to audit what the agent knew | no memory versioning (M-01b) | **open** |
| Any | Wrong-person answers if keys pool people | `validKeys` (M-02) | **fixed** |

---

## 8. Recommended roadmap, ordered by risk-per-effort

1. **Surface memory pressure in the UI.** No data loss possible; turns a silent
   wall into an informed choice. *(UI-only)*
2. **Pin the extraction model and add a `memory.write.failed` counter.** Make
   silence observable. *(Deployment)*
3. **Add the PHI-free triage audit row (§5).** Prerequisite for any incident
   review. *(Small; the decision object already carries the fields)*
4. **Move to append-only facts + summarised injection.** The real long-run fix for
   M-01. Requires a retrieval store; do not attempt as a patch.
5. **Migrate frozen `family_member_*` rows** into per-person partitions.
   *(Manual, one-time, reviewable)*
6. **Do not** add automatic recency eviction without a clinical rule that protects
   allergy / anticoagulant / anaphylaxis categories — deleting a 2019
   anaphylaxis record to store a new preference is a worse failure than refusing
   the write.

---

## 9. Per-person records: how a record is created, labelled and read

Researched from the code, not from the design intent. The chain is short and it
is entirely implicit — there is no "new record" screen in the agent's path.

### 9.1 The write path

| Step | File | What happens |
| --- | --- | --- |
| 1 | `packages/api/src/agents/memory.ts:376-378` | `set_memory`'s schema gains a `profile` argument **only** for an agent with `memory_profiles` |
| 2 | `memory.ts:900-902` | `resolveProfileTarget = (profile) => prepareProfileTarget({ userId, profile, ... })` |
| 3 | `tools/profiles/runtime.ts` | label → target: self, or a key derived from the label |
| 4 | `runtime.ts` `prepareProfileTarget` | registry read; on a miss `createProfile({ userId, name: label })` |
| 5 | `data-schemas/src/methods/profile.ts` `createProfile` | key from the label, unique index on `{userId, profileId}`, `''` refused, duplicate → `conflict` |
| 6 | `memory.ts:335` | `created` is surfaced to the model: *"Opened a new record for …"* |

### 9.2 The read path

```
buildInlineMemoryContext (agents/memory.ts)   ← profile mode
        → formatProfileIndex                    names + relationship + count, never facts
        → model calls read_profile(person)
        → partition { userId, profileId?, agentId? }
        → getFormattedMemories + getUserMemories → dated facts, one person
```

Isolation is therefore a data-flow property, not an attention property: another
person's facts were never in the prompt, so no instruction can make the model
recall them. `client.js` also returns an empty memory marker for profile agents,
so the background extraction agent — which has no `profile` argument and no
consent check — never writes into a record (`client.js:3264-3268`, with the
profile index built at `client.js:3001-3010`).

### 9.3 Identity rules (after this stage)

Nothing about a person is enumerated. A person is any label the user says, and a
`relationship` is free text in their own words; the tools, the seed and the
schema hold no kinship table. The only reserved string is `self`, and it is
reserved because the tools publish it themselves as the id of the user's own
record.

| Question | Rule | Where |
| --- | --- | --- |
| Is this the user themselves? | blank, the published id `self`, or the name on the user's own record | `runtime.ts` `resolveProfileName` |
| What is a record's key? | every letter and digit of the label, in order, `_`-joined, NFKC | `data-schemas/src/schema/profile.ts` `toProfileId` |
| Can the key move? | no. Renaming changes the label; facts stay in the partition | `methods/profile.ts` `updateProfile` |
| How is a renamed person found? | by key, then by the name the record now carries | `runtime.ts` `findEntry` |
| Can a record be deleted? | yes, except the user's own; the cascade removes that person's facts in every agent partition | `methods/profile.ts` `deleteProfile` |
| Can the model maintain records? | yes: `create_profile`, `update_profile`, `delete_profile` alongside `list_profiles`, `read_profile` | `tools/profiles/definitions.ts` |

### 9.4 Findings from this stage

| ID | Finding | Severity | Status |
| --- | --- | --- | --- |
| M-05 | An ASCII-only key derivation collapsed every non-Latin label to `''`, and `''` is falsy — `setMemory` dropped it and the row landed in the **user's own** partition. For a Bangla-first deployment this was the primary path, and it failed silently. | **P0** | **FIXED** — key keeps `\p{L}\p{N}`; `memory.ts` uses strict `!= null && !== ''` |
| M-06 | A `createProfile` failure other than a lost race was treated as success, so the write went ahead into whatever partition was left. | **P0** | **FIXED** — `prepareProfileTarget` throws instead of writing |
| M-07 | The record stored its **slug** as `name`, so the profile list showed `my_father` instead of what the user said. | P1 | **FIXED** — the label is stored |
| M-08 | A renamed record was unreachable: reading the new name returned an empty record and writing to it opened a **second** record for the same person. | P1 | **FIXED** — registry lookup by key then by name |
| M-09 | The model had no way to open, correct or close a record deliberately; creation was only a side effect of a write, so a typo became a permanent person. | P1 | **FIXED** — full lifecycle tools |
| M-10 | `updateProfile`/`deleteProfile` take `profileId`; mongoose **drops an undefined condition**, so an absent key made the filter `{ userId }` — an arbitrary record, and for delete the cascade went with it. | P1 | **FIXED** — exactly one of `profileId`/`isSelf`; delete refuses a blank key |
| M-11 | Specialist sub-agents were seeded with MCP tools only — no memory capability, no `memory_profiles` — so they were profile-blind and had to be told the patient in prose. `memory_scope: 'agent'` per agent would also have put each agent's facts in a separate pool. | P1 | **FIXED** — every agent gets `memory` + `memory_profiles`, one shared pool |
| M-12 | `SELF_PROFILE_ALIASES` was an English-only synonym table: a predefined vocabulary, in a deployment that must not carry one, and blind to the name the user actually uses. | P2 | **FIXED** — removed |
| M-13 | `lazySubagents.ts` hashes a `VersionedAgent` that includes `memory_scope` but **not** `memory_profiles`, so changing the profile flag on a sub-agent does not change its cached config id. | P2 | **open** |
| M-14 | `tokenLimit` is enforced **per partition**, so N people permit N× the configured memory. | P2 | **open** — a cap would be an invented number; see §8 |

### 9.5 Verification for §9

| Check | Command | Result |
| --- | --- | --- |
| Key derivation properties, generated labels | `packages/api`: `npx jest src/tools/profiles` | **PASS** 55/55 |
| Storage behaviour on a real in-memory MongoDB | `packages/data-schemas`: `npx jest src/methods/profile.spec.ts src/methods/memory.spec.ts` | **PASS** 39/39 |
| Model-facing lifecycle through the real tool loader | `api`: `npx jest app/clients/tools/util/handleTools.test.js` | **PASS** 32/32 |
| Profile-mode prompt/index isolation | `packages/api`: `npx jest src/agents/memory.spec.ts` | **PASS** 49/49 |
| REST per-person routes | `api`: `npx jest server/routes/__tests__/memories.spec.js` | **PASS** 15/15 |
| Agent initialisation (tool registration) | `packages/api`: `npx jest src/agents/__tests__/initialize.test.ts` | **PASS** 152/152 |
| Seeded graph wiring | root: `npx jest --config config/jest.config.js config/medical-deployment-config.spec.js` | **PASS** 12/12 |
| Medical package (untouched by this stage) | `packages/mcp-medical`: `npx jest` / `node scripts/emergency-e2e.mjs` | **PASS** 143/143, 6/6 |
| Full `packages/api` suite | `npx jest --ci` | **NOT RUN** — the sandbox has ~1.9 GB RAM; the full run dies before finishing. The six suites that touch profiles were run individually. |
| `tsc --noEmit` for the whole API package | `npx tsc --noEmit -p packages/api/tsconfig.json` | **BLOCKED** — heap exhaustion. Type errors would still fail `npm run build:api`, which passed (tsdown emits declarations and fails on type errors). |

### 9.6 Migration note

`memory_scope` moved from `agent` to `user` for the seeded graph so that the
specialists read the same records the primary agent writes. Facts already stored
under an agent partition are **not** visible in the shared pool. Either re-key
them once (`MemoryEntry.updateMany({ agentId: '<agent id>' }, { $unset: { agentId: 1 } })`)
or keep the old scope on an existing deployment. Nothing performs this
automatically.
