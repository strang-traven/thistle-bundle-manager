import {normaliseComponents,decodePlanShards} from '../extensions/preorder-manager/src/logic.js';
// Fixed Shopify bundles are capped at 30 distinct component variants.
export const PART_SIZE=30;
export function fixedBundleParts(components,chunk=PART_SIZE){
  if(chunk!==PART_SIZE)throw new Error('Fixed bundle parts must use Shopify limit 30');
  const cleaned=normaliseComponents(components);
  if(!cleaned.length)throw new Error('Add at least one single variant first');
  return Array.from({length:Math.ceil(cleaned.length/chunk)},(_,i)=>({part:i+1,items:cleaned.slice(i*chunk,(i+1)*chunk)}));
}
export function decodeShopifyPlan(config,shards){
  if(config?.schemaVersion===3)return decodePlanShards(config,shards);
  return normaliseComponents(config?.components||[]);
}
export function orderExposure(order,parentVariantId){
  const matches=(order.lineItems?.nodes||[]).filter(x=>x.variant?.id===parentVariantId);
  if(order.lineItems?.pageInfo?.hasNextPage)throw new Error('Order has more than 100 line items; cannot safely import');
  const cancelled=!!order.cancelledAt;
  const bad=['VOIDED','REFUNDED','EXPIRED'].includes(order.displayFinancialStatus);
  return {orderId:order.id,name:order.name,purchased:cancelled||bad?0:matches.reduce((s,x)=>s+Math.max(0,x.currentQuantity||0),0),
    outstanding:cancelled||bad?0:matches.reduce((s,x)=>s+Math.max(0,x.unfulfilledQuantity||0),0),
    cancelled,financialStatus:order.displayFinancialStatus||'UNKNOWN',matched:matches.length>0};
}
