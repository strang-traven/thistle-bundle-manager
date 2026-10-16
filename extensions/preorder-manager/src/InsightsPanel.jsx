import {useEffect,useState} from 'preact/hooks';
import {stockCapacityByLocation,preorderOrderTally,safeSkuSearch} from './insights.js';

const API_VERSION='2026-07';
const PARENT_SKU=`query ParentSku($id:ID!){productVariant(id:$id){id sku}}`;
const STOCK_QUERY=`query LargeSetStock($ids:[ID!]!){nodes(ids:$ids){... on ProductVariant {
 id displayName inventoryPolicy requiresComponents
 inventoryItem {tracked inventoryLevels(first:30){ nodes {location{id name} quantities(names:["available"]){name quantity}} pageInfo{hasNextPage}}}
}}}`;
const ORDER_QUERY=`query BundleOrderAudit($after:String,$q:String!){orders(first:25,after:$after,query:$q,sortKey:CREATED_AT,reverse:true){
 nodes{id name cancelledAt displayFinancialStatus lineItems(first:100){nodes{currentQuantity unfulfilledQuantity variant{id}} pageInfo{hasNextPage}}}
 pageInfo{hasNextPage endCursor}
}}`;

async function graphql(doc,variables={}){
 const reply=await shopify.query(doc,{version:API_VERSION,variables});
 if(reply.errors?.length)throw new Error(reply.errors.map(e=>e.message).join('; '));
 if(!reply.data)throw new Error('Shopify Admin API did not return data. Check app permissions.');
 return reply.data;
}

export function InsightsPanel({parentId,cards}){
 const [stock,setStock]=useState(null),[audit,setAudit]=useState(null);
 const [working,setWorking]=useState(''),[error,setError]=useState(''),[progress,setProgress]=useState('');
 useEffect(()=>{setStock(null);setAudit(null);setError('');setWorking('');setProgress('');},[parentId]);
 async function perform(name,fn){if(working)return;setWorking(name);setError('');setProgress('');try{await fn();}catch(e){setError(String(e?.message||e));}finally{setWorking('');}}
 function checkLiveStock(){void perform('stock',async()=>{
  if(!cards.length)throw new Error('Add and save the card list first.');
  const collected=[];
  for(let offset=0;offset<cards.length;offset+=15){
   const ids=cards.slice(offset,offset+15).map(c=>c.id);
   const data=await graphql(STOCK_QUERY,{ids});
   for(let i=0;i<ids.length;i++){
    const row=(data.nodes||[]).find(v=>v?.id===ids[i]);
    if(!row)throw new Error('Component is missing from Shopify: '+ids[i]);
    if(row.inventoryItem?.inventoryLevels?.pageInfo?.hasNextPage)throw new Error('More than 30 inventory locations for '+row.displayName+'; cannot safely calculate stock.');
    collected.push(row);
   }
   setProgress(`Read ${Math.min(offset+15,cards.length)} of ${cards.length} Shopify card variants`);
  }
  setStock(stockCapacityByLocation(cards,collected));
 });}
 function checkOrders(){void perform('orders',async()=>{
  const sku=(await graphql(PARENT_SKU,{id:parentId})).productVariant?.sku;
  const query=safeSkuSearch(sku);
  const matches=[];let after=null,page=0;
  do{
   if(page>=200)throw new Error('Audit exceeds 5,000 order records. No result is shown; use a more targeted review.');
   const data=await graphql(ORDER_QUERY,{after,q:query});const connection=data.orders;
   if(!connection)throw new Error('Unable to read order history. Grant read_orders scope.');
   for(const order of connection.nodes||[]){
    if(order.lineItems?.pageInfo?.hasNextPage)throw new Error(`Order ${order.name} contains over 100 lines; incomplete audit is blocked.`);
    matches.push(order);
   }
   after=connection.pageInfo.hasNextPage?connection.pageInfo.endCursor:null;
   page++;setProgress(`Scanned ${matches.length} matching SKU orders…`);
  }while(after);
  setAudit({...preorderOrderTally(matches,parentId),examined:matches.length,sku});
 });}
 return <s-section heading="Pre-order history and live singles stock — safe preview">
  <s-stack direction="block" gap="base">
   <s-banner tone="info">These checks are READ-ONLY. They never change single-card stock, create bundle inventory, edit customer orders, or switch checkout modes.</s-banner>
   <s-stack direction="inline" gap="base"><s-button onClick={checkOrders} disabled={!!working}>Count existing pre-orders</s-button><s-button onClick={checkLiveStock} disabled={!!working||!cards.length}>Calculate live set capacity</s-button></s-stack>
   {working&&<s-text>{progress||`Checking Shopify ${working}…`}</s-text>}
   {audit&&<s-box padding="base" border="base" borderRadius="base"><s-stack direction="block" gap="small">
    <s-text type="strong">Existing order audit: {audit.sku}</s-text>
    <s-text>Unfulfilled sets requiring cards: {audit.unfulfilled}</s-text>
    <s-text>Non-cancelled units (including fulfilled): {audit.purchased} · Matching orders: {audit.ordersMatched}</s-text>
    <s-text>Excluded cancelled orders: {audit.excludedCanceled} · Excluded voided/refunded orders: {audit.unpaid}</s-text>
    <s-banner tone="warning">Shopify normally restricts app order history to 60 days without approved read_all_orders. An older pre-order may be missing. Do not allocate historical orders solely from this estimate; reconcile all orders and refunds first. Bundle SKU must be unique and unchanged.</s-banner>
   </s-stack></s-box>}
   {stock&&<s-stack direction="block" gap="base"><s-text type="strong">Unreserved single-card stock available to assemble sets</s-text>
    {stock.length===0&&<s-text>No Shopify inventory locations were returned.</s-text>}
    {stock.map(l=><s-box key={l.locationId} padding="base" border="base" borderRadius="base"><s-stack direction="block" gap="small">
     <s-text type="strong">{l.locationName}: {l.possible} potential complete sets</s-text>
     <s-text>{l.components} linked variants · Calculated independently at this location</s-text>
     {l.bottlenecks.length>0&&<s-text>Limited by: {l.bottlenecks.slice(0,3).map(b=>`${b.title} (${b.possible} possible)`).join(', ')}</s-text>}
    </s-stack></s-box>)}
    <s-banner tone="warning">This is a current stock snapshot, NOT a synchronized sellable bundle quantity. Availability can change as singles sell. Pre-order reserved card quantities are already excluded from Shopify 'available' stock. A true automatic live bundle requires verified Shopify checkout enforcement and is not enabled here.</s-banner>
   </s-stack>}
   {error&&<s-banner tone="critical">{error}</s-banner>}
  </s-stack>
 </s-section>;
}
