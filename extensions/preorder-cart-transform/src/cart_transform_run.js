// This Function is hosted and run by Shopify, not a separate server.
// Input is private, merchant-managed variant metafield data. Never trust cart line properties.
const PREFIX = 'gid://shopify/ProductVariant/';
const MAX_COMPONENTS = 150;

export function cartTransformRun(input) {
  const operations = [];
  const groups = new Map();
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
    const part = line.merchandise?.livePart?.jsonValue;
    if (part) {
      if (part.v !== 1 || !Number.isInteger(part.p) || !Number.isInteger(part.t) || part.p < 1 || part.p > part.t || part.t < 2 || part.t > 100) throw new Error('Invalid Thistle large-bundle part configuration.');
      const group=line.group?.value, cartPart=Number(line.part?.value), cartTotal=Number(line.total?.value);
      if (!group || group.length > 80 || cartPart !== part.p || cartTotal !== part.t || !Number.isInteger(line.quantity) || line.quantity < 1) throw new Error('A large bundle part is missing its protected cart grouping.');
      const key=`${part.g}:${group}`;
      const holder=groups.get(key)||{total:part.t,quantity:line.quantity,parts:new Set()};
      if(holder.total!==part.t||holder.quantity!==line.quantity||holder.parts.has(part.p))throw new Error('Large bundle parts do not match.');
      holder.parts.add(part.p);groups.set(key,holder);
    }
    operations.push({lineExpand: {cartLineId: line.id, expandedCartItems}});
  }
  for(const group of groups.values())if(group.parts.size!==group.total)throw new Error('All parts of this large bundle must be purchased together.');
  return {operations};
}
