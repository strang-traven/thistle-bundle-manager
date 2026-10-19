import http from 'node:http';
import {readFile} from 'node:fs/promises';
import pg from 'pg';
import {verifyWebhook,verifyIdToken,assertShop,encrypt} from './security.js';
import {authShopToken,bundleLocations,createBundleProduct,exchangeOfflineToken,fetchBundlePlan,stageBundlePlan} from './shopify.js';
import {enqueue,runWorker} from './worker.js';
import {fixedBundleParts} from './plan.js';
const port=Number(process.env.PORT||8080);
const apiKey=process.env.SHOPIFY_API_KEY;
const apiSecret=process.env.SHOPIFY_API_SECRET;
const encryptionKey=process.env.ENCRYPTION_KEY;
const dbUrl=process.env.DATABASE_URL;
if(import.meta.url===`file://${process.argv[1]}`){
 if(!apiKey||!apiSecret||!encryptionKey||!dbUrl)throw Error('Required: SHOPIFY_API_KEY, SHOPIFY_API_SECRET, ENCRYPTION_KEY, DATABASE_URL');
}
const pool=dbUrl?new pg.Pool({connectionString:dbUrl,max:8,connectionTimeoutMillis:7000,idleTimeoutMillis:30000}):null;
const send=(res,status,data)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});res.end(JSON.stringify(data));};
const limits={raw:4*1024*1024};
export async function rawBody(req,max=limits.raw){
 const chunks=[];let length=0;
 for await(const chunk of req){length+=chunk.length;if(length>max)throw Object.assign(new Error('Request body too large'),{status:413});chunks.push(chunk);}
 return Buffer.concat(chunks);
}
async function auth(req){
 const jwt=(req.headers.authorization||'').replace(/^Bearer /i,'');
 return verifyIdToken(jwt,{clientId:apiKey,secret:apiSecret,allowedShop:process.env.SHOPIFY_SHOP_DOMAIN});
}
const htmlPath=new URL('./public/index.html',import.meta.url);
export function makeHandler(database=pool,{getHtml=()=>readFile(htmlPath,'utf8')}={}){
 return async(req,res)=>{
  try{
   const url=new URL(req.url,'http://internal');
   if(req.method==='GET'&&url.pathname==='/healthz'){
     await database.query('SELECT 1');return send(res,200,{ok:true});
   }
   if(req.method==='GET'&&url.pathname==='/auth/callback'){
     res.writeHead(302,{'Location':'/','Cache-Control':'no-store'});return res.end();
   }
   if(req.method==='GET'&&url.pathname==='/'){
     const shop=String(url.searchParams.get('shop')||'');
     if(shop)assertShop(shop,process.env.SHOPIFY_SHOP_DOMAIN);
     res.writeHead(200,{
       'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store',
       'Content-Security-Policy':`frame-ancestors https://admin.shopify.com https://*.myshopify.com; default-src 'self' https://cdn.shopify.com; script-src 'self' https://cdn.shopify.com 'unsafe-inline'; connect-src 'self' https://admin.shopify.com https://*.myshopify.com; style-src 'self' 'unsafe-inline'; img-src 'self' data:`,
       'X-Content-Type-Options':'nosniff'
     });
     const template=await getHtml();
     return res.end(template.replaceAll('__SHOPIFY_API_KEY__',apiKey||''));
   }
   if(req.method==='POST'&&url.pathname==='/webhooks/shopify'){
     const raw=await rawBody(req);const signature=req.headers['x-shopify-hmac-sha256'];
     if(!verifyWebhook(raw,signature,apiSecret))return send(res,401,{error:'Invalid webhook signature'});
     const shop=assertShop(req.headers['x-shopify-shop-domain'],process.env.SHOPIFY_SHOP_DOMAIN);
     const topic=String(req.headers['x-shopify-topic']||'').toLowerCase();
     const webhookId=String(req.headers['x-shopify-webhook-id']||'');
     if(!/^[a-z0-9/_-]{2,100}$/.test(topic)||!webhookId||webhookId.length>128)return send(res,400,{error:'Invalid webhook headers'});
     let payload;try{payload=JSON.parse(raw.toString('utf8'));}catch{return send(res,400,{error:'Invalid webhook JSON'});}
     const client=await database.connect();
     try{
       await client.query('BEGIN');
       // Store only the identifiers needed to re-fetch the latest Shopify state.
       // Full webhook bodies can contain customer personal data and are not needed here.
       const minimal={id:payload.id??null,order_id:payload.order_id??null,inventory_item_id:payload.inventory_item_id??null};
       const inserted=await client.query(`INSERT INTO webhook_events(shop,webhook_id,topic,payload) VALUES($1,$2,$3,$4) ON CONFLICT(shop,webhook_id) DO NOTHING RETURNING id`,[shop,webhookId,topic,JSON.stringify(minimal)]);
       if(inserted.rowCount){
         if(topic==='app/uninstalled'){
           await client.query('DELETE FROM jobs WHERE shop=$1',[shop]);
           await client.query('DELETE FROM shops WHERE shop=$1',[shop]);
         }else if(['orders/create','orders/updated','orders/cancelled','refunds/create','orders/paid','fulfillments/create'].includes(topic)){
           const orderId=topic==='refunds/create'?payload.order_id:topic==='fulfillments/create'?payload.order_id:payload.id;
           if(orderId){await enqueue(client,shop,'ORDER_SYNC',{orderId:`gid://shopify/Order/${orderId}`},`${shop}:webhook:${webhookId}`);}
         }else if(topic==='inventory_levels/update'&&payload.inventory_item_id){
           await enqueue(client,shop,'INVENTORY_INVALIDATE',{inventoryItemId:`gid://shopify/InventoryItem/${payload.inventory_item_id}`},`${shop}:webhook:${webhookId}`);
         }
       }
       await client.query('COMMIT');
     }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
     return send(res,200,{received:true});
   }
   if(url.pathname.startsWith('/api/admin/')){
     const {shop}=await auth(req);
     if(req.method==='GET'&&url.pathname==='/api/admin/status'){
       const bundles=await database.query(`SELECT b.id,b.parent_variant_id,b.title,b.sku,b.mode,b.location_id,b.release_date,b.preorder_limit,b.reconciled_at,jsonb_array_length(b.components) AS card_count,b.synced_at,
           (SELECT a.status FROM allocation_batches a WHERE a.bundle_id=b.id ORDER BY a.id DESC LIMIT 1) AS allocation_status,
           COALESCE(sum(o.purchased),0)::int AS sold,COALESCE(sum(o.outstanding),0)::int AS outstanding,COUNT(o.order_id)::int AS order_count
          FROM bundles b LEFT JOIN preorder_orders o ON o.bundle_id=b.id
          WHERE b.shop=$1 GROUP BY b.id ORDER BY b.id DESC LIMIT 100`,[shop]);
       const jobs=await database.query(`SELECT id,kind,status,attempts,last_error,updated_at FROM jobs WHERE shop=$1 ORDER BY id DESC LIMIT 30`,[shop]);
       const connected=await database.query('SELECT access_token_cipher IS NOT NULL AS linked FROM shops WHERE shop=$1',[shop]);
       return send(res,200,{shop,linked:!!connected.rows[0]?.linked,bundles:bundles.rows,jobs:jobs.rows,stockMutationsEnabled:true});
     }
     if(req.method==='POST'&&url.pathname==='/api/admin/connect'){
       const jwt=(req.headers.authorization||'').replace(/^Bearer /i,'');
       const token=await exchangeOfflineToken(shop,jwt);
       const sealed=encrypt(token,encryptionKey);
       await database.query(`INSERT INTO shops(shop,access_token_cipher) VALUES($1,$2)
          ON CONFLICT(shop) DO UPDATE SET access_token_cipher=EXCLUDED.access_token_cipher,updated_at=now()`,[shop,sealed]);
       return send(res,200,{connected:true,shop});
     }
     if(req.method==='POST'&&url.pathname==='/api/admin/sync'){
       const body=JSON.parse((await rawBody(req,32768)).toString());
       const connected=await database.query('SELECT 1 FROM shops WHERE shop=$1 AND access_token_cipher IS NOT NULL',[shop]);
       if(!connected.rowCount)return send(res,409,{error:'Connect the Shopify app first'});
       const {authShopToken}=await import('./shopify.js');
       const bundle=await fetchBundlePlan(shop,await authShopToken(database,shop),body.parentVariantId);
       const duplicate=await database.query('SELECT parent_variant_id FROM bundles WHERE shop=$1 AND sku=$2 AND parent_variant_id<>$3',[shop,bundle.sku,bundle.parentVariantId]);
       if(duplicate.rowCount)return send(res,409,{error:'The parent SKU is already assigned to another bundle. Use a unique SKU.'});
       const saved=await database.query(`INSERT INTO bundles(shop,parent_variant_id,parent_product_id,title,sku,release_date,components)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(shop,parent_variant_id) DO UPDATE SET
        title=EXCLUDED.title,sku=EXCLUDED.sku,release_date=EXCLUDED.release_date,
        components=EXCLUDED.components,synced_at=now()
        WHERE bundles.mode='PREORDER' RETURNING id`,[shop,bundle.parentVariantId,bundle.parentProductId,bundle.title,bundle.sku,bundle.releaseDate,JSON.stringify(bundle.components)]);
       if(!saved.rowCount)return send(res,409,{error:'Bundle is locked beyond PREORDER; cannot overwrite card list.'});
       return send(res,200,{synced:true,id:saved.rows[0].id,cards:bundle.components.length,parts:fixedBundleParts(bundle.components).length});
     }
     if(req.method==='POST'&&url.pathname==='/api/admin/bundle-product'){
       const body=JSON.parse((await rawBody(req,32768)).toString());
       const token=await authShopToken(database,shop);
       const created=await createBundleProduct(shop,token,body);
       const saved=await database.query(`INSERT INTO bundles(shop,parent_variant_id,parent_product_id,title,sku,release_date,preorder_limit,location_id)
         VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,[shop,created.parentVariantId,created.productId,created.title,created.sku,created.releaseDate,created.preorderLimit,created.locationId]);
       return send(res,200,{...created,id:saved.rows[0].id});
     }
     if(req.method==='GET'&&url.pathname==='/api/admin/locations'){
       const token=await authShopToken(database,shop);
       return send(res,200,{locations:await bundleLocations(shop,token)});
     }
     if(req.method==='GET'&&url.pathname==='/api/admin/bundle'){
       const id=Number(url.searchParams.get('bundleId'));
       if(!Number.isSafeInteger(id)||id<1)return send(res,400,{error:'Invalid bundle ID'});
       const found=await database.query(`SELECT id,parent_variant_id,parent_product_id,title,sku,mode,location_id,release_date,
          preorder_limit,components,reconciled_at,allocated_at,ready_for_live_at,live_at,paused_reason,synced_at
         FROM bundles WHERE shop=$1 AND id=$2`,[shop,id]);
       const bundle=found.rows[0];
       if(!bundle)return send(res,404,{error:'Bundle not found'});
       return send(res,200,{bundle:{...bundle,editable:bundle.mode==='PREORDER',components:Array.isArray(bundle.components)?bundle.components:[]}});
     }
     if(req.method==='POST'&&url.pathname==='/api/admin/bundle-save'){
       const body=JSON.parse((await rawBody(req,512*1024)).toString());
       const token=await authShopToken(database,shop);
       const parent=await stageBundlePlan(shop,token,body);
       const duplicate=await database.query('SELECT parent_variant_id FROM bundles WHERE shop=$1 AND sku=$2 AND parent_variant_id<>$3',[shop,parent.sku,parent.parentVariantId]);
       if(duplicate.rowCount)return send(res,409,{error:'The parent SKU is already assigned to another bundle. Use a unique SKU.'});
       const saved=await database.query(`INSERT INTO bundles(shop,parent_variant_id,parent_product_id,title,sku,release_date,components)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(shop,parent_variant_id) DO UPDATE SET
        title=EXCLUDED.title,sku=EXCLUDED.sku,release_date=EXCLUDED.release_date,components=EXCLUDED.components,synced_at=now()
        WHERE bundles.mode='PREORDER' RETURNING id`,[shop,parent.parentVariantId,parent.parentProductId,parent.title,parent.sku,parent.releaseDate,JSON.stringify(parent.components)]);
       if(!saved.rowCount)return send(res,409,{error:'Bundle is locked beyond PREORDER; its component list cannot be changed.'});
       return send(res,200,{saved:true,id:saved.rows[0].id,cards:parent.components.length,status:'PREORDER'});
     }
     if(req.method==='POST'&&url.pathname==='/api/admin/bundle-settings'){
       const body=JSON.parse((await rawBody(req,4096)).toString());
       const id=Number(body.bundleId),locationId=String(body.locationId||'');
       if(!Number.isSafeInteger(id)||id<1)return send(res,400,{error:'Invalid bundle ID'});
       if(!/^gid:\/\/shopify\/Location\/\d+$/.test(locationId))return send(res,400,{error:'Select a valid Shopify location'});
       const token=await authShopToken(database,shop);
       const locations=await bundleLocations(shop,token);
       if(!locations.some(location=>location.id===locationId))return send(res,400,{error:'That Shopify location is unavailable'});
       const updated=await database.query(`UPDATE bundles SET location_id=$3,synced_at=now() WHERE id=$1 AND shop=$2 AND mode='PREORDER' RETURNING id`,[id,shop,locationId]);
       if(!updated.rowCount)return send(res,409,{error:'Only pre-order bundles can change inventory location'});
       return send(res,200,{saved:true,bundleId:id,locationId});
     }
     if(req.method==='POST'&&url.pathname==='/api/admin/bundle-remove'){
       const body=JSON.parse((await rawBody(req,2048)).toString());
       const id=Number(body.bundleId);
       if(!Number.isSafeInteger(id)||id<1)return send(res,400,{error:'Invalid bundle ID'});
       const client=await database.connect();
       try{
         await client.query('BEGIN');
         await client.query('SELECT pg_advisory_xact_lock($1)',[id]);
         const found=await client.query('SELECT id,title,mode FROM bundles WHERE id=$1 AND shop=$2 FOR UPDATE',[id,shop]);
         const bundle=found.rows[0];
         if(!bundle)throw Object.assign(Error('Bundle not found'),{status:404});
         if(bundle.mode!=='PREORDER')throw Object.assign(Error('Only a pre-order bundle can be removed from the app'),{status:409});
         const history=await client.query(`SELECT
           (SELECT COUNT(*)::int FROM preorder_orders WHERE bundle_id=$1 AND shop=$2) AS orders,
           (SELECT COUNT(*)::int FROM allocation_batches WHERE bundle_id=$1 AND shop=$2) AS allocations`,[id,shop]);
         if(Number(history.rows[0]?.orders)||Number(history.rows[0]?.allocations)){
           throw Object.assign(Error('This bundle has order or allocation history and cannot be safely removed'),{status:409});
         }
         const running=await client.query(`SELECT 1 FROM jobs WHERE shop=$1 AND kind='ORDER_RECONCILE'
           AND status='PROCESSING' AND payload->>'bundleId'=$2 LIMIT 1`,[shop,String(id)]);
         if(running.rowCount)throw Object.assign(Error('Order reconciliation is running. Wait for it to finish before removing this bundle.'),{status:409});
         await client.query(`DELETE FROM jobs WHERE shop=$1 AND kind='ORDER_RECONCILE'
           AND status IN ('PENDING','FAILED') AND payload->>'bundleId'=$2`,[shop,String(id)]);
         await client.query('DELETE FROM bundles WHERE id=$1 AND shop=$2',[id,shop]);
         await client.query('COMMIT');
         return send(res,200,{removed:true,bundleId:id,title:bundle.title,shopifyProductDeleted:false});
       }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
     }
     if(req.method==='POST'&&url.pathname==='/api/admin/reconcile'){
       const body=JSON.parse((await rawBody(req,2048)).toString());
       const id=Number(body.bundleId);
       if(!Number.isSafeInteger(id)||id<1)return send(res,400,{error:'Invalid bundle ID'});
       const found=await database.query('SELECT id FROM bundles WHERE id=$1 AND shop=$2',[id,shop]);
       if(!found.rowCount)return send(res,404,{error:'Bundle not found'});
       await enqueue(database,shop,'ORDER_RECONCILE',{bundleId:id});
       return send(res,202,{queued:true,bundleId:id});
     }
     if(req.method==='POST'&&url.pathname==='/api/admin/allocate'){
       const body=JSON.parse((await rawBody(req,2048)).toString());
       const id=Number(body.bundleId);
       if(!Number.isSafeInteger(id)||id<1)return send(res,400,{error:'Invalid bundle ID'});
       const client=await database.connect();
       try{
         await client.query('BEGIN');
         await client.query('SELECT pg_advisory_xact_lock($1)',[id]);
         const found=await client.query(`SELECT * FROM bundles WHERE id=$1 AND shop=$2 FOR UPDATE`,[id,shop]);
         const bundle=found.rows[0];
         if(!bundle)throw Object.assign(Error('Bundle not found'),{status:404});
         if(bundle.mode!=='PREORDER')throw Object.assign(Error(`Bundle is already ${bundle.mode}`),{status:409});
         if(!bundle.reconciled_at)throw Object.assign(Error('Reconcile orders before allocating cards'),{status:409});
         if(!bundle.location_id)throw Object.assign(Error('Select one inventory location before allocation'),{status:409});
         if(!Array.isArray(bundle.components)||!bundle.components.length)throw Object.assign(Error('Link and save all card variants before allocation'),{status:409});
         const orders=await client.query(`SELECT order_id,order_name,outstanding FROM preorder_orders
           WHERE bundle_id=$1 AND shop=$2 AND outstanding>0 AND cancelled=false ORDER BY order_id`,[id,shop]);
         const outstanding=orders.rows.reduce((sum,row)=>sum+Number(row.outstanding),0);
         if(!outstanding)throw Object.assign(Error('No outstanding pre-orders to allocate'),{status:409});
         const made=await client.query(`INSERT INTO allocation_batches(bundle_id,shop,location_id,outstanding_sets,component_count,plan_snapshot)
           VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,[id,shop,bundle.location_id,outstanding,bundle.components.length,JSON.stringify({components:bundle.components,orders:[]})]);
         const batchId=made.rows[0].id;
         await client.query(`UPDATE bundles SET mode='ALLOCATING' WHERE id=$1`,[id]);
         await enqueue(client,shop,'BUNDLE_ALLOCATE',{batchId},`${shop}:allocation:${batchId}`);
         await client.query('COMMIT');
         return send(res,202,{queued:true,bundleId:id,batchId,outstandingSets:outstanding,componentCount:bundle.components.length});
       }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
     }
     if(req.method==='POST'&&url.pathname==='/api/admin/prepare-live'){
       const body=JSON.parse((await rawBody(req,2048)).toString());
       const id=Number(body.bundleId);
       if(!Number.isSafeInteger(id)||id<1)return send(res,400,{error:'Invalid bundle ID'});
       const client=await database.connect();
       try{
         await client.query('BEGIN');
         await client.query('SELECT pg_advisory_xact_lock($1)',[id]);
         const found=await client.query(`SELECT * FROM bundles WHERE id=$1 AND shop=$2 FOR UPDATE`,[id,shop]);
         const bundle=found.rows[0];
         if(!bundle)throw Object.assign(Error('Bundle not found'),{status:404});
         if(bundle.mode!=='PREORDER')throw Object.assign(Error(`Bundle is already ${bundle.mode}`),{status:409});
         if(!bundle.reconciled_at)throw Object.assign(Error('Reconcile orders first, then wait for the reconciliation job to finish'),{status:409});
         if(!bundle.location_id)throw Object.assign(Error('Select an inventory location before preparing live mode'),{status:409});
         if(!Array.isArray(bundle.components)||!bundle.components.length)throw Object.assign(Error('Link and save all card variants before preparing live mode'),{status:409});
         const orders=await client.query(`SELECT COALESCE(sum(outstanding),0)::int AS outstanding FROM preorder_orders
           WHERE bundle_id=$1 AND shop=$2 AND outstanding>0 AND cancelled=false`,[id,shop]);
         const outstanding=Number(orders.rows[0]?.outstanding||0);
         if(outstanding)throw Object.assign(Error(`${outstanding} pre-order set(s) still need card allocation. Use Allocate cards to pre-orders first.`),{status:409});
         await client.query(`UPDATE bundles SET mode='READY_FOR_LIVE',ready_for_live_at=now(),paused_reason=NULL WHERE id=$1`,[id]);
         if(body.activateNow===true)await enqueue(client,shop,'LIVE_ACTIVATE',{bundleId:id},`${shop}:live-activate:${id}:${Date.now()}`);
         await client.query('COMMIT');
         return send(res,202,{queued:body.activateNow===true,bundleId:id,mode:'READY_FOR_LIVE'});
       }catch(e){await client.query('ROLLBACK');throw e;}finally{client.release();}
     }
     if(req.method==='POST'&&url.pathname==='/api/admin/go-live'){
       const body=JSON.parse((await rawBody(req,2048)).toString());
       const id=Number(body.bundleId);
       if(!Number.isSafeInteger(id)||id<1)return send(res,400,{error:'Invalid bundle ID'});
       const found=await database.query(`SELECT mode FROM bundles WHERE id=$1 AND shop=$2`,[id,shop]);
       if(!found.rowCount)return send(res,404,{error:'Bundle not found'});
       if(found.rows[0].mode!=='READY_FOR_LIVE')return send(res,409,{error:'Bundle must finish pre-order allocation before it can go live'});
       await enqueue(database,shop,'LIVE_ACTIVATE',{bundleId:id},`${shop}:live-activate:${id}:${Date.now()}`);
       return send(res,202,{queued:true,bundleId:id});
     }
     if(req.method==='POST'&&url.pathname==='/api/admin/sync-live'){
       const body=JSON.parse((await rawBody(req,2048)).toString());
       const id=Number(body.bundleId);
       if(!Number.isSafeInteger(id)||id<1)return send(res,400,{error:'Invalid bundle ID'});
       const found=await database.query(`SELECT mode FROM bundles WHERE id=$1 AND shop=$2`,[id,shop]);
       if(!found.rowCount)return send(res,404,{error:'Bundle not found'});
       if(found.rows[0].mode!=='LIVE')return send(res,409,{error:'Only a live bundle can have its stock synchronized'});
       await enqueue(database,shop,'LIVE_SYNC',{},`${shop}:live-sync:manual:${id}:${Date.now()}`);
       return send(res,202,{queued:true,bundleId:id});
     }
     if(req.method==='GET'&&url.pathname==='/api/admin/part-plan'){
       const id=Number(url.searchParams.get('bundleId'));
       if(!Number.isSafeInteger(id)||id<1)return send(res,400,{error:'Invalid bundle ID'});
       const found=await database.query('SELECT components,mode FROM bundles WHERE shop=$1 AND id=$2',[shop,id]);
       if(!found.rowCount)return send(res,404,{error:'Bundle not found'});
       const parts=fixedBundleParts(found.rows[0].components);
       return send(res,200,{mode:found.rows[0].mode,totalCards:parts.reduce((s,p)=>s+p.items.length,0),parts:parts.map(p=>({part:p.part,count:p.items.length,components:p.items}))});
     }
     if(req.method==='GET'&&url.pathname==='/api/admin/manifests'){
       const id=Number(url.searchParams.get('bundleId'));
       if(!Number.isSafeInteger(id)||id<1)return send(res,400,{error:'Invalid bundle ID'});
       const found=await database.query('SELECT id FROM bundles WHERE shop=$1 AND id=$2',[shop,id]);
       if(!found.rowCount)return send(res,404,{error:'Bundle not found'});
       const manifests=await database.query(`SELECT order_id,order_name,bundle_quantity,items,status,updated_at FROM packing_manifests WHERE bundle_id=$1 ORDER BY order_name,order_id`,[id]);
       return send(res,200,{manifests:manifests.rows});
     }
     return send(res,404,{error:'Admin route not found'});
   }
   return send(res,404,{error:'Not found'});
  }catch(e){
    const status=e.status||(e.message?.includes('permission denied')||e.code?.startsWith?.('0')?503:/token|shop|signature|issuer|destination|allowed/i.test(e.message)?401:400);
    console.error('Request failed',req.method,req.url,String(e.message||e).slice(0,180));
    return send(res,status,{error:status>=500?'Service error':String(e.message||e).slice(0,240)});
  }
 };
}
if(import.meta.url===`file://${process.argv[1]}`){
 await pool.query('SELECT 1 FROM shops LIMIT 1').catch(e=>{throw new Error('Database is not migrated. Run npm run migrate: '+e.message);});
 const app=http.createServer(makeHandler(pool));
 const stopWorker=runWorker(pool);
 app.listen(port,'0.0.0.0',()=>console.log(`Thistle bundles v6 listening on ${port}`));
 const stop=()=>{stopWorker();app.close(()=>pool.end().then(()=>process.exit(0)));setTimeout(()=>process.exit(1),25000).unref();};
 process.on('SIGINT',stop);process.on('SIGTERM',stop);
}
