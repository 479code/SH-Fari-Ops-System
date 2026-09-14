# SH Fari Ops — Station Management & Financial Control

## 1. Project overview

SH Fari Ops is the station-control platform for SH Fari Oil & Gas Ltd. It covers a station's day from product receipt to management reporting:

- **Truck receiving:** verified receipts post to stock and discharge the linked GIT orders.
- **DSR:** sales are derived from controlled opening and closing meter readings, and days lock on close.
- **RTT:** return-to-tank is recorded separately and never counted as a sale.
- **Stock ledger:** a continuous per-tank ledger with physical dips and variance flags against tolerance.
- **GIT:** order → truck → in transit → arrival → discharge, including multi-delivery.
- **Cash, POS & bank:** expected cash vs POS, CIT, cash at hand and teller-wise deposits, with variance escalation.
- **Debtors:** transaction-driven balances with FIFO aging.
- **Expenses:** narrations come from a controlled list, with approval thresholds.
- **Dashboard and reports:** built from approved records only, exportable to CSV (Excel) and PDF (print).
- **Access and control:** role-based access, station segregation and a full audit trail.

The original prototype is in `context/sh-fari-ops-prototype 2.html`, and the functional specification in `context/SH_Fari_Oil_Gas_System_Application_Documentation.docx`.

## 2. Architecture

```
Browser (HTML/CSS + ES modules)
      │  same-origin fetch, session cookie
      ▼
Hono REST API (/api/v1)  ── request id, security headers, CORS, rate limit, origin guard, body limit
      │
      ├─ auth middleware ── session lookup → Actor (roles, permissions, station scope)
      ├─ route handlers ─── Zod validation, permission guard (thin; no SQL)
      ├─ services ───────── business rules, transactions, audit entries, exceptions
      ├─ repositories ───── shared queries: stock ledger, pricing, period locks, sequences
      ▼
Drizzle ORM ── mysql2 pool ── MariaDB
```

- **One origin.** The backend serves `frontend/` as static files, so the session cookie can be `SameSite=Strict` and no CORS is needed in the default deployment.
- **Derived data is never stored twice.**
  - Tank balances are the sum of the stock ledger.
  - Debtor balances are the sum of transactions.
  - Cash figures are recomputed from their sources and snapshotted only when a day is closed.
- **Business dates vs instants.** Business dates are `DATE` strings evaluated in `BUSINESS_TIMEZONE`; instants are UTC `DATETIME`.
- **Transactions.** Every multi-step change runs in one database transaction, and its audit row is written in that same transaction.
- **Period locks.**
  - A closed DSR day freezes that station/date's stock movements until an authorised reopen.
  - A closed cash reconciliation freezes that day's cash inputs.
- **Scheduled checks.** An hourly in-process job flags GIT delays and debtor aging, and purges expired sessions. The checks are idempotent.
- **Layers.** Queries reused across modules live in `repositories/`. Queries private to one module live in its service, which avoids pass-through repository boilerplate.
- **Relational queries.** Drizzle's relational query API is not used, because it emits `LATERAL` joins that MariaDB rejects.

## 3. Requirements

