# Thistle Bundle Manager v6 — Fly.io backend (alpha 1)

This is the **first deployable server release** of Thistle's previous v5 Shopify-native bundle allocator. It adds a real Fly.io Node.js service, Managed Postgres persistence, signed webhook ingestion, retriable order-sync jobs, an authenticated embedded dashboard, and a native fixed-bundle 30-item **planning** preview. It **does not** yet create or activate linked native bundle parts or automatically reserve/unreserve component cards for legacy pre-orders.

## What is working in this source

- Shopify embedded Admin app home (served by Fly), using Shopify App Bridge ID tokens with signature/issuer/audience/expiry validation and Shopify offline token exchange.
- Encrypted offline Shopify API token in Postgres using AES-256-GCM (required `ENCRYPTION_KEY` secret).
- Shopify signed webhooks: orders/create, orders/updated, orders/cancelled, orders/paid, refunds/create, fulfillments/create, inventory_levels/update and app/uninstalled.
- Unique webhook IDs, transactional durable jobs with retry, PostgreSQL leases for competing workers, 8-attempt dead-letter failures, heartbeat job history. Workers use durable Postgres, not memory-only timers.
- Old card-set plans persisted in `tt_preorders.configuration` and `tt_preorders.plan_*` remain compatible. Backend reads and imports them without writing product or inventory stock.
- User-initiated pre-order reconciliation by exact variant ID using unique Shopify SKU search, with per-order unfulfilled quantities. Never treat a 60-day-only API search as proof of full historical entitlement.
- 30-variant native bundle part planner: a 250-card set is shown as 9 planned parts and a 1,000-card set as 34. This planner does not create real parts yet.
- Preserves v5's Shopify-hosted editor, safe stock previews, legacy reservation actions, and old 150-line cart transform source.

**Do not enable two competing stock engines on the same parent.** V5's reservation mode and a future live Shopify component-bundle mode must be mutually exclusive. We have not wired live conversion, checkout validation, or reservation migration yet. This alpha deliberately performs no stock mutations.

## Fly.io deployment from Windows PowerShell

### Requirements

- A Fly.io account with billing configured, `flyctl` installed (`winget install Fly-io.flyctl`) and signed in (`fly auth login`).
- A Shopify Dev Dashboard app, preferably the existing **Thistle Pre-Order Bundles** app linked by Shopify CLI. Do **not** link your separate checkout protection app.
- Node.js 22 and Shopify CLI. Get the Shopify app's client ID and secret from the Dev Dashboard. Do not paste the secret into chats.
- Shopify store's **myshopify.com** domain (not custom storefront domain).

### Step 1 — prepare the Fly app

Edit `fly.toml` and replace `thistle-bundle-manager-your-unique-name` with a globally unique lowercase app name (e.g. `thistle-bundles-unique`).

```powershell
fly auth login
fly apps create thistle-bundles-unique
```

If the CLI says the app already exists, don't recreate it. Use that exact name in `fly.toml`.

### Step 2 — create Managed Postgres and attach

```powershell
fly mpg create
fly mpg list
fly mpg attach YOUR_CLUSTER_ID -a thistle-bundles-unique
```

Choose a Postgres region matching the `primary_region = "lhr"` in `fly.toml` where possible. Fly's Managed Postgres attach sets `DATABASE_URL` as a secret automatically. Managed Postgres is chargeable.

### Step 3 — set secrets

Generate a fresh AES encryption key locally (PowerShell):

```powershell
node -e "console.log(require('node:crypto').randomBytes(32).toString('base64'))"
```

Then run this command with **your real values** (do not commit them or share a screenshot containing secrets):

```powershell
fly secrets set SHOPIFY_API_KEY="YOUR_APP_CLIENT_ID" SHOPIFY_API_SECRET="YOUR_APP_CLIENT_SECRET" SHOPIFY_SHOP_DOMAIN="YOUR_STORE.myshopify.com" ENCRYPTION_KEY="YOUR_BASE64_KEY" -a thistle-bundles-unique
```

Do not overwrite the `DATABASE_URL` managed by Fly Postgres.

### Step 4 — deploy Fly application and migrate DB

```powershell
fly deploy -a thistle-bundles-unique
fly status -a thistle-bundles-unique
fly logs -a thistle-bundles-unique
```

