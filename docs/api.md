# SH Fari Ops — API contract (v1)

Base URL: `/api/v1`. All request and response bodies are JSON (`Content-Type: application/json`); CSV exports are the only exception.

## Conventions

**Authentication.** `POST /auth/login` sets an `HttpOnly`, `SameSite=Strict` session cookie (`shfari_session`, or `__Host-shfari_session` in production). Every endpoint except `/health`, `/auth/login`, `/auth/logout` and `/auth/password-reset/*` requires it. A user flagged `mustChangePassword` can only call `/auth/me`, `/auth/logout` and `/auth/change-password` until they change it.

**Authorisation.** Each endpoint names the permission it needs (see *Roles and permissions* in the README). Users bound to a station can only read and write that station's data: filtering another station returns `403`, and addressing another station's record by id returns `404`.

**Success envelope**

```json
{ "success": true, "data": {}, "message": "Optional human-readable message" }
```

Paginated lists add `pagination` (and sometimes `summary`):

```json
{ "success": true, "data": [], "pagination": { "page": 1, "limit": 20, "total": 150, "totalPages": 8 } }
```

List query parameters: `page` (default 1), `limit` (default 20, max 100), `sortOrder` (`asc`|`desc`). Month filters use `month=YYYY-MM`; ranges use `from`/`to` (`YYYY-MM-DD`, max 400 days). Explicit `from`/`to` wins over `month`; with neither, the current month is used.

**Error envelope**

```json
{ "success": false, "error": { "code": "VALIDATION_ERROR", "message": "Some fields are invalid…", "fields": { "quantity": "Quantity must be greater than zero." }, "requestId": "…" } }
```

| Status | Code | When |
| --- | --- | --- |
| 400 | `BAD_REQUEST` | Body is not JSON, invalid reset link |
| 401 | `UNAUTHORIZED` | No/expired session, wrong credentials |
| 403 | `FORBIDDEN` | Missing permission, other station, cross-site request, password change pending, self-approval |
| 404 | `NOT_FOUND` | Unknown route or record (including out-of-scope records) |
| 409 | `CONFLICT` | Duplicate reference, locked day, invalid state transition, negative stock, credit limit |
| 413 | `PAYLOAD_TOO_LARGE` | Body over 1 MB |
| 422 | `VALIDATION_ERROR` | Field validation failed — see `fields` |
| 429 | `RATE_LIMITED` | Rate limit hit or account locked after failed sign-ins |
| 500 | `INTERNAL_ERROR` | Unexpected failure (details are logged, never returned) |

Numbers accept plain numbers or strings with thousands separators/currency symbols (`"33,000"`, `"₦645.00"`). Money has at most 2 decimals, litres at most 2. Business dates cannot be in the future.

---

## Health

| Method | Path | Auth | Response |
| --- | --- | --- | --- |
| GET | `/health` | — | `{ status: "ok"|"degraded", database: "up"|"down" }` (503 when the DB is down) |

## Auth

| Method | Path | Auth | Body | Response / notes |
| --- | --- | --- | --- | --- |
| POST | `/auth/login` | — | `{ username, password }` | Profile `{ id, username, fullName, email, phone, stationId, stationName, roles[], permissions[], mustChangePassword, lastLoginAt }`; sets cookie. 401 invalid, 403 suspended, 429 locked/rate limited |
| POST | `/auth/logout` | — | `{}` | Revokes the session server-side and clears the cookie |
| GET | `/auth/me` | session | — | Profile |
| POST | `/auth/change-password` | session | `{ currentPassword, newPassword }` | Profile. Password: ≥10 chars, letters and numbers. Other sessions are revoked |
| POST | `/auth/password-reset/verify` | — | `{ token }` | `{ username, fullName, expiresAt }` or 400 |
| POST | `/auth/password-reset/confirm` | — | `{ token, newPassword }` | Single-use; revokes all sessions and clears lockout |

## Lookups, search, badges

