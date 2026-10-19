import test from 'node:test';import assert from 'node:assert/strict';
import {allocateBundle,enqueue,processOne,settleReservation,syncLiveBundle,enqueueLiveRefreshes} from './worker.js';
import {encrypt} from './security.js';
test('jobs use unique event keys for idempotent queue writes',async()=>{
 let sql='',params;
 const db={query:async(q,p)=>{sql=q;params=p;}};
 await enqueue(db,'myshop.myshopify.com','ORDER_SYNC',{orderId:'gid://shopify/Order/42'},'event-42');
 assert.match(sql,/ON CONFLICT \(dedupe_key\) DO NOTHING/);
 assert.equal(params[3],'event-42');
});
test('successful worker completes a leased job',async()=>{
 const seen=[];
 const db={query:async(sql,params)=>{seen.push([sql,params]);if(sql.includes('RETURNING *'))return {rows:[{id:11,kind:'ORDER_SYNC',shop:'x',payload:{orderId:'abc'},attempts:1}]};return {rows:[]};}};
 let invoked=0;
 assert.equal(await processOne(db,async()=>{invoked++;}),true);
 assert.equal(invoked,1);
 assert.ok(seen.some(([sql])=>sql.includes("status='DONE'")));
});
test('failed worker retries without marking order processed',async()=>{
 const seen=[];
 const db={query:async(sql,params)=>{seen.push([sql,params]);if(sql.includes('RETURNING *'))return {rows:[{id:13,kind:'ORDER_SYNC',shop:'x',payload:{orderId:'abc'},attempts:2}]};return {rows:[]};}};
 assert.equal(await processOne(db,async()=>{throw Error('simulated network failure');}),true);
 assert.ok(seen.some(([sql,p])=>sql.includes('next_run_at=')&&p[1]==='PENDING'));
});
test('allocation closes preorder, reserves exact demand, and checkpoints completion',async()=>{
 const oldKey=process.env.ENCRYPTION_KEY;process.env.ENCRYPTION_KEY=Buffer.alloc(32,7).toString('base64');
 const state={status:'PLANNED',cursor:0,step:null,mode:'ALLOCATING',ledger:false};
 const batch={id:7,bundle_id:2,shop:'myshop.myshopify.com',location_id:'gid://shopify/Location/3',outstanding_sets:12,component_count:1,
   plan_snapshot:{components:[{id:'gid://shopify/ProductVariant/9',title:'Card',quantity:2}]},parent_product_id:'gid://shopify/Product/1',parent_variant_id:'gid://shopify/ProductVariant/1'};
 const query=async(sql,params=[])=>{
   if(sql.includes('FROM allocation_batches a'))return {rows:[{...batch,status:state.status,cursor:state.cursor,step:state.step,mode:state.mode}]};
   if(sql.includes('SELECT access_token_cipher'))return {rows:[{access_token_cipher:encrypt('token',process.env.ENCRYPTION_KEY)}]};
   if(sql.includes('FROM bundles WHERE shop=')&&sql.includes('id='))return {rows:[{id:2,shop:batch.shop,sku:'SET-1',parent_variant_id:batch.parent_variant_id}]};
   if(sql.includes('FROM preorder_orders')&&sql.includes('outstanding>0'))return {rows:[{order_id:'gid://shopify/Order/12',order_name:'#12',outstanding:12}]};
   if(sql.includes('INSERT INTO preorder_orders')||sql.includes('INSERT INTO packing_manifests')||sql.includes('INSERT INTO reservation_ledger')||sql.includes('reconciled_at=now()'))return {rows:[]};
   if(sql.includes("status='RESERVING'")){state.status='RESERVING';return {rows:[]};}
   if(sql.includes('SET step=')){state.step=JSON.parse(params[1]);return {rows:[]};}
   if(sql.includes("reservation_ledger SET status='RESERVED'")){state.ledger=true;return {rows:[]};}
   if(sql.includes('SET cursor=')&&sql.includes('step=NULL')){state.cursor=params[1];state.step=null;return {rows:[]};}
   if(sql.includes("status='RESERVED',cursor=component_count")){state.status='RESERVED';return {rows:[]};}
   if(sql.includes("mode='READY_FOR_LIVE'")){state.mode='READY_FOR_LIVE';return {rows:[]};}
   return {rows:[]};
 };
 const db={query,connect:async()=>({query,release(){}})};
 const calls=[];
 const api=async(_shop,_token,doc,variables)=>{calls.push({doc,variables});
   if(doc.includes('CloseBundlePreorder'))return {productUpdate:{product:{id:batch.parent_product_id,status:'DRAFT'},userErrors:[]}};
   if(doc.includes('OrderScan'))return {orders:{nodes:[{id:'gid://shopify/Order/12',name:'#12',cancelledAt:null,displayFinancialStatus:'PAID',lineItems:{nodes:[{currentQuantity:12,unfulfilledQuantity:12,variant:{id:batch.parent_variant_id}}],pageInfo:{hasNextPage:false}}}],pageInfo:{hasNextPage:false,endCursor:null}}};
   if(doc.includes('AllocationComponent'))return {productVariant:{id:'gid://shopify/ProductVariant/9',displayName:'Card',inventoryPolicy:'DENY',requiresComponents:false,inventoryItem:{id:'gid://shopify/InventoryItem/9',tracked:true,inventoryLevel:{quantities:[{name:'available',quantity:30}]}}}};
   if(doc.includes('ReserveBundleComponent'))return {inventoryMoveQuantities:{inventoryAdjustmentGroup:{createdAt:'now'},userErrors:[]}};
   throw Error('Unexpected API call');
 };
 try{await allocateBundle(db,batch.shop,batch.id,api);}finally{if(oldKey===undefined)delete process.env.ENCRYPTION_KEY;else process.env.ENCRYPTION_KEY=oldKey;}
 const move=calls.find(call=>call.doc.includes('ReserveBundleComponent'));
 assert.equal(move.variables.input.changes[0].quantity,24);
 assert.match(move.variables.key,/^[0-9a-f-]{36}$/);
 assert.equal(state.ledger,true);assert.equal(state.cursor,1);assert.equal(state.status,'RESERVED');assert.equal(state.mode,'READY_FOR_LIVE');
});
test('fulfilled preorder consumes its reserved component stock exactly once',async()=>{
 const oldKey=process.env.ENCRYPTION_KEY;process.env.ENCRYPTION_KEY=Buffer.alloc(32,8).toString('base64');
 const row={id:31,bundle_id:2,order_id:'gid://shopify/Order/12',variant_id:'gid://shopify/ProductVariant/9',location_id:'gid://shopify/Location/3',quantity:6,status:'RESERVED',ledger_uri:'gid://thistle/BundleAllocation/7/0',step:null};
 const seen=[];
 const db={query:async(sql,params=[])=>{
   if(sql.includes('SELECT access_token_cipher'))return {rows:[{access_token_cipher:encrypt('token',process.env.ENCRYPTION_KEY)}]};
   if(sql.includes('FROM reservation_ledger'))return {rows:row.status==='RESERVED'?[{...row}]:[]};
   if(sql.includes('SET step=')){row.step=JSON.parse(params[1]);return {rows:[]};}
   if(sql.includes('reservation_ledger SET status=')){row.status=params[1];row.step=null;return {rows:[]};}
   return {rows:[]};
 }};
 const api=async(_shop,_token,doc,variables)=>{seen.push({doc,variables});
   if(doc.includes('AllocationComponent'))return {productVariant:{id:row.variant_id,displayName:'Card',inventoryPolicy:'DENY',requiresComponents:false,inventoryItem:{id:'gid://shopify/InventoryItem/9',tracked:true,inventoryLevel:{quantities:[{name:'reserved',quantity:6},{name:'available',quantity:4}]}}}};
   if(doc.includes('AdjustBundleComponent'))return {inventoryAdjustQuantities:{inventoryAdjustmentGroup:{createdAt:'now'},userErrors:[]}};
   throw Error('Unexpected API call');
 };
 try{await settleReservation(db,'myshop.myshopify.com',{bundleId:2,orderId:row.order_id,action:'CONSUME'},api);}finally{if(oldKey===undefined)delete process.env.ENCRYPTION_KEY;else process.env.ENCRYPTION_KEY=oldKey;}
 const adjust=seen.find(x=>x.doc.includes('AdjustBundleComponent'));
 assert.equal(adjust.variables.input.changes[0].delta,-6);assert.equal(adjust.variables.input.changes[0].ledgerDocumentUri,row.ledger_uri);assert.equal(row.status,'CONSUMED');
});
test('live bundle capacity follows the scarcest available component',async()=>{
 const oldKey=process.env.ENCRYPTION_KEY;process.env.ENCRYPTION_KEY=Buffer.alloc(32,9).toString('base64');
 const bundle={id:4,parent_variant_id:'gid://shopify/ProductVariant/1',location_id:'gid://shopify/Location/3',components:[{id:'gid://shopify/ProductVariant/8',title:'A',quantity:1},{id:'gid://shopify/ProductVariant/9',title:'B',quantity:2}]};
 let written=null;
 const db={query:async sql=>sql.includes('SELECT access_token_cipher')?{rows:[{access_token_cipher:encrypt('token',process.env.ENCRYPTION_KEY)}]}:{rows:[]}};
 const api=async(_shop,_token,doc,variables)=>{
   if(doc.includes('AllocationComponent')){const available=variables.id.endsWith('/8')?9:20;return {productVariant:{id:variables.id,displayName:'Card',inventoryPolicy:'DENY',requiresComponents:false,inventoryItem:{id:variables.id.replace('ProductVariant','InventoryItem'),tracked:true,inventoryLevel:{quantities:[{name:'available',quantity:available},{name:'reserved',quantity:0}]}}}};}
   if(doc.includes('LiveParentCapacity'))return {productVariant:{id:bundle.parent_variant_id,product:{id:'gid://shopify/Product/1'},inventoryItem:{id:'gid://shopify/InventoryItem/1',tracked:true,inventoryLevel:{quantities:[{name:'available',quantity:10}]}}}};
   if(doc.includes('SetBundleInventory')){written=variables.input;return {inventorySetQuantities:{inventoryAdjustmentGroup:{createdAt:'now'},userErrors:[]}};}
   throw Error('Unexpected API call');
 };
 try{assert.equal(await syncLiveBundle(db,'myshop.myshopify.com',bundle,api),9);}finally{if(oldKey===undefined)delete process.env.ENCRYPTION_KEY;else process.env.ENCRYPTION_KEY=oldKey;}
 assert.equal(written.quantities[0].quantity,9);assert.equal(written.quantities[0].compareQuantity,10);
});
test('live refreshes are coalesced into one shop job per 30-second window',async()=>{
 const calls=[];
 const db={query:async(sql,params)=>{
   calls.push([sql,params]);
   if(sql.includes("SELECT DISTINCT shop FROM bundles"))return {rows:[{shop:'one.myshopify.com'},{shop:'two.myshopify.com'}]};
   return {rows:[]};
 }};
 await enqueueLiveRefreshes(db,60001);
 const inserts=calls.filter(([sql])=>sql.includes('INSERT INTO jobs'));
 assert.equal(inserts.length,2);
 assert.deepEqual(inserts.map(([,params])=>params[3]),[
   'one.myshopify.com:live-sync-window:2','two.myshopify.com:live-sync-window:2'
 ]);
});
