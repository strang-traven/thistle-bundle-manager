import test from 'node:test';import assert from 'node:assert/strict';
import {enqueue,processOne} from './worker.js';
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
