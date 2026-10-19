import test from 'node:test';
import assert from 'node:assert/strict';
import {configureLargeLiveBundle,createBundleProduct,ensureCartTransform,fetchBundlePlan,saveLiveBundle,stageBundlePlan,validateBundleInput} from './shopify.js';

const shop='example.myshopify.com', token='token', id=n=>`gid://shopify/ProductVariant/${n}`;

test('bundle product input is normalised and requires the pre-order controls',()=>{
  assert.deepEqual(validateBundleInput({title:' Set ',sku:'SET-1',price:'12.5',preorderLimit:40,releaseDate:'2027-01-02',locationId:'gid://shopify/Location/3'}),{title:'Set',sku:'SET-1',price:'12.50',preorderLimit:40,releaseDate:'2027-01-02',locationId:'gid://shopify/Location/3'});
  assert.throws(()=>validateBundleInput({title:'Set',sku:'SET-1',price:'free'}),/valid bundle price/);
});

test('creating a bundle makes an active capped preorder at one location',async()=>{
  const calls=[];
  const request=async(_shop,_token,query,variables)=>{calls.push({query,variables});
    if(query.includes('BundleLocations'))return {locations:{nodes:[{id:'gid://shopify/Location/3',name:'Main'}]}};
    if(query.includes('CreateBundleProduct'))return {productCreate:{product:{id:'gid://shopify/Product/8',title:'Set',variants:{nodes:[{id:id(9)}]}},userErrors:[]}};
    if(query.includes('UpdateBundleVariant'))return {productVariantsBulkUpdate:{productVariants:[{id:id(9),sku:'SET-1',price:'12.50'}],userErrors:[]}};
    if(query.includes('BundleVariantInventory'))return {productVariant:{id:id(9),inventoryItem:{id:'gid://shopify/InventoryItem/4'}}};
    if(query.includes('ActivateBundleInventory'))return {inventoryActivate:{inventoryLevel:{id:'gid://shopify/InventoryLevel/5'},userErrors:[]}};
    if(query.includes('SetBundleInventory'))return {inventorySetQuantities:{inventoryAdjustmentGroup:{createdAt:'now'},userErrors:[]}};
    if(query.includes('SalesPublications'))return {publications:{nodes:[{id:'gid://shopify/Publication/1',catalog:{title:'Online Store'}}]}};
    if(query.includes('PublishBundlePart'))return {publishablePublish:{userErrors:[]}};
    throw Error('unexpected query');
  };
  const result=await createBundleProduct(shop,token,{title:'Set',sku:'SET-1',price:'12.50',preorderLimit:40,releaseDate:'2027-01-02',locationId:'gid://shopify/Location/3'},request);
  assert.equal(result.parentVariantId,id(9));
  assert.equal(calls.find(c=>c.query.includes('CreateBundleProduct')).variables.product.status,'ACTIVE');
  assert.deepEqual(calls.find(c=>c.query.includes('UpdateBundleVariant')).variables.variants[0].inventoryItem,{sku:'SET-1',tracked:true});
  assert.equal(calls.find(c=>c.query.includes('SetBundleInventory')).variables.input.quantities[0].quantity,40);
  assert.equal(calls.find(c=>c.query.includes('PublishBundlePart')).variables.input[0].publicationId,'gid://shopify/Publication/1');
});

