# Deployment

This file covers **this fork** (the medical agent). Upstream LibreChat deployment
docs do not apply unchanged: the upstream image contains none of the medical
code, and the upstream compose file mounts a config file this repository does not
ship.

Everything below was executed against a real MongoDB during the deploy audit
except where a line is explicitly marked **NOT TESTED**.

---

## 1. What actually has to be right

| Piece | Where | Fails how if wrong |
| --- | --- | --- |
| Chat model endpoint | `MEDICAL_LLM_BASE_URL` / `MEDICAL_LLM_API_KEY` → custom endpoint in `librechat.pure-doctor.yaml` | App boots and logs nothing; every message errors. Nothing in this repo serves a model. |
| Config file | `librechat.pure-doctor.yaml` (mounted at `/app/librechat.yaml` by `deploy-compose.yml`) | Silent fall back to defaults: **no** agent endpoint, **no** memory block, **no** MCP server. |
| Config `version:` | must equal `Constants.CONFIG_VERSION` (currently `1.3.16`) | Warning `Outdated Config version` at every boot. |
| MCP entry path | `packages/mcp-medical/dist/index.js`, resolved against the **API process working directory** | `Cannot find module …/api/packages/…` → circuit breaker → 0 tools. |
| MCP `serverInstructions: true` | `mcpServers.medical` | The server's safety preamble is never injected; the model sees `Server Instructions: N/A`. |
| BDDrugBank corpus | `packages/mcp-medical/data/bddrugbank-compact.json.gz` (762 KB) | `bd_medicine_lookup` throws; the flagship BD formulary tool is dead. `Dockerfile.multi` copies it. |
| Secrets | `JWT_SECRET`, `JWT_REFRESH_SECRET`, `CREDS_KEY` (32-byte hex), `CREDS_IV` (16-byte hex) | Without them LibreChat generates **temporary** credentials: every restart logs everyone out and orphans encrypted stored keys. |
| Seed | `config/seed-medical-agent.js` | No agent exists to chat with. |
| `SCHEDULES_SINGLE_PROCESS=true` | one API replica, no Redis | Scheduler refuses to arm; schedule writes 503. |

## 2. Preflight — run this first

```bash
npm run verify-deployment            # or: node config/verify-deployment.js
npm run verify-deployment -- --offline   # skip the LLM + Mongo probes
```

Exit code `1` means a real blocker. It checks: Node version, config exists and
parses, config version matches the code, MCP entry resolves from the current
working directory, `serverInstructions`, tool count, corpus presence, JWT/CREDS
secrets, writable `uploads` / `client/public/images` / log dirs, MongoDB
connectivity, seeded agent + sub-agents, and that the chat endpoint answers
`GET {baseURL}/models` **and advertises the model `agent.json` asks for**.

## 3. Docker Compose (recommended)

```bash
cp .env.example .env
$EDITOR .env      # MONGO_URI is overridden by compose; set the secrets below
```

`.env` must contain at least:

```dotenv
JWT_SECRET=<32+ random chars>
JWT_REFRESH_SECRET=<32+ random chars>
CREDS_KEY=<64 hex chars>      # openssl rand -hex 32
CREDS_IV=<32 hex chars>       # openssl rand -hex 16
DOMAIN_CLIENT=http://localhost:3080
ADMIN_PANEL_SESSION_SECRET=<32+ chars>   # only if the admin-panel profile is used
MEDICAL_LLM_BASE_URL=http://host.docker.internal:4120/v1
MEDICAL_LLM_API_KEY=<key for that endpoint>
```

```bash
docker compose -f deploy-compose.yml up -d --build     # api, client(nginx), mongodb, meilisearch, rag stack
docker compose -f deploy-compose.yml logs -f api       # expect: "Server readiness checks passing."
curl -fsS http://localhost/health                      # 200 OK through nginx
```

First-run database work, **in this order** — the seed refuses to run without an
ADMIN owner:

```bash
# 1. an owner. --email-verified=true is required in a non-interactive shell:
#    without it the script waits on a y/N prompt that no one can answer.
docker compose -f deploy-compose.yml run --rm api \
  node config/create-user.js admin@yourdomain.org "Admin" admin 'Strong-Passw0rd!' --email-verified=true

# 2. the agent + 7 specialist sub-agents
docker compose -f deploy-compose.yml --profile seed run --rm seed

# 3. re-run the preflight against the running stack
docker compose -f deploy-compose.yml exec api node config/verify-deployment.js
```

