// This Function is hosted and run by Shopify, not a separate server.
// Input is private, merchant-managed variant metafield data. Never trust cart line properties.
const PREFIX = 'gid://shopify/ProductVariant/';
const MAX_COMPONENTS = 150;

export function cartTransformRun(input) {
  const operations = [];
  for (const line of input.cart?.lines || []) {
    if (line.merchandise?.__typename !== 'ProductVariant') continue;
    if (line.merchandise?.liveEnabled?.value !== 'true') continue;
    const config = line.merchandise?.liveConfig?.jsonValue;
    // Shopify can omit metafields exceeding its Function input limit. Fail closed.
    if (!config || config.v !== 2 || !Array.isArray(config.c) || !config.c.length || config.c.length > MAX_COMPONENTS) {
      throw new Error('Active Thistle pre-order bundle configuration is missing or invalid.');
    }
    const seen = new Set();
    const expandedCartItems = [];
    let valid = true;
    for (const pair of config.c) {
      if (!Array.isArray(pair) || pair.length !== 2) {valid = false; break;}
      const [numericId, qty] = pair;
      const id = String(numericId);
      if (!/^\d+$/.test(id) || !Number.isInteger(qty) || qty < 1 || qty > 2000 || seen.has(id)) {valid = false; break;}
      if (PREFIX + id === line.merchandise.id) {valid = false; break;}
      seen.add(id);
      expandedCartItems.push({merchandiseId: PREFIX + id, quantity: qty});
    }
    if (!valid) throw new Error('Invalid Thistle pre-order bundle components.');
    operations.push({lineExpand: {cartLineId: line.id, expandedCartItems}});
  }
  return {operations};
}
