/**
 * Real-browser end-to-end audit of signup / login / logout / admin access.
 *
 * Runs Chromium (Playwright) against a live LibreChat stack:
 *   - backend  : http://127.0.0.1:3080  (`node api/server/index.js`)
 *   - frontend : http://127.0.0.1:3090  (Vite dev server, proxies /api -> backend)
 *
 * Every step records PASS / FAIL with the evidence that produced the verdict.
 * Screenshots land in docs/e2e/ (synthetic accounts only, no patient data).
 *
 * Usage:
 *   node e2e/browser-auth.e2e.mjs [--base=http://127.0.0.1:3090] [--headful]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const shotDir = path.join(repoRoot, 'docs', 'e2e');
fs.mkdirSync(shotDir, { recursive: true });

const arg = (name, dflt) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : dflt;
};
const BASE = arg('base', 'http://127.0.0.1:3090').replace(/\/$/, '');
const HEADFUL = process.argv.includes('--headful');
const STAMP = Date.now().toString(36);
const EMAIL = `e2e.patient.${STAMP}@example.org`;
const PASSWORD = 'E2e!TestPassw0rd-2026';
const NAME = 'E2E Test Patient';

const results = [];
let shotIndex = 0;

function record(id, title, status, detail) {
  results.push({ id, title, status, detail });
  const icon = status === 'PASS' ? '✅' : status === 'FAIL' ? '❌' : '⚠️ ';
  console.log(`${icon} [${id}] ${title} — ${status}`);
  if (detail) console.log(`      ${detail}`);
}

async function shot(page, label) {
  shotIndex += 1;
  const file = path.join(shotDir, `${String(shotIndex).padStart(2, '0')}-${label}.png`);
  await page.screenshot({ path: file, fullPage: false }).catch(() => {});
  return path.relative(repoRoot, file);
}

/** Wait for the SPA to be interactive (Vite dev compiles on demand). */
async function settle(page, ms = 1500) {
  await page.waitForLoadState('domcontentloaded').catch(() => {});
  await page.waitForTimeout(ms);
}

