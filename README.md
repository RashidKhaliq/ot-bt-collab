# StockBridge v3.2 — Automatic Webhook Order Routing & Safe Conflict Logging

Node.js 20+ · Express · Vercel · Neon/PostgreSQL · Shopify Admin GraphQL

**Status:** source-code upgrade. Offline code/syntax and archive validation performed. No access to live Shopify/Neon configuration. **Never deploy live writes until manual integration checks complete.**

## Contents

- Shopify `orders/create` + `orders/cancelled` webhooks verified with HMAC per store.
- Supplier ownership from **product metafield `custom.supplier`**, coupled with exact SKU.
- Cross-store source identification, inventory draft/zero, idempotent supplier order creation, and configurable supplier-order discount (default **99%**).
- Cancellation snapshot restoration with manual-review guards for conflicts and external changes.
- **Collaboration Analytics**: who sold whose products, Shopify Product Type, units, customer selling value, and each connected store's listing price **captured at sale time**.
- **Competition Matrix**: Product Type × selling store, plus ranking by dropship units/revenue; uses **actual store names from Neon**, not internal A/B/C keys.
- Inventory availability by **owner store × product type** from deduplicated owner inventory snapshots, with snapshot completeness warning.
- **Store Settings**: add/edit/disable store, actual display name, Shopify domain, supplier identifier, owner details; no Vercel redeployment needed for these fields.
- On-demand **webhook diagnosis and registration**, Shopify latest-orders comparison, exact SKU+supplier check, missing-order requeue/recovery, job logs.
- Static dashboard in `public/index.html`, database-first reports, **zero browser polling**, once-daily recovery worker.
- Shopify API tokens and webhook signing secrets remain in Vercel ENV, never database or browser.
- One-time SQL schema migration; no concurrent `CREATE TABLE` from incoming serverless webhooks.


## v3.2 — IMPORTANT: upgrade from v3.1

This is a **source code release, not a live-shop deployment**. Backup your Neon production branch and save a PostgreSQL `pg_dump` before updating. Do **not** change production `DATABASE_URL` or drop `ts_claims`. Existing claims are intentional safeguards against physical-item double sales.

1. `npm install` on development PC or clean CI machine (Node.js 20+).
2. Run `npm run db:migrate` **once** against production Neon using the secure direct connection string. Adds `ts_jobs.next_attempt` and due-job index; does not delete existing data.
3. Run `npm test` and `npm run check`. Run controlled test stores before production activation.
4. Deploy source to Vercel. Keep existing token and webhook secret ENV values; set all store display names/domains/`custom.supplier` through dashboard.
5. Settings → enable **LIVE** only when ready; previous database setting remains unchanged unless modified.
6. Diagnostics → select EACH connected store; verify signed `orders/create` and `orders/cancelled` webhooks, current token scopes, callback `https://YOUR-APP-DOMAIN/api/webhooks`, and recent deliveries. App-scoped TOML subscriptions may not appear in shop-scoped list. Never create duplicate subscriptions without checking existing app-scoped subscriptions.
7. Make one new Store B test purchase of Store A item. Expect Store B customer order → Store A discounted internal order → matching SKU+supplier on every connected store Qty 0 / DRAFT / `Soldby_<ActualSellerName>`. Cancel test customer order and verify supplier cancellation and cautious stock restoration.

### Automatic processing; no Recover button required for new successful orders

