import test from 'node:test';
import assert from 'node:assert/strict';
import {createBundleProduct,ensureCartTransform,fetchBundlePlan,saveLiveBundle,validateBundleInput} from './shopify.js';

const shop='example.myshopify.com', token='token', id=n=>`gid://shopify/ProductVariant/${n}`;

test('bundle product input is normalised and rejects invalid money',()=>{
  assert.deepEqual(validateBundleInput({title:' Set ',sku:'SET-1',price:'12.5'}),{title:'Set',sku:'SET-1',price:'12.50'});
  assert.throws(()=>validateBundleInput({title:'Set',sku:'SET-1',price:'free'}),/valid bundle price/);
});

test('creating a bundle makes a draft product and updates its default variant',async()=>{
  const calls=[];
  const request=async(_shop,_token,query,variables)=>{calls.push({query,variables});return calls.length===1
    ?{productCreate:{product:{id:'gid://shopify/Product/8',title:'Set',variants:{nodes:[{id:id(9)}]}},userErrors:[]}}
    :{productVariantsBulkUpdate:{productVariants:[{id:id(9),sku:'SET-1',price:'12.50'}],userErrors:[]}};};
  const result=await createBundleProduct(shop,token,{title:'Set',sku:'SET-1',price:'12.50'},request);
  assert.equal(result.parentVariantId,id(9));
  assert.equal(calls[0].variables.product.status,'DRAFT');
  assert.deepEqual(calls[1].variables.variants[0].inventoryItem,{sku:'SET-1',tracked:true});
});

test('saving a live bundle writes plan, live components, enabled flag and transform',async()=>{
  const calls=[];
  const request=async(_shop,_token,query,variables)=>{calls.push({query,variables});
    if(query.includes('BundleComponents'))return {nodes:[{id:id(2),displayName:'Card',requiresComponents:false,inventoryPolicy:'DENY',inventoryItem:{tracked:true}}]};
    if(query.includes('SaveBundleFields'))return {metafieldsSet:{metafields:variables.metafields,userErrors:[]}};
    if(query.includes('ActiveCartTransforms'))return {cartTransforms:{nodes:[{id:'gid://shopify/CartTransform/1'}]}};
    throw Error('unexpected query');
  };
  const result=await saveLiveBundle(shop,token,{parentVariantId:id(1),releaseDate:'2027-01-02',components:[{id:id(2),title:'Card',quantity:2}]},request);
  assert.equal(result.components[0].quantity,2);
  const finalWrite=calls.filter(c=>c.query.includes('SaveBundleFields')).at(-1).variables.metafields;
  assert.equal(finalWrite.find(x=>x.key==='live_enabled').value,'true');
  assert.match(finalWrite.find(x=>x.key==='live_components').value,/"v":2/);
  assert.match(finalWrite.find(x=>x.key==='configuration').value,/"schemaVersion":2/);
});

test('an incomplete old paged plan recovers from its live component field',async()=>{
  const request=async(_shop,_token,query)=>query.includes('BundleParent')?{productVariant:{id:id(1),sku:'SET-1',product:{id:'gid://shopify/Product/1',title:'Set',status:'DRAFT'},metafield:{value:JSON.stringify({schemaVersion:3,bank:'a',shardCount:1,componentCount:1})},liveField:{value:JSON.stringify({v:2,c:[[2,3]]})}}}:{productVariant:{metafields:{nodes:[],pageInfo:{hasNextPage:false,endCursor:null}}}};
  const result=await fetchBundlePlan(shop,token,id(1),request);
  assert.deepEqual(result.components,[{id:id(2),quantity:3,title:id(2)}]);
});

test('cart transform is only created when the app has none',async()=>{
  let count=0;
  const request=async(_shop,_token,query)=>{count++;return query.includes('ActiveCartTransforms')?{cartTransforms:{nodes:[]}}:{cartTransformCreate:{cartTransform:{id:'gid://shopify/CartTransform/2'},userErrors:[]}};};
  const result=await ensureCartTransform(shop,token,request);
  assert.equal(result.created,true);assert.equal(count,2);
});

