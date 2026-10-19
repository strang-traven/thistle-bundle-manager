import test from 'node:test';
import assert from 'node:assert/strict';
import {MAX_COMPONENTS, normaliseComponents, encodeLiveComponents, decodeLiveComponents, previewSellable, componentProblems, equalLive, makePlanShards, decodePlanShards, PLAN_CHUNK_BYTES} from '../extensions/preorder-manager/src/logic.js';
import {cartTransformRun} from '../extensions/preorder-cart-transform/src/cart_transform_run.js';
const id = n => `gid://shopify/ProductVariant/${n}`;
const cards = count => Array.from({length:count},(_,i)=>({id:id(i+1000),quantity:1,title:`Riftbound Card ${i} - Long description of card details / variant` }));
test('unlimited editor normalizes 10,000 different cards without 150 cap',()=> {
  const list=normaliseComponents(cards(10000));
  assert.equal(list.length,10000);
  assert.equal(list.at(-1).id,id(10999));
});
test('sharded storage round-trips 4,000 variants under Shopify JSON size cap',()=> {
  const original=cards(4000); const result=makePlanShards(original,'a','2027-06-17');
  assert.ok(result.fields.length>2);
  assert.equal(result.index.componentCount,4000);
  assert.equal(result.index.releaseDate,'2027-06-17');
  for(const field of result.fields) assert.ok(Buffer.byteLength(field.value)<=PLAN_CHUNK_BYTES);
  const restored=decodePlanShards(result.index,result.fields);
  assert.deepEqual(restored,original);
});
test('storage alternates banks and detects incomplete pages before publishing index',()=> {
  const a=makePlanShards(cards(4000),'a');
  const b=makePlanShards(cards(201),'b');
  assert.notEqual(a.fields[0].key,b.fields[0].key);
  assert.throws(()=>decodePlanShards(a.index,a.fields.slice(0,-1)),/Missing pre-order/);
});
test('live checkout strictly blocks over 150 even when admin plan has 151',()=> {
  assert.equal(MAX_COMPONENTS,150);
  assert.equal(normaliseComponents(cards(151)).length,151);
  assert.throws(()=>encodeLiveComponents(cards(151)),/150/);
});
test('Shopify live config round trips 150 cards',()=> {
  const value=encodeLiveComponents(cards(150));
  assert.ok(Buffer.byteLength(value)<10000);
  assert.equal(decodeLiveComponents(value).length,150);
});
test('Shopify transform expands precisely 150 items at quantity 2',()=> {
  const raw=JSON.parse(encodeLiveComponents(cards(150).map(x=>({...x,quantity:2}))));
  const r=cartTransformRun({cart:{lines:[{id:'gid://shopify/CartLine/1',merchandise:{__typename:'ProductVariant',id:id(50),liveEnabled:{value:'true'},liveConfig:{jsonValue:raw}}}]}});
  assert.equal(r.operations[0].lineExpand.expandedCartItems.length,150);
  assert.equal(r.operations[0].lineExpand.expandedCartItems[0].quantity,2);
});
test('unconfigured parent does not transform',()=> {
  assert.deepEqual(cartTransformRun({cart:{lines:[{id:'1',merchandise:{__typename:'ProductVariant',id:id(30)}}]}}),{operations:[]});
});
test('large bundle parts expand only when the complete protected group is present',()=> {
  const line=(part,components)=>({id:`line-${part}`,quantity:2,group:{value:'instance-1'},part:{value:String(part)},total:{value:'2'},merchandise:{__typename:'ProductVariant',id:id(50+part),liveEnabled:{value:'true'},liveConfig:{jsonValue:{v:2,c:components}},livePart:{jsonValue:{v:1,g:'bundle-9',p:part,t:2}}}});
  const result=cartTransformRun({cart:{lines:[line(1,[[2,1]]),line(2,[[3,1]])]}});
  assert.equal(result.operations.length,2);
  assert.throws(()=>cartTransformRun({cart:{lines:[line(1,[[2,1]])]}}),/All parts/);
});
test('prevent untracked, overselling and nested components before checkout activation',()=> {
  assert.equal(componentProblems([{id:id(1),quantity:1,title:'Card',inventoryPolicy:'CONTINUE',tracked:false,requiresComponents:true}],id(77)).length,3);
});
test('capacity estimate uses most constrained card',()=> {
  assert.equal(previewSellable([{inventoryQuantity:6,quantity:3},{inventoryQuantity:9,quantity:1}]),2);
});
test('staged changes are different to live',()=> {
  assert.equal(equalLive(cards(2),cards(3)),false);
});
