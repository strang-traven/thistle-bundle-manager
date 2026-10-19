import test from 'node:test';
import assert from 'node:assert/strict';
import {allocationDemand,assertTransition,liveParts,packingManifest,MODES} from './lifecycle.js';
const id=n=>`gid://shopify/ProductVariant/${n}`;
const cards=n=>Array.from({length:n},(_,i)=>({id:id(i+1),title:`Card ${i+1}`,quantity:i===0?2:1}));

test('twelve preorders calculate exact component demand',()=>{
  const demand=allocationDemand(cards(250),12);
  assert.equal(demand.length,250);assert.equal(demand[0].required,24);assert.equal(demand[249].required,12);
});
test('packing manifest retains original bundle line while itemising picks',()=>{
  const manifest=packingManifest({order_id:id(99),order_name:'#99',outstanding:2},cards(3));
  assert.equal(manifest.bundleQuantity,2);assert.deepEqual(manifest.items.map(x=>x.quantity),[4,2,2]);
});
test('large live bundles are deterministically split below Shopify limit',()=>{
  assert.deepEqual(liveParts(cards(301)).map(x=>x.components.length),[150,150,1]);
});
test('lifecycle refuses allocation without location and reconciliation',()=>{
  const bundle={mode:MODES.PREORDER,components:cards(2),location_id:null,reconciled_at:null};
  assert.throws(()=>assertTransition(bundle,MODES.ALLOCATING),/location/);
  bundle.location_id='gid://shopify/Location/1';assert.throws(()=>assertTransition(bundle,MODES.ALLOCATING),/Reconcile/);
  bundle.reconciled_at=new Date().toISOString();assert.equal(assertTransition(bundle,MODES.ALLOCATING),true);
});
test('live transition requires all reservations and all checkout parts',()=>{
  const allocating={mode:MODES.ALLOCATING,components:cards(250)};
  assert.throws(()=>assertTransition(allocating,MODES.READY_FOR_LIVE,{outstanding:12,reservedSets:11}),/do not match/);
  assert.equal(assertTransition(allocating,MODES.READY_FOR_LIVE,{outstanding:12,reservedSets:12}),true);
  const ready={...allocating,mode:MODES.READY_FOR_LIVE};
  assert.throws(()=>assertTransition(ready,MODES.LIVE,{activeParts:1}),/incomplete/);
  assert.equal(assertTransition(ready,MODES.LIVE,{activeParts:2}),true);
});