- Shopify sends signed JSON webhook. Handler verifies domain+HMAC and saves pending job in Neon before HTTP 200 acknowledgment. Registers a Vercel `waitUntil()` background worker **before** response, which attempts one queued order and one cancellation.
- Owner decided from **source-selling-store product metafield** `custom.supplier` (not SKU alone). If supplier maps back to seller, no internal order created. Otherwise, matching owner SKU+supplier is required; seller order placed on **owner** with dashboard discount (default 99%), internal tag, free-shipping settings, original order reference. New internal webhook is ignored and logged.
- After owner order exists, all matching connected listings are tagged `Soldby_<seller's configured display name>`, set to `DRAFT`, and inventory `0`. Owners keep own internal order quantity adjustment; linked stores update individually.
- Durable claim prevents two legitimate Shopify checkouts selling same physical piece **after both checkouts already happened**. Webhooks cannot prevent a concurrent oversell at checkout time. Never force-create a second supplier order from `CONFLICT` state.
- Dashboard → Diagnostics → **Recent Jobs & Error Logs** → **Details** shows signed webhook deliveries, job status, step-by-step timeline, owner internal order IDs, snapshot references, claimed SKU, and conflict holder. No background dashboard polling.
- `RETRY` = transient network/API error. `REVIEW` = Shopify order-create network timeout where order might already exist; **do not retry blindly**. `CONFLICT` = another customer checkout currently owns physical claim; investigate both original orders and owner orders. `ERROR` = validation/API failure. `DONE` = completed. `DRY_RUN` = actual stock/order writes disabled.
- HTTP webhook processing occurs on receipt. Retry sweep on Vercel Hobby default scheduler is **daily only**: if Shopify API temporarily fails, a `RETRY` job will wait until next worker invocation or scheduled check. For reliable frequent recovery, set up an **optional externally scheduled authenticated GET `/api/worker`** (example every 10–15 minutes) or a reliable queue service; this incurs extra invocations and must preserve `Authorization: Bearer <CRON_SECRET>`. Vercel Hobby cannot schedule native cron more than once per day. Avoid unauthenticated public worker endpoints.

### Conflict example & safe review

If a job reports:

```text
CONFLICT: A:wts10uk4p claimed by B:6721133379772; both checkouts may already exist
```

it means current sale and previously claimed order point to **same physical-item key**. Check **both** Shopify customer orders, the previous job `B:6721133379772`, owner internal order, snapshot, and any cancellation. New supplier order is **deliberately blocked** to prevent duplicate fulfillment of one-off stock. Do not `DELETE FROM ts_claims` or change claim key simply to bypass error. After appropriate cancellation and successful StockBridge restoration, existing claim is released automatically. If previous job was a partial failure or source order is no longer valid, reconcile manually; do not guess inventory.

Read-only SQL diagnostics for Neon SQL Editor (not data-changing):

```sql
SELECT item_key,job_key,claimed_at FROM ts_claims WHERE item_key='A:wts10uk4p';
SELECT job_key,selling_key,order_name,state,attempts,last_error,created_at FROM ts_jobs WHERE job_key='B:6721133379772';
SELECT owner_key,owner_order_gid FROM ts_supplier_orders WHERE job_key='B:6721133379772';
SELECT level,message,created_at FROM ts_logs WHERE job_key='B:6721133379772' ORDER BY id;
```

### Webhook and jobs troubleshooting

- **No Store B webhook delivery:** check Store B webhook subscription URL, signing secret, correct `.myshopify.com` domain, access token, Shopify webhook delivery history. A webhook cannot process orders if Shopify never sends it or HMAC rejects it.
- **Webhook received; job absent:** inspect Neon connection and Vercel Functions error logs (webhook should return 2xx only after queue insert succeeds).
- **Job PENDING:** `waitUntil` did not finish/start; trigger secure worker, review Vercel timeout and function logs.
- **Job DRY_RUN:** Settings → LIVE writes is off; recover existing dry-run order explicitly after enabling it. Do not confuse absence of owner order with webhook failure.
- **Job ERROR:** inspect step logs and Shopify GraphQL error, scopes or inventory. An explicit recover is only needed for old/failed orders; new ordinary orders auto-trigger.
- **Job REVIEW/CONFLICT:** resolve both Shopify orders and their physical stock claim before retry. Never force duplicate supplier orders.


## 1. Essential deployment caution

This application **cannot recover Shopify orders retroactively unless the relevant order still exists in Shopify and the Admin API token can access it**. Use read-only diagnostics first. Shopify product status is **product-level**; drafting a multi-variant product drafts all variants. Cancellation restoration uses captured location snapshots and can stop for manual review if stock is ambiguous. Test with separate Shopify development stores before changing real inventory.

**Store B not routing an order to Store A:** older releases lacked clear confirmation of Store B webhook subscriptions. v3.2 exposes a diagnostic page that shows the store connection, recent Shopify orders, received webhook events, local processing state/error, owner matching, and a manual one-order recovery action. Do not assume root cause until these checks run.