| Method | Path | Permission | Query | Response |
| --- | --- | --- | --- | --- |
| GET | `/lookups` | session | — | `{ stations[], products[], tanks[], pumps[], narrations[], banks[], users[], roles[], settings, today, currentMonth }` — scoped to the user |
| GET | `/search` | session | `q` (2–60 chars) | `[{ type, page, id, ref, label, date, stationId, stationName }]` across modules the user can view |
| GET | `/dashboard/badges` | session | — | `{ openDsrDays, stockExceptions, openExceptions, pendingExpenses }` |

## Dashboard & exceptions

| Method | Path | Permission | Query / body | Response |
| --- | --- | --- | --- | --- |
| GET | `/dashboard` | `dashboard.view` | `stationId?` | `{ kpis{ salesMtd, salesDeltaPct, stockValue, stockLitres, stockStations, outstandingDebt, debtAccountsOver60, netProfitMtd, netProfitDeltaPct, … }, salesTrend[8 weeks], gitStatus[], exceptions{ open, items[] }, salesByStation[], stationSummary, topDebtors[] }` |
| GET | `/dashboard/comparison` | `dashboard.view` | `month?` | `{ month, range, rows[{ stationName, soldLitres, salesValue, costOfSales, grossProfit, trucksReceived, receivedLitres, expenses, netProfit, debt, closingStockLitres, closingStockValue, gitLitres, gitValue }], totals }` |
| GET | `/exceptions` | `exceptions.view` | `status?` (`open`/`reviewed`/`closed`/`active`), `type?`, `stationId?`, paging | Paged exceptions |
| POST | `/exceptions/:id/review` | `exceptions.review` | `{ comment }` | Open → reviewed |
| POST | `/exceptions/:id/close` | `exceptions.review` | `{ resolution }` | → closed |

## Truck receipts

| Method | Path | Permission | Query / body | Notes |
| --- | --- | --- | --- | --- |
| GET | `/receipts` | `receipts.view` | `month|from|to`, `stationId`, `productId`, `status`, `search` (waybill/truck/GIT ref), `sortBy` (`businessDate`/`quantity`/`createdAt`), paging | Adds `summary{ verifiedCount, verifiedQuantity, verifiedValue, byStatus }` |
| POST | `/receipts` | `receipts.create` | `{ stationId, productId, tankId?, quantity, orderPrice, landingPrice, waybillRef, truckPlate, gitDeliveryId?, businessDate? }` | 201. Tank auto-selected when the station has one tank for the product. 409 duplicate waybill or locked day |
| GET | `/receipts/:id` | `receipts.view` | — | Receipt |
| POST | `/receipts/:id/verify` | `receipts.verify` | `{}` | Posts stock; discharges linked GIT delivery (completes order / flags shortage) |
| POST | `/receipts/:id/dispute` | `receipts.verify` | `{ reason }` | Received → disputed |
| POST | `/receipts/:id/cancel` | `receipts.cancel` | `{ reason }` | Voids stock posting and GIT discharge if verified; 409 if stock would go negative |

## Goods in transit

| Method | Path | Permission | Query / body | Notes |
| --- | --- | --- | --- | --- |
| GET | `/git-orders` | `git.view` | `status` (any status, `open`, `exception`), `stationId`, `productId`, `search`, `month|from|to`, paging | Rows include `destinations`, `discharged`, `outstanding`, `daysInTransit`, `delayed` |
| GET | `/git-orders/open-deliveries` | `receipts.create` or `git.view` | `stationId`, `productId?` | Pending deliveries a receipt can link to |
| POST | `/git-orders` | `git.create` | `{ productId, quantity, orderPrice, truckPlate?, source?, orderDate?, expectedArrivalDate?, notes?, isMultiDelivery, destinations[{ stationId, quantity? }] }` | Multi-delivery quantities must add up to the order |
| GET | `/git-orders/:id` | `git.view` | — | Detail with `stages[]`, `allowedTransitions[]`, `deliveries[]` (with receipts) and `events[]` |
| PATCH | `/git-orders/:id` | `git.update` | `{ truckPlate?, expectedArrivalDate?, source?, notes? }` | Quantity and order price are immutable |
| POST | `/git-orders/:id/status` | `git.update` | `{ status, note? }` | `truck_assigned → in_transit → arrived → discharging → completed`; `cancelled` before discharge. Note required to cancel or short-close |
| PUT | `/git-orders/:id/deliveries` | `git.update` | `{ destinations[] }` | Only before any receipt is linked |
| POST | `/git-orders/:id/exception` | `git.update` | `{ type: shortage|delay|price|other, note }` | Raises an exception |
| POST | `/git-orders/:id/exception/resolve` | `git.update` | `{ note }` | Clears and closes related exceptions |

