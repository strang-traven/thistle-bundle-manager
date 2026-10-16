export const MAX_COMPONENTS = 150;
export const META_NAMESPACE = 'tt_preorders';
export const META_KEY = 'configuration';
export const LIVE_META_KEY = 'live_components';
export const APP_TAG = 'Thistle Pre-Order Bundle';
export const TRANSFORM_HANDLE = 'thistle-preorder-cart-transform';
const GID = /^gid:\/\/shopify\/ProductVariant\/(\d+)$/;

export function normaliseComponents(items) {
  const merged = new Map();
  for (const item of items || []) {
    const id = String(item.id || '');
    const q = Number(item.quantity);
    if (!GID.test(id)) throw new Error('A component has an invalid Shopify variant ID.');
    if (!Number.isSafeInteger(q) || q < 1 || q > 2000) throw new Error('Quantities must be whole numbers from 1 to 2,000.');
    if (merged.has(id)) {
      const prev = merged.get(id);
      prev.quantity += q;
      if (prev.quantity > 2000) throw new Error('Combined quantity exceeds 2,000.');
    } else merged.set(id, {id, quantity: q, title: String(item.title || id)});
  }
  return [...merged.values()];
}

// Compact encoding: Shopify Functions do not receive metafield values >10,000 bytes.
// Long readable titles belong only in the admin planning field, never the live Function field.
export function encodeLiveComponents(items) {
  const components = normaliseComponents(items);
  if (!components.length) throw new Error('Select at least one card first.');
  if (components.length > MAX_COMPONENTS) throw new Error(`Shopify live checkout bundles support only ${MAX_COMPONENTS} unique components. Your larger card plan remains saved; do not activate it as a single bundle.`);
  const value = JSON.stringify({v: 2, c: components.map(c => [GID.exec(c.id)[1], c.quantity])});
  if (new TextEncoder().encode(value).length >= 9000) throw new Error('Live bundle metadata is too large for Shopify Functions.');
  return value;
}
export function decodeLiveComponents(value) {
  if (!value) return [];
  let parsed;
  try { parsed = typeof value === 'string' ? JSON.parse(value) : value; } catch { throw new Error('Invalid live component metafield.'); }
  if (!parsed || parsed.v !== 2 || !Array.isArray(parsed.c)) throw new Error('Invalid live bundle configuration version.');
  return normaliseComponents(parsed.c.map(([id, quantity]) => ({id: `gid://shopify/ProductVariant/${id}`, quantity})));
}
export function componentProblems(components, parentId) {
  const warnings = [];
  for (const c of components) {
    if (c.id === parentId) warnings.push('A bundle cannot include itself.');
    if (c.missing) warnings.push(`${c.title}: Shopify variant not found.`);
    if (c.requiresComponents) warnings.push(`${c.title}: nested bundles are unsupported.`);
    if (c.inventoryPolicy !== 'DENY') warnings.push(`${c.title}: disable “Continue selling when out of stock”.`);
    if (!c.tracked) warnings.push(`${c.title}: enable Track quantity.`);
  }
  return warnings;
}
export function previewSellable(components) {
  if (!components?.length || components.some(c => !Number.isSafeInteger(c.inventoryQuantity) || c.quantity <= 0)) return null;
  return Math.max(0, Math.min(...components.map(c => Math.floor(c.inventoryQuantity / c.quantity))));
}
export function equalLive(a, b) {
  try {
    const aa=normaliseComponents(a).map(c=>`${c.id}:${c.quantity}`).sort();
    const bb=normaliseComponents(b).map(c=>`${c.id}:${c.quantity}`).sort();
    return aa.join('|')===bb.join('|');
  } catch { return false; }
}
export function productAdminUrl(productId) { return `shopify:admin/products/${String(productId).split('/').pop()}`; }

// V3: the editor itself has no fixed card count. Shopify is still limited to 150
// live checkout components in one expanded bundle. Keep those concerns separate.
export const PLAN_CHUNK_BYTES = 48000; // below Shopify's 128KB JSON write limit
export function makePlanShards(items, bank, releaseDate = '') {
  if (bank !== 'a' && bank !== 'b') throw new Error('Invalid plan storage bank.');
  const clean = normaliseComponents(items);
  const rows = clean.map(c => [GID.exec(c.id)[1], c.quantity, c.title]);
  const chunks = [];
  let current = [];
  const encode = list => JSON.stringify({v:3, c:list});
  for (const row of rows) {
    if (new TextEncoder().encode(encode([row])).length > PLAN_CHUNK_BYTES) throw new Error('A Shopify card title is too large to save in this pre-order plan.');
    if (current.length && new TextEncoder().encode(encode([...current, row])).length > PLAN_CHUNK_BYTES) {
      chunks.push(encode(current));
      current = [];
    }
    current.push(row);
  }
  if (current.length) chunks.push(encode(current));
  const fields = chunks.map((value,i) => ({key:`plan_${bank}_${String(i).padStart(6,'0')}`, type:'json', value}));
  return {
    index: {schemaVersion:3, bank, shardCount:fields.length, componentCount:clean.length, releaseDate},
    fields,
  };
}
export function decodePlanShards(index, fields) {
  if (index?.schemaVersion !== 3 || !['a','b'].includes(index.bank) || !Number.isSafeInteger(index.shardCount) || index.shardCount < 0) throw new Error('Invalid v3 pre-order plan index.');
  const byKey = new Map(fields.map(f=>[f.key, f.value]));
  const unpacked = [];
  for (let i=0; i<index.shardCount; i++) {
    const key = `plan_${index.bank}_${String(i).padStart(6,'0')}`;
    if (!byKey.has(key)) throw new Error('Missing pre-order card page '+(i+1)+'; the plan may not have finished saving.');
    let parsed;
    try { parsed = JSON.parse(byKey.get(key)); } catch { throw new Error('Corrupt pre-order card page '+(i+1)+'.'); }
    if (parsed.v !== 3 || !Array.isArray(parsed.c)) throw new Error('Invalid pre-order card page '+(i+1)+'.');
    unpacked.push(...parsed.c.map(row => ({id:`gid://shopify/ProductVariant/${row[0]}`,quantity:row[1],title:row[2]})));
  }
  if (unpacked.length !== index.componentCount) throw new Error('Saved pre-order card count does not match its index.');
  const cards = normaliseComponents(unpacked);
  if (cards.length !== unpacked.length) throw new Error('Saved pre-order plan contains duplicates.');
  return cards;
}
