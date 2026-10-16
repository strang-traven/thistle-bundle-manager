import test from 'node:test';
import assert from 'node:assert/strict';
import {createReservationService,assertRetrySafe,makeMove,makeAdjust,checkStock} from '../extensions/preorder-manager/src/reservations.js';

const P='gid://shopify/ProductVariant/90001';
const L='gid://shopify/Location/11';
function makeMock(count,{failAt=null,failCheckpoint=false}={}) {
  const parent={id:P,displayName:'Full set',inventoryPolicy:'DENY',inventoryQuantity:0,requiresComponents:false,
    product:{id:'gid://shopify/Product/900',title:'Full Set',status:'DRAFT'},
    inventoryItem:{id:'gid://shopify/InventoryItem/90001',tracked:true,
      inventoryLevels:{nodes:[{location:{id:L,name:'Aberdeen'},quantities:[{name:'available',quantity:0},{name:'on_hand',quantity:0},{name:'committed',quantity:0},{name:'reserved',quantity:0}]}],pageInfo:{hasNextPage:false}}},
    plan:{value:'{}',compareDigest:'index1'},job:null,oldLive:null};
  const variants=Array.from({length:count},(_,i)=>({
    id:`gid://shopify/ProductVariant/${i+1}`,displayName:`Card ${i+1}`,inventoryPolicy:'DENY',requiresComponents:false,
    inventoryItem:{id:`gid://shopify/InventoryItem/${i+1}`,tracked:true,
      inventoryLevels:{nodes:[{location:{id:L,name:'Aberdeen'},quantities:[{name:'available',quantity:30},{name:'reserved',quantity:0},{name:'on_hand',quantity:30}]}],pageInfo:{hasNextPage:false}}}}));
  const cards=variants.map(v=>({id:v.id,quantity:1,title:v.displayName}));
  const states=new Map(variants.map(v=>[v.id,v]));
  let revision=0,reservations=0,published=0,consumed=0,failOne=failAt,checkpoint=failCheckpoint;
  const idempotent=new Map();
  function state(n,name){return n.inventoryItem.inventoryLevels.nodes[0].quantities.find(q=>q.name===name);}
  function result(data){return {data};}
  const api=async (doc,vars)=>{
    if(doc.includes('query AllocationParent'))return result({productVariant:structuredClone(parent)});
    if(doc.includes('query AllocationComponents'))return result({nodes:vars.ids.map(id=>states.has(id)?structuredClone(states.get(id)):null)});
    if(doc.includes('mutation SaveAllocation')){
      const input=vars.metafields[0];
      assert.equal(input.compareDigest,parent.job?.compareDigest??null,'CAS journal digest matches');
      const next=JSON.parse(input.value);
      if(checkpoint && next.cursor===1 && next.step===null && next.status==='reserving'){
        checkpoint=false;throw new Error('Simulated response timeout after stock moved, before checkpoint.');
      }
      revision++;parent.job={value:input.value,compareDigest:'rev'+revision};
      return result({metafieldsSet:{metafields:[{compareDigest:parent.job.compareDigest,value:input.value,key:'allocation_job'}],userErrors:[]}});
    }
    if(doc.includes('mutation AllocateMove')){
      if(idempotent.has(vars.key))return result({inventoryMoveQuantities:{inventoryAdjustmentGroup:{createdAt:'now'},userErrors:[]}});
      const item=vars.input.changes[0];const itemId=item.inventoryItemId.replace('InventoryItem','ProductVariant');
      const variant=states.get(itemId),from=state(variant,item.from.name),to=state(variant,item.to.name);
      if(failOne===item.inventoryItemId){failOne=null;throw new Error('Simulated stock move failure');}
      if(from.quantity!==item.from.changeFromQuantity || from.quantity<item.quantity)return result({inventoryMoveQuantities:{userErrors:[{message:'Insufficient / stale stock'}]}});
      from.quantity-=item.quantity;to.quantity+=item.quantity;reservations++;idempotent.set(vars.key,true);
      return result({inventoryMoveQuantities:{inventoryAdjustmentGroup:{createdAt:'now'},userErrors:[]}});
    }
    if(doc.includes('mutation AllocateAdjust')){
      if(idempotent.has(vars.key))return result({inventoryAdjustQuantities:{inventoryAdjustmentGroup:{createdAt:'now'},userErrors:[]}});
      const item=vars.input.changes[0];
      const variant=item.inventoryItemId===parent.inventoryItem.id?parent:states.get(item.inventoryItemId.replace('InventoryItem','ProductVariant'));
      const from=state(variant,vars.input.name);
      if(from.quantity!==item.changeFromQuantity)return result({inventoryAdjustQuantities:{userErrors:[{message:'Stale parent/reserved state'}]}});
      if(from.quantity+item.delta<0)return result({inventoryAdjustQuantities:{userErrors:[{message:'Negative inventory'}]}});
      from.quantity+=item.delta;
      if(vars.input.name==='available' && variant===parent){state(parent,'on_hand').quantity+=item.delta;parent.inventoryQuantity+=item.delta;published++;}
      if(vars.input.name==='reserved'){state(variant,'on_hand').quantity+=item.delta;consumed++;}
      idempotent.set(vars.key,true);
      return result({inventoryAdjustQuantities:{inventoryAdjustmentGroup:{createdAt:'now'},userErrors:[]}});
    }
    throw new Error('Unexpected GraphQL document '+doc.slice(0,45));
  };
  return {api, parent,variants,cards,service:createReservationService(api),
    counts:()=>({reservations,published,consumed}),state,location:L};
}