`[deploy].release_command` automatically runs `node server/migrate.js`. A successful `https://thistle-bundles-unique.fly.dev/healthz` responds `{"ok":true}`. One warm worker is deliberately configured; don't scale to zero or jobs won't be processed while idle.

### Step 5 — connect your Shopify app and deploy its configuration

Edit `shopify.app.toml`: set `client_id` to this existing bundle app's client ID, and replace `https://REPLACE-WITH-YOUR-FLY-APP.fly.dev` with your actual Fly app URL in **both** places. In the directory containing this project:

```powershell
npm install
npm test
npx shopify app config link
npx shopify app deploy
```

In Shopify Admin, open the existing bundles app. Its embedded Fly dashboard uses Shopify App Bridge. Click **Connect Shopify offline access**. This is necessary for background webhook sync to make authenticated GraphQL calls. If permissions change on deployment, approve the new app scopes.

### Step 6 — import and reconcile your first set

1. In the existing **Pre-Order Bundle Manager** app home extension, open the parent product and save its singles card list (no need to activate stock reservation).
2. Copy the Shopify parent **variant GID** (example: `gid://shopify/ProductVariant/123456789`). Ensure the parent variant has a unique, stable SKU.
3. In the new Fly dashboard, paste that variant ID and click **Sync bundle to Fly.io**. This creates a `PREORDER` database record only.
4. Click **Reconcile orders**. It queues an order history scan. View job statuses (`DONE`, `PENDING`, or `FAILED`) and the outstanding quantity. `read_orders` may only access the last 60 days. For longer-lived pre-orders, approved `read_all_orders` or an audited historical import is essential before stock allocation.
5. Click **See bundle parts** to preview the split into 30-component Shopify native bundle parts. These parts are *not yet published*.

### Shop currency, location and stock safety

Aberdeen and Edinburgh inventory must **never** be combined into a phantom same-location complete set. A later release will enforce one-location allocation and reservations. The app does not infer SKU-to-card data, substitute finish variants, adjust stock based on stale webhook snapshots, edit historical orders, or double deduct an inventory item.

## Security and production checklist

- Keep `SHOPIFY_API_SECRET`, `ENCRYPTION_KEY`, and `DATABASE_URL` in Fly secrets. Never put them in theme Liquid, the GitHub repo or frontend code.
- Don't rotate `ENCRYPTION_KEY` without re-encrypting stored Shopify tokens; otherwise reconnect Shopify from the embedded app.
- Shopify webhooks are HMAC-verified from their **raw body** before data enters Postgres. Webhook events are persisted before an HTTP 200 is returned.
- Shopify webhooks can arrive out of order or be missed; jobs always refetch the latest order snapshot and support a manual reconciliation scan.
- Only sync/read-only planning is available in the v6 backend. `/api/admin/...` requires a Shopify App Bridge ID token. No public endpoint can write inventory.
- The legacy v5 in-admin manual inventory reservation panel remains in the inherited extension source; use only after a separate inventory audit, and do not combine it with live component bundles.
- Shopify's existing Cart Transform remains in the source for old plans; do not enable it on products reserved through v5's `reserved` inventory mode.
- Apply Fly Managed Postgres automated backups, verify retention policies, use a private Shopify development store to test app installation and webhooks, and review all Shopify order privacy/data requirements.
- Without approved `read_all_orders`, historic orders older than 60 days may be missing. The server intentionally **never auto-reserves stock** based on incomplete history.

## What's left before fully automatic live selling

1. Native fixed-bundle-part creation, update and cleanup with a per-part state ledger; max 30 linked variants each.
2. One storefront Add to Cart action that adds **all** parts, a server-independent Shopify Checkout Validation Function that blocks missing/uneven parts and cross-session cart tampering, and real Shop Pay tests.
3. Historical preorder allocation/reservation and cancellation/refund release using Shopify available/reserved inventory operations with durable idempotent journals and location locking.
4. Price splitting across parts, product publication, fulfillment and refund workflow, operator sign-off switch from PREORDER to LIVE.
5. Race/concurrency and multi-location integration testing. On failure the system must remain paused, not oversell.

**Current status: code and unit tests verified locally; npm registry unreachable in this environment, so dependency installation, Docker build, Shopify CLI compilation, live Fly deployment and live checkout tests have NOT been performed.** The source is a functional first server slice, not a claim that automated 250-card checkout already works.
