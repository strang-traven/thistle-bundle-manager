// Shopify-only, READ-ONLY helpers. Never use a stock snapshot to publish parent stock.
import {normaliseComponents} from './logic.js';

export function stockCapacityByLocation(cards, variantRows, locations = []) {
  const required = normaliseComponents(cards);
  const byId = new Map((variantRows || []).filter(Boolean).map(v => [v.id, v]));
  const locs = new Map((locations || []).map(l => [l.id, {id:l.id,name:l.name || l.id}]));
  for (const v of variantRows || []) for (const l of v?.inventoryItem?.inventoryLevels?.nodes || [])
    if (l?.location?.id) locs.set(l.location.id,{id:l.location.id,name:l.location.name || l.location.id});
  return [...locs.values()].map(location => {
    const bottlenecks = [];
    let count = Infinity;
    for (const item of required) {
      const v=byId.get(item.id);
      const level=v?.inventoryItem?.inventoryLevels?.nodes?.find(n=>n.location?.id===location.id);
      const amount=level?.quantities?.find(q=>q.name==='available')?.quantity;
      const ok = v && v.inventoryItem?.tracked === true && v.inventoryPolicy === 'DENY' &&
        v.requiresComponents !== true && level && Number.isSafeInteger(amount) && amount>=0;
      const possible = ok ? Math.floor(amount / item.quantity) : 0;
      count=Math.min(count,possible);
      if (!ok || possible <= 2) bottlenecks.push({id:item.id,title:item.title,quantity:item.quantity,available:ok?amount:null,possible});
    }
    if (!required.length)count=0;
    return {locationId:location.id,locationName:location.name,possible:Number.isFinite(count)?count:0,
      bottlenecks:bottlenecks.sort((a,b)=>a.possible-b.possible),components:required.length};
  }).sort((a,b)=>b.possible-a.possible);
}

export function preorderOrderTally(orders, variantId) {
  let purchased=0,unfulfilled=0,ordersMatched=0,excludedCanceled=0,unpaid=0;
  for(const o of orders || []) {
    const matching=(o.lineItems?.nodes||[]).filter(l=>l.variant?.id===variantId);
    if(!matching.length)continue;
    if(o.cancelledAt){excludedCanceled++;continue;}
    const bought=matching.reduce((s,l)=>s+Math.max(0,l.currentQuantity || 0),0);
    const pending=matching.reduce((s,l)=>s+Math.max(0,l.unfulfilledQuantity || 0),0);
    if(!bought)continue;
    if(['VOIDED','REFUNDED','EXPIRED'].includes(o.displayFinancialStatus)){unpaid++;continue;}
    purchased+=bought;unfulfilled+=pending;ordersMatched++;
  }
  return {purchased,unfulfilled,ordersMatched,excludedCanceled,unpaid};
}

export function safeSkuSearch(sku) {
  const value=String(sku||'').trim();
  if(!value || value.length>100 || /[\n\r"\\]/.test(value))throw new Error('Set a simple, unique SKU on the bundle parent variant in Shopify before auditing its orders.');
  return `sku:"${value}" status:any`;
}