test('large 220-card set reserves stock then publishes one Shopify parent variant',async()=>{
 const m=makeMock(220); const progress=[];
 await m.service.begin({variantId:P,cards:m.cards,planDigest:'index1',locationId:L,sets:3,onProgress:s=>progress.push(s)});
 assert.equal(m.state(m.parent,'available').quantity,0);
 const job=await m.service.resume({variantId:P,cards:m.cards,onProgress:s=>progress.push(s)});
 assert.equal(job.status,'active');assert.equal(job.totalAllocated,3);
 assert.equal(m.state(m.parent,'available').quantity,3);
 assert.equal(m.counts().reservations,220);assert.equal(m.counts().published,1);
 assert.equal(m.variants[0].inventoryItem.inventoryLevels.nodes[0].quantities[0].quantity,27);
 assert.equal(m.variants[0].inventoryItem.inventoryLevels.nodes[0].quantities[1].quantity,3);
 await assert.rejects(m.service.begin({variantId:P,cards:m.cards,planDigest:'index2',locationId:L,sets:1}),/saved card list changed/i);
});

test('no parent stock made available when one component fails, resume after recovery',async()=>{
 const m=makeMock(84,{failAt:'gid://shopify/InventoryItem/52'});
 await m.service.begin({variantId:P,cards:m.cards,planDigest:'index1',locationId:L,sets:2});
 await assert.rejects(m.service.resume({variantId:P,cards:m.cards}),/Simulated stock move failure/);
 assert.equal(m.state(m.parent,'available').quantity,0);
 assert.equal(m.counts().reservations,51);
 const pending=(await m.service.readParent(P)).job;
 assert.equal(pending.status,'reserving');assert.equal(pending.cursor,51);
 await m.service.resume({variantId:P,cards:m.cards});
 assert.equal(m.state(m.parent,'available').quantity,2);
 assert.equal(m.counts().reservations,84);
});

test('a journal-save timeout retries the SAME Shopify idempotency key without double moving',async()=>{
 const m=makeMock(3,{failCheckpoint:true});
 await m.service.begin({variantId:P,cards:m.cards,planDigest:'index1',locationId:L,sets:1});
 await assert.rejects(m.service.resume({variantId:P,cards:m.cards}),/timeout/);
 assert.equal(m.counts().reservations,1);
 await m.service.resume({variantId:P,cards:m.cards});
 assert.equal(m.counts().reservations,3);
 assert.equal(m.state(m.parent,'available').quantity,1);
});

test('consuming shipped stock is prohibited until Shopify parent was fulfilled',async()=>{
 const m=makeMock(4);
 await m.service.begin({variantId:P,cards:m.cards,planDigest:'index1',locationId:L,sets:5});
 await m.service.resume({variantId:P,cards:m.cards});
 await assert.rejects(m.service.beginConsume({variantId:P,planDigest:'index1',count:1}),/Only 0/);
 m.state(m.parent,'on_hand').quantity-=2;m.parent.inventoryQuantity-=2;
 await m.service.beginConsume({variantId:P,planDigest:'index1',count:2});
 const done=await m.service.resume({variantId:P,cards:m.cards});
 assert.equal(done.totalConsumed,2);
 assert.equal(m.counts().consumed,4);
 assert.equal(m.state(m.variants[0],'reserved').quantity,3);
 assert.equal(m.state(m.variants[0],'on_hand').quantity,28);
});

test('second top-up shares locked card list and adds parent only after another reservation',async()=>{
 const m=makeMock(2);
 await m.service.begin({variantId:P,cards:m.cards,planDigest:'index1',locationId:L,sets:2});
 await m.service.resume({variantId:P,cards:m.cards});
 await m.service.begin({variantId:P,cards:m.cards,planDigest:'index1',locationId:L,sets:3});
 await m.service.resume({variantId:P,cards:m.cards});
 assert.equal(m.state(m.parent,'available').quantity,5);
 assert.equal((await m.service.readParent(P)).job.totalAllocated,5);
 assert.equal(m.state(m.variants[0],'reserved').quantity,5);
});

test('expired 24-hour ambiguity cannot be replayed blindly',()=>{
 assert.throws(()=>assertRetrySafe({issuedAt:new Date(Date.now()-25*3600*1000).toISOString()}),/Do NOT retry/);
 assert.doesNotThrow(()=>assertRetrySafe({issuedAt:new Date().toISOString()}));
});

test('1,000 distinct cards can be reserved for a single normal checkout parent',async()=>{
 const m=makeMock(1000);
 await m.service.begin({variantId:P,cards:m.cards,planDigest:'index1',locationId:L,sets:1});
 const job=await m.service.resume({variantId:P,cards:m.cards});
 assert.equal(job.status,'active');assert.equal(m.counts().reservations,1000);
 assert.equal(m.state(m.parent,'available').quantity,1);
});

test('cannot top up a product when manual parent stock drifted from the allocation ledger',async()=>{
 const m=makeMock(2);
 await m.service.begin({variantId:P,cards:m.cards,planDigest:'index1',locationId:L,sets:3});
 await m.service.resume({variantId:P,cards:m.cards});
 m.state(m.parent,'on_hand').quantity+=1;
 await assert.rejects(m.service.begin({variantId:P,cards:m.cards,planDigest:'index1',locationId:L,sets:1}),/does not match previously allocated/i);
});