## DSR

| Method | Path | Permission | Query / body | Notes |
| --- | --- | --- | --- | --- |
| GET | `/dsr/day` | `dsr.view` | `stationId`, `date?` | `{ station, date, status (not_opened/open/closed), day, openBlocker, readings[{ pumpId, pumpName, productCode, openingReading, closingReading, openingEditable, dispensed, rtt, netSales, unitPrice, salesValue }], products[], totals }` |
| GET | `/dsr` | `dsr.view` | `stationId`, `status`, `month|from|to`, paging | Day list with net sales and value |
| POST | `/dsr/open` | `dsr.record` | `{ stationId, businessDate }` | Days open in order; opening readings carry forward |
| PUT | `/dsr/:id/readings` | `dsr.record` | `{ readings[{ pumpId, closingReading, openingReading? }] }` | Field errors use `readings.N.closingReading` |
| POST | `/dsr/:id/close` | `dsr.close` | `{}` | Computes net sales (RTT excluded), snapshots price and cost, posts dispensing and RTT to the ledger, locks the day |
| POST | `/dsr/:id/reopen` | `dsr.reopen` | `{ reason }` | Latest day only; voids postings until re-closed |

## RTT

| Method | Path | Permission | Query / body | Notes |
| --- | --- | --- | --- | --- |
| GET | `/rtt` | `rtt.view` | `month|from|to`, `stationId`, `pumpId`, `productId`, `status`, paging | Adds `summary.totalLitres` |
| POST | `/rtt` | `rtt.create` | `{ stationId, pumpId, quantity, reason, businessDate?, productId? }` | 409 if the day is locked |
| GET | `/rtt/:id` | `rtt.view` | — | Entry |
| POST | `/rtt/:id/cancel` | `rtt.cancel` | `{ reason }` | Open days only |

## Stock

| Method | Path | Permission | Query / body | Notes |
| --- | --- | --- | --- | --- |
| GET | `/stock/movement` | `stock.view` | `stationId`, `productId`, `tankId?`, `date?` | `{ opening, receipts, dispensed, rtt, adjustments, closing, netSales, physicalDip, variance, tanksDipped, tanksTotal, tolerance }` |
| GET | `/stock/ledger` | `stock.view` | `stationId`, `productId?`, `tankId?`, `from`, `to`, paging | Movements with `runningBalance`; `dips[]` for the page's dates |
| GET | `/stock/tanks` | `stock.view` | `stationId?` | Tanks with balance, valuation price, stock value and latest dip |
| GET | `/stock/system-closing` | `stock.view` | `tankId`, `date?` | `{ systemStock, tolerance, dsrStatus, existingDip }` |
| POST | `/stock/dips` | `stock.dip` | `{ tankId, businessDate, dipLitres, note? }` | Requires the day's DSR closed; one dip per tank per day; flags variance beyond tolerance |
| POST | `/stock/adjustments` | `stock.adjust` | `{ tankId, businessDate, quantity (±), reason }` | Blocked on locked days or if stock would go negative |

## Cash, POS & bank