- [Bun](https://bun.sh) ≥ 1.3
- MariaDB ≥ 10.6 or MySQL ≥ 8.0 (window functions required)
- A modern browser (Chrome, Edge, Firefox, Safari)

## 4. Installation

```bash
cd backend
bun install
cp ../.env.example .env        # then edit .env
```

## 5. Environment variables

All variables are documented in [`.env.example`](.env.example) and validated at startup (`backend/src/config/env.ts`); the process exits with a readable list if any are invalid.

| Variable | Required | Purpose |
| --- | --- | --- |
| `NODE_ENV` | | `development`, `test` or `production` (production enables `Secure`/`__Host-` cookies and hides stack traces) |
| `PORT`, `HOST` | | Listen address (default `127.0.0.1:3000`) |
| `BUSINESS_TIMEZONE` | | IANA zone for business dates (default `Africa/Lagos`) |
| `DATABASE_HOST`, `DATABASE_PORT`, `DATABASE_NAME`, `DATABASE_USER`, `DATABASE_PASSWORD`, `DATABASE_POOL_SIZE` | ✓ name/user | MariaDB connection |
| `AUTH_SECRET`, `SESSION_SECRET` | ✓ | ≥32 chars each; keys for reset-token and session-token HMACs (`openssl rand -base64 48`) |
| `SESSION_IDLE_MINUTES`, `SESSION_ABSOLUTE_HOURS` | | Session expiry (60 min idle, 12 h absolute) |
| `LOGIN_MAX_ATTEMPTS`, `LOGIN_LOCKOUT_MINUTES` | | Account lockout (5 attempts, 15 min) |
| `PASSWORD_RESET_TTL_MINUTES` | | Reset link lifetime (60) |
| `CORS_ORIGIN` | | Comma-separated origins allowed to call the API with credentials (only for split deployments) |
| `FRONTEND_DIR` | | Static frontend path relative to `backend/` (empty = API only) |
| `TRUST_PROXY` | | Trust `X-Forwarded-*` headers (only behind your own reverse proxy) |
| `API_RATE_LIMIT_PER_MINUTE`, `LOGIN_RATE_LIMIT_PER_MINUTE` | | Per-IP limits (600, 10) |
| `SEED_ADMIN_USERNAME`, `SEED_ADMIN_PASSWORD`, `SEED_ADMIN_NAME` | | First administrator created by `db:seed` |

## 6. Database setup

Create a database and a least-privilege user:

```sql
CREATE DATABASE shfari CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER 'shfari'@'localhost' IDENTIFIED BY 'a-strong-password';
GRANT ALL PRIVILEGES ON shfari.* TO 'shfari'@'localhost';
```

For the test suite, also create `shfari_test` (the name must end in `_test`), grant the same user access, and create `backend/.env.test` (a copy of `.env` with `NODE_ENV=test`, `DATABASE_NAME=shfari_test`, `LOG_LEVEL=silent`, and high `*_RATE_LIMIT_PER_MINUTE` values).

## 7. Migrations

Migrations are generated SQL files committed in `backend/src/db/migrations/`.

```bash
bun run db:migrate      # apply pending migrations (run on every deploy, before starting the API)
bun run db:generate     # after changing src/db/schema/*: write the next migration file (review it, commit it)
bun run db:studio       # optional: Drizzle Studio
```

A fresh database is fully reproducible with `db:migrate` followed by `db:seed`. `drizzle-kit push` is never used against real data.

## 8. Seed data

```bash
bun run db:seed         # idempotent, safe in production
```

This creates:
- the permission catalogue
- the seven system roles
- products PMS, AGO and DPK
- default control settings
- the first administrator, if none exists

The administrator's password comes from `SEED_ADMIN_PASSWORD`. If that is empty, a password is generated and printed once. Either way, it must be changed at first sign-in.

```bash
bun run db:seed:demo    # development only — needs an empty (freshly migrated) database
```

The demo seed builds three stations (Lagos – Apapa, Ibadan – Ring Rd, Yola) and 45 days of operations by calling the real service layer. Every figure is therefore produced by the application's own rules: receipts, DSR, RTT, dips, deposits, declarations, debtors, expenses, GIT orders and exceptions. The staff accounts it creates all use the password `Password123`:

| Username | Role | Station |
| --- | --- | --- |
| `c.nwachukwu` | Station Manager + Cashier | Lagos – Apapa |
| `b.adewale` | Pump / Sales Officer | Lagos – Apapa |
| `k.musa` / `r.olawale` / `t.ojo` | Manager / Cashier / Pump officer | Ibadan – Ring Rd |
| `h.bello` / `m.garba` / `y.ibrahim` | Manager / Cashier / Pump officer | Yola |
| `f.okoro` | Receiving / Operations Officer | All |
| `a.danjuma` | Management / ED | All |
| `s.audu` | Auditor / Control | All |

## 9. Running the development server

```bash
cd backend
bun run dev             # http://127.0.0.1:3000 — API + frontend, restarts on backend changes
```

Frontend files are plain ES modules served as-is. Refresh the browser after editing them; there is no build step.

Quality checks:

```bash
bun run typecheck       # tsc --noEmit (strict)
bun run test            # integration tests against the *_test database
bun run build           # production bundle into backend/dist
```

## 10. Production deployment

1. Provision MariaDB, create the database and user (§6), and set `NODE_ENV=production` with strong unique secrets.
2. `bun install --production`, `bun run db:migrate`, `bun run db:seed`.
3. Start the API with `bun run start` (or `bun run build && bun run start:dist`) under a process supervisor (systemd, pm2). `SIGTERM` triggers a graceful shutdown.
4. Put it behind a TLS-terminating reverse proxy (nginx, Caddy, OpenLiteSpeed) and set `TRUST_PROXY=true`, `HOST=127.0.0.1`. Production cookies are `Secure` and `__Host-` prefixed, so HTTPS is mandatory.
5. Keep `frontend/` next to `backend/` (or point `FRONTEND_DIR` elsewhere). To host the frontend on a different origin, set `<meta name="api-base">` in `frontend/index.html` to the API URL and list that origin in `CORS_ORIGIN`. The session cookie then needs `SameSite=None`, so prefer same-origin.
6. Schedule database backups (for example nightly `mariadb-dump --single-transaction`) and test restores.
7. Health check: `GET /api/v1/health` (returns 503 when the database is unreachable).

## 11. API documentation

The full frontend/backend contract lives in [`docs/api.md`](docs/api.md): every endpoint's method, path, permission, body, query, response and errors. All responses use the envelope:

```json
{ "success": true, "data": {}, "message": "…", "pagination": { "page": 1, "limit": 20, "total": 150, "totalPages": 8 } }
{ "success": false, "error": { "code": "VALIDATION_ERROR", "message": "…", "fields": { "quantity": "…" } } }
```

## 12. Authentication

- **Sign-in.** Username and password are checked with Bun's argon2id. Unknown users take the same time to reject and get the same error.
- **Sessions.** The browser holds a random 256-bit token in an `HttpOnly`, `SameSite=Strict` cookie. The database stores only its HMAC (`SESSION_SECRET`). Sessions expire after `SESSION_IDLE_MINUTES` idle or `SESSION_ABSOLUTE_HOURS`, and logout revokes them server-side.
- **Brute force.**
  - Per-IP rate limiting on sign-in.
  - `LOGIN_MAX_ATTEMPTS` consecutive failures lock the account for `LOGIN_LOCKOUT_MINUTES`; an administrator can unlock it.
  - Every attempt is audit logged.
- **Passwords.** At least 10 characters with letters and numbers. Temporary passwords must be changed at first sign-in, and changing a password signs out other devices.
- **Password reset.** There is no outbound email in this deployment, so an administrator issues a single-use link (`/#reset=<token>`, valid `PASSWORD_RESET_TTL_MINUTES`) and shares it securely. Only the token's HMAC (`AUTH_SECRET`) is stored. Using the link revokes all sessions.
- **CSRF.** Three layers apply:
  - `SameSite=Strict` cookies
  - JSON-only request bodies
  - an origin guard that rejects cross-site state-changing requests
- **Headers.**
  - Content-Security-Policy (`script-src 'self'`; the frontend uses no inline scripts)
  - `frame-ancestors 'none'`
  - `no-store` on API responses

## 13. Roles and permissions

Permissions are `<module>.<action>` codes, defined in `backend/src/auth/permissions.ts` and enforced on every endpoint. Hiding a button in the UI is presentation only. Users can hold several roles, and roles are editable in **Setup → Users & roles**. A user assigned to a station can only see and change that station's records; out-of-scope records return 404.

| Role | Access |
| --- | --- |
| System Administrator | Everything, including users, roles, master data, settings and the audit trail |
| Station Manager | Receipts (incl. verify/cancel), DSR (incl. close/reopen), RTT, stock dips & adjustments, cash review, debtors (incl. void), expense approval, reports & export, exceptions review |
| Receiving / Operations Officer | Truck receiving and verification, GIT create/update, stock view & dips |
| Pump / Sales Officer | DSR open & readings, RTT, stock view |
| Cashier / Accounts Officer | Cash deposits & declarations, debtors & transactions, expenses (log), reports |
| Management / ED | Read-only across operations and finance, reports & export |
| Auditor / Control | Read-only everything including users, roles and audit trail; report & audit export |

Built-in controls:
- An expense cannot be approved by the person who logged it.
- Only the most recent DSR day can be reopened, and a reason is required.
- At least one active user must always be able to manage users and roles.

## 14. Troubleshooting

| Symptom | Fix |
| --- | --- |
| `Invalid environment configuration` at start | Read the listed variables; secrets must be ≥32 characters |
| `ER_ACCESS_DENIED_ERROR` / `ECONNREFUSED` | Check `DATABASE_*` and that MariaDB is running (`brew services start mariadb` / `systemctl start mariadb`) |
| `Table … doesn't exist` | Run `bun run db:migrate` |
| Sign-in works but every page is 403 “change your password” | The account has a temporary password — complete the change-password screen |
| “Account temporarily locked” | Wait `LOGIN_LOCKOUT_MINUTES` or unlock the user in Setup → Users & roles |
| Cookie not kept in production | HTTPS is required (`__Host-` + `Secure`); set `TRUST_PROXY=true` behind a proxy |
| “Cross-site request blocked” | The page origin differs from the API origin — serve both from the same origin or add the origin to `CORS_ORIGIN` |
| “Close the DSR for … before recording a physical dip” | Dips compare against system stock after the day's sales; close the DSR first |
| “The business day … is closed and locked” | Reopen that day in DSR (requires `dsr.reopen`), make the change, close it again |
| Tests refuse to run | `DATABASE_NAME` in `.env.test` must end in `_test`; create and migrate it with `bun --env-file=.env.test src/db/migrate.ts` |
| Rate limited during scripted testing | Raise `API_RATE_LIMIT_PER_MINUTE` / `LOGIN_RATE_LIMIT_PER_MINUTE` for that environment |

## 15. Project structure

```
.
├── .env.example                 environment template (copy to backend/.env)
├── context/                     original prototype and functional specification
├── docs/api.md                  frontend/backend API contract
├── frontend/
│   ├── index.html               prototype markup wired to the API (no inline scripts)
│   ├── css/app.css              prototype stylesheet + integration styles
│   └── js/
│       ├── app.js               bootstrap: session, sign-in/password flows, page registry
│       ├── api/client.js        the only fetch layer (JSON, errors, timeouts, downloads)
│       ├── core/                dom (escaping `html` template), format, ui (modals/forms/tables/pager),
│       │                        charts (SVG), state, router, shell (search/bell/menus), filters, exceptions
│       └── pages/               one module per screen: dashboard, truck, dsr, rtt, stock, git,
│                                cash, debtors, expenses, reports, audit, setup
└── backend/
    ├── drizzle.config.ts
    ├── package.json · tsconfig.json
    ├── src/
    │   ├── index.ts             HTTP server, scheduler, graceful shutdown
    │   ├── app.ts               Hono app: middleware, routes, static frontend
    │   ├── config/env.ts        validated configuration
    │   ├── auth/                permission catalogue & roles, password hashing, tokens, station scope
    │   ├── db/                  client, schema/, migrations/, migrate, seed, seed-demo
    │   ├── middleware/          request context, error handler, security, rate limit, auth guards
    │   ├── routes/              auth, operations, finance, insights, setup (thin handlers)
    │   ├── services/            business logic per module (+ audit, exceptions, settings)
    │   ├── repositories/        shared queries: stock ledger, pricing, locks, sequences, trucks
    │   ├── validators/          Zod schemas per module
    │   ├── jobs/scheduler.ts    hourly control checks
    │   └── utils/               errors, http envelopes, dates, numbers, csv, logger
    └── tests/                   unit + integration tests (real MariaDB, real HTTP app)
```

### Business rules implemented (and how they are calculated)

- **Tank equation:** closing = opening + verified receipts − metered dispensing + RTT ± adjustments. **Net sales** = dispensing − RTT, valued at the pump price effective on the day and snapshotted at close.
- **Stock variance** = physical dip − system closing stock, flagged when |variance| > the station's stock tolerance. Dips never overwrite system stock.
- **Expected cash** = DSR sales value − POS − credit sales + cash debtor repayments − approved cash expenses.
- **Cash variance** = deposits + closing CIT + cash at hand − (brought forward + expected cash). Brought forward is the previous declared day's CIT plus cash at hand. The variance is always shown; tolerance decides escalation.
- **Profit:**
  - gross profit = sales value − cost of sales, where cost is net litres × landing price of the latest verified receipt, snapshotted at close
  - net profit = gross profit − approved expenses
- **Stock valuation** = litres × latest verified landing price.
- **Debtor aging** is FIFO (repayments settle the oldest charges first), bucketed 0–30, 31–60, 61–90 and 90+ days.
- **References** (GIT-1001, RTT-0001, DIP-00001, ADJ-00001, EXP-0001) come from atomic sequences. Waybill and teller references are unique.

### Assumptions (open items in §24 of the specification)

- The exact DSR and stock formulas, CIT definition, profit rules, aging buckets and approval hierarchy were not confirmed. The rules above are the implemented interpretation, and each is isolated in its service so it can be changed in one place.
- One truck receipt discharges one GIT delivery. A partial discharge beyond the shortage tolerance is flagged rather than left open.
- GIT outstanding in historical station comparisons is the current figure; GIT status history is not snapshotted per month.
- Station investment/capital indicators (§16–17 of the specification) have no data source yet and are not reported.
- Notifications are the in-app exceptions bell; there is no outbound email or SMS.
