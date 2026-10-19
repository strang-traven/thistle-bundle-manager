import {createHash} from 'node:crypto';
import {authShopToken,graphql,ORDER_BY_ID,ORDER_SCAN,skuQuery,CLOSE_PREORDER,ALLOCATION_COMPONENT,RESERVE_COMPONENT,ADJUST_COMPONENT,PARENT_CAPACITY,SET_INVENTORY,saveLiveBundle,configureLargeLiveBundle} from './shopify.js';
import {orderExposure} from './plan.js';
import {liveParts} from './lifecycle.js';

export async function enqueue(pool,shop,kind,payload,unique=null){
  await pool.query(`INSERT INTO jobs(shop,kind,payload,dedupe_key) VALUES($1,$2,$3,$4)
    ON CONFLICT (dedupe_key) DO NOTHING`,[shop,kind,JSON.stringify(payload),unique]);
}
export async function syncOrder(pool,shop,orderId,api=graphql){
  const token=await authShopToken(pool,shop);
  const order=(await api(shop,token,ORDER_BY_ID,{id:orderId}))?.order;
  if(!order)throw Error('Shopify order not found or not authorized: '+orderId);
  if(order.lineItems.pageInfo.hasNextPage)throw Error('Order contains over 100 lines. Requires paginated order handler.');
  const {rows}=await pool.query('SELECT * FROM bundles WHERE shop=$1',[shop]);
  for(const bundle of rows){
    const info=orderExposure(order,bundle.parent_variant_id);
    if(!info.matched)continue;
    await pool.query(`INSERT INTO preorder_orders(shop,bundle_id,order_id,order_name,purchased,outstanding,cancelled,financial_status)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)
      ON CONFLICT(shop,bundle_id,order_id) DO UPDATE SET
      order_name=EXCLUDED.order_name,purchased=EXCLUDED.purchased,outstanding=EXCLUDED.outstanding,
      cancelled=EXCLUDED.cancelled,financial_status=EXCLUDED.financial_status,updated_at=now()`,
      [shop,bundle.id,info.orderId,info.name,info.purchased,info.outstanding,info.cancelled,info.financialStatus]);
    if(info.outstanding===0)await enqueue(pool,shop,'RESERVATION_SETTLE',{bundleId:bundle.id,orderId:info.orderId,action:info.cancelled||info.purchased===0?'RELEASE':'CONSUME'},`${shop}:settle:${bundle.id}:${info.orderId}:${info.cancelled||info.purchased===0?'release':'consume'}`);
  }
}
export async function reconcileOrders(pool,shop,bundleId,api=graphql){
  const {rows}=await pool.query('SELECT * FROM bundles WHERE shop=$1 AND id=$2',[shop,bundleId]);
  const bundle=rows[0];if(!bundle)throw Error('Bundle not found');
  const token=await authShopToken(pool,shop);
  const orderList=[];let after=null,page=0;
  do{
    if(page++>=250)throw Error('Order history exceeds 10,000 matches; reconcile using a larger paginated job before activating any inventory changes');
    const data=(await api(shop,token,ORDER_SCAN,{after,q:skuQuery(bundle.sku)}))?.orders;
    if(!data)throw Error('Order history unavailable');
    for(const order of data.nodes){
      const info=orderExposure(order,bundle.parent_variant_id);
      if(info.matched)orderList.push(info);
    }
    after=data.pageInfo.hasNextPage?data.pageInfo.endCursor:null;
  }while(after);
  // Commit the whole ledger only after the full scan succeeds, to avoid a partial allocation view.
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)',[Number(bundle.id)]);
    for(const item of orderList){
      await client.query(`INSERT INTO preorder_orders(shop,bundle_id,order_id,order_name,purchased,outstanding,cancelled,financial_status)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(shop,bundle_id,order_id) DO UPDATE SET
       order_name=EXCLUDED.order_name,purchased=EXCLUDED.purchased,outstanding=EXCLUDED.outstanding,
       cancelled=EXCLUDED.cancelled,financial_status=EXCLUDED.financial_status,updated_at=now()`,
       [shop,bundle.id,item.orderId,item.name,item.purchased,item.outstanding,item.cancelled,item.financialStatus]);
    }
    // Do not delete absent records: Shopify order search may be access-scope restricted to 60 days.
    await client.query('UPDATE bundles SET reconciled_at=now() WHERE id=$1 AND shop=$2',[bundle.id,shop]);
    await client.query('COMMIT');
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
  return orderList.length;
}
function operationUuid(batchId,index){
  const hex=createHash('sha256').update(`thistle-allocation:${batchId}:${index}`).digest('hex').slice(0,32).split('');
  hex[12]='4';hex[16]=((parseInt(hex[16],16)&3)|8).toString(16);
  return `${hex.slice(0,8).join('')}-${hex.slice(8,12).join('')}-${hex.slice(12,16).join('')}-${hex.slice(16,20).join('')}-${hex.slice(20).join('')}`;
}
function mutationErrors(result,label){
  const errors=result?.userErrors||[];
  if(errors.length)throw Error(`${label}: ${errors.map(e=>e.message).join('; ')}`);
  return result;
}
export async function allocateBundle(pool,shop,batchId,api=graphql){
  const batchResult=await pool.query(`SELECT a.*,b.parent_product_id,b.parent_variant_id,b.mode
    FROM allocation_batches a JOIN bundles b ON b.id=a.bundle_id WHERE a.id=$1 AND a.shop=$2`,[batchId,shop]);
  const batch=batchResult.rows[0];if(!batch)throw Error('Allocation batch not found');
  if(batch.status==='RESERVED'||batch.status==='DONE')return;
  const token=await authShopToken(pool,shop);
  if(batch.status==='PLANNED'){
    mutationErrors((await api(shop,token,CLOSE_PREORDER,{product:{id:batch.parent_product_id,status:'DRAFT'}}))?.productUpdate,'Close pre-order product');
    // Close sales first, then perform a final authoritative scan. This prevents an
    // order placed between the button click and product closure being omitted.
    await reconcileOrders(pool,shop,batch.bundle_id,api);
    const finalOrders=await pool.query(`SELECT order_id,order_name,outstanding FROM preorder_orders
      WHERE bundle_id=$1 AND shop=$2 AND outstanding>0 AND cancelled=false ORDER BY order_id`,[batch.bundle_id,shop]);
    const finalOutstanding=finalOrders.rows.reduce((sum,row)=>sum+Number(row.outstanding),0);
    if(!finalOutstanding)throw Error('No outstanding pre-orders remain after the final closed-product reconciliation');
    const components=(typeof batch.plan_snapshot==='string'?JSON.parse(batch.plan_snapshot):batch.plan_snapshot).components||[];
    const client=await pool.connect();
    try{
      await client.query('BEGIN');
      await client.query('SELECT pg_advisory_xact_lock($1)',[Number(batch.bundle_id)]);
      for(const order of finalOrders.rows){
        const items=components.map(component=>({...component,quantity:Number(component.quantity)*Number(order.outstanding)}));
        await client.query(`INSERT INTO packing_manifests(bundle_id,order_id,order_name,bundle_quantity,items)
          VALUES($1,$2,$3,$4,$5) ON CONFLICT(bundle_id,order_id) DO NOTHING`,[batch.bundle_id,order.order_id,order.order_name,order.outstanding,JSON.stringify(items)]);
        for(let componentIndex=0;componentIndex<components.length;componentIndex++){
          const component=components[componentIndex];
          await client.query(`INSERT INTO reservation_ledger(bundle_id,order_id,variant_id,location_id,quantity,operation_key,ledger_uri)
            VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(bundle_id,order_id,variant_id) DO NOTHING`,[batch.bundle_id,order.order_id,component.id,batch.location_id,Number(component.quantity)*Number(order.outstanding),`allocation:${batch.id}:${order.order_id}:${component.id}`,`gid://thistle/BundleAllocation/${batch.id}/${componentIndex}`]);
        }
      }
      const plan=JSON.stringify({components,orders:finalOrders.rows});
      await client.query(`UPDATE allocation_batches SET status='RESERVING',outstanding_sets=$2,plan_snapshot=$3,updated_at=now() WHERE id=$1 AND status='PLANNED'`,[batch.id,finalOutstanding,plan]);
      await client.query('COMMIT');
      batch.outstanding_sets=finalOutstanding;batch.plan_snapshot=JSON.parse(plan);batch.status='RESERVING';
    }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
  }
  const snapshot=typeof batch.plan_snapshot==='string'?JSON.parse(batch.plan_snapshot):batch.plan_snapshot;
  const components=snapshot.components||[];
  for(let index=Number(batch.cursor);index<components.length;index++){
    const component=components[index];
    const quantity=Number(component.quantity)*Number(batch.outstanding_sets);
    let step=batch.step;
    if(!step){
      const variant=(await api(shop,token,ALLOCATION_COMPONENT,{id:component.id,locationId:batch.location_id}))?.productVariant;
      if(!variant)throw Error(`Component was deleted: ${component.title||component.id}`);
      if(variant.requiresComponents)throw Error(`${variant.displayName}: nested bundles cannot be allocated`);
      if(!variant.inventoryItem?.tracked||variant.inventoryPolicy!=='DENY')throw Error(`${variant.displayName}: enable stock tracking and turn off overselling`);
      const available=variant.inventoryItem.inventoryLevel?.quantities?.find(q=>q.name==='available')?.quantity;
      if(!Number.isSafeInteger(available)||available<quantity)throw Error(`${variant.displayName}: ${available??0} available, ${quantity} required`);
      const ledgerUri=`gid://thistle/BundleAllocation/${batch.id}/${index}`;
      step={index,key:operationUuid(batch.id,index),issuedAt:new Date().toISOString(),input:{reason:'correction',referenceDocumentUri:`gid://thistle/BundleAllocation/${batch.id}`,changes:[{
        inventoryItemId:variant.inventoryItem.id,quantity,
        from:{locationId:batch.location_id,name:'available',ledgerDocumentUri:null,changeFromQuantity:available},
        to:{locationId:batch.location_id,name:'reserved',ledgerDocumentUri:ledgerUri}
      }]}};
      await pool.query(`UPDATE allocation_batches SET step=$2,updated_at=now() WHERE id=$1 AND cursor=$3`,[batch.id,JSON.stringify(step),index]);
      batch.step=step;
    }
    if(Number(step.index)!==index)throw Error('Allocation checkpoint does not match its component cursor');
    if((Date.now()-new Date(step.issuedAt).valueOf())>=23*60*60*1000){
      await pool.query(`UPDATE allocation_batches SET status='REVIEW',last_error='Idempotency checkpoint older than 23 hours; manually reconcile Shopify inventory',updated_at=now() WHERE id=$1`,[batch.id]);
      throw Error('Allocation needs manual review because its Shopify idempotency key is close to expiry');
    }
    mutationErrors((await api(shop,token,RESERVE_COMPONENT,{input:step.input,key:step.key}))?.inventoryMoveQuantities,'Reserve component stock');
    const client=await pool.connect();
    try{
      await client.query('BEGIN');
      await client.query(`UPDATE reservation_ledger SET status='RESERVED',updated_at=now()
        WHERE bundle_id=$1 AND variant_id=$2 AND status='PLANNED'`,[batch.bundle_id,component.id]);
      await client.query('UPDATE allocation_batches SET cursor=$2,step=NULL,updated_at=now() WHERE id=$1',[batch.id,index+1]);
      await client.query('COMMIT');
    }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
    batch.cursor=index+1;batch.step=null;
  }
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    await client.query(`UPDATE allocation_batches SET status='RESERVED',cursor=component_count,updated_at=now() WHERE id=$1`,[batch.id]);
    await client.query(`UPDATE bundles SET mode='READY_FOR_LIVE',allocated_at=now(),ready_for_live_at=now() WHERE id=$1 AND mode='ALLOCATING'`,[batch.bundle_id]);
    await client.query('COMMIT');
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
}
export async function settleReservation(pool,shop,{bundleId,orderId,action},api=graphql){
  if(!['CONSUME','RELEASE'].includes(action))throw Error('Unknown reservation settlement action');
  const token=await authShopToken(pool,shop);
  const rows=(await pool.query(`SELECT * FROM reservation_ledger WHERE bundle_id=$1 AND order_id=$2 AND status='RESERVED' ORDER BY id`,[bundleId,orderId])).rows;
  for(const row of rows){
    let step=typeof row.step==='string'?JSON.parse(row.step):row.step;
    if(!step){
      const variant=(await api(shop,token,ALLOCATION_COMPONENT,{id:row.variant_id,locationId:row.location_id}))?.productVariant;
      if(!variant?.inventoryItem?.id)throw Error(`Reserved component is missing: ${row.variant_id}`);
      const reserved=variant.inventoryItem.inventoryLevel?.quantities?.find(q=>q.name==='reserved')?.quantity;
      if(!Number.isSafeInteger(reserved)||reserved<Number(row.quantity))throw Error(`${variant.displayName}: reserved quantity ${reserved??0} is below settlement ${row.quantity}`);
      const key=operationUuid(`settle-${row.id}`,action==='CONSUME'?1:2);
      const referenceDocumentUri=`gid://thistle/ReservationSettlement/${row.id}`;
      const input=action==='RELEASE'?{reason:'correction',referenceDocumentUri,changes:[{inventoryItemId:variant.inventoryItem.id,quantity:Number(row.quantity),from:{locationId:row.location_id,name:'reserved',ledgerDocumentUri:row.ledger_uri,changeFromQuantity:reserved},to:{locationId:row.location_id,name:'available',ledgerDocumentUri:null}}]}:{name:'reserved',reason:'correction',referenceDocumentUri,changes:[{inventoryItemId:variant.inventoryItem.id,locationId:row.location_id,delta:-Number(row.quantity),changeFromQuantity:reserved,ledgerDocumentUri:row.ledger_uri}]};
      step={key,input,issuedAt:new Date().toISOString(),action};
      await pool.query(`UPDATE reservation_ledger SET step=$2,updated_at=now() WHERE id=$1 AND status='RESERVED'`,[row.id,JSON.stringify(step)]);
    }
    if((Date.now()-new Date(step.issuedAt).valueOf())>=23*60*60*1000)throw Error(`Reservation settlement ${row.id} needs manual review before retry`);
    if(action==='RELEASE')mutationErrors((await api(shop,token,RESERVE_COMPONENT,{input:step.input,key:step.key}))?.inventoryMoveQuantities,'Release reserved stock');
    else mutationErrors((await api(shop,token,ADJUST_COMPONENT,{input:step.input,key:step.key}))?.inventoryAdjustQuantities,'Consume reserved stock');
    await pool.query(`UPDATE reservation_ledger SET status=$2,step=NULL,updated_at=now() WHERE id=$1 AND status='RESERVED'`,[row.id,action==='RELEASE'?'RELEASED':'CONSUMED']);
  }
  await pool.query(`UPDATE packing_manifests SET status=$3,updated_at=now() WHERE bundle_id=$1 AND order_id=$2`,[bundleId,orderId,action==='RELEASE'?'CANCELLED':'PACKED']);
}
export async function syncLiveBundle(pool,shop,bundle,api=graphql){
  const token=await authShopToken(pool,shop);
  let capacity=1000000000;
  for(const component of bundle.components){
    const variant=(await api(shop,token,ALLOCATION_COMPONENT,{id:component.id,locationId:bundle.location_id}))?.productVariant;
    if(!variant?.inventoryItem?.tracked||variant.inventoryPolicy!=='DENY')throw Error(`${variant?.displayName||component.title}: live component inventory is unsafe`);
    const available=variant.inventoryItem.inventoryLevel?.quantities?.find(q=>q.name==='available')?.quantity;
    if(!Number.isSafeInteger(available))throw Error(`${variant.displayName}: no available stock at the bundle location`);
    capacity=Math.min(capacity,Math.floor(available/Number(component.quantity)));
  }
  const parent=(await api(shop,token,PARENT_CAPACITY,{id:bundle.parent_variant_id,locationId:bundle.location_id}))?.productVariant;
  if(!parent?.inventoryItem?.id)throw Error('Live bundle parent inventory is unavailable');
  const current=parent.inventoryItem.inventoryLevel?.quantities?.find(q=>q.name==='available')?.quantity;
  if(!Number.isSafeInteger(current))throw Error('Live bundle parent is not active at its inventory location');
  if(current!==capacity)mutationErrors((await api(shop,token,SET_INVENTORY,{input:{name:'available',reason:'correction',referenceDocumentUri:`gid://thistle/LiveCapacity/${bundle.id}`,ignoreCompareQuantity:false,quantities:[{inventoryItemId:parent.inventoryItem.id,locationId:bundle.location_id,quantity:capacity,compareQuantity:current}]}}))?.inventorySetQuantities,'Synchronize live bundle capacity');
  return capacity;
}
export async function activateLiveBundle(pool,shop,bundleId,api=graphql){
  const bundle=(await pool.query(`SELECT * FROM bundles WHERE id=$1 AND shop=$2`,[bundleId,shop])).rows[0];
  if(!bundle||bundle.mode!=='READY_FOR_LIVE')return;
  const token=await authShopToken(pool,shop);
  let activatedParts=[];
  if(bundle.components.length<=150){
    await saveLiveBundle(shop,token,{parentVariantId:bundle.parent_variant_id,releaseDate:bundle.release_date,components:bundle.components},api);
    activatedParts=[{part:1,productId:bundle.parent_product_id,variantId:bundle.parent_variant_id,components:bundle.components}];
  }else{
    activatedParts=await configureLargeLiveBundle(shop,token,{bundleId:Number(bundle.id),title:bundle.title,parentProductId:bundle.parent_product_id,parentVariantId:bundle.parent_variant_id,parts:liveParts(bundle.components)},api);
  }
  await api(shop,token,CLOSE_PREORDER,{product:{id:bundle.parent_product_id,status:'ACTIVE'}}).then(x=>mutationErrors(x?.productUpdate,'Activate live bundle product'));
  await syncLiveBundle(pool,shop,{...bundle,mode:'LIVE'},api);
  const client=await pool.connect();
  try{
    await client.query('BEGIN');
    for(const part of activatedParts)await client.query(`INSERT INTO live_bundle_parts(bundle_id,part_number,parent_product_id,parent_variant_id,components,status)
      VALUES($1,$2,$3,$4,$5,'ACTIVE') ON CONFLICT(bundle_id,part_number) DO UPDATE SET parent_product_id=EXCLUDED.parent_product_id,parent_variant_id=EXCLUDED.parent_variant_id,components=EXCLUDED.components,status='ACTIVE',updated_at=now()`,[bundle.id,part.part,part.productId,part.variantId,JSON.stringify(part.components)]);
    await client.query(`UPDATE bundles SET mode='LIVE',live_at=now(),paused_reason=NULL WHERE id=$1 AND mode='READY_FOR_LIVE'`,[bundle.id]);
    await client.query('COMMIT');
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
}
export async function enqueueDueTransitions(pool){
  const due=(await pool.query(`SELECT id,shop,ready_for_live_at FROM bundles WHERE mode='READY_FOR_LIVE'
    AND (release_date IS NULL OR release_date='' OR release_date::date<=CURRENT_DATE) ORDER BY id LIMIT 50`)).rows;
  for(const bundle of due)await enqueue(pool,bundle.shop,'LIVE_ACTIVATE',{bundleId:bundle.id},
    `${bundle.shop}:live-activate:${bundle.id}:${new Date(bundle.ready_for_live_at).toISOString()}`);
}
export async function enqueueLiveRefreshes(pool,now=Date.now()){
  const shops=(await pool.query(`SELECT DISTINCT shop FROM bundles WHERE mode='LIVE' ORDER BY shop`)).rows;
  // Inventory webhooks can arrive once per component. One shop-level refresh per
  // 30-second window prevents a large bundle sale from causing thousands of
  // duplicate Shopify reads while keeping storefront stock near real time.
  const window=Math.floor(now/30000);
  for(const row of shops)await enqueue(pool,row.shop,'LIVE_SYNC',{},`${row.shop}:live-sync-window:${window}`);
}
async function executeJob(pool,job){
  switch(job.kind){
    case 'ORDER_SYNC':return syncOrder(pool,job.shop,job.payload.orderId);
    case 'ORDER_RECONCILE':return reconcileOrders(pool,job.shop,job.payload.bundleId);
    case 'BUNDLE_ALLOCATE':return allocateBundle(pool,job.shop,job.payload.batchId);
    case 'RESERVATION_SETTLE':return settleReservation(pool,job.shop,job.payload);
    case 'LIVE_ACTIVATE':return activateLiveBundle(pool,job.shop,job.payload.bundleId);
    case 'LIVE_SYNC':{
      const bundles=(await pool.query(`SELECT * FROM bundles WHERE shop=$1 AND mode='LIVE'`,[job.shop])).rows;
      for(const bundle of bundles)await syncLiveBundle(pool,job.shop,bundle);
      return;
    }
    case 'INVENTORY_INVALIDATE':
      await pool.query(`INSERT INTO inventory_dirty(shop,inventory_item_id) VALUES($1,$2)
        ON CONFLICT(shop,inventory_item_id) DO UPDATE SET seen_at=now()`,[job.shop,job.payload.inventoryItemId]);
      return enqueue(pool,job.shop,'LIVE_SYNC',{},`${job.shop}:live-sync-window:${Math.floor(Date.now()/30000)}`);
    default:throw new Error('Unknown job type');
  }
}
export async function processOne(pool,handler=executeJob){
  const {rows}=await pool.query(`UPDATE jobs SET status='PROCESSING',attempts=attempts+1,
    leased_until=now()+interval '3 minutes',updated_at=now()
    WHERE id=(SELECT id FROM jobs WHERE (status='PENDING' AND next_run_at<=now())
      OR (status='PROCESSING' AND leased_until<now()) ORDER BY next_run_at,id
      FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *`);
  const job=rows[0];if(!job)return false;
  try{
    await handler(pool,job);
    await pool.query(`UPDATE jobs SET status='DONE',leased_until=NULL,updated_at=now(),last_error=NULL WHERE id=$1 AND status='PROCESSING'`,[job.id]);
  }catch(err){
    const exhausted=job.attempts>=8;
    const backoff=Math.min(3600,Math.pow(2,job.attempts)*15);
    await pool.query(`UPDATE jobs SET status=$2,leased_until=NULL,
      next_run_at=now()+($3::int*interval '1 second'),last_error=$4,updated_at=now() WHERE id=$1`,
      [job.id,exhausted?'FAILED':'PENDING',backoff,String(err.message||err).slice(0,450)]);
    console.error('Job failed',job.id,job.kind,String(err.message||err).slice(0,300));
  }
  return true;
}
export function runWorker(pool,{signal}={}){
  // The process has one worker loop; Postgres leases protect against multiple Fly machines.
  let running=false;
  const interval=setInterval(async()=>{
    if(running||signal?.aborted)return;
    running=true;
    try{await enqueueDueTransitions(pool);await enqueueLiveRefreshes(pool);for(let i=0;i<5;i++)if(!await processOne(pool))break;}
    catch(e){console.error('Worker loop error',e.message);}finally{running=false;}
  },5000);
  interval.unref();
  return ()=>clearInterval(interval);
}