async function main() {
  /** The sandbox box has ~2 GB RAM shared with Mongo, the API and the Vite dev
   *  server, so Chromium is asked to run as a single process with a small JS heap
   *  instead of the usual one-renderer-per-tab tree. */
  const browser = await chromium.launch({
    headless: !HEADFUL,
    args: [
      '--no-sandbox',
      '--disable-gpu',
      '--disable-dev-shm-usage',
      '--single-process',
      '--renderer-process-limit=1',
      '--js-flags=--max-old-space-size=320',
    ],
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  const consoleErrors = [];
  const apiCalls = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 400));
  });
  page.on('response', async (res) => {
    const url = res.url();
    if (url.includes('/api/auth/') || url.includes('/api/user') || url.includes('/api/config')) {
      apiCalls.push({ method: res.request().method(), url: url.replace(BASE, ''), status: res.status() });
    }
  });

  // ---------------------------------------------------------------- A1 landing
  try {
    const res = await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await settle(page, 6000);
    const bodyText = await page.locator('body').innerText();
    const hasLoginUi = /log ?in|sign ?in|email|password/i.test(bodyText);
    await shot(page, 'login-page');
    record(
      'A1',
      'Login page renders in a real browser',
      res && res.status() < 400 && hasLoginUi ? 'PASS' : 'FAIL',
      `HTTP ${res?.status()}, ${hasLoginUi ? 'login form text found' : 'no login form text'}; body chars=${bodyText.length}`,
    );
  } catch (e) {
    record('A1', 'Login page renders in a real browser', 'FAIL', e.message);
  }

  // ------------------------------------------------------------ A2 signup form
  try {
    await page.goto(`${BASE}/register`, { waitUntil: 'domcontentloaded', timeout: 90000 });
    await settle(page, 6000);
    const fields = ['name', 'email', 'password', 'confirm_password'];
    const seen = {};
    for (const f of fields) {
      seen[f] = (await page.locator(`[data-testid="${f}"]`).count()) > 0;
    }
    await shot(page, 'register-page');
    const allPresent = fields.every((f) => seen[f]);
    record(
      'A2',
      'Signup form exposes name/email/password/confirm fields',
      allPresent ? 'PASS' : 'FAIL',
      JSON.stringify(seen),
    );
  } catch (e) {
    record('A2', 'Signup form exposes name/email/password/confirm fields', 'FAIL', e.message);
  }

  // --------------------------------------------------------------- A3 signup
  let signupLanded = null;
  try {
    await page.fill('[data-testid="name"]', NAME);
    await page.fill('[data-testid="email"]', EMAIL);
    await page.fill('[data-testid="password"]', PASSWORD);
    await page.fill('[data-testid="confirm_password"]', PASSWORD);
    await shot(page, 'register-filled');
    const submit = page.locator('[data-testid="submit"]').or(page.locator('form button[type="submit"]')).first();
    await submit.click();
    await page.waitForURL((u) => !u.pathname.includes('register'), { timeout: 60000 }).catch(() => {});
    await settle(page, 4000);
    signupLanded = new URL(page.url()).pathname;
    const bodyText = await page.locator('body').innerText();
    await shot(page, 'after-signup');
    const movedOn = !signupLanded.includes('register');
    record(
      'A3',
      'Signup with a fresh synthetic account is accepted',
      movedOn ? 'PASS' : 'FAIL',
      `landed on ${signupLanded}; body: ${bodyText.replace(/\s+/g, ' ').slice(0, 160)}`,
    );
  } catch (e) {
    record('A3', 'Signup with a fresh synthetic account is accepted', 'FAIL', e.message);
  }

  // ------------------------------------------------- A4 first user becomes ADMIN
  try {
    const r = await context.request.get(`${BASE}/api/user`, { failOnStatusCode: false });
    const body = await r.json().catch(() => ({}));
    await shot(page, 'user-endpoint');
    record(
      'A4',
      'First registered account is granted the ADMIN role',
      r.status() === 200 && body?.role === 'ADMIN' ? 'PASS' : (r.status() === 200 ? 'FAIL' : 'NOT TESTED'),
      `GET /api/user -> ${r.status()}, role=${body?.role ?? 'n/a'}, email=${body?.email ?? 'n/a'}`,
    );
  } catch (e) {
    record('A4', 'First registered account is granted the ADMIN role', 'FAIL', e.message);
  }

  // ------------------------------------------------------------- A5 logout
  try {
    const r = await context.request.post(`${BASE}/api/auth/logout`, { failOnStatusCode: false });
    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
    await settle(page, 4000);
    const afterLogout = await page.locator('[data-testid="login-button"]').count();
    await shot(page, 'after-logout');
    record(
      'A5',
      'Logout ends the session and returns to the login screen',
      r.status() < 400 && afterLogout > 0 ? 'PASS' : 'FAIL',
      `POST /api/auth/logout -> ${r.status()}, login button visible=${afterLogout > 0}`,
    );
  } catch (e) {
    record('A5', 'Logout ends the session and returns to the login screen', 'FAIL', e.message);
  }

  // ------------------------------------------------- A6 wrong password rejected
  try {
    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
    await settle(page, 4000);
    await page.fill('[data-testid="email"]', EMAIL);
    await page.fill('[data-testid="password"]', 'definitely-the-wrong-password');
    await page.click('[data-testid="login-button"]');
    await page.waitForTimeout(6000);
    const stillLogin = new URL(page.url()).pathname.includes('login');
    const bodyText = await page.locator('body').innerText();
    const errorShown = /incorrect|invalid|wrong|failed|error/i.test(bodyText);
    await shot(page, 'wrong-password');
    record(
      'A6',
      'Wrong password is rejected with a visible error',
      stillLogin && errorShown ? 'PASS' : 'FAIL',
      `stayed on login=${stillLogin}, error text=${errorShown}`,
    );
  } catch (e) {
    record('A6', 'Wrong password is rejected with a visible error', 'FAIL', e.message);
  }

  // ------------------------------------------------------------ A7 real login
  try {
    await page.goto(`${BASE}/login`, { waitUntil: 'domcontentloaded' });
    await settle(page, 4000);
    await page.fill('[data-testid="email"]', EMAIL);
    await page.fill('[data-testid="password"]', PASSWORD);
    await page.click('[data-testid="login-button"]');
    await page.waitForURL((u) => !u.pathname.includes('login') && !u.pathname.includes('register'), {
      timeout: 60000,
    }).catch(() => {});
    await settle(page, 5000);
    const landed = new URL(page.url()).pathname;
    const bodyText = await page.locator('body').innerText();
    await shot(page, 'after-login');
    const okPath = landed.startsWith('/c/') || landed === '/';
    const uiAlive = bodyText.length > 40;
    record(
      'A7',
      'Login with the new credentials reaches the chat UI',
      okPath && uiAlive ? 'PASS' : 'FAIL',
      `landed on ${landed}; body chars=${bodyText.length}; body: ${bodyText.replace(/\s+/g, ' ').slice(0, 140)}`,
    );
  } catch (e) {
    record('A7', 'Login with the new credentials reaches the chat UI', 'FAIL', e.message);
  }

  // ------------------------------------------- A8 session survives a reload
  try {
    await page.reload({ waitUntil: 'domcontentloaded' });
    await settle(page, 5000);
    const landed = new URL(page.url()).pathname;
    const r = await context.request.get(`${BASE}/api/user`, { failOnStatusCode: false });
    const body = await r.json().catch(() => ({}));
    await shot(page, 'after-reload');
    record(
      'A8',
      'Session persists across a page reload (refresh-token cookie works)',
      !landed.includes('login') && r.status() === 200 ? 'PASS' : 'FAIL',
      `after reload path=${landed}, GET /api/user -> ${r.status()} (${body?.email ?? 'n/a'})`,
    );
  } catch (e) {
    record('A8', 'Session persists across a page reload (refresh-token cookie works)', 'FAIL', e.message);
  }

  // ------------------------------------------------- A9 duplicate email blocked
  try {
    const fresh = await browser.newContext();
    const p2 = await fresh.newPage();
    await p2.goto(`${BASE}/register`, { waitUntil: 'domcontentloaded' });
    await settle(p2, 5000);
    await p2.fill('[data-testid="name"]', 'Dup Attempt');
    await p2.fill('[data-testid="email"]', EMAIL);
    await p2.fill('[data-testid="password"]', PASSWORD);
    await p2.fill('[data-testid="confirm_password"]', PASSWORD);
    await p2
      .locator('[data-testid="submit"]')
      .or(p2.locator('form button[type="submit"]'))
      .first()
      .click();
    await p2.waitForTimeout(6000);
    const stillOnRegister = new URL(p2.url()).pathname.includes('register');
    const bodyText = await p2.locator('body').innerText();
    const errorShown = /already|exists|registered|error/i.test(bodyText);
    await p2.screenshot({ path: path.join(shotDir, `${String(++shotIndex).padStart(2, '0')}-duplicate-email.png`) });
    await fresh.close();
    record(
      'A9',
      'Duplicate email signup is refused',
      stillOnRegister && errorShown ? 'PASS' : 'FAIL',
      `stayed on register=${stillOnRegister}, error text=${errorShown}`,
    );
  } catch (e) {
    record('A9', 'Duplicate email signup is refused', 'FAIL', e.message);
  }

  // ------------------------------------------------------- A10 admin portal
  for (const [id, section, needle] of [
    ['A10', '/admin', /admin|console|dashboard|user/i],
    ['A11', '/admin/triage-safety', /triage|severity|assess/i],
  ]) {
    try {
      const res = await page.goto(`${BASE}${section}`, { waitUntil: 'domcontentloaded', timeout: 90000 });
      await settle(page, 6000);
      const bodyText = await page.locator('body').innerText();
      const slug = section.replace(/\//g, '_') || '_admin';
      await shot(page, `admin${slug}`);
      const rendered = res && res.status() < 400 && needle.test(bodyText) && bodyText.length > 60;
      const notAssessed = /NOT ASSESSED/i.test(bodyText);
      record(
        id,
        `Admin portal renders: ${section}`,
        rendered ? 'PASS' : 'FAIL',
        `HTTP ${res?.status()}, matched=${needle.test(bodyText)}, notAssessedBadge=${notAssessed}, body: ${bodyText
          .replace(/\s+/g, ' ')
          .slice(0, 150)}`,
      );
    } catch (e) {
      record(id, `Admin portal renders: ${section}`, 'FAIL', e.message);
    }
  }

  // ------------------------------------------------ A12 non-admin gets no portal
  try {
    const fresh = await browser.newContext();
    const p3 = await fresh.newPage();
    const email2 = `e2e.second.${STAMP}@example.org`;
    await p3.goto(`${BASE}/register`, { waitUntil: 'domcontentloaded' });
    await settle(p3, 5000);
    await p3.fill('[data-testid="name"]', 'Second User');
    await p3.fill('[data-testid="email"]', email2);
    await p3.fill('[data-testid="password"]', PASSWORD);
    await p3.fill('[data-testid="confirm_password"]', PASSWORD);
    await p3
      .locator('[data-testid="submit"]')
      .or(p3.locator('form button[type="submit"]'))
      .first()
      .click();
    await p3.waitForTimeout(7000);
    const userRes = await fresh.request.get(`${BASE}/api/user`, { failOnStatusCode: false });
    const userBody = await userRes.json().catch(() => ({}));
    // server-side check: cross-user read must be forbidden for a non-admin
    const adminRes = await fresh.request.get(`${BASE}/api/admin/users`, { failOnStatusCode: false });
    await p3.goto(`${BASE}/admin`, { waitUntil: 'domcontentloaded' });
    await settle(p3, 5000);
    const bodyText = await p3.locator('body').innerText();
    await p3.screenshot({ path: path.join(shotDir, `${String(++shotIndex).padStart(2, '0')}-non-admin.png`) });
    await fresh.close();
    const roleOk = userBody?.role === 'USER';
    const apiBlocked = adminRes.status === 403 || adminRes.status === 401;
    record(
      'A12',
      'Second account is a plain USER and cannot read the admin API',
      roleOk && apiBlocked ? 'PASS' : 'FAIL',
      `second user role=${userBody?.role ?? 'n/a'}; GET /api/admin/users -> ${adminRes.status}; /admin body: ${bodyText
        .replace(/\s+/g, ' ')
        .slice(0, 120)}`,
    );
  } catch (e) {
    record('A12', 'Second account is a plain USER and cannot read the admin API', 'FAIL', e.message);
  }

  // ------------------------------------------------------------- summary
  const relevantErrors = consoleErrors.filter(
    (t) => !/ResizeObserver|Failed to load resource.*favicon|Download the React DevTools/i.test(t),
  );
  record(
    'A13',
    'Browser console stayed free of uncaught errors during the run',
    relevantErrors.length === 0 ? 'PASS' : 'WARN',
    relevantErrors.length === 0 ? 'no error-level console output' : `${relevantErrors.length} error(s): ${relevantErrors.slice(0, 3).join(' | ')}`,
  );

  await browser.close();

  const summary = {
    base: BASE,
    ranAt: new Date().toISOString(),
    account: { email: EMAIL, name: NAME },
    authApiCalls: apiCalls,
    results,
    totals: {
      pass: results.filter((r) => r.status === 'PASS').length,
      fail: results.filter((r) => r.status === 'FAIL').length,
      warn: results.filter((r) => r.status === 'WARN').length,
      notTested: results.filter((r) => r.status === 'NOT TESTED').length,
    },
  };
  fs.writeFileSync(path.join(shotDir, 'browser-auth-report.json'), JSON.stringify(summary, null, 2));
  fs.writeFileSync(
    path.join(shotDir, 'browser-auth-report.md'),
    [
      '# Real-browser signup / login audit',
      '',
      `- Base URL: \`${BASE}\``,
      `- Ran at: ${summary.ranAt}`,
      `- Synthetic account: \`${EMAIL}\``,
      `- Totals: **${summary.totals.pass} PASS / ${summary.totals.fail} FAIL / ${summary.totals.warn} WARN / ${summary.totals.notTested} NOT TESTED**`,
      '',
      '| # | Check | Status | Evidence |',
      '| --- | --- | --- | --- |',
      ...results.map((r) => `| ${r.id} | ${r.title} | ${r.status} | ${String(r.detail ?? '').replace(/\|/g, '\\|').slice(0, 220)} |`),
      '',
    ].join('\n'),
  );

  console.log('\n=== SUMMARY ===');
  console.log(JSON.stringify(summary.totals));
  process.exit(summary.totals.fail > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error('FATAL', e);
  process.exit(2);
});
