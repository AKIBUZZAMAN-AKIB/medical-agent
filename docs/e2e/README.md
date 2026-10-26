# Real-browser end-to-end audit

Three Playwright / Node artifacts live here. They answer different questions and are
*not* interchangeable — read the scope of each before quoting a result.

| Artifact | What it proves | Needs a browser *and* the client bundle |
| --- | --- | --- |
| `e2e/browser-auth-api.e2e.mjs` | The auth contract a browser actually exercises: signup, login, refresh cookie, logout, role assignment, admin gate, same-origin guard. Cookies are stored and replayed by Chromium itself. | No — backend only |
| `e2e/browser-auth.e2e.mjs` | The same flows through the rendered UI: `/login` and `/register` DOM, redirects, error banners, `/admin` and `/admin/triage-safety` screens. | Yes — the client bundle must be built |
| `e2e/verify-require-local-auth.js` | The status codes of `api/server/middleware/requireLocalAuth.js` (F-28), including a regression guard that a rejected login is never `404`. | No — no npm dependencies at all |

## How to run

```bash
# 0. one-time, host level (Debian: Chromium needs these shared libraries)
#    without root they can be unpacked into a prefix and pointed at by LD_LIBRARY_PATH
mkdir -p /tmp/debs && cd /tmp/debs && apt-get download \
  libnspr4 libnss3 libasound2t64 libatk1.0-0t64 libatk-bridge2.0-0t64 \
  libatspi2.0-0t64 libxkbcommon0 libxdamage1
for d in *.deb; do dpkg-deb -x "$d" "$HOME/libs"; done
export LD_LIBRARY_PATH="$HOME/libs/usr/lib/x86_64-linux-gnu"
npx playwright install chromium

# 1. dependencies + databases
npm install
npm run build:data-provider && npm run build:data-schemas && npm run build:api \
  && npm run build:client-package && npm run build:mcp-medical
mongod --dbpath ./mongo-data --port 27017     # or point MONGO_URI at an existing one

# 2. API (fresh database keeps the "first user becomes ADMIN" check meaningful)
MONGO_URI=mongodb://127.0.0.1:27017/LibreChat_e2e_auth node api/server/index.js

# 3. auth contract suite — runs against the API alone
node e2e/browser-auth-api.e2e.mjs --base=http://127.0.0.1:3080

# 4. UI suite — needs `npm run frontend` to have produced client/dist first
cd client && npm run build && cd ..
PORT=3080 node api/server/index.js &
node e2e/browser-auth.e2e.mjs --base=http://127.0.0.1:3080

# 5. dependency-free check of the login status codes
node e2e/verify-require-local-auth.js
```

Both Playwright suites write `*-report.json` and `*-report.md` into this directory,
and the UI suite also stores screenshots here.

## Result of the last run in this workspace (2026-10-26)

**`browser-auth-api.e2e.mjs`: 12 / 12 PASS** against a fresh `LibreChat_e2e_auth`
database, Chromium 151.0.7922.34. Evidence table: `browser-auth-api-report.md`.

**`verify-require-local-auth.js`: 6 / 6 PASS** (5 behaviour cases + regression guard).

**`browser-auth.e2e.mjs`: BLOCKED in this workspace, not failed.** The client bundle
could not be produced here. The host has 1.98 GB RAM shared with MongoDB, the API
server and the frontend toolchain; every attempt to compile the client (9,717
modules) was killed by the kernel OOM killer:

```
$ NODE_OPTIONS=--max-old-space-size=800 npx vite build --minify false
vite v8.2.2 building client environment for production...
✓ 9717 modules transformed.
rendering chunks...
Killed

$ dmesg | tail -1
Out of memory: Killed process 10296 (MainThread) total-vm:12623568kB,
anon-rss:1359316kB ... oom-kill:constraint=CONSTRAINT_NONE,...,global_oom
```

The Vite dev server dies the same way during dependency pre-bundling, so serving
the UI from source is not an option on this host either. Nothing about the UI is
claimed here: the login and signup *screens* are **NOT TESTED** in a browser until
this suite is run on a machine with roughly 4 GB of free RAM.

## What this means for the "does signup/login work" question

* Verified, in a real browser: an account is created, it can log in immediately,
  the session cookie is httpOnly + SameSite=Strict, refresh mints a usable access
  token, logout clears the cookie, the first account is ADMIN and later accounts
  are USER and are denied `/api/admin/*`, anonymous contexts are refused, and a
  foreign `Origin` is rejected.
* NOT verified here: that the React forms render those fields, that the success
  banner appears, and that the redirect after signup lands where the user expects.
  Those are exactly the checks `browser-auth.e2e.mjs` performs.

## Notes for whoever runs the UI suite next

* Registration always answers `200` with one generic message and creates **no**
  session (anti-enumeration, `api/server/services/AuthService.js`). The UI counts
  down for three seconds and then navigates to `/c/new`, so the assertion in the
  suite is "leaves `/register`", not "is now authenticated".
* A failed password therefore has to be checked through a separate login step,
  which is what `browser-auth.e2e.mjs` step A6 does.
* The register endpoint is rate limited (`registerLimiter`); running a suite more
  than a handful of times inside one window returns `429`. Restart the API (the
  limiter is in-memory) or wait out the window.
