import test from 'node:test';
import assert from 'node:assert/strict';
import {stockCapacityByLocation,preorderOrderTally,safeSkuSearch} from '../extensions/preorder-manager/src/insights.js';

const L='gid://shopify/Location/1', E='gid://shopify/Location/2';
const V=i=>`gid://shopify/ProductVariant/${i}`;
const makeRow=(i,aberdeen,edinburgh)=>({id:V(i),inventoryPolicy:'DENY',requiresComponents:false,
 inventoryItem:{tracked:true,inventoryLevels:{nodes:[
 {location:{id:L,name:'Aberdeen'},quantities:[{name:'available',quantity:aberdeen}]},
 {location:{id:E,name:'Edinburgh'},quantities:[{name:'available',quantity:edinburgh}]}
 ]}}});
test('1000-card set bottleneck, card sale immediately lowers computed potential capacity',()=>{
 const cards=Array.from({length:1000},(_,i)=>({id:V(i+1),quantity:1,title:'Card '+i}));
 const variants=cards.map((c,i)=>makeRow(i+1,i===5?4:30, i===5?2:20));
 let result=stockCapacityByLocation(cards,variants);
 assert.equal(result.find(x=>x.locationId===L).possible,4);
 assert.equal(result.find(x=>x.locationId===E).possible,2);
 variants[5].inventoryItem.inventoryLevels.nodes[0].quantities[0].quantity=3;
 result=stockCapacityByLocation(cards,variants);
 assert.equal(result.find(x=>x.locationId===L).possible,3);
});
test('required quantities and reserved stock are handled using Shopify AVAILABLE only',()=>{
 const cards=[{id:V(1),quantity:2,title:'Foil'}, {id:V(2),quantity:1,title:'Non-foil'}];
 const result=stockCapacityByLocation(cards,[makeRow(1,5,1),makeRow(2,9,4)]);
 assert.equal(result.find(x=>x.locationId===L).possible,2);
 assert.equal(result.find(x=>x.locationId===E).possible,0);
});
test('missing/untracked/overselling variant fails capacity closed',()=>{
 const cards=[{id:V(1),quantity:1,title:'X'},{id:V(2),quantity:1,title:'Y'}];
 assert.equal(stockCapacityByLocation(cards,[makeRow(1,9,9)]).every(x=>x.possible===0),true);
 const a=makeRow(2,7,7);a.inventoryPolicy='CONTINUE';
 assert.equal(stockCapacityByLocation(cards,[makeRow(1,9,9),a]).every(x=>x.possible===0),true);
});
test('order tally counts unfulfilled and excludes canceled and refunded',()=>{
 const line=(id,c,u)=>({variant:{id},currentQuantity:c,unfulfilledQuantity:u});
 const orders=[
  {cancelledAt:null,displayFinancialStatus:'PAID',lineItems:{nodes:[line(V(1),2,2),line(V(2),3,3)]}},
  {cancelledAt:null,displayFinancialStatus:'PAID',lineItems:{nodes:[line(V(1),1,0)]}},
  {cancelledAt:'now',displayFinancialStatus:'PAID',lineItems:{nodes:[line(V(1),6,6)]}},
  {cancelledAt:null,displayFinancialStatus:'REFUNDED',lineItems:{nodes:[line(V(1),4,4)]}}
 ];
 assert.deepEqual(preorderOrderTally(orders,V(1)),{purchased:3,unfulfilled:2,ordersMatched:2,excludedCanceled:1,unpaid:1});
});
test('SKU filter rejects unsafe or missing search data',()=>{
 assert.equal(safeSkuSearch('PREORDER-SET-123'),'sku:"PREORDER-SET-123" status:any');
 assert.throws(()=>safeSkuSearch(''),/SKU/);
 assert.throws(()=>safeSkuSearch('hello" world'),/SKU/);
});