## 2. Install and first migration

```bash
unzip StockBridge-v3.2-Auto-Orders.zip
cd StockBridge-v3.2
cp .env.example .env
npm install
npm run check
npm test
npm run db:migrate
npm start
```

For an **existing v3 database**, first take a Neon backup/snapshot. **Run** `npm run db:migrate` **once**, preferably locally using a secure Neon connection, before shipping upgraded Vercel code. It adds `sb_stores`, `sb_sale_prices`, `sb_webhook_events`, and supporting indexes without deleting previous orders or snapshots. Script runs SQL in one transaction guarded by a PostgreSQL advisory lock. The previous per-request auto-creation of tables was removed to avoid:

```text
duplicate key value violates unique constraint "pg_type_typname_nsp_index"
```

If this error still appears, locate any other old Vercel deployment or app instance executing concurrent schema creation. Check Neon query logs and migrations. **Do not drop tables, schemas, types, or databases to resolve it.**

### Vercel

- Framework preset: **Other**; Node.js 20+.
- Set `DATABASE_URL`, `ADMIN_USER`, long `ADMIN_PASSWORD`, `CRON_SECRET`, and store tokens/secrets in Project Settings → Environment Variables.
- `vercel.json` rewrites **only `/api/*`** to Express. Root dashboard `public/index.html` is a CDN-served static file and makes no authenticated Shopify requests by itself.
- Deploy from Git/ZIP source (or Vercel CLI). The `public/` directory must be retained.
- On first visit, dashboard data requests use HTTP Basic authentication. Store metadata and sales JSON never ship in static HTML.
- Default scheduler: `GET /api/worker` at `04:00 UTC` daily for stuck jobs. Vercel automatically attaches `Authorization: Bearer <CRON_SECRET>` if configured. A webhook attempts immediate processing using `waitUntil`, and daily sweep can recover some pending or transiently failed jobs later. Full reliability and short retry times require an external durable scheduler/queue; `waitUntil` alone can be cut short by function timeouts. On a plan allowing reliable more-frequent schedules, you may change this, at expense of extra invocations.

## 3. Dashboard store setup (actual store names)

Open **Manage Stores → Add / Edit Store**.

| Field | Example for Store A | Example for Store B |
|---|---|---|
| Internal key (database/env only) | `A` | `B` |
| Actual display name | `Store A` | `Store B` |
| Shopify domain | `store-a.myshopify.com` | `store-b.myshopify.com` |
| Ownership metafield value | `StoreA` | `StoreB` |
| Owner contact email | `a@example.com` | `b@example.com` |
| Owner shipping address | Enter in form | Enter in form |
| Enabled | Yes | Yes |

Only **internal key** is used for `STORE_A_ACCESS_TOKEN`, `STORE_A_WEBHOOK_SECRET`, etc. Real display names read from database everywhere in reports, and no personal names are hardcoded. Supplier lookup canonicalizes whitespace, dashes, underscores, and case: `StoreA` matches `Store A` when configured. SKU still must exactly match case-insensitively and uniquely with supplier.

For a **new store**, enter Shopify access token + signing secret in Vercel environment variables once. Redeploy may be necessary for new secrets to reach running functions. After that, edit name, domain, supplier identifier, email, phone, address, enabled status through dashboard without redeployment. Setting tokens in database is deliberately **not** supported, minimizing credential exposure.

Only **secrets and infrastructure bootstrap** stay in ENV: `DATABASE_URL`, `ADMIN_USER`, `ADMIN_PASSWORD`, `CRON_SECRET`, per-store `ACCESS_TOKEN` and `WEBHOOK_SECRET`. Never put DB connection or security master credentials in browser/dashboard settings.

## 4. Verify Store B order webhook and fix missing order

Example: Store B sold `WKT-342-UK-12-P` belonging to Store A, with `custom.supplier=StoreA`.

