# Changelog

## 6.0.0-alpha.1 — Fly.io backend foundation
- Added Fly.io Dockerfile, fly.toml with lhr region, managed PostgreSQL migration, always-on worker and health check.
- Added embedded Shopify App Bridge dashboard using verified Shopify ID tokens, offline token exchange and encrypted storage.
- Added Shopify webhook HMAC ingestion, durable queue, retry leases, latest-order refetch and full-order SKU reconciliation.
- Added Shopify old-format metafield-shard plan reader, a 30-item native bundle part planner and tests for 250/1000-card lists.
- Preserved v5 editor, manual reservation system and existing functions as legacy code, without enabling automatic stock writes.
- Stock mutation, native component bundle generation, checkout validation and live activation are deliberately not yet implemented.
