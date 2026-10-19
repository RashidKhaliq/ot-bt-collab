-- StockBridge v3.1 one-time SQL migration. Run with npm run db:migrate.
-- Transaction + advisory lock in scripts/migrate.js. Never per-request.
CREATE TABLE IF NOT EXISTS ts_jobs (
    job_key TEXT PRIMARY KEY, selling_key TEXT NOT NULL, order_id TEXT NOT NULL,
    order_name TEXT NOT NULL, payload JSONB NOT NULL,
    state TEXT NOT NULL DEFAULT 'PENDING', attempts INT NOT NULL DEFAULT 0,
    locked_at TIMESTAMPTZ, last_error TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS ts_jobs_pending ON ts_jobs (state, updated_at);
CREATE TABLE IF NOT EXISTS ts_claims (
    item_key TEXT PRIMARY KEY, job_key TEXT NOT NULL,
    claimed_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS ts_supplier_orders (
    job_key TEXT NOT NULL, owner_key TEXT NOT NULL,
    owner_order_gid TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (job_key, owner_key));
CREATE TABLE IF NOT EXISTS ts_logs (
    id BIGSERIAL PRIMARY KEY, job_key TEXT, level TEXT NOT NULL,
    message TEXT NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE INDEX IF NOT EXISTS ts_logs_recent ON ts_logs (created_at DESC);
CREATE TABLE IF NOT EXISTS sb_snapshots (
    job_key TEXT NOT NULL, item_key TEXT NOT NULL, store_key TEXT NOT NULL,
    snapshot JSONB NOT NULL, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY(job_key,item_key,store_key));
CREATE TABLE IF NOT EXISTS sb_cancellations (
    job_key TEXT PRIMARY KEY, state TEXT NOT NULL DEFAULT 'PENDING',
    attempts INT NOT NULL DEFAULT 0, locked_at TIMESTAMPTZ,
    last_error TEXT, created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS sb_settings (
    key TEXT PRIMARY KEY, value JSONB NOT NULL, updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS sb_sales (
    store_key TEXT NOT NULL, order_id TEXT NOT NULL, line_id TEXT NOT NULL,
    order_date TIMESTAMPTZ NOT NULL, sku TEXT NOT NULL DEFAULT '',
    supplier TEXT, owner_key TEXT, brand TEXT, product_type TEXT,
    quantity INT NOT NULL DEFAULT 0, gross_value NUMERIC(18,2) NOT NULL DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'PKR', cancelled BOOLEAN NOT NULL DEFAULT false,
    is_internal BOOLEAN NOT NULL DEFAULT false,
    PRIMARY KEY(store_key,order_id,line_id));
CREATE INDEX IF NOT EXISTS sb_sales_date ON sb_sales (order_date,store_key,owner_key);
CREATE TABLE IF NOT EXISTS sb_inventory (
    store_key TEXT NOT NULL, variant_id TEXT NOT NULL,
    sku TEXT NOT NULL DEFAULT '', supplier TEXT, owner_key TEXT, brand TEXT,
    product_type TEXT, quantity INT NOT NULL DEFAULT 0,
    price NUMERIC(18,2) NOT NULL DEFAULT 0, currency TEXT NOT NULL DEFAULT 'PKR',
    status TEXT NOT NULL DEFAULT 'ACTIVE', synced_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY(store_key,variant_id));
CREATE INDEX IF NOT EXISTS sb_inventory_identity ON sb_inventory (supplier,sku,owner_key);
CREATE TABLE IF NOT EXISTS sb_sync (
    store_key TEXT PRIMARY KEY, cursor TEXT, synced_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS sb_report_cache (
    cache_key TEXT PRIMARY KEY, result JSONB NOT NULL,
    fetched_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS sb_stores (
 store_key TEXT PRIMARY KEY,
 display_name TEXT NOT NULL,
 domain TEXT NOT NULL UNIQUE,
 supplier TEXT NOT NULL,
 owner_email TEXT DEFAULT '', owner_phone TEXT DEFAULT '',
 owner_address JSONB NOT NULL DEFAULT '{}'::jsonb,
 enabled BOOLEAN NOT NULL DEFAULT TRUE,
 created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS sb_sale_prices (
 store_key TEXT NOT NULL, order_id TEXT NOT NULL, line_id TEXT NOT NULL,
 price_store_key TEXT NOT NULL, unit_price NUMERIC(18,2) NOT NULL,
 currency TEXT NOT NULL DEFAULT 'PKR',
 PRIMARY KEY(store_key,order_id,line_id,price_store_key)
);
CREATE INDEX IF NOT EXISTS sb_sale_prices_lookup ON sb_sale_prices (store_key,order_id,line_id);
CREATE TABLE IF NOT EXISTS sb_webhook_events (
 event_id TEXT PRIMARY KEY, store_key TEXT NOT NULL,
 topic TEXT NOT NULL, order_id TEXT NOT NULL,
 received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS sb_webhook_events_recent ON sb_webhook_events(store_key,received_at DESC);
CREATE TABLE IF NOT EXISTS sb_order_checks (
 store_key TEXT NOT NULL, order_id TEXT NOT NULL,
 last_seen TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 PRIMARY KEY(store_key,order_id)
);
