# InvestBrick: paper trading for Indian markets

**Status: all 5 phases are built. The project is deployment-ready; it has NOT been deployed yet (that needs your accounts: follow "Phase 5" below).**

| Phase | Scope | Status |
|---|---|---|
| 1 | Express backend, live market data (NSE via Yahoo, crypto via CoinGecko), market status, charts, honest unavailable/stale states | Done |
| 2 | Accounts: register, login, logout, password reset, secure sessions (PostgreSQL / Neon) | Done |
| 3 | Postgres: cash, holdings, transactions, watchlists, portfolio history per user | Done |
| 4 | Reliable trading engine: background limit-order matcher, order lifecycle, audit log, price-safety gate | Done |
| 5 | Deployment: Render + Neon, HTTPS, health checks, structured logs, graceful shutdown, verification script | Files ready, deploy is yours |

**Logged-in users: cash, holdings, orders, transactions, watchlist and lesson progress live in PostgreSQL and follow you to any device. Guests keep a separate demo portfolio in their own browser.** Prices are real (never simulated).

## Run it

```bash
npm install
cp .env.example .env      # then paste your CoinGecko key
npm run smoke             # verifies the live APIs work from your network
npm start                 # http://localhost:3000
npm test                  # 8 offline tests (fixtures, no network needed)
```
Requires Node 20+.

## Setup actions for you
1. **CoinGecko Demo key (free):** sign up at coingecko.com/en/api, create a Demo key, put it in `.env` as `COINGECKO_API_KEY`. Never commit `.env`; never put the key in front-end code.
2. Run `npm run smoke` on your own computer. The build sandbox had no access to the data APIs, so **live fetching is verified by fixture tests only until you run this**. Send me the output if anything shows FAIL.
3. Use Node 20+.

## Data sources, limits and costs
| Data | Provider | Cost / limits | Caveats |
|---|---|---|---|
| NSE stocks, ETFs, NIFTY 50, SENSEX, Bank Nifty | Yahoo Finance chart endpoint | Free, no key | **Unofficial**: no SLA, terms restrict redistribution, cloud IPs are sometimes blocked (429). Treated as ~15 min delayed. OK for a college demo; not for a public commercial product |
| Crypto (BTC, ETH, SOL, XRP, DOGE in INR) | CoinGecko API | Demo: 100 calls/min, 10,000 credits/month, attribution required | App caches crypto quotes 5 min and stops at 9,000 calls/month; paid plans start about $35/month |
| Licensed NSE data | NSE Data & Analytics or a licensed vendor | NSE's published 15-min delayed capital-market tariff is ₹1,10,000 | Needed if you publicly display NSE prices commercially. Check terms yourself; this is not legal advice |

Adapters live in `server/market/providers/`; swapping in a licensed vendor means writing one file with `quote()` and `candles()`.

## How data honesty works
- Every quote carries provider, `asOf`, `fetchedAt`, and a state: `live`, `delayed`, `last-close`, or `stale`.
- If a provider fails the UI shows "unavailable" and **pauses orders**; it never substitutes made-up numbers.
- Market orders need a fresh price (<2 min old) while the market is open. NSE holidays for 2026 are in `server/market/calendar.js`; update them yearly.
- Limit orders placed while NSE is closed wait and fill only during market hours.
- Indices are display-only; trade ETFs (NIFTYBEES, BANKBEES, GOLDBEES) instead.

