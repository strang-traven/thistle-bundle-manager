# Full requested design — beyond v5 preview

This file describes the engineering work required before Thistle Tavern can operate automatically with no external always-on server. It is a design, not functioning checkout code.

## Required behavior

1. Pre-order products are ordinary Shopify products until their component singles exist. Put exact product tag `Pre Order` on preorders. For capped quantities, use a tracked, deny-oversell parent variant before product publication; otherwise preorders can exceed available supply.
2. Later link hundreds of variant IDs with variant quantities, set a physical location (Aberdeen vs Edinburgh), scan all *unfulfilled* parent order line quantities, remove canceled/refunded quantities, and compare reserved allocations in a durable ledger. Orders beyond the normal 60-day access window require approved `read_all_orders`.
3. Reserve the historical parent order's component quantities, with a crash-safe per-variant journal and idempotency keys before any live mode activation. For older orders, do not invent new paid items or silently change amounts. Produce a pick/fulfillment manifest on original orders; order edits are a separate carefully validated workflow, not guaranteed to be possible for all orders or currencies.
4. Once there are stock-linked live sets, the customer should only be able to buy a complete set if every component can be fulfilled; single sales and bundle orders must deduct the **same tracked variant inventory** in Shopify. Existing pre-order reservations stay separated and are not counted as free singles.

## Shopify hard limits and possible live implementation

Native fixed bundles support up to **30 components**; customized Cart Transform bundles up to **150**. Never add one 250-component set to a single native bundle. Shopify bundles are also incompatible with selling plans for preorders. A normal pre-order tagged product is not itself a preorder selling plan.

A promising Shopify-only proof of concept for 250+ live cards is to create multiple hidden, merchant-controlled child bundle parents with at most 150 *different* component variants each; one storefront app block adds all child parents as one offer. Each child parent is expanded by Shopify Cart Transform so the real variants are represented at checkout and deducted by Shopify. A Cart/Checkout Validation Function must reject checkout if *any* child is missing, any component quantity is mismatched, or shoppers tamper with cart lines. Verify theme/Shop Pay/POS behavior and per-group price allocation on a development store first, including concurrency, returns and refund edge cases. Multi-parent cart adds and validation are not implemented in v5. This design must not be marked production-safe before testing.

Alternative is an always-on event-driven backend with inventory webhooks, reservation transactions, and atomic checkout validation. The user previously ruled out an external server, so that is NOT the selected implementation here.

## Safety conditions

- Never set a parent bundle's published quantity from a stale snapshot of card stock. Two checkouts can race between the read and the stock update.
- When reserving older preorders, always write an auditable allocation checkpoint and avoid double decrements in Shopify inventory. Reserved quantities move from `available` to `reserved` without changing `on_hand`, and are consumed at fulfillment. Keep the preorders' parent order line separate from later live checkout component lines.
- If a set contains overlapping components in multiple shards, deduplicate or coordinate them; demand for a card is the sum across all groups.
- A complete set should be fulfilled from one designated physical location unless split fulfillment is explicitly implemented and verified.
- Retest order refunds, cancellations, edits, late stock receipts, direct-to-checkout, variant deletions, other apps' cart transforms, and POS access.

## Developer references

- https://shopify.dev/docs/apps/build/product-merchandising/bundles/add-product-fixed-bundle
- https://shopify.dev/docs/apps/build/product-merchandising/bundles/add-customized-bundle-function
- https://shopify.dev/docs/api/functions/latest/cart-and-checkout-validation
- https://shopify.dev/docs/apps/build/orders-fulfillment/order-management-apps/edit-orders
- https://shopify.dev/docs/api/admin-graphql/latest/mutations/inventoryMoveQuantities
