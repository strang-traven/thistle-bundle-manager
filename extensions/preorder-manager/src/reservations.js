// Shopify-hosted reservation engine. No backend, timers, or local-storage ledger.
// Each side effect has a persisted step with a stable Shopify @idempotent key.
// DO NOT bypass a stopped/ambiguous step: Shopify only retains keys for 24 h.
import {normaliseComponents, META_NAMESPACE} from './logic.js';

const VERSION = '2026-07';
const JOB_KEY = 'allocation_job';
const URI_ROOT = 'gid://thistle-tavern/BundleAllocation/';
const ACTIVE = 'active';
const PENDING = new Set(['reserving','publishing','consuming']);

const PARENT = `query AllocationParent($id:ID!){productVariant(id:$id){
  id inventoryPolicy inventoryQuantity requiresComponents
  product{id title status}
  inventoryItem{id tracked inventoryLevels(first:50){nodes{location{id name} quantities(names:["available","on_hand","committed","reserved"]){name quantity}} pageInfo{hasNextPage}}}
  plan:metafield(namespace:"tt_preorders",key:"configuration"){value compareDigest}
  job:metafield(namespace:"tt_preorders",key:"allocation_job"){value compareDigest}
  oldLive:metafield(namespace:"tt_preorders",key:"live_enabled"){value}
}}`;
const COMPONENTS = `query AllocationComponents($ids:[ID!]!){nodes(ids:$ids){... on ProductVariant{
  id displayName inventoryPolicy requiresComponents
  inventoryItem{id tracked inventoryLevels(first:50){nodes{location{id name} quantities(names:["available","reserved"]){name quantity}} pageInfo{hasNextPage}}}
}}}`;
const SAVE = `mutation SaveAllocation($metafields:[MetafieldsSetInput!]!){metafieldsSet(metafields:$metafields){metafields{key compareDigest value}userErrors{field message}}}`;
const MOVE = `mutation AllocateMove($input:InventoryMoveQuantitiesInput!,$key:String!){inventoryMoveQuantities(input:$input) @idempotent(key:$key){inventoryAdjustmentGroup{createdAt}userErrors{field message code}}}`;
const ADJUST = `mutation AllocateAdjust($input:InventoryAdjustQuantitiesInput!,$key:String!){inventoryAdjustQuantities(input:$input) @idempotent(key:$key){inventoryAdjustmentGroup{createdAt}userErrors{field message code}}}`;

export const RESERVATION_QUERY_DOCUMENTS = {PARENT,COMPONENTS,SAVE,MOVE,ADJUST};

