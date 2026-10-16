import test from 'node:test';import assert from 'node:assert/strict';
import {fixedBundleParts,orderExposure} from './plan.js';
const variants=n=>Array.from({length:n},(_,i)=>({id:`gid://shopify/ProductVariant/${i+1000}`,quantity:1,title:'Card '+(i+1)}));
test('250 card set results in nine fixed bundle parts of at most 30',()=>{
 const groups=fixedBundleParts(variants(250));
 assert.deepEqual(groups.map(g=>g.items.length),[30,30,30,30,30,30,30,30,10]);
 assert.equal(groups.flatMap(g=>g.items).length,250);
});
test('1000 card set stays within part maximum and preserves variant identity',()=>{
 const groups=fixedBundleParts(variants(1000));
 assert.equal(groups.length,34);
 assert.deepEqual(groups.flatMap(g=>g.items).map(v=>v.id),variants(1000).map(v=>v.id));
});
test('order tally ignores cancellations and refunds',()=>{
 const order={id:'gid://shopify/Order/5',name:'#5',displayFinancialStatus:'PAID',lineItems:{nodes:[{variant:{id:'gid://shopify/ProductVariant/1000'},currentQuantity:2,unfulfilledQuantity:1}],pageInfo:{hasNextPage:false}}};
 assert.deepEqual([orderExposure(order,'gid://shopify/ProductVariant/1000').purchased,orderExposure(order,'gid://shopify/ProductVariant/1000').outstanding],[2,1]);
 assert.equal(orderExposure({...order,cancelledAt:'today'},'gid://shopify/ProductVariant/1000').outstanding,0);
 assert.equal(orderExposure({...order,displayFinancialStatus:'REFUNDED'},'gid://shopify/ProductVariant/1000').purchased,0);
});
test('a huge Shopify order is rejected before importing partial data',()=>{
 assert.throws(()=>orderExposure({lineItems:{nodes:[],pageInfo:{hasNextPage:true}}},'any'),/100/);
});