1. Save Store A and Store B metadata in Manage Stores. Ensure both ENV token + HMAC secret set.
2. Settings: enter public HTTPS app URL, e.g. `https://app.example.com`; save. Keep **DRY RUN** until diagnostics pass.
3. **Order Diagnostics → select Store B → Test Store / Orders.** Compare recent Shopify orders with local `B:ORDER_ID` jobs. Missing means event was never saved locally (possible missing subscription, invalid HMAC, wrong Shopify domain, DB outage).
4. Inspect missing `ORDERS_CREATE` / `ORDERS_CANCELLED` webhook subscriptions. Select **Install missing Webhooks**; requires Shopify API authorization. Note Shopify `webhookSubscriptions` returns only **shop-scoped** subscriptions, not app-scoped subscriptions configured in Shopify app TOML. App-scoped subscribers may already exist even if this screen says missing.
5. Enter SKU `WKT-342-UK-12-P` and supplier `StoreA`. Check first with Store B, then Store A. Each must return exact matched SKU+supplier, correct product ID, location quantity. If no owner match, fix product metafields/listings first.
6. Check Jobs & Error Logs. `ERROR` shows Shopify API failures; `DRY_RUN` means no inventory or supplier order writes occurred; `DONE` means processing reports success and should be reconciled with Shopify.
7. If genuinely missing, **Recover** that Shopify order once from Store B's recent order list. This reads Shopify and requeues the existing order. No new supplier order will be created in DRY RUN. With LIVE writes, the worker can create real orders and zero stock; confirm manually first. Previous `ERROR` and `DRY_RUN` jobs can be explicitly retried. Completed `DONE` jobs are not reprocessed.
8. Enable **LIVE** in Settings only after confirming scopes, webhooks, test orders, and cancellation behavior. Type `ENABLE` as prompted.

Expected production sequence:

```text
Store B customer order
  → Shopify ORDERS_CREATE to /api/webhooks (Store B signature)
  → Neon job B:ORDER_ID
  → read sold product from Store B; custom.supplier = StoreA
  → find matching SKU + supplier on owner Store A (and Store C/D if listed)
  → snapshot inventory / status / tags / per-store listed price
  → reserve physical item (claim) and capture full snapshots
  → one internal order on Store A FIRST (discount from dashboard settings)
  → draft / remove stock across Store A, B and linked C/D listings
  → internal-order tags prevent a second customer sale event
  → sale ledger reflects ORIGINAL Store B revenue; internal order excluded
  → Collaboration / Competition report reads Neon (no Shopify polling)
```

**v3.2 order of operations:** Verify source line `SKU + custom.supplier`, find exact owner listing, obtain unique physical-item claim, save location/status snapshots, create internal order on owner store first (unless owner sold own item), then zero available inventory and DRAFT the matching listing on every connected store. A failed owner `orderCreate` no longer drafts linked products in a new attempt. A later Shopify write can still fail mid-operation; inspect logged steps and reconcile carefully. `StockBridgeInternal`/`Dropshipped_Order` tags prevent recursive supplier orders. Never repeatedly create an internal order without checking the original `TS_...` reference. Input `orderCreate` mutation requires offline-token access with proper `write_orders` scope.

### Required Shopify access

Offline Admin API token for each store and relevant scopes: `read_products`, `write_products`, `read_inventory`, `write_inventory`, `read_orders`, `write_orders`; ShopifyQL requires `read_reports` if used by optional legacy scripts. Older than 60 days of order history may require extra `read_all_orders` approval. Protected customer data permissions can apply. Webhook subscription management also requires that the app is allowed to create shop-scoped webhook subscriptions. Shopify API version defaults to `2026-10` and should be verified against the installation.

