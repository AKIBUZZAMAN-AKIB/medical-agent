/**
 * Real-browser smoke of the rendered UI, driven by Playwright/Chromium against
 * the vite dev server (3090) and the API (3080).
 *
 * Not a screenshot generator: every step asserts something, and the run fails if
 * the console reports an error, if login does not produce a session, or if the
 * admin portal does not render its medical modules.
 */
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const BASE = process.env.UI_BASE ?? 'http://127.0.0.1:3090';
const EMAIL = 'admin@example.test';
const PASSWORD = 'Smoke-Only-Passw0rd!';
const OUT = process.env.SHOT_DIR ?? '/tmp/ui-shots';

const results = [];
const step = (name, ok, detail) => {
  results.push({ name, ok, detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();

  const consoleErrors = [];
  const failedRequests = [];
  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      consoleErrors.push(msg.text());
    }
  });
  page.on('requestfailed', (req) => failedRequests.push(`${req.method()} ${req.url()}`));
  /** Which request failed matters more than the console's copy of it. */
  const badResponses = [];
  page.on('response', (res) => {
    if (res.status() >= 400) {
      badResponses.push(
        `${res.status()} ${res.request().method()} ${res.url()} (on ${page.url()})`,
      );
    }
  });

  /* 1. the app shell renders ------------------------------------------------ */
  // A vite dev server keeps an HMR websocket open, so 'networkidle' never fires;
  // wait for the app shell to actually mount instead.
  const response = await page.goto(`${BASE}/login`, {
    waitUntil: 'domcontentloaded',
    timeout: 120_000,
  });
  await page
    .waitForSelector('#root > *', { timeout: 180_000 })
    .catch(() => step('React app mounted within 180s', false, 'no #root child appeared'));
  step('GET /login returns 200', response.status() === 200, `status=${response.status()}`);
  await page.screenshot({ path: path.join(OUT, '01-login.png') });
  const hasRoot = (await page.locator('#root').count()) === 1;
  const bodyText = await page.locator('body').innerText();
  step(
    '#root mounted React',
    hasRoot && bodyText.trim().length > 0,
    `${bodyText.trim().slice(0, 60).replace(/\n/g, ' ')}…`,
  );

  /* 2. log in with the seeded ADMIN ---------------------------------------- */
  const emailInput = page.locator('input[type="email"], input[name="email"]').first();
  const passInput = page.locator('input[type="password"]').first();
  step(
    'login form fields exist',
    (await emailInput.count()) === 1 && (await passInput.count()) === 1,
  );
  await emailInput.fill(EMAIL);
  await passInput.fill(PASSWORD);
  const loginResponse = page.waitForResponse(
    (res) => res.url().includes('/api/auth/login') && res.request().method() === 'POST',
    { timeout: 30_000 },
  );
  await page.locator('button[type="submit"]').first().click();
  const loginRes = await loginResponse.catch(() => null);
  step(
    'POST /api/auth/login succeeds',
    loginRes != null && loginRes.status() === 200,
    loginRes ? `status=${loginRes.status()}` : 'no response',
  );
  await page.waitForTimeout(4000);
  await page.screenshot({ path: path.join(OUT, '02-after-login.png') });
  const afterLogin = page.url();
  step('navigated away from /login', !afterLogin.includes('/login'), afterLogin);

  const cookies = await context.cookies();
  step(
    'session cookie is httpOnly',
    cookies.some((c) => c.name === 'refreshToken' && c.httpOnly),
    cookies.map((c) => c.name).join(','),
  );

  /* 3. /api/config tells us which chat surface the deployment exposes -------- */
  const config = await page.evaluate(async () => {
    const res = await fetch('/api/config', { credentials: 'include' });
    return { status: res.status, body: await res.json().catch(() => null) };
  });
  step('GET /api/config returns 200', config.status === 200, `status=${config.status}`);
  /**
   * `/api/config` carries no endpoint list in this version, so the deployment's
   * chat surface is asserted where the client actually reads it: `/api/models`
   * (authenticated) must advertise the custom endpoint from
   * librechat.pure-doctor.yaml and the model the seeded agent was built with.
   */
  const sessionToken = await page.evaluate(async () => {
    const res = await fetch('/api/auth/refresh', { method: 'POST', credentials: 'include' });
    const body = await res.json().catch(() => null);
    return body?.token ?? null;
  });
  const models = await page.evaluate(async (token) => {
    const res = await fetch('/api/models', {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      credentials: 'include',
    });
    return { status: res.status, body: await res.json().catch(() => null) };
  }, sessionToken);
  const endpointModels = models.body?.['OpenRouter (Free)'] ?? [];
  step(
    'the configured custom endpoint is served',
    models.status === 200 && endpointModels.length > 0,
    `status=${models.status} models=${endpointModels.join(',') || 'none'}`,
  );
  step(
    'the model the agent was seeded with is available',
    endpointModels.includes('nvidia/nemotron-3-ultra-550b-a55b:free'),
    endpointModels.join(','),
  );

  /* 4. the agent surface ---------------------------------------------------- */
  await page.goto(`${BASE}/c/new`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.waitForTimeout(8000);
  await page.screenshot({ path: path.join(OUT, '03-chat.png'), fullPage: true });
  const chatText = await page.locator('body').innerText();
  step(
    'chat view renders without redirecting to login',
    !page.url().includes('/login'),
    page.url(),
  );
  step(
    'the doctor agent is offered to the user',
    /Super-Power Doctor AI/i.test(chatText),
    chatText.replace(/\s+/g, ' ').slice(0, 120),
  );

  /* 5. admin portal --------------------------------------------------------- */
  await page.goto(`${BASE}/admin`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
  await page.waitForTimeout(8000);
  await page.screenshot({ path: path.join(OUT, '04-admin.png'), fullPage: true });
  const adminText = await page.locator('body').innerText();
  step('/admin is reachable for an ADMIN', !page.url().includes('/login'), page.url());
  /**
   * The real route. `/api/admin/medical-command` is mounted in api/server/routes/index.js
   * and every endpoint is under it; the previous check invented
   * `/api/admin/medical/command-center`, which 404s for a reason that has nothing
   * to do with the deployment.
   */
  const adminToken = sessionToken;
  const adminEndpoints = {};
  for (const endpoint of ['/overview', '/mcp-tools', '/triage-safety', '/formulary']) {
    adminEndpoints[endpoint] = await page.evaluate(
      async ([path, token]) => {
        const res = await fetch(`/api/admin/medical-command${path}`, {
          headers: token ? { Authorization: `Bearer ${token}` } : {},
          credentials: 'include',
        });
        return res.status;
      },
      [endpoint, adminToken],
    );
  }
  step(
    'admin medical command-center API answers',
    Object.values(adminEndpoints).every((status) => status === 200),
    JSON.stringify(adminEndpoints),
  );
  const toolCount = await page.evaluate(async (token) => {
    const res = await fetch('/api/admin/medical-command/mcp-tools', {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      credentials: 'include',
    });
    if (!res.ok) return -1;
    return (await res.json()).totalTools;
  }, adminToken);
  step(
    'admin console reports the published tool count',
    toolCount === 33,
    `totalTools=${toolCount} (the MCP server publishes 33)`,
  );

  step(
    'admin portal rendered content',
    adminText.trim().length > 40,
    adminText.replace(/\s+/g, ' ').slice(0, 120),
  );

  /* 6. no console errors ---------------------------------------------------- */
  const ignorable = (text) => /favicon|ResizeObserver|Download the React DevTools/i.test(text);
  const realErrors = consoleErrors.filter((text) => !ignorable(text));
  step('no browser console errors', realErrors.length === 0, realErrors.slice(0, 3).join(' | '));
  step(
    'no failed network requests',
    failedRequests.length === 0,
    failedRequests.slice(0, 3).join(' | '),
  );
  step(
    'no server-side 5xx responses',
    badResponses.filter((entry) => entry.startsWith('5')).length === 0,
    badResponses
      .filter((entry) => entry.startsWith('5'))
      .slice(0, 3)
      .join(' | '),
  );
  if (badResponses.length > 0) {
    console.log(`\nnon-2xx responses seen:\n  ${badResponses.join('\n  ')}`);
  }

  await browser.close();

  const failed = results.filter((entry) => !entry.ok);
  console.log(
    `\n${results.length - failed.length}/${results.length} checks passed. Screenshots: ${OUT}`,
  );
  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
  process.exit(failed.length > 0 ? 1 : 0);
})().catch((error) => {
  console.error('ui smoke crashed:', error);
  process.exit(2);
});