`deploy-compose.yml` differs from upstream `docker-compose.yml` on purpose and
for reasons recorded in its header: it builds the API from this repository
(`Dockerfile.multi`, target `api-build`), mounts the config file that exists,
runs the API with `working_dir: /app`, and sets `SCHEDULES_SINGLE_PROCESS`.

**NOT TESTED:** no `docker compose` run, image build, or container boot has been
executed in the audit sandbox (no Docker daemon available). The Dockerfile and
compose changes are derived from reading the files and from a host boot that
reproduced each failure they fix.

## 4. Host / systemd-style deployment

```bash
nvm use                 # Node >= 24 to build, >= 20 to run
npm install
npm run build:data-provider && npm run build:data-schemas && npm run build:api \
  && npm run build:client-package && npm run build:mcp-medical
cd client && npm run build && cd ..          # needs ~4 GB RAM for Vite

export CONFIG_PATH="$PWD/librechat.pure-doctor.yaml"
npm run backend                              # from the repo root, always
```

Start it from the repository root. The MCP entry in the config is relative, and
starting from `api/` makes it unresolvable — this was reproduced: the server
retried three times, opened its circuit breaker, and the app came up with **0
medical tools** and no error the user would ever see.

`npm run verify-deployment` is the post-start check; `curl -fsS localhost:3080/health`
is the liveness check.

## 5. Reverse proxy and TLS

`client/nginx.conf` is HTTP-only out of the box: its TLS `server` block is
commented out and no certificate is mounted, so `deploy-compose.yml` publishes
**80 only**. Put TLS in front (Caddy, a cloud load balancer, or the commented
SSL block plus a mounted certificate), then set `DOMAIN_CLIENT=https://…` and
`ADMIN_PANEL_SESSION_COOKIE_SECURE=true` for the admin panel.

## 6. Choosing the tool catalogue per model

The default is the full 33-tool catalogue. Small models degrade with it; the
emergency screen cannot be removed by any variable.

```yaml
mcpServers:
  medical:
    env:
      MEDICAL_TOOL_GROUPS: 'formulary,drugs,calculators,emergency'
```

## 7. Browser verification (the UI path)

`config/ui-smoke.js` (`npm run verify-ui`) drives real Chromium against a running
deployment and asserts 18 things; it exits non-zero on any failure and writes
screenshots plus `results.json` to `SHOT_DIR` (default `/tmp/ui-shots`).

```bash
SHOT_DIR=/tmp/ui-shots UI_BASE=http://127.0.0.1:3090 npm run verify-ui
```

Two prerequisites, both easy to get wrong:

- **`packages/client` must be built** (`npm run build:client-package`) before the
  vite dev server will serve `@librechat/client/style.css`. Without it every
  module import of `@librechat/client` fails with a 500 and the page renders
  blank — a build step, not a deployment bug.
- **Raise `LOGIN_MAX`** for the run, or repeated logins trip the limiter
  (default `LOGIN_MAX=7` per `LOGIN_WINDOW=5` minutes) and every later check sees
  429/401. `LOGIN_MAX=200 LOGIN_WINDOW=1` on the API process is enough.

What it proved on this tree (18/18): the login surface renders, `POST /api/auth/login`
returns 200 and sets an httpOnly `refreshToken`, `/api/models` serves the custom
endpoint and the seeded model, the chat view offers **Super-Power Doctor AI** with
its Bangla conversation starters, `/admin` renders *Medical Admin OS* with live
data, all four admin endpoints answer 200, the console reports **33** tools — and
the browser console has **no errors**, no failed requests and no 5xx.

Screenshot: `docs/screenshots/` is intentionally not committed; regenerate with the
command above.

## 8. Operational gaps (read before calling this production-ready)

1. **No backups.** `mongodump` is documented, no restore drill has been run.
2. **MongoDB runs without authentication** inside the compose network and its
   port is not published. That is safe only as long as the network stays private.
3. **Single replica only.** `SCHEDULES_SINGLE_PROCESS=true` is an assertion, not
   a check. Two replicas with this flag will corrupt scheduled runs.
4. **The LLM endpoint is a single point of failure** with no failover and no
   circuit breaker.
5. **The emergency screen is model-invoked.** If the model skips the tool, no
   deterministic check runs. This is a known, documented design limit.
6. **Not HIPAA/GDPR compliant.** No claim is made; no patient data was used in
   any test.
7. **A full `vite build` OOMs in a 2 GB sandbox.** The production client bundle was
   therefore not built here; the UI was verified through the vite dev server
   instead (§7), which compiles the same modules but skips the optimiser and
   minifier.
