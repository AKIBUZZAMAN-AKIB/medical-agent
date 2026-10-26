/**
 * Real-browser (Chromium) end-to-end audit of the auth surface a browser uses:
 * registration, login, refresh-token cookies, logout and the admin gate.
 *
 * Chromium is driven through a real Playwright browser context, so cookies are
 * stored, replayed and cleared by the browser itself, not by a hand-rolled client.
 *
 * Expectations below were taken from the code, not guessed:
 *   - AuthService.registerUser always answers 200 with one generic message and
 *     sets no session cookie (anti-enumeration; see api/server/services/AuthService.js).
 *   - setAuthTokens sets `refreshToken` (httpOnly, sameSite=strict) and returns the
 *     access token in the response body; the SPA keeps that token in memory and
 *     sends it as `Authorization: Bearer`.
 *   - middleware/requireLocalAuth answers 401 when Passport finds no user (it used
 *     to answer 404; F-28 in docs/REPOSITORY_DEEP_AUDIT.md records the change).
 *
 * Not covered here (needs a machine with >= 3 GB RAM to build the client bundle):
 * the DOM of /login and /register — see e2e/browser-auth.e2e.mjs and docs/e2e/README.md.
 *
 * Usage: node e2e/browser-auth-api.e2e.mjs [--base=http://127.0.0.1:3080]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const outDir = path.join(repoRoot, 'docs', 'e2e');
fs.mkdirSync(outDir, { recursive: true });

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const BASE = arg('base', 'http://127.0.0.1:3080').replace(/\/$/, '');
const STAMP = Date.now().toString(36);
const EMAIL = `e2e.first.${STAMP}@example.org`;
const EMAIL2 = `e2e.second.${STAMP}@example.org`;
const PASSWORD = 'E2e!TestPassw0rd-2026';

const results = [];
const record = (id, title, status, detail) => {
  results.push({ id, title, status, detail });
  const icon = status === 'PASS' ? '✅' : status === 'FAIL' ? '❌' : '⚠️ ';
  console.log(`${icon} [${id}] ${title} — ${status}\n      ${detail ?? ''}`);
};

const getCookie = async (ctx, name) => (await ctx.cookies()).find((c) => c.name === name);

async function main() {
  const browser = await chromium.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-gpu', '--disable-dev-shm-usage', '--single-process'],
  });
  const chromiumVersion = browser.version();

  // --------------------------------------------------------- B0 startup config
  {
    const ctx = await browser.newContext();
    const r = await ctx.request.get(`${BASE}/api/config`, { failOnStatusCode: false });
    const cfg = await r.json().catch(() => ({}));
    await ctx.close();
    record(
      'B0',
      'Server advertises registration + email login',
      r.status() === 200 && cfg?.registrationEnabled === true && cfg?.emailLoginEnabled === true
        ? 'PASS'
        : 'FAIL',
      `GET /api/config -> ${r.status()}; registrationEnabled=${JSON.stringify(cfg?.registrationEnabled)}; emailLoginEnabled=${JSON.stringify(cfg?.emailLoginEnabled)}; emailEnabled=${JSON.stringify(cfg?.emailEnabled)}`,
    );
  }

  const ctx = await browser.newContext();

  // ------------------------------------------------------------------- B1 signup
  let registerBody = null;
  {
    const r = await ctx.request.post(`${BASE}/api/auth/register`, {
      data: { name: 'E2E First Patient', email: EMAIL, password: PASSWORD, confirm_password: PASSWORD },
      failOnStatusCode: false,
    });
    registerBody = await r.json().catch(() => ({}));
    const rt = await getCookie(ctx, 'refreshToken');
    record(
      'B1',
      'Signup is accepted and (by design) returns a generic message without a session',
      r.status() === 200 && typeof registerBody?.message === 'string' && rt == null ? 'PASS' : 'FAIL',
      `POST /api/auth/register -> ${r.status()}; message="${registerBody?.message}"; userCreated=${registerBody?.userCreated ?? 'n/a'}; session cookie=${rt ? 'ISSUED' : 'not issued (expected)'}`,
    );
  }

  // ------------------------------------------------- B2 the account really exists
  let accessToken = null;
  let adminCookie = null;
  {
    const r = await ctx.request.post(`${BASE}/api/auth/login`, {
      data: { email: EMAIL, password: PASSWORD },
      failOnStatusCode: false,
    });
    const body = await r.json().catch(() => ({}));
    accessToken = body?.token ?? null;
    adminCookie = await getCookie(ctx, 'refreshToken');
    record(
      'B2',
      'The account created in B1 can log in immediately',
      r.status() === 200 && accessToken != null && adminCookie != null ? 'PASS' : 'FAIL',
      `POST /api/auth/login -> ${r.status()}; user=${body?.user?.email ?? 'n/a'}; access token in body=${
        accessToken != null ? 'yes' : 'no'
      }; refreshToken cookie=${adminCookie ? `httpOnly=${adminCookie.httpOnly}, sameSite=${adminCookie.sameSite}` : 'MISSING'}`,
    );
  }

  // ----------------------------------------------------- B3 first user is ADMIN
  {
    const r = await ctx.request.get(`${BASE}/api/user`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      failOnStatusCode: false,
    });
    const me = await r.json().catch(() => ({}));
    record(
      'B3',
      'First registered account is ADMIN',
      r.status() === 200 && me?.role === 'ADMIN' ? 'PASS' : 'FAIL',
      `GET /api/user (Bearer) -> ${r.status()}; role=${me?.role}; email=${me?.email}`,
    );
  }

  // ------------------------------------------------ B4 admin API reachable (ADMIN)
  {
    const r = await ctx.request.get(`${BASE}/api/admin/users?limit=5`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      failOnStatusCode: false,
    });
    record(
      'B4',
      'ADMIN can read the admin user list',
      r.status() === 200 ? 'PASS' : 'FAIL',
      `GET /api/admin/users -> ${r.status()}`,
    );
  }

  // -------------------------------- B5 refresh restores a usable access token
  {
    const r = await ctx.request.post(`${BASE}/api/auth/refresh`, { failOnStatusCode: false });
    const body = await r.json().catch(() => ({}));
    const fresh = body?.token ?? null;
    const me = await ctx.request.get(`${BASE}/api/user`, {
      headers: fresh ? { Authorization: `Bearer ${fresh}` } : {},
      failOnStatusCode: false,
    });
    record(
      'B5',
      'Refresh token cookie mints a new access token that works',
      r.status() === 200 && fresh != null && me.status() === 200 ? 'PASS' : 'FAIL',
      `POST /api/auth/refresh -> ${r.status()} (user=${body?.user?.email ?? 'n/a'}); new token used for GET /api/user -> ${me.status()}`,
    );
  }

  // --------------------------------------------------------------- B6 logout
  {
    const before = await getCookie(ctx, 'refreshToken');
    const r = await ctx.request.post(`${BASE}/api/auth/logout`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      failOnStatusCode: false,
    });
    const after = await getCookie(ctx, 'refreshToken');
    record(
      'B6',
      'Logout clears the refresh-token cookie in the browser',
      r.status() < 400 && before != null && after == null ? 'PASS' : 'FAIL',
      `POST /api/auth/logout -> ${r.status()}; cookie before=${before ? 'set' : 'none'}, after=${after ? 'still set' : 'cleared'}`,
    );
  }

  // ------------------------------------------------- B7 wrong password rejected
  let wrongPasswordStatus = null;
  {
    const r = await ctx.request.post(`${BASE}/api/auth/login`, {
      data: { email: EMAIL, password: 'WrongPassword-2026' },
      failOnStatusCode: false,
    });
    wrongPasswordStatus = r.status();
    const body = await r.json().catch(() => ({}));
    const rt = await getCookie(ctx, 'refreshToken');
    record(
      'B7',
      'Wrong password is rejected and issues no session',
      r.status() === 401 && rt == null ? 'PASS' : 'FAIL',
      `POST /api/auth/login -> ${r.status()} ("${body?.message}"); refreshToken cookie=${rt ? 'ISSUED (bad)' : 'not issued'}`,
    );
  }

  // ------------------------------ B8 duplicate signup leaks nothing, creates nothing
  {
    const fresh = await browser.newContext();
    const r = await fresh.request.post(`${BASE}/api/auth/register`, {
      data: { name: 'Duplicate', email: EMAIL, password: PASSWORD, confirm_password: PASSWORD },
      failOnStatusCode: false,
    });
    const body = await r.json().catch(() => ({}));
    const rt = await getCookie(fresh, 'refreshToken');
    await fresh.close();
    const identical = r.status() === 200 && body?.message === registerBody?.message;
    record(
      'B8',
      'Duplicate signup answers identically (no account enumeration) and creates no session',
      identical && rt == null ? 'PASS' : 'FAIL',
      `POST /api/auth/register (existing email) -> ${r.status()}; message identical to B1=${identical}; userCreated=${body?.userCreated ?? 'n/a'}; session cookie=${rt ? 'ISSUED (bad)' : 'not issued'}`,
    );
  }

  // ------------------------------------- B9 second account is USER, admin API denied
  {
    const fresh = await browser.newContext();
    const reg = await fresh.request.post(`${BASE}/api/auth/register`, {
      data: { name: 'E2E Second User', email: EMAIL2, password: PASSWORD, confirm_password: PASSWORD },
      failOnStatusCode: false,
    });
    const login = await fresh.request.post(`${BASE}/api/auth/login`, {
      data: { email: EMAIL2, password: PASSWORD },
      failOnStatusCode: false,
    });
    const loginBody = await login.json().catch(() => ({}));
    const token2 = loginBody?.token ?? null;
    const me = await fresh.request.get(`${BASE}/api/user`, {
      headers: token2 ? { Authorization: `Bearer ${token2}` } : {},
      failOnStatusCode: false,
    });
    const meBody = await me.json().catch(() => ({}));
    const admin = await fresh.request.get(`${BASE}/api/admin/users?limit=5`, {
      headers: token2 ? { Authorization: `Bearer ${token2}` } : {},
      failOnStatusCode: false,
    });
    await fresh.close();
    const roleOk = meBody?.role === 'USER';
    const denied = admin.status() === 403 || admin.status() === 401;
    record(
      'B9',
      'Second account is USER and is denied the admin API',
      reg.status() === 200 && login.status() === 200 && roleOk && denied ? 'PASS' : 'FAIL',
      `register -> ${reg.status()}${reg.status() === 429 ? ' (register rate limiter tripped — expected after repeated runs in one window)' : ''}; login -> ${login.status()}; role=${meBody?.role}; GET /api/admin/users -> ${admin.status()}`,
    );
  }

  // ------------------------------------ B10 anonymous browser context is refused
  {
    const anon = await browser.newContext();
    const me = await anon.request.get(`${BASE}/api/user`, { failOnStatusCode: false });
    const admin = await anon.request.get(`${BASE}/api/admin/users`, { failOnStatusCode: false });
    await anon.close();
    record(
      'B10',
      'Anonymous browser context cannot read /api/user or /api/admin/users',
      (me.status() === 401 || me.status() === 403) && (admin.status() === 401 || admin.status() === 403)
        ? 'PASS'
        : 'FAIL',
      `GET /api/user -> ${me.status()}; GET /api/admin/users -> ${admin.status()}`,
    );
  }

  // ----------------------------------- B11 same-origin guard on the login route
  {
    const csrf = await browser.newContext();
    const r = await csrf.request.post(`${BASE}/api/auth/login`, {
      data: { email: EMAIL, password: PASSWORD },
      headers: { Origin: 'https://evil.example.com' },
      failOnStatusCode: false,
    });
    const rt = await getCookie(csrf, 'refreshToken');
    await csrf.close();
    record(
      'B11',
      'Login rejects a foreign Origin (requireSameOrigin)',
      r.status() >= 400 && rt == null ? 'PASS' : 'FAIL',
      `POST /api/auth/login with Origin: https://evil.example.com -> ${r.status()}; session cookie=${rt ? 'ISSUED (bad)' : 'not issued'}`,
    );
  }

  await browser.close();

  const totals = {
    pass: results.filter((r) => r.status === 'PASS').length,
    fail: results.filter((r) => r.status === 'FAIL').length,
  };
  const report = {
    base: BASE,
    ranAt: new Date().toISOString(),
    chromium: chromiumVersion,
    accounts: { admin: EMAIL, user: EMAIL2 },
    observed: { wrongPasswordStatus },
    results,
    totals,
  };
  fs.writeFileSync(path.join(outDir, 'browser-auth-api-report.json'), JSON.stringify(report, null, 2));
  fs.writeFileSync(
    path.join(outDir, 'browser-auth-api-report.md'),
    [
      '# Browser-driven auth audit (Chromium)',
      '',
      `- Base URL: \`${BASE}\``,
      `- Ran at: ${report.ranAt}`,
      `- Browser: Chromium ${chromiumVersion} via Playwright (real browser cookie jar)`,
      `- Synthetic accounts: \`${EMAIL}\`, \`${EMAIL2}\``,
      `- Totals: **${totals.pass} PASS / ${totals.fail} FAIL**`,
      '',
      '| # | Check | Status | Evidence |',
      '| --- | --- | --- | --- |',
      ...results.map(
        (r) =>
          `| ${r.id} | ${r.title} | ${r.status} | ${String(r.detail ?? '')
            .replace(/\|/g, '\\|')
            .slice(0, 260)} |`,
      ),
      '',
    ].join('\n'),
  );
  console.log('\n=== TOTALS ===', JSON.stringify(totals));
  process.exit(totals.fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(2);
});