| Method | Path | Permission | Query / body | Notes |
| --- | --- | --- | --- | --- |
| GET | `/cash/position` | `cash.view` | `stationId`, `date?` | `{ declaration, figures{ salesValue, posAmount, creditSales, debtorCashReceipts, cashExpenses, expectedCash, broughtForward, depositsTotal, closingCit, cashAtHand, variance, tolerance, toleranceStatus }, deposits[], dsr }` |
| GET | `/cash/history` | `cash.view` | `stationId`, `month|from|to` | Daily rows (newest first) |
| POST | `/cash/deposits` | `cash.record` | `{ stationId, businessDate, bankId, tellerRef, amount, depositTime? (HH:MM) }` | 409 duplicate teller ref or closed day |
| POST | `/cash/deposits/:id/cancel` | `cash.record` | `{ reason }` | |
| PUT | `/cash/declarations` | `cash.record` | `{ stationId, businessDate, posAmount, closingCit, cashAtHand, notes? }` | Upsert; recalculates this and later days |
| POST | `/cash/positions/:id/review` | `cash.review` | `{ comment }` | |
| POST | `/cash/positions/:id/close` | `cash.review` | `{ comment? }` | Needs closed DSR and earlier days closed; justification required if exceeded |

## Debtors

| Method | Path | Permission | Query / body | Notes |
| --- | --- | --- | --- | --- |
| GET | `/debtors` | `debtors.view` | `search`, `stationId`, `status`, `hasBalance`, `sortBy` (`name`/`balance`/`closing`), `month|from|to`, paging | Rows `{ opening, additions, payments, closing, balance, aging, oldestAgeDays }` |
| GET | `/debtors/summary` | `debtors.view` | `stationId?` | `{ totalOutstanding, accounts, over60, over90, accountsOver60, buckets, byStation, topDebtors }` |
| POST | `/debtors` | `debtors.create` | `{ stationId, name, phone?, creditLimit?, openingBalance?, openingDate? }` | 409 duplicate name at station |
| GET | `/debtors/:id` | `debtors.view` | — | Detail with aging and transactions (running balance) |
| PATCH | `/debtors/:id` | `debtors.create` | `{ name?, phone?, creditLimit?, status? }` | |
| POST | `/debtors/:id/transactions` | `debtors.transact` | `{ type: credit_sale|repayment, amount, businessDate?, reference?, paymentMethod (repayment: cash|transfer|pos), note? }` | 422 repayment above balance; 409 credit limit |
| POST | `/debtors/transactions/:id/void` | `debtors.void` | `{ reason }` | |

## Expenses

| Method | Path | Permission | Query / body | Notes |
| --- | --- | --- | --- | --- |
| GET | `/expenses` | `expenses.view` | `month|from|to`, `stationId`, `narrationId`, `status`, `search`, paging | Adds `summary{ approvedAmount, approvedCount, pendingAmount, pendingCount }`; rows carry `canDecide` |
| POST | `/expenses` | `expenses.create` | `{ stationId, narrationId, amount, payee, businessDate?, reference?, note?, paymentMethod: cash|transfer }` | Pending when above the narration's threshold |
| GET | `/expenses/:id` | `expenses.view` | — | |
| POST | `/expenses/:id/approve` | `expenses.approve` | `{ note? }` | 403 for the person who logged it |
| POST | `/expenses/:id/reject` | `expenses.approve` | `{ reason }` | |
| POST | `/expenses/:id/cancel` | `expenses.create` or `expenses.approve` | `{ reason }` | Approved expenses need `expenses.approve` |

## Reports

| Method | Path | Permission | Query | Response |
| --- | --- | --- | --- | --- |
| GET | `/reports` | `reports.view` | — | Catalogue `[{ key, title, category, description, filters[], statuses[], canExport }]` |
| GET | `/reports/:key` | `reports.view` + module view | `month|from|to`, `stationId`, `productId`, `pumpId`, `bankId`, `narrationId`, `userId`, `status`, `action`, `search`, `format=json|csv` | `{ key, title, generatedAt, columns[{ key, label, type }], rows[], totals, truncated, meta }`; CSV needs `reports.export` (`audit.export` for the audit report). Max 5,000 rows |

Report keys: `truck-receipts`, `daily-sales`, `rtt`, `stock-ledger`, `dip-variance`, `cash-reconciliation`, `bank-deposits`, `expenses`, `debtors`, `git`, `monthly-management`, `audit`.