function asError(v){return (v?.userErrors||[]).map(e=>e.message).filter(Boolean).join('; ');}
function must(result, name){if (!result || asError(result)) throw new Error(asError(result)||`${name} failed`);return result;}
function randomKey(){
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  // No financial or authentication use; Shopify idempotency keys should be unique.
  return `tt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
}
function quantity(node,name){return node?.quantities?.find(q=>q.name===name)?.quantity??null;}
function locationLevel(item,locationId){return item?.inventoryLevels?.nodes?.find(l=>l.location.id===locationId)||null;}
function elapsedHours(iso){return (Date.now()-new Date(iso).valueOf())/3600000;}
export function assertRetrySafe(step){
  if (step && !(elapsedHours(step.issuedAt)<23)) throw new Error(
    'This operation has been pending for about 23 hours or longer. Shopify idempotency keys expire after 24 hours. Do NOT retry automatically: review inventory history and reconcile the allocation with staff first.');
}
export function summarizeAllocation(job){
  if(!job)return {status:'Not allocated',allocated:0,consumed:0,progress:0};
  return {status:job.status,allocated:job.totalAllocated||0,consumed:job.totalConsumed||0,progress:job.cursor||0,qty:job.count||0};
}
export function normalizePlan(cards){
  const list=normaliseComponents(cards);
  if(!list.length) throw new Error('Add and save the card list before reserving stock.');
  return list;
}
export function checkStock(card,locationId,sets,parentId){
  if(!card || card.id===parentId || card.requiresComponents) throw new Error('Invalid or nested component in this card list.');
  if(!card.inventoryItem?.tracked || card.inventoryPolicy!=='DENY') throw new Error(`${card.displayName}: enable Shopify stock tracking and disable overselling.`);
  if(card.inventoryItem.inventoryLevels.pageInfo.hasNextPage) throw new Error(`${card.displayName}: too many inventory locations to verify safely.`);
  const level=locationLevel(card.inventoryItem,locationId);
  const available=quantity(level,'available');
  if(!Number.isSafeInteger(available) || available < sets) throw new Error(`${card.displayName}: only ${available??0} available at the selected location; requires ${sets}.`);
  return {itemId:card.inventoryItem.id,available};
}
export function makeMove(card,locationId,quantityNeeded,from,to,ledger,before){
  return {reason:'correction',referenceDocumentUri:URI_ROOT+ledger.split('_')[0],changes:[{
    inventoryItemId:card.inventoryItem.id,quantity:quantityNeeded,
    from:{locationId,name:from,changeFromQuantity:before,ledgerDocumentUri:from==='reserved'?`${URI_ROOT}${ledger}`:null},
    to:{locationId,name:to,ledgerDocumentUri:to==='reserved'?`${URI_ROOT}${ledger}`:null},
  }]};
}
export function makeAdjust(itemId,locationId,delta,name,before,ref){
  return {name,reason:'correction',referenceDocumentUri:URI_ROOT+ref,
    changes:[{inventoryItemId:itemId,locationId,delta,changeFromQuantity:before,
      ...(name==='reserved'?{ledgerDocumentUri:URI_ROOT+ref}: {})}]};
}
export function availableIn(node,locationId){return quantity(locationLevel(node.inventoryItem,locationId),'available');}
export function onHandIn(node,locationId){return quantity(locationLevel(node.inventoryItem,locationId),'on_hand');}

// `api` accepts a GraphQL string and variables. The adapter is mockable.
export function createReservationService(api){
  async function query(doc,variables={}){
    const response=await api(doc,variables,VERSION);
    if(response.errors?.length) throw new Error(response.errors.map(x=>x.message).join('; '));
    if(!response.data) throw new Error('Shopify did not return GraphQL data. Check permissions.');
    return response.data;
  }
  async function readParent(id){
    const v=(await query(PARENT,{id})).productVariant;
    if(!v) throw new Error('Bundle variant was deleted from Shopify.');
    let allocation=null;
    if(v.job?.value){try{allocation=JSON.parse(v.job.value);}catch{throw new Error('Corrupt allocation journal: stop and reconcile manually.');}}
    if(allocation && allocation.v!==4) throw new Error('Unknown reservation version. Stop and reconcile manually.');
    return {variant:v,job:allocation,digest:v.job?.compareDigest??null,planDigest:v.plan?.compareDigest??null};
  }
  async function cardAt(id){const found=(await query(COMPONENTS,{ids:[id]})).nodes?.[0];if(!found)throw new Error('Card variant was removed from Shopify: '+id);return found;}
  async function save(id,job,digest){
    const field={ownerId:id,namespace:META_NAMESPACE,key:JOB_KEY,type:'json',value:JSON.stringify(job),compareDigest:digest};
    const result=must((await query(SAVE,{metafields:[field]})).metafieldsSet,'Allocation journal save');
    return {job,digest:result.metafields?.[0]?.compareDigest};
  }
  async function verifyCards(cards,locationId,sets,parentId,onProgress=()=>{}){
    for(let i=0;i<cards.length;i+=20){
      const batch=cards.slice(i,i+20);
      const raw=(await query(COMPONENTS,{ids:batch.map(c=>c.id)})).nodes;
      const byId=new Map((raw||[]).filter(Boolean).map(v=>[v.id,v]));
      for(const c of batch){
        const found=byId.get(c.id);
        if(!found)throw new Error(`Missing card ${c.title||c.id} from Shopify.`);
        checkStock(found,locationId,sets*c.quantity,parentId);
      }
      onProgress(`Checking card stock ${Math.min(i+20,cards.length)} / ${cards.length}…`);
    }
  }
  async function begin({variantId,cards,planDigest,locationId,sets,onProgress=()=>{}}){
    const list=normalizePlan(cards);
    if(!Number.isSafeInteger(sets)||sets<1||sets>10000)throw new Error('Please reserve between 1 and 10,000 complete sets in one batch.');
    const state=await readParent(variantId),v=state.variant;
    if(!planDigest||state.planDigest!==planDigest)throw new Error('The saved card list changed. Reload the product and review before reserving.');
    if(v.requiresComponents||v.oldLive?.value==='true') throw new Error('Legacy Shopify bundle mode is active. Disable or migrate it before reserving stock; do not double deduct.');
    if(!v.inventoryItem.tracked||v.inventoryPolicy!=='DENY')throw new Error('Bundle product must track inventory with Continue selling when out of stock OFF.');
    if(v.inventoryItem.inventoryLevels.pageInfo.hasNextPage)throw new Error('Too many parent inventory locations to verify.');
    const parentLevel=locationLevel(v.inventoryItem,locationId);
    if(!parentLevel)throw new Error('Enable the parent pre-order product at this Shopify inventory location first.');
    const previous=state.job;
    if(previous && previous.status!==ACTIVE) throw new Error('A reservation or dispatch is unfinished. Resume it before creating another batch.');
    if(previous && (previous.locationId!==locationId||previous.planDigest!==planDigest))throw new Error('You cannot change the location or card list after stock has been allocated.');
    if(previous && onHandIn(v,locationId)!==(previous.totalAllocated-previous.totalConsumed))throw new Error('Parent inventory does not match previously allocated minus consumed sets. Reconcile fulfilled orders and any manual changes before adding more stock.');
    if(!previous){
      const totalOnHand=v.inventoryItem.inventoryLevels.nodes.reduce((s,l)=>s+Math.max(0,quantity(l,'on_hand')||0),0);
      if(totalOnHand!==0 || Number(v.inventoryQuantity)!==0)throw new Error('The parent already has stock or open pre-orders. Reconcile those orders and set parent stock to 0 before first allocation.');
    }
    await verifyCards(list,locationId,sets,variantId,onProgress);
    const job={v:4,status:'reserving',batchId:randomKey(),locationId,locationName:parentLevel.location.name,
      planDigest,count:sets,cursor:0,step:null,totalAllocated:previous?.totalAllocated||0,totalConsumed:previous?.totalConsumed||0,
      history:previous?.history||[],startedAt:new Date().toISOString()};
    return save(variantId,job,state.digest);
  }
  async function beginConsume({variantId,planDigest,count}){
    if(!Number.isSafeInteger(count)||count<1||count>10000) throw new Error('Enter a valid number of fulfilled sets (1–10,000).');
    const state=await readParent(variantId),prev=state.job;
    if(!prev||prev.status!==ACTIVE)throw new Error('Complete stock allocation before dispatching cards.');
    if(state.planDigest!==planDigest||prev.planDigest!==planDigest)throw new Error('Card plan changed unexpectedly. Stop and reconcile.');
    const currentOnHand=onHandIn(state.variant,prev.locationId);
    if(currentOnHand==null)throw new Error('Parent stock is not available at the allocation location.');
    const fulfilled=prev.totalAllocated-currentOnHand;
    const unconsumed=fulfilled-prev.totalConsumed;
    if(count>unconsumed)throw new Error(`Only ${Math.max(0,unconsumed)} parent sets appear fulfilled in Shopify and not yet consumed. Fulfil orders in Shopify first.`);
    return save(variantId,{...prev,status:'consuming',batchId:randomKey(),count,cursor:0,step:null,startedAt:new Date().toISOString()},state.digest);
  }
  async function resume({variantId,cards,onProgress=()=>{}}){
    const list=normalizePlan(cards);
    let holder=await readParent(variantId);
    let {job,digest}=holder;
    if(!job||!PENDING.has(job.status))throw new Error('No unfinished reservation or dispatch to resume.');
    if(holder.planDigest!==job.planDigest)throw new Error('Saved card plan changed during an allocation. Do not continue; manually reconcile.');
    while(job.cursor<list.length && job.status!=='publishing'){
      const i=job.cursor, card=await cardAt(list[i].id),need=list[i].quantity*job.count;
      if(!card.inventoryItem.tracked)throw new Error(`Inventory tracking disabled on ${card.displayName}`);
      const mode=job.status,from=mode==='reserving'?'available':'reserved';
      if(!job.step){
        const level=locationLevel(card.inventoryItem,job.locationId);
        const baseline=quantity(level,from);
        if(baseline==null||baseline<need)throw new Error(`${card.displayName}: only ${baseline??0} ${from} at ${job.locationName}, need ${need}. Resolve and Resume. No parent stock was added for this batch.`);
        ({job,digest}=await save(variantId,{...job,step:{index:i,inventoryItemId:card.inventoryItem.id,
          availableBefore:baseline,key:randomKey(),issuedAt:new Date().toISOString()}},digest));
      }
      const s=job.step;
      if(s.index!==i||s.inventoryItemId!==card.inventoryItem.id)throw new Error('Allocation checkpoint mismatch. Manual reconciliation required.');
      assertRetrySafe(s);
      if(mode==='reserving'){
        const input=makeMove(card,job.locationId,need,'available','reserved',`${job.batchId}_${i}`,s.availableBefore);
        must((await query(MOVE,{input,key:s.key})).inventoryMoveQuantities,'Stock reservation');
      }else{
        const input=makeAdjust(card.inventoryItem.id,job.locationId,-need,'reserved',s.availableBefore,`${job.batchId}_${i}`);
        must((await query(ADJUST,{input,key:s.key})).inventoryAdjustQuantities,'Reserved-stock consumption');
      }
      ({job,digest}=await save(variantId,{...job,cursor:i+1,step:null},digest));
      onProgress(`${mode==='reserving'?'Reserved':'Consumed'} ${job.cursor} / ${list.length} card variants`);
    }
    if(job.status==='consuming'){
      ({job,digest}=await save(variantId,{...job,status:ACTIVE,totalConsumed:job.totalConsumed+job.count,
        count:0,cursor:0,step:null},digest));
      return job;
    }
    if(job.status==='reserving')({job,digest}=await save(variantId,{...job,status:'publishing',step:null},digest));
    // Publishing the parent LAST guarantees a half-reserved batch cannot sell.
    if(!job.step){
      const updated=await readParent(variantId);
      if(updated.digest!==digest) throw new Error('A second operator changed this allocation. Refresh before continuing.');
      const baseline=availableIn(updated.variant,job.locationId);
      if(baseline==null)throw new Error('Parent inventory location is missing.');
      ({job,digest}=await save(variantId,{...job,step:{index:-1,availableBefore:baseline,
        inventoryItemId:updated.variant.inventoryItem.id,key:randomKey(),issuedAt:new Date().toISOString()}},digest));
    }
    const step=job.step;
    assertRetrySafe(step);
    const input=makeAdjust(step.inventoryItemId,job.locationId,job.count,'available',step.availableBefore,`${job.batchId}_parent`);
    must((await query(ADJUST,{input,key:step.key})).inventoryAdjustQuantities,'Parent product availability');
    ({job,digest}=await save(variantId,{...job,status:ACTIVE,totalAllocated:job.totalAllocated+job.count,
      history:[...(job.history||[]),{batchId:job.batchId,sets:job.count,createdAt:job.startedAt}],
      count:0,cursor:0,step:null},digest));
    onProgress('All cards reserved. Shopify parent stock has been made available.');
    return job;
  }
  return {readParent,verifyCards,begin,beginConsume,resume};
}
