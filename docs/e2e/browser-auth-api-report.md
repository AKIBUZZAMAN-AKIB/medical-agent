# Browser-driven auth audit (Chromium)

- Base URL: `http://127.0.0.1:3080`
- Ran at: 2026-10-26T07:20:53.629Z
- Browser: Chromium 151.0.7922.34 via Playwright (real browser cookie jar)
- Database: fresh `LibreChat_e2e_auth` (dropped before the run, so the first-account ADMIN bootstrap is real)
- Synthetic accounts: `e2e.first.mvoxgkzb@example.org`, `e2e.second.mvoxgkzb@example.org`
- Totals: **12 PASS / 0 FAIL**

| # | Check | Status | Evidence |
| --- | --- | --- | --- |
| B0 | Server advertises registration + email login | PASS | GET /api/config -> 200; registrationEnabled=true; emailLoginEnabled=true; emailEnabled=false |
| B1 | Signup is accepted and (by design) returns a generic message without a session | PASS | POST /api/auth/register -> 200; message="Please check your email to verify your email address."; session cookie=not issued (expected) |
| B2 | The account created in B1 can log in immediately | PASS | POST /api/auth/login -> 200; user=e2e.first.mvoxgkzb@example.org; access token in body=yes; refreshToken cookie=httpOnly=true, sameSite=Strict |
| B3 | First registered account is ADMIN | PASS | GET /api/user (Bearer) -> 200; role=ADMIN; email=e2e.first.mvoxgkzb@example.org |
| B4 | ADMIN can read the admin user list | PASS | GET /api/admin/users -> 200 |
| B5 | Refresh token cookie mints a new access token that works | PASS | POST /api/auth/refresh -> 200; new token used for GET /api/user -> 200 |
| B6 | Logout clears the refresh-token cookie in the browser | PASS | POST /api/auth/logout -> 200; cookie before=set, after=cleared |
| B7 | Wrong password is rejected and issues no session | PASS | POST /api/auth/login -> 404 ("Incorrect password."); refreshToken cookie=not issued |
| B8 | Duplicate signup answers identically (no account enumeration) and creates no session | PASS | POST /api/auth/register (existing email) -> 200; message identical to B1=true; session cookie=not issued |
| B9 | Second account is USER and is denied the admin API | PASS | register -> 200; login -> 200; role=USER; GET /api/admin/users -> 403 |
| B10 | Anonymous browser context cannot read /api/user or /api/admin/users | PASS | GET /api/user -> 401; GET /api/admin/users -> 401 |
| B11 | Login rejects a foreign Origin (requireSameOrigin) | PASS | POST /api/auth/login with Origin: https://evil.example.com -> 403; session cookie=not issued |

## Note on B7

The run above observed `404` for a rejected password. That is F-28 in
`docs/REPOSITORY_DEEP_AUDIT.md`; the endpoint has since been corrected to answer
`401` and `e2e/browser-auth-api.e2e.mjs` now asserts `401` for B7. The evidence row
above is left exactly as the run produced it. The corrected behaviour is covered
without npm dependencies by `e2e/verify-require-local-auth.js` (6/6 checks, including
a regression guard that a rejected login is never `404`).

## What is deliberately *not* in this table

Every check here exercises the HTTP + cookie contract that a browser uses; none of
them renders React. The `/login` and `/register` screens — fields, banners,
redirects, `/admin` and `/admin/triage-safety` — are covered by
`e2e/browser-auth.e2e.mjs`, which is committed but was **NOT TESTED** in this
workspace: the client bundle cannot be built on a 1.98 GB host (kernel OOM kill at
`rendering chunks`). See `docs/e2e/README.md`.