Official reference: [webhookSubscriptionCreate](https://shopify.dev/docs/api/admin-graphql/latest/mutations/webhookSubscriptionCreate), [webhookSubscriptions](https://shopify.dev/docs/api/admin-graphql/latest/queries/webhookSubscriptions).

## 5. Collaboration Analytics and price columns

Only **genuine buyer-side sales** from `sb_sales` are counted. `is_internal=true`, `cancelled=true`, and owner=seller rows are excluded from dropshipping reports. Selling store names come from saved `sb_stores.display_name`.

### Collaboration table

| Selling store | Owner store | Product type | Sold units | Customer sale value | Store A listed value | Store B listed value | Store C listed value |
|---|---|---|---:|---:|---:|---:|---:|
| Store B | Store A | Crop Tops | 15 | 22,500 | 24,000 | 22,500 | 23,700 |

*Example only.* `sb_sale_prices` snapshots linked stores' Shopify variant prices **when webhook job processes**; these are listing/catalog values, not necessarily realized sales. **No historical price reconstruction** is done. Older rows lacking a price snapshot show **N/A**, not 0. Prices from stores with different currencies must not be directly added or compared without FX conversion.

### Competition matrix

| Product type | Store A | Store B | Store C | Total |
|---|---:|---:|---:|---:|
| Crop Tops | 15 | 45 | 10 | 70 |

Each cell counts products **sold on that store which belong to another store**, during selected date window. Rankings show dropship units and buyer-side sales. Buttons do **not** refresh periodically; they run on user action.

### Available stock

Owner-store physical SKU + supplier deduplicated. Available stock by owner+type comes from `sb_inventory` **only after an initial complete snapshot**. If missing/incomplete, table displays **Partial snapshot / N/A**, never an invented zero. Inventory is *current as of latest snapshot*; sold units are *selected reporting period*. Dashboard shows snapshot timestamps. No full live catalog scan occurs on report load.

### Initial one-time catalog snapshot (local, avoids Vercel compute)

After installing dependencies, for each enabled store on your own laptop/server:

```bash
STORE_KEY=A npm run sync:catalog
STORE_KEY=B npm run sync:catalog
STORE_KEY=C npm run sync:catalog
STORE_KEY=D npm run sync:catalog
```

Each command resumes previous cursor (and internally reads Shopify product variants in bounded pages); runs **outside Vercel**, so it does not consume Vercel Function Invocations. The initial process reads full required lightweight inventory fields (SKU, supplier, category, brand, price, quantity), not all Shopify product data. Set `SYNC_RESET=true` explicitly only when a full refresh is intended; it may take time for large stores. Successful real-time order-processing updates already-stored stock rows. Changes outside StockBridge (manual Shopify stock edits/restocks) require an occasional snapshot refresh or future product/inventory webhooks.

### Older sales

For permitted history and when desired, run on a local machine:

```bash
STORE_KEY=A npm run backfill:orders
STORE_KEY=B npm run backfill:orders
```

Store C/D likewise. Date range up to 12 months; Admin API older-order access is subject to Shopify permissions. **Backfill may be incomplete** if orders have more than 50 line items, were edited, or product metafield history is no longer available. The database stores lightweight sale rows, excluding internal supplier orders with known tags. Historical internal orders from prior app versions with unknown tags require manual exclusion. The app does not re-create historical cross-store catalog prices.

## 6. Minimize Vercel usage

Screenshot provided: **455K / 1M CDN requests; 427K / 1M Function Invocations; 1h 37m / 4h Fluid Active CPU; 2.32 GB / 10 GB Fast Origin Transfer** over displayed last-30-day window. Actual root cause of many requests requires Vercel route-level analytics/logs. Numbers alone do **not** prove dashboard or Shopify webhooks caused all invocations.

v3.2 deliberately:

- Serves dashboard static from Vercel CDN; **zero API invocations just to download HTML/CSS/JS**.
- Uses **no client timers, setInterval, background dashboard refresh or Sync 200 products buttons**.
- Calls a single database aggregation request when report opens or filters run. Store/settings/diagnostic API calls happen only when relevant tab opens or user clicks action.
- Avoids Shopify Admin API requests for normal reports. Shopify calls happen for signed incoming webhooks, explicit diagnostics, recovery or optional local scripts.
- Uses one lightweight 04:00 UTC daily cron check, approximately 30 Function Invocations/month; immediate processing attempts are tied to actual order webhook events.
- Uses a small Neon connection pool. Never runs schema DDL per request.

**Important:** A publicly reachable `/api/*` route can still be hit by bots and cause Vercel invocations even if Basic Auth rejects those calls. Check **Vercel Observability → Functions → top routes**, enable Deployment Protection where appropriate, configure Vercel Firewall/WAF or trusted-source restrictions. Do not block Shopify webhook deliveries. Rate-limit abusive paths at the edge, not by making extra Express calls. Shopify may also retry failed webhooks; fix 401/HMAC and 5xx errors so retries stop.

## 7. Cancellation and recovery safety

On buyer cancellation, StockBridge attempts canceling linked supplier-side synthetic orders, compares existing physical claims, restores stored inventory location quantities and product status/tags only where safe, marks original sale cancelled, and releases item claims. It can stop for manual review if stock changed elsewhere or restock would oversell. **Test both own-store and cross-store cancellation on development stores**. Never reset inventory to `1` blindly.

## 8. Troubleshooting

| Symptom | Check |
|---|---|
| Store B order not recorded | Store B webhook subscription, exact Shopify domain, signing secret, 401/5xx deliveries, `B:ORDER_ID` job |
| Job `ERROR` | Local job `last_error`, exact SKU+supplier on seller and owner, API permissions, owner inventory, 429/GraphQL userErrors |
| Job `DRY_RUN` | Dashboard `LIVE` mode not enabled; recover after confirming settings |
| Owner stock still ACTIVE | Whether Store B webhook exists, job created, owner SKU match, and supplier order mutation succeeded |
| `pg_type_typname_nsp_index` | Stop old simultaneous schema init, run single migration with advisory lock; don't DROP database |
| Settings store shows missing token | Add `STORE_X_ACCESS_TOKEN` and `STORE_X_WEBHOOK_SECRET` as Vercel secrets and deploy |
| Stock available shows N/A | Local one-time initial snapshot not completed; use `sync:catalog` outside Vercel |
| Old Store B orders missing from report | Inspect webhook history; run explicit authorized backfill locally or recover individual Shopify order |
| Vercel high invocations | Check top routes, bot traffic, webhook delivery failures/retries, route-level protections |

## 9. Scripts & files

```text
public/index.html                 static responsive reporting dashboard
api/index.js                     single Express serverless handler
src/app.js                       HMAC webhooks, auth, diagnostics, recovery, settings
src/config.js                    ENV secrets and owner-identifier normalization
src/stores.js                    PostgreSQL-managed store metadata
src/db.js                        ledger, queues, snapshots, price persistence
src/engine.js                    Shopify multi-store order routing/cancellation
src/shopify.js                   GraphQL operations and webhook tools
src/reports.js                   collaboration + competition SQL summaries
src/report-utils.js              validated date filters
src/analytics.js                 local one-time catalog/backfill utilities
sql/migrate.sql                  one-time schema migration
scripts/migrate.js               transactional/advisory-locked migration runner
scripts/sync-catalog.js          one-time/on-demand local owner inventory import
scripts/backfill-orders.js       manually executed historical sale backfill
vercel.json                      static frontend + API only + daily cron
.env.example                     minimal secrets template
```

## 10. Commands

```bash
npm run db:migrate
npm run check
npm test
npm start
```

**Testing disclosure:** Node.js syntax tests and pure offline assertions can run without Shopify credentials; full `npm install`, existing integration-style unit suite and production Shopify API tests require dependencies and store authorization. No real Shopify order was modified by building this ZIP. Enable `LIVE` only after validating connected stores and testing safely.

## v3.2 validation notes

- Included test suite covers owner/seller resolution, internal-order prevention, owner-first creation order, zero-stock mutation request, discount settings, conflict states, and safe retry classification.
- `npm test` uses mock Shopify responses and injected database behavior. Run it **with installed project dependencies**. Deployment and real Shopify/Neon integration tests were **not** executed as part of package creation.
- `node --check` covers server modules. The embedded static dashboard script can also be checked with a JS parser. `npm install` and actual Vercel build must pass before production promotion.
- `orderCreate` uses offline Shopify Admin API tokens with `write_orders` and product/inventory permissions. Verify scope setup in each store and webhook registrations.
- If a transaction has an ambiguous Shopify `orderCreate` network failure, mark `REVIEW` and verify Shopify order reference before allowing any rerun. This avoids creating two supplier orders for same customer order.
- Emergency recovery needs human confirmation. Do not disable claim checks, forcibly set available stock, or change existing database rows to bypass inventory conflicts.
