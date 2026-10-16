CREATE TABLE IF NOT EXISTS shops (
  shop TEXT PRIMARY KEY,
  access_token_cipher TEXT,
  installed_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS bundles (
  id BIGSERIAL PRIMARY KEY,
  shop TEXT NOT NULL REFERENCES shops(shop) ON DELETE CASCADE,
  parent_variant_id TEXT NOT NULL,
  parent_product_id TEXT NOT NULL,
  sku TEXT NOT NULL,
  title TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'PREORDER' CHECK (mode IN ('PREORDER','ALLOCATING','READY_FOR_LIVE','LIVE','PAUSED')),
  release_date TEXT,
  components JSONB NOT NULL DEFAULT '[]'::jsonb,
  location_id TEXT,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(shop,parent_variant_id)
);
CREATE INDEX IF NOT EXISTS bundles_shop_sku ON bundles(shop,sku);
CREATE TABLE IF NOT EXISTS preorder_orders (
  shop TEXT NOT NULL REFERENCES shops(shop) ON DELETE CASCADE,
  bundle_id BIGINT NOT NULL REFERENCES bundles(id) ON DELETE CASCADE,
  order_id TEXT NOT NULL,
  order_name TEXT,
  purchased INTEGER NOT NULL DEFAULT 0 CHECK (purchased >= 0),
  outstanding INTEGER NOT NULL DEFAULT 0 CHECK (outstanding >= 0),
  cancelled BOOLEAN NOT NULL DEFAULT FALSE,
  financial_status TEXT,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (shop,bundle_id,order_id)
);
CREATE TABLE IF NOT EXISTS reservation_ledger (
  id BIGSERIAL PRIMARY KEY,
  bundle_id BIGINT NOT NULL REFERENCES bundles(id) ON DELETE CASCADE,
  order_id TEXT NOT NULL,
  variant_id TEXT NOT NULL,
  location_id TEXT NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  status TEXT NOT NULL DEFAULT 'PLANNED' CHECK (status IN ('PLANNED','RESERVED','CONSUMED','RELEASED','ERROR')),
  operation_key TEXT UNIQUE NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE TABLE IF NOT EXISTS webhook_events (
  id BIGSERIAL PRIMARY KEY,
  shop TEXT NOT NULL,
  webhook_id TEXT NOT NULL,
  topic TEXT NOT NULL,
  payload JSONB NOT NULL,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (shop,webhook_id)
);
CREATE TABLE IF NOT EXISTS jobs (
  id BIGSERIAL PRIMARY KEY,
  shop TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('ORDER_SYNC','ORDER_RECONCILE','INVENTORY_INVALIDATE')),
  payload JSONB NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key TEXT UNIQUE,
  status TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','PROCESSING','DONE','FAILED')),
  attempts INT NOT NULL DEFAULT 0,
  next_run_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  leased_until TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS jobs_pending ON jobs(next_run_at,id) WHERE status IN ('PENDING','PROCESSING');
CREATE TABLE IF NOT EXISTS inventory_dirty (
  shop TEXT NOT NULL REFERENCES shops(shop) ON DELETE CASCADE,
  inventory_item_id TEXT NOT NULL,
  seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(shop,inventory_item_id)
);
