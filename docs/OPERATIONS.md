# Operations: answer mode, tools stack, model pool and access

This is the private deployment used for Super-Power Doctor AI. Secrets
(`.env`, gate password, admin credentials, Tailscale state and keys) live only
on the host and are git-ignored.

## Answer mode: maximum help

The agent always researches first and then gives practical, structured help
instead of stopping at "see a doctor".

- Urgency is the model's own judgement. There is no triage tool, no red-flag
  list and no keyword or regex rule anywhere that labels a message as an
  emergency. The model reads the whole message and decides.
- No reply carries a scripted emergency-call line, alarm emoji or forced
  phone number. When the model judges a life-threatening situation, it opens
  with the first thing to do and gives the full step-by-step help: what to do
  now, getting to care (it says plainly when a hospital is needed, where and
  why), danger signs, likely causes, what to tell the hospital, what to do if
  the hospital is far, and questions. For self-harm it offers the Kaan Pete Roi
  emotional-support line.
- A definition question such as "what is a seizure" or "heart attack ki" gets
  a normal informative answer.
- Every tool result carries short hints added by the server
  (`src/language.ts`): a reply-language note when the user writes Bangla or
  Banglish, and correct fever home care (paracetamol is the right medicine
  for fever, including children and suspected dengue; avoid ibuprofen,
  aspirin and other NSAIDs when dengue is possible; no aspirin under 16).
- Doses: only what an official first-aid guideline or the drug label says,
  with the source. The consent text says the same.

The main agent's instructions live in `packages/mcp-medical/agent/instructions.md`.
Each specialist sub-agent has its own skill file in
`packages/mcp-medical/agent/subagents/` (role, method, tools, limits), followed
by the shared rules in `_shared.md` and the person-record rules from
`config/seed-medical-agent.js`. Specialists report to the main agent and do not
carry its user-facing instructions. The copies stored in MongoDB must be
updated whenever any of these files change.

## Tools stack

All services run on the same host via `deploy-compose.yml` +
`docker-compose.local-private.yml`.

| Service | Port | Purpose |
| --- | --- | --- |
| LibreChat API + client | 3080 | Chat UI, agents, MCP host |
| `mcp-medical` (stdio, inside the API container) | – | 33 tools: PubMed, drug labels, interactions, disease KB, lab reference ranges, BD drug index |
| SearXNG | internal | Private web search for the agent (`searxng/settings.example.yml`) |
| medtools | 4134 | `multilingual-e5` embeddings and cross-encoder reranker for RAG, page scraper for web search, and Mistral-compatible OCR for prescription photos and scanned lab reports |
| rag_api + vectordb | internal | Uploaded-file search |
| Bifrost | 4120 | OpenAI-compatible gateway in front of the model providers |

Model pool (`ops/model-pool`): `kilo_free_sync.py` runs daily, lists the free
models, tests tool calling and streaming, then runs `quality_bench.py` on each
candidate: a Bangla child-fever case and a Banglish `kalajor` case, each with
a real tool round trip, scored on Bangla script ratio, correct fever care,
kala-azar recognition, loops, leaked reasoning and mixed scripts, plus a
second model that rates Bangla and medical correctness. Only passing models
enter the `kilo/free-pool` routing rule; random routers and small models are
never used. Results are cached in `quality.json` for three days. The fallback
chain (e.g. `ovh/gpt-oss-120b`) stays in place.

Bifrost must start with `BIFROST_SETUP_TOKEN` set (read from the host's
`bifrost-data/setup_token.txt`), otherwise the admin API returns 403 and the
daily sync cannot update the routing rule.

## Access

- **Gate** (`ops/panel-gate`): nginx + a small password gate in front of both
  panels (user panel on 9081, admin panel on 9301). Five wrong passwords lock
  one connection for 15 minutes; a correct password clears the counter; an
  unlocked device stays unlocked for 7 days.
- **Stable links:** two Tailscale nodes (`medical-agent`, `medical-admin`) in
  userspace mode, each running `tailscale serve`/Funnel to its gate port, so
  the HTTPS names stay the same across restarts. State directories and auth
  keys stay on the host.
- **Backup links:** a supervisor keeps trycloudflare quick tunnels running and
  writes the current URLs to a local note. They change whenever the host
  sleeps.
- The host sleeps when idle, so links stop answering until it wakes. For
  always-on hosting move the stack to a small always-on VM.

## Consent

`interface.termsOfService` in `librechat.pure-doctor.yaml` holds the Bangla +
English consent popup. After editing it, reset acceptance so every user sees
the new text:

```js
db.users.updateMany({}, { $set: { termsAccepted: false }, $unset: { termsAcceptedAt: '' } })
```

## Branding

`branding/make_icons.py` builds the icon set; `branding/apply_branding.sh`
installs icons, page title and manifest into the running API container. Then
`docker commit` the container to `medical-agent-api:local` so it survives
restarts. The in-app title comes from `APP_TITLE` in `.env`.