## Production notes (the full deployment guide is in Phase 5 below)
- `NODE_ENV=production`, `TRUST_PROXY=1` behind a proxy, terminate HTTPS at the proxy/host (Render, Railway, Fly, or nginx + Let's Encrypt). HSTS is enabled in production.
- Helmet security headers, CSP, rate limiting (120 req/min/IP on `/api`), 10kb JSON body cap are already on.

## Phase 2: accounts

### What you get
Register, log in, log out, forgot/reset password, change password (API). Pages: `/login`, `/register`, `/forgot-password`, `/reset-password`. Guests can still use the site; the nav shows Log in / Sign up, or your name and Log out.

### Option A: quick local development (no accounts to create)
```bash
npm install
npm run dev:local     # on-disk Postgres (PGlite) in .data/pglite; reset links print in the server log
```
### Option B: Neon (what you will deploy with)
1. Sign up at neon.com (free plan, no card needed) and create a project (pick the region nearest your users, e.g. Mumbai/Singapore if offered).
2. Open **Connect**, choose the **pooled** connection string, copy it into `.env` as `DATABASE_URL`. If you get a `channel_binding` error, delete `&channel_binding=require` from the string.
3. `npm run migrate` (also runs automatically at server start). Tables created: `users`, `sessions`, `password_resets`, `schema_migrations`.
4. `npm start`. The log should say `accounts ON`.

Free-tier notes (check neon.com/pricing, it changes): the free plan has a small storage and compute allowance and scales to zero after idle time, so the first request after a pause can take a second or two. Plenty for a college project.

### Password-reset email
Reset emails need an SMTP service. In development, `EMAIL_PROVIDER=console` prints the link in the terminal. For real email set `EMAIL_PROVIDER=smtp` plus `SMTP_*` and `EMAIL_FROM`:
- **Brevo** (free ~300 emails/day): create an account, SMTP & API > SMTP keys, host `smtp-relay.brevo.com`, port 587, your login and the SMTP key. Verify your sender address.
- **Resend**: host `smtp.resend.com`, port 465 with `SMTP_SECURE=true`, user `resend`, password = API key. You must verify a domain you own to email anyone except yourself.
- **Gmail** (testing only): enable 2-step verification, create an App Password, host `smtp.gmail.com`, port 587.
Production start is refused if SMTP is missing, so users never get silent failures. **Email sending itself could not be tested from the build sandbox (no network)**: send yourself a reset link once after configuring.

### Security design (what protects what)
| Risk | Defence |
|---|---|
| Stolen database | Passwords stored as **Argon2id** hashes (random salt per user). Session and reset tokens stored only as SHA-256 hashes |
| Stolen/guessed session | 256-bit random token in an `HttpOnly`, `SameSite=Lax` cookie (`Secure` + `__Host-` prefix in production), invisible to page JavaScript; 30-day max life, 7-day idle timeout; deleted on logout; all sessions revoked on password reset |
| CSRF | SameSite cookie + JSON-only bodies + Origin / Fetch-Metadata checks on every state-changing request |
| Brute force | Per-IP and per-IP+email rate limits (429), plus account lockout after 10 failures; identical error for wrong password and unknown email, with equalised timing |
| Email enumeration on reset | Same response whether or not the account exists; mail throttled to one per minute per account |
| Poisoned reset links | Link host comes from `APP_URL`, never the request's Host header; token travels in the URL fragment (not sent to servers or in Referer) and works once, for 60 minutes |
| Injection / XSS | Parameterised SQL only; user text is rendered with `textContent`; the session JSON embedded in the page is escaped; CSP and security headers via Helmet |
| Weak passwords | 10 to 128 characters, common-password and email-name checks (server-enforced) |
| Cross-account access | Identity comes only from the server-side session, never from a client-supplied id; browser-saved paper data is namespaced per account |

Known trade-offs: registering reveals whether an email is already used (needed without email verification; rate limited). Email verification and two-factor login are not built. Rate-limit counters live in memory, so run one instance, or move them to Redis/Postgres before scaling out.

### Tests
`npm test` runs 32 tests (market data + accounts) against a real in-memory Postgres (PGlite), no network or Neon needed. They cover hashing, cookies, validation, duplicate/concurrent registration, lockout, rate limits, expiry, CSRF, enumeration, reset-token single use (including concurrent redemption), session revocation and data isolation.

## Phase 3: database-backed portfolios

### Migration strategy (what was moved, what deliberately was not)
| Data | Decision | Why |
|---|---|---|
| New accounts | Portfolio row (₹10,00,000) is created **in the same transaction as the account** | The money is credited exactly once; if either insert fails, neither exists |
| Phase 2 accounts (already registered) | `migrations/002_portfolio.sql` back-fills one portfolio per user with `ON CONFLICT DO NOTHING` | Re-running can never reset a balance. Verified against a real Phase 2 database |
| Logging in, reloading, switching device | Read-only. Nothing is created or reset on login | Balances are never touched by login |
| Guest demo portfolio (browser) | **Stays in the browser**, separate and untouched. Guests can still trade | Requirement: guests keep their own demo portfolio |
| Browser-saved **balances and holdings** | **Never imported** | A browser's storage can be edited, so the server only trusts its own database. Old browser data is not deleted, only left alone, and the user is told |
| Guest watchlist and lesson progress | **Opt-in, one-time, merge-only** import offered after first login (no money fields are accepted) | Harmless preferences; never overwrites, never duplicates (a flag makes the offer one-time) |

### How trading works now (server-authoritative)
- The browser sends only: symbol, side, type, quantity, optional limit price, a note, and a random order id. **Prices, balances, fees, user id and averages are all computed on the server** (price from the live market service, identity from the session cookie). Extra fields such as `price`, `cash` or `userId` are ignored (there is a test for this).
- Every money-moving request runs in one database transaction that first **locks the user's portfolio row** (`SELECT ... FOR UPDATE`). Concurrent requests from the same user queue up, so cash cannot go negative and shares cannot be oversold. Different users never block each other.
- All arithmetic uses PostgreSQL `numeric` (exact decimals): quantities to 6 decimals, amounts rounded to paise. The database also refuses negative cash and non-positive quantities by constraint, as a last line of defence.
- **Duplicate protection:** each order carries a random id. A double-click, a retry after a network drop, or a replayed request returns the original result instead of trading twice.
- Market orders need a fresh price while the market is open (equities under 2 minutes old, crypto under 6). Otherwise the server refuses with a clear message and nothing changes. Limit orders reserve cash or shares so they cannot be double-booked.
- Average cost method: average price = total cost of open shares / quantity; realized P&L is booked on sells; unrealized P&L is shown from live prices. A built-in check (`cash + open cost - realized = starting cash`) is asserted in the tests after every scenario.

### Tables (migration 002)
`portfolios` (cash, starting cash, realized P&L, lesson progress), `positions`, `orders`, `transactions` (every fill with price, source and time), `watchlists`, `portfolio_snapshots` (portfolio value over time), `idempotency_keys`. Every row is owned by a `user_id` that cascades on account deletion.

### API (all require login; user id always comes from the session)
`GET /api/portfolio` | `POST /api/portfolio/orders` | `DELETE /api/portfolio/orders/:id` | `POST /api/portfolio/basket` | `PUT|DELETE /api/portfolio/watchlist/:symbol` | `PUT /api/portfolio/learning` | `POST /api/portfolio/import-guest` | `POST /api/portfolio/reset` (needs `{"confirm":"RESET"}`; archives old history) | `GET /api/portfolio/history`

### Setup
Nothing new to configure: same `DATABASE_URL` as Phase 2. Start the server (or `npm run migrate`) and migration 002 is applied automatically; existing users receive their portfolio on the spot.

### Tests
- `npm test`: 56 tests on PGlite (real Postgres compiled to WebAssembly).
- `npm run test:pg`: runs the portfolio suite (including the concurrency tests) against a **real PostgreSQL server** that is downloaded and started for you. It cannot run as root and needs a free port. Or point `TEST_PG_URL` at any Postgres database whose name contains `test` (the suite drops its schema).
- Covered: two-plus users and isolation, reloads / new device / server restart, 20 simultaneous buys with only enough cash for 10, simultaneous oversells, 90 random concurrent orders/cancels across 3 users with exact-ledger checks, idempotency, exact decimal rounding, one-time provisioning, backfill safety, import rules, reset and archiving, input validation, and rejection of browser-supplied prices/balances/ids.
- Also verified in a real browser: register, trade, reload, second device, second user, limit order fill, cancel, closed-market refusal, double-click, logout back to the guest portfolio.

### Remaining limitations
- *(Fixed in Phase 4)* Limit orders used to fill only when the portfolio was loaded; a background matcher now fills them (see Phase 4).
- **Prices are delayed/unofficial for NSE** (Yahoo, about 15 minutes) and cached up to 5 minutes for crypto, so paper fills use those prices. See the data-source table above.
- **Portfolio history is stored** (a snapshot after each trade and about hourly on load) and exposed at `GET /api/portfolio/history`, but there is no chart for it in the UI yet.
- The history tab shows the latest 200 transactions; older ones stay in the database.
- Quantities allow up to 6 decimals and limit prices up to 4. Indices are display-only.
- The reset button exists for logged-in users and restores ₹10,00,000 only after explicit confirmation; earlier history is archived under an older "epoch", never deleted.
- Rate-limit counters are in memory (single instance). Real-Postgres tests ran against a local PostgreSQL 18, not Neon itself; email delivery and the live market APIs still need your own check (see earlier phases).


## Phase 4: reliable paper-trading engine

### What changed
- **Background matcher** (`server/portfolio/matcher.js`): runs inside the server process every `MATCHER_INTERVAL_SEC` seconds (default 15), whether or not anyone has the site open. It fetches each needed price once, then settles only the users whose orders can actually change. The old fill-on-page-load path still exists as a fallback and uses the **same** settlement code.
- **Safety against double fills, races and overspending:** every settlement takes the per-user row lock first, re-reads orders under row locks, re-checks price, cash and holdings, and runs each order in its own savepoint so one failure cannot affect others. A database unique index also allows at most one fill per order. Client retries stay protected by idempotency keys. A cancel racing a fill always ends in exactly one outcome.
- **Price safety:** an order never fills (and a market order is refused) when the price is missing, older than our cache window, from a frozen feed (last trade older than 45 min for stocks, 20 min for crypto), more than 40% (stocks) / 50% (crypto) away from the previous close, or when the market is closed. Nothing is ever guessed or filled from the browser. Fills use the server's current market price, not the limit price.
- **Order statuses:** `open`, `filled`, `cancelled`, `rejected`, `expired`, each with a reason. Open orders show why they are waiting (market closed, price not reached, price data paused). Limit orders expire after `ORDER_TTL_DAYS` (default 30). Orders are **rejected** (not retried forever) if cash/holdings are no longer enough at fill time or the instrument is no longer tradable; transient database errors are retried up to 5 times, then rejected.
- **Cancellation rules:** only the owner, only while `open`. Anything else returns 404 (not yours) or 409 (already filled/cancelled/expired). Account reset cancels open orders with reason `account_reset`.
- **Audit log:** `order_events` is append-only (a database trigger refuses UPDATE and DELETE). Every creation, deferral, fill (with price, source and timestamps), cancellation, rejection and expiry is recorded with who did it (`user`, `matcher`, `read`). `engine_runs` logs matcher passes that did something or failed.
- **Instruments and hours:** only tradable instruments (indices are display-only) and NSE hours 9:15 to 15:30 IST on trading days; crypto 24x7.
- **UI:** new **Order log** tab (logged-in users) showing every order, its status and reason. Design unchanged.
- **Monitoring:** `GET /healthz` now includes the matcher's status (last tick, last error, leader).

### Setup
Nothing to install. Start the server (or `npm run migrate`) and migration 003 applies automatically; existing open orders get 30 days and an audit history marked `backfilled`. Optional settings in `.env`: `MATCHER_ENABLED=true|false`, `MATCHER_INTERVAL_SEC=15` (minimum 5), `ORDER_TTL_DAYS=30`. Keep the server running continuously for background fills; with `npm run dev:local` that means leaving the terminal open.

### New API
`GET /api/portfolio/orders?status=&limit=` and `GET /api/portfolio/orders/:id/events` (owner only). The portfolio response also includes `orderLog`.

### Tests
`npm test` runs 73 tests on PGlite; `npm run test:pg` runs portfolio and engine suites on a real PostgreSQL. New engine tests cover: background fill with no browser, market closed/reopen, feed failure (throws, missing, stale, frozen, outlier) and recovery, concurrent ticks and reads, cancel-versus-fill races, overspend and tampered-state rejection, expiry, restart simulation, matcher loop survival and status, two matchers, overlap guard, audit immutability, owner-only APIs, and 3-user randomized load with exact ledger checks.

### Remaining limitations
- Prices for NSE are delayed (~15 min) and unofficial (Yahoo); the live feeds, email and Neon were not reachable from my test sandbox. Please run `npm run smoke` and watch the server log yourself.
- The matcher polls; it is not tick-by-tick, so a price that crosses your limit and comes back between two passes is missed. Fills happen at the price seen at the pass, which may be better or worse than your limit.
- Matching runs only while the server process runs. On free hosts that sleep, orders wait until it wakes (Phase 5 will address hosting).
- Order types are market and limit (good-till-30-days). No stop-loss, partial fills, short selling, brokerage or taxes.
- The matcher lease prevents duplicate work across several server copies, but rate limits are still per instance.
- The Order log shows the latest 100 orders; the full list is available via the API.
- Deployment (HTTPS, Docker, backups) has not been started; that is Phase 5.


## Phase 5: deploying InvestBrick publicly

> **Honest status:** I (the assistant) cannot create your accounts or reach Render, Neon, Yahoo or CoinGecko from my sandbox, so **nothing is deployed and the live services were not tested**. What I did test: the whole app running in `NODE_ENV=production` against a real PostgreSQL server, with mocked price feeds and a local SMTP server (details at the end). The script `npm run verify:deploy` re-runs those checks against **your live site** so you can see for yourself what works.

### Architecture, costs and why
| Part | Service | Cost | Why |
|---|---|---|---|
| Website, API and the background matcher (one Node process) | **Render** web service, plan **Starter**, 1 instance | about US$7/month (I could not open Render's price page: confirm on render.com/pricing) | Always on. Render's free web service sleeps after ~15 idle minutes, which would silently stop limit-order matching. HTTPS and custom domains are included. |
| Database | **Neon** Postgres, Free plan | $0 (no card). Free plan: 1 GB storage, 100 compute-hours/month, compute suspends after 5 idle minutes (checked on neon.com/pricing) | Persistent accounts, cash, holdings, orders, transactions, learning progress. |
| Password-reset email | Any SMTP service (Brevo, Resend, Gmail app password...) | free tiers exist; check current limits | Required in production; there is no fake email mode. |
| Crypto prices | CoinGecko free **Demo** key | $0 | Optional but recommended. |
| Custom domain | Any registrar | about US$10 to 15/year | Optional. |

**Why the database stays cheap:** a matcher that polls the database every 15 seconds would keep Neon awake all month and use up the 100 free hours in about 17 days. So the matcher only touches the database while limit orders are open (placing one wakes it instantly) and otherwise re-checks every 30 minutes (`MATCHER_IDLE_RECHECK_SEC`). Render's health check uses `/healthz`, which never queries the database. The first request after Neon has been idle can take a second or two while the compute wakes.

**Why one instance:** the matcher is safe with more instances (a database lease elects one leader, and row locks plus a unique index make double fills impossible even if two ran at once; both are tested), but rate-limit counters and the price cache are per instance, so one is simplest.

### Required accounts
1. **GitHub** (Render deploys from a repository). Create a **private** repo and push this project (`.env` is git-ignored, never commit secrets).
2. **Neon** (you already have a project: org `org-shiny-fire-16337174`, project `billowing-pine-85276930`, branch `production`).
3. **Render** (card required for Starter).
4. **An SMTP provider** for password-reset email.
5. **CoinGecko** (free Demo API key, optional).

### Environment variables
Set these in Render (the Blueprint creates the non-secret ones for you; the rest it asks for). Never put real values in files you commit.

| Variable | Required | Value |
|---|---|---|
| `NODE_ENV` | yes | `production` (set by the Blueprint) |
| `DATABASE_URL` | yes | Neon connection string, must contain `sslmode=require` |
| `APP_URL` | yes | your public `https://` address, no trailing slash (used in reset emails) |
| `TRUST_PROXY` | yes | `1` (set by the Blueprint) |
| `DB_DRIVER` / `EMAIL_PROVIDER` | yes | `pg` / `smtp` (set by the Blueprint) |
| `SMTP_HOST`, `SMTP_PORT`, `SMTP_USER`, `SMTP_PASS`, `EMAIL_FROM` | yes | from your SMTP provider |
| `COINGECKO_API_KEY` | recommended | CoinGecko Demo key |
| `MATCHER_ENABLED`, `MATCHER_INTERVAL_SEC`, `MATCHER_IDLE_RECHECK_SEC`, `ORDER_TTL_DAYS` | no | defaults `true`, `15`, `1800`, `30` |
| `MIGRATE_ON_START` | no | default `true` (see Migrations) |
| `LOG_LEVEL`, `SHUTDOWN_GRACE_SEC`, `SESSION_DAYS`, `SESSION_IDLE_DAYS` | no | defaults `info`, `25`, `30`, `7` |

There is **no session secret to set**: sessions are random 256-bit tokens stored only as SHA-256 hashes in the database, and passwords use Argon2id. The server **refuses to start in production** (and logs exactly why) if `DATABASE_URL`, `APP_URL`, SMTP or `TRUST_PROXY` are missing or wrong; nothing is silently disabled.

### Step by step
**A. Get the code onto GitHub.** On your computer, in the project folder: `git init`, `git add .`, `git commit -m "InvestBrick"`, create an empty **private** repository on github.com, then run the two commands GitHub shows (`git remote add origin ...` and `git push -u origin main`). Check that `.env` is not in the repository.

**B. Neon.** In the Neon console open your project, branch `production`, click **Connect**, switch **Connection pooling off**, and copy the string. (The pooled string should also work, but only the direct one was tested.) Keep it private.

**C. Email (SMTP).** Easiest free route: create a Brevo account, verify a sender address, then SMTP & API > SMTP: host `smtp-relay.brevo.com`, port `587`, your login and generated SMTP key. Alternative: a Gmail account with 2-step verification and an *app password* (host `smtp.gmail.com`, port 587, `EMAIL_FROM` must be that Gmail address). Check the provider's current free limits.

**D. Render.** Dashboard > **New > Blueprint** > pick your repo. Render reads `render.yaml` and asks for the secret values: paste `DATABASE_URL`, the SMTP settings and `EMAIL_FROM`, `COINGECKO_API_KEY`, and for `APP_URL` put `https://investbrick.onrender.com` for now. Click **Apply**. Render builds (`npm ci --omit=dev`), starts the server, applies the database migrations automatically, and checks `/healthz`. When it is live, open the service page, copy its real address (the name can get a suffix if taken), set `APP_URL` to exactly that, and save (it redeploys).

**E. Custom domain (optional).** Render service > Settings > Custom Domains > add `www.yourdomain.com`, create the DNS record Render shows at your registrar, wait for the certificate, then change `APP_URL` to `https://www.yourdomain.com`.

**F. Verify (from your own computer, in the project folder, after `npm install`):**
```
npm run verify:deploy -- https://YOUR-SITE
npm run verify:deploy -- https://YOUR-SITE --full --reset-email=you@gmail.com
```
`--full` creates a clearly named test account and trades with it. It prints PASS / FAIL / SKIP / MANUAL for every check; **SKIP means "not verified"**, not success. Then do the manual items below.

### Production verification checklist
- [ ] `verify:deploy` shows no FAIL. Live quotes for RELIANCE/NIFTYBEES (Yahoo) and BTC/ETH (CoinGecko) pass. If an equity quote fails, Yahoo is blocking Render's IP: equities then show as unavailable (never invented) and market orders are refused.
- [ ] Password reset: the email arrives (check spam), the link opens `/reset-password`, the new password works, the old one does not.
- [ ] Register in a normal browser, buy something, close the browser, log in from your phone: same cash and holdings.
- [ ] **Background matcher, crypto (any time):** `npm run verify:deploy -- https://YOUR-SITE --full --matcher-test=15` places a BTC buy limit 0.2% under the price and waits; a pass reads "filled by the BACKGROUND matcher (actor=matcher)". The server fills it even if you close everything; this works because crypto trades 24x7. Crypto prices are cached for up to 5 minutes, so allow at least that long.
- [ ] **Background matcher, equities:** while NSE is closed place a *limit* buy for an ETF above the current price. It shows "Waiting: market is closed" in the Order log; the next market open it fills with no browser open (Order log shows Filled, and `GET /api/portfolio/orders/<id>/events` shows `actor: matcher`).
- [ ] Restart: Render > Manual Deploy > Restart. Reload the site: you are still logged in and the portfolio is unchanged.
- [ ] Logs: Render > Logs show JSON lines. You should see `listening`, `background limit-order matcher started`, request lines with `requestId`. There must be no passwords, tokens or connection strings.
- [ ] `https://YOUR-SITE/readyz` returns `{"ok":true,...}` (this one does query the database; use it for an external uptime monitor such as UptimeRobot, no more often than every 5 to 10 minutes if you want Neon to be able to sleep).

### What production gives you (and where it lives)
- **HTTPS:** Render terminates TLS and renews certificates. The app redirects any plain `http://` page request to `https://` (308), refuses plain-HTTP API writes, sends HSTS, and uses the `__Host-` Secure, HttpOnly, SameSite=Lax session cookie.
- **CSRF / CORS:** no cross-origin access is allowed (no CORS headers are sent). State-changing requests must come from your own origin, be JSON, and not be cross-site (Origin and Fetch-Metadata checks, verified by the script).
- **Logging:** one JSON object per line (`time, level, msg, requestId, method, path, status, ms, userId`). No query strings, bodies, cookies, IP addresses or emails are logged; secrets are masked and credentials inside URLs are stripped. Responses carry an `X-Request-Id` header; a 500 shows the same id so you can find the log line.
- **Errors:** unexpected errors return a generic message plus the request id. An unhandled rejection or uncaught exception is logged and the process exits so Render restarts it cleanly.
- **Health:** `/healthz` (liveness, no database, also reports whether the matcher loop is alive) is what Render polls; `/readyz` (readiness) checks the database and the matcher heartbeat.
- **Graceful shutdown:** on `SIGTERM` the server stops accepting connections, lets in-flight requests finish, finishes a running matcher pass, **releases the matcher lease** (so a new instance takes over immediately), closes the database pool and exits 0 (25 s limit, `SHUTDOWN_GRACE_SEC`). Render restarts crashed processes automatically.
- **Rate limits:** per-IP on `/api` (600/min), login (20 per 15 min per IP, 5 failures per account), registration, password reset and per-user order limits. `TRUST_PROXY=1` makes them see the real client. Counters live in memory (single instance).
- **Migrations:** by default pending migrations are applied at boot, one at a time under a database lock (safe if two instances start together), each inside a transaction, tracked in `schema_migrations`. They never re-run and never reset balances. For stricter control set `MIGRATE_ON_START=false`: the server then never changes the schema and refuses to start if migrations are pending; run `npm run migrate` yourself (or as a Render pre-deploy command on paid plans) first.
- **Market data failure behaviour:** Yahoo and CoinGecko calls have timeouts, a circuit breaker, caching with single-flight and stale-while-error; a stale, frozen, missing or implausible price is shown as such and never used to fill an order. CoinGecko has a monthly call-budget guard.
- **Docker (optional):** a `Dockerfile` is included for hosts that run containers (`docker build -t investbrick .`). It has not been built or run in my environment.

### Troubleshooting
| Symptom | Likely cause and fix |
|---|---|
| Render log: `refusing to start in production` | Read the `problems` list in that line; set the named variable. |
| `could not start accounts` + `password authentication failed` | Wrong `DATABASE_URL` (reset the Neon role password and copy a fresh string). |
| `... does not support SSL` / `sslmode` problem | The string must end with `?sslmode=require`. |
| Connection error mentioning `channel_binding` | Delete `&channel_binding=require` from the string. |
| First page after quiet time is slow | Neon compute was suspended (free plan); it wakes in a second or two. |
| 503 "Accounts are not set up" | The database did not start: see the log line `could not start accounts`. |
| Login works but you are logged out on the next page | `APP_URL` is not your real `https://` address, or you opened the site over `http://`. |
| 403 `BAD_ORIGIN` on login or orders | Request came from a different site than the one you are on (for example a cached old domain). Hard-refresh; check `APP_URL`. |
| Reset email never arrives | Check SMTP variables and that `EMAIL_FROM` is a sender your provider allows; look for `password reset email failed` in the logs; check spam. |
| Crypto prices show unavailable / 429 | Add `COINGECKO_API_KEY` (free Demo key); the free tier is rate limited. |
| Equity prices unavailable | Yahoo may block a cloud IP (it is an unofficial source). Nothing is faked; see Limitations. |
| Limit orders never fill | `/healthz` should show `matcher.alive: true`; check the plan is Starter (not Free); NSE orders only fill during market hours; the Order log shows the waiting reason. |
| Build fails on `argon2` | Make sure `NODE_VERSION` is 22 (set by the Blueprint). |

### How I tested Phase 5 (and what I could not)
- `npm test` (all suites on PGlite; the portfolio, engine and deploy suites also on a real PostgreSQL via `npm run test:pg`). New tests cover: secret redaction in logs, request ids and log content, error handling, `/healthz` vs `/readyz`, matcher idle mode and wake, **matcher failover** (a crashed leader replaced after lease expiry, standby never runs while the leader lives, five matchers racing give one leader and one fill per order), production-config checks, and a **real server process** that is restarted (session cookie and portfolio survive), stopped with `SIGTERM` (exit 0, clean shutdown), refuses bad production config, and refuses to boot with `MIGRATE_ON_START=false` on an unmigrated database.
- **Production-mode rehearsal:** the unmodified server (`NODE_ENV=production`, `TRUST_PROXY=1`, `https` forwarded header) on a real PostgreSQL 18 server, a local SMTP server requiring STARTTLS, and mocked Yahoo/CoinGecko responses. `verify:deploy --full` passed registration, secure cookie flags, ₹10,00,000 start, buy/sell, duplicate-submission safety, limit order open/cancel with audit trail, market-closed refusal, fresh-login persistence and logout; the password-reset flow passed through real SMTP+STARTTLS (single-use token, old sessions revoked, link uses `APP_URL`, token never logged).
- **Not tested, because I cannot reach them:** Render, Neon, your DNS/TLS certificate, a real SMTP provider, real Yahoo and CoinGecko responses. The `verify:deploy` script exists precisely to check these on your live site.

### Remaining limitations
- Yahoo Finance is unofficial and delayed (~15 min) and may block cloud IPs; CoinGecko's free tier is rate limited and cached for 5 minutes, so limit orders react to price moves with up to that delay.
- Neon free: 1 GB, 100 compute-hours, no long history (6-hour restore window). Take your own backups: `pg_dump "$DATABASE_URL" > backup.sql` (needs the PostgreSQL client tools) before risky changes.
- The matcher polls (every 15 s while orders are open); it is not tick-by-tick.
- Rate-limit counters and the price cache are per instance.
- No two-factor login, no email verification at signup, no admin console or alerting (use an external uptime monitor on `/readyz`).
- The CSP still allows inline scripts/styles because the front end is a single HTML file.
- Render's price and Brevo/Gmail limits were not verified by me; check them before relying on them.
- Real-money trading does not exist and was not added.