## Audit trail

| Method | Path | Permission | Query | Response |
| --- | --- | --- | --- | --- |
| GET | `/audit` | `audit.view` | `action`, `resource`, `userId`, `search` (record ref), `from`, `to`, paging | `[{ createdAt, userName, action, resource, resourceId, recordRef, oldValue, newValue, ipAddress }]` |
| GET | `/audit/facets` | `audit.view` | — | `{ actions[], resources[] }` |
| GET | `/audit/export` | `audit.export` | same filters | CSV |

## Setup

| Method | Path | Permission | Body | Notes |
| --- | --- | --- | --- | --- |
| GET | `/stations` | `stations.view` | — | With manager, pump count, products, tolerances |
| POST | `/stations` | `stations.manage` | `{ code, name, address?, managerUserId?, cashTolerance, stockTolerance }` | |
| GET | `/stations/:id` | `stations.view` | — | With `tanks[]` (balances) and `pumps[]` |
| PATCH | `/stations/:id` | `stations.manage` | any of the above + `status` | |
| POST | `/stations/:id/tanks` | `stations.manage` | `{ productId, name, capacity?, openingStock?, openingDate? }` | Opening stock posts to the ledger |
| PATCH | `/tanks/:id` | `stations.manage` | `{ name?, capacity?, status? }` | |
| POST | `/stations/:id/pumps` | `stations.manage` | `{ tankId, name, meterLabel?, initialReading? }` | |
| PATCH | `/pumps/:id` | `stations.manage` | `{ tankId?, name?, meterLabel?, initialReading?, status? }` | |
| GET | `/products` | `products.manage` or `stations.view` | — | With current default price |
| POST | `/products` | `products.manage` | `{ code, name, price?, effectiveFrom? }` | |
| PATCH | `/products/:id` | `products.manage` | `{ name?, status? }` | |
| GET | `/products/:id/prices` | `products.manage` or `stations.view` | — | Effective-dated history |
| POST | `/products/:id/prices` | `products.manage` | `{ stationId?, price, effectiveFrom }` | Append-only |
| GET/POST/PATCH | `/narrations`, `/narrations/:id` | GET: `narrations.manage` or `expenses.view`; write: `narrations.manage` | `{ name, approvalThreshold?, status? }` | |
| GET/POST/PATCH | `/banks`, `/banks/:id` | GET: `banks.manage` or `cash.view`; write: `banks.manage` | `{ name, status? }` | |
| GET | `/users` | `users.view` | `search`, `stationId`, `roleId`, `status`, paging | |
| POST | `/users` | `users.manage` | `{ username, fullName, email?, phone?, stationId?, roleIds[], password }` | Temporary password; change forced at first sign-in |
| GET | `/users/:id` | `users.view` | — | |
| PATCH | `/users/:id` | `users.manage` | `{ fullName?, email?, phone?, stationId?, roleIds?, status? }` | 409 if no active administrator would remain |
| DELETE | `/users/:id` | `users.manage` | — | Soft delete; revokes sessions |
| POST | `/users/:id/unlock` | `users.manage` | `{}` | Clears lockout |
| POST | `/users/:id/password-reset` | `users.manage` | `{}` | 201 `{ token, expiresAt }` — shown once; the link is `/#reset=<token>` |
| GET | `/roles` | `roles.view` | — | Roles with permission codes and user counts |
| GET | `/roles/permissions` | `roles.view` | — | Catalogue grouped by module |
| POST | `/roles` | `roles.manage` | `{ name, description?, permissions[] }` | |
| PATCH | `/roles/:id` | `roles.manage` | `{ name?, description?, permissions? }` | System roles cannot be renamed |
| DELETE | `/roles/:id` | `roles.manage` | — | Non-system roles without users |
| GET | `/settings` | session | — | `{ allowNegativeStock, gitDelayDays, gitShortageToleranceLitres, debtorAgingAlertDays }` |
| PUT | `/settings` | `settings.manage` | any subset | Audit logged |