test('saving a live bundle writes plan, live components, enabled flag and transform',async()=>{
  const calls=[];
  const request=async(_shop,_token,query,variables)=>{calls.push({query,variables});
    if(query.includes('BundleParentSetup'))return {productVariant:{id:id(1),product:{id:'gid://shopify/Product/1'}}};
    if(query.includes('BundleComponents'))return {nodes:[{id:id(2),displayName:'Card',requiresComponents:false,inventoryPolicy:'DENY',inventoryItem:{tracked:true}}]};
    if(query.includes('UpdateBundleVariant'))return {productVariantsBulkUpdate:{productVariants:[{id:id(1)}],userErrors:[]}};
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

test('bundle activation refuses components that Shopify would oversell',async()=>{
  const request=async(_shop,_token,query)=>{
    if(query.includes('BundleParentSetup'))return {productVariant:{id:id(1),product:{id:'gid://shopify/Product/1'}}};
    if(query.includes('BundleComponents'))return {nodes:[{id:id(2),displayName:'Unsafe card',requiresComponents:false,inventoryPolicy:'CONTINUE',inventoryItem:{tracked:true}}]};
    throw Error('unexpected query');
  };
  await assert.rejects(saveLiveBundle(shop,token,{parentVariantId:id(1),components:[{id:id(2),title:'Unsafe card',quantity:1}]},request),/Continue selling/);
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
test('staged plans support hundreds of variants without activating checkout',async()=>{
  const list=Array.from({length:250},(_,i)=>({id:id(i+10),title:`Card ${i}`,quantity:1}));
  let writes=0;
  const request=async(_shop,_token,query,variables)=>{
    if(query.includes('StagedBundleParent'))return {productVariant:{id:id(1),sku:'BIG-SET',product:{id:'gid://shopify/Product/1',title:'Big Set',status:'DRAFT'}}};
    if(query.includes('BundleComponents'))return {nodes:variables.ids.map((variantId,i)=>({id:variantId,displayName:`Card ${i}`,requiresComponents:false,inventoryPolicy:'DENY',inventoryItem:{tracked:true}}))};
    writes++;throw Error('unexpected mutation');
  };
  const result=await stageBundlePlan(shop,token,{parentVariantId:id(1),components:list},request);
  assert.equal(result.components.length,250);assert.equal(writes,0);
});
test('large live bundle creates hidden zero-price parts and publishes one atomic storefront plan',async()=>{
  const calls=[];
  const request=async(_shop,_token,query,variables)=>{calls.push({query,variables});
    if(query.includes('BundlePublications'))return {product:{resourcePublications:{nodes:[{publication:{id:'gid://shopify/Publication/1'}}]}}};
    if(query.includes('InternalBundlePart'))return {productByIdentifier:null};
    if(query.includes('CreateBundleProduct'))return {productCreate:{product:{id:'gid://shopify/Product/2',title:'Internal',handle:'thistle-internal-7-part-2',variants:{nodes:[{id:id(202)}]}},userErrors:[]}};
    if(query.includes('UpdateBundleVariant'))return {productVariantsBulkUpdate:{productVariants:[{id:id(202)}],userErrors:[]}};
    if(query.includes('PublishBundlePart'))return {publishablePublish:{userErrors:[]}};
    if(query.includes('SaveBundleFields'))return {metafieldsSet:{metafields:variables.metafields,userErrors:[]}};
    if(query.includes('ActiveCartTransforms'))return {cartTransforms:{nodes:[{id:'gid://shopify/CartTransform/1'}]}};
    throw Error('unexpected query');
  };
  const result=await configureLargeLiveBundle(shop,token,{bundleId:7,title:'Set',parentProductId:'gid://shopify/Product/1',parentVariantId:id(201),parts:[{components:[{id:id(1),title:'A',quantity:1}]},{components:[{id:id(2),title:'B',quantity:1}]}]},request);
  assert.equal(result.length,2);
  assert.equal(calls.find(c=>c.query.includes('UpdateBundleVariant')).variables.variants[0].price,'0.00');
  assert.equal(calls.find(c=>c.query.includes('PublishBundlePart')).variables.input[0].publicationId,'gid://shopify/Publication/1');
  const plan=calls.filter(c=>c.query.includes('SaveBundleFields')).flatMap(c=>c.variables.metafields).find(x=>x.key==='large_bundle_parts');
  assert.deepEqual(JSON.parse(plan.value),[201,202]);
});
