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
- When the model judges a life-threatening situation, the reply starts with one line, `🚨 এখনই 999-এ কল করুন।`
  (plus Kaan Pete Roi for self-harm), followed by the full step-by-step help:
  what to do now, on the way, danger signs, likely causes, what to tell the
  hospital, what to do if the hospital is far, and questions.
- Non-emergencies never get the 999 line, and neither does a definition
  question such as "what is a seizure" or "heart attack ki".
- Every tool result carries short hints added by the server
  (`src/language.ts`): a reply-language note when the user writes Bangla or
  Banglish, and correct fever home care (paracetamol is the right medicine
  for fever, including children and suspected dengue; avoid ibuprofen,
  aspirin and other NSAIDs when dengue is possible; no aspirin under 16).
- Doses: only what an official first-aid guideline or the drug label says,
  with the source. The consent text says the same.
- `MEDICAL_TRIAGE_MODE=control` restores the old triage-first behaviour.

Agent instructions live in `packages/mcp-medical/agent/instructions.md`; the
copies stored in MongoDB (main agent + specialist sub-agents, each with its
own prefix) must be updated whenever that file changes.

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
