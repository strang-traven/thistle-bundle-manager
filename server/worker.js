import {authShopToken,graphql,ORDER_BY_ID,ORDER_SCAN,skuQuery} from './shopify.js';
import {orderExposure} from './plan.js';

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
    await client.query('COMMIT');
  }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
  return orderList.length;
}
async function executeJob(pool,job){
  switch(job.kind){
    case 'ORDER_SYNC':return syncOrder(pool,job.shop,job.payload.orderId);
    case 'ORDER_RECONCILE':return reconcileOrders(pool,job.shop,job.payload.bundleId);
    case 'INVENTORY_INVALIDATE':
      return pool.query(`INSERT INTO inventory_dirty(shop,inventory_item_id) VALUES($1,$2)
        ON CONFLICT(shop,inventory_item_id) DO UPDATE SET seen_at=now()`,[job.shop,job.payload.inventoryItemId]);
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
    try{for(let i=0;i<5;i++)if(!await processOne(pool))break;}
    catch(e){console.error('Worker loop error',e.message);}finally{running=false;}
  },5000);
  interval.unref();
  return ()=>clearInterval(interval);
}
