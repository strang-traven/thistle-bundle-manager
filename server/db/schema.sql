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
  preorder_limit INTEGER CHECK (preorder_limit IS NULL OR preorder_limit > 0),
  components JSONB NOT NULL DEFAULT '[]'::jsonb,
  location_id TEXT,
  reconciled_at TIMESTAMPTZ,
  allocated_at TIMESTAMPTZ,
  ready_for_live_at TIMESTAMPTZ,
  live_at TIMESTAMPTZ,
  paused_reason TEXT,
  synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(shop,parent_variant_id)
);
CREATE INDEX IF NOT EXISTS bundles_shop_sku ON bundles(shop,sku);
ALTER TABLE bundles ADD COLUMN IF NOT EXISTS preorder_limit INTEGER CHECK (preorder_limit IS NULL OR preorder_limit > 0);
ALTER TABLE bundles ADD COLUMN IF NOT EXISTS reconciled_at TIMESTAMPTZ;
ALTER TABLE bundles ADD COLUMN IF NOT EXISTS allocated_at TIMESTAMPTZ;
ALTER TABLE bundles ADD COLUMN IF NOT EXISTS ready_for_live_at TIMESTAMPTZ;
ALTER TABLE bundles ADD COLUMN IF NOT EXISTS live_at TIMESTAMPTZ;
ALTER TABLE bundles ADD COLUMN IF NOT EXISTS paused_reason TEXT;
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
  ledger_uri TEXT,
  step JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX IF NOT EXISTS reservation_ledger_order_variant ON reservation_ledger(bundle_id,order_id,variant_id);
ALTER TABLE reservation_ledger ADD COLUMN IF NOT EXISTS ledger_uri TEXT;
ALTER TABLE reservation_ledger ADD COLUMN IF NOT EXISTS step JSONB;
CREATE TABLE IF NOT EXISTS allocation_batches (
  id BIGSERIAL PRIMARY KEY,
  bundle_id BIGINT NOT NULL REFERENCES bundles(id) ON DELETE CASCADE,
  shop TEXT NOT NULL REFERENCES shops(shop) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'PLANNED' CHECK (status IN ('PLANNED','RESERVING','RESERVED','CONSUMING','DONE','FAILED','REVIEW')),
  location_id TEXT NOT NULL,
  outstanding_sets INTEGER NOT NULL CHECK (outstanding_sets >= 0),
  component_count INTEGER NOT NULL CHECK (component_count > 0),
  plan_snapshot JSONB NOT NULL,
  cursor INTEGER NOT NULL DEFAULT 0 CHECK (cursor >= 0),
  step JSONB,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
ALTER TABLE allocation_batches ADD COLUMN IF NOT EXISTS step JSONB;
CREATE UNIQUE INDEX IF NOT EXISTS allocation_batches_active ON allocation_batches(bundle_id)
  WHERE status IN ('PLANNED','RESERVING','RESERVED','CONSUMING','REVIEW');
CREATE TABLE IF NOT EXISTS packing_manifests (
  bundle_id BIGINT NOT NULL REFERENCES bundles(id) ON DELETE CASCADE,
  order_id TEXT NOT NULL,
  order_name TEXT,
  bundle_quantity INTEGER NOT NULL CHECK (bundle_quantity > 0),
  items JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','PICKED','PACKED','CANCELLED')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(bundle_id,order_id)
);
CREATE TABLE IF NOT EXISTS live_bundle_parts (
  bundle_id BIGINT NOT NULL REFERENCES bundles(id) ON DELETE CASCADE,
  part_number INTEGER NOT NULL CHECK (part_number > 0),
  parent_product_id TEXT,
  parent_variant_id TEXT,
  components JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'PLANNED' CHECK (status IN ('PLANNED','CREATED','ACTIVE','PAUSED','ERROR')),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(bundle_id,part_number)
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
  kind TEXT NOT NULL CHECK (kind IN ('ORDER_SYNC','ORDER_RECONCILE','INVENTORY_INVALIDATE','BUNDLE_ALLOCATE','RESERVATION_SETTLE','LIVE_ACTIVATE','LIVE_SYNC')),
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
ALTER TABLE jobs DROP CONSTRAINT IF EXISTS jobs_kind_check;
ALTER TABLE jobs ADD CONSTRAINT jobs_kind_check CHECK (kind IN ('ORDER_SYNC','ORDER_RECONCILE','INVENTORY_INVALIDATE','BUNDLE_ALLOCATE','RESERVATION_SETTLE','LIVE_ACTIVATE','LIVE_SYNC'));
CREATE INDEX IF NOT EXISTS jobs_pending ON jobs(next_run_at,id) WHERE status IN ('PENDING','PROCESSING');
CREATE TABLE IF NOT EXISTS inventory_dirty (
  shop TEXT NOT NULL REFERENCES shops(shop) ON DELETE CASCADE,
  inventory_item_id TEXT NOT NULL,
  seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY(shop,inventory_item_id)
);
