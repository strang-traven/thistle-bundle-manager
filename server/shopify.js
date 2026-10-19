import {assertShop,decrypt} from './security.js';
import {decodeShopifyPlan} from './plan.js';
import {decodeLiveComponents,encodeLiveComponents,normaliseComponents} from '../extensions/preorder-manager/src/logic.js';
const getApiVersion=()=>process.env.SHOPIFY_API_VERSION||'2026-10';
export async function exchangeOfflineToken(shop,idToken,{clientId=process.env.SHOPIFY_API_KEY,secret=process.env.SHOPIFY_API_SECRET,fetchImpl=fetch}={}){
  shop=assertShop(shop);
  const data=new URLSearchParams({client_id:clientId,client_secret:secret,
    grant_type:'urn:ietf:params:oauth:grant-type:token-exchange',
    subject_token:idToken,subject_token_type:'urn:ietf:params:oauth:token-type:id_token',
    requested_token_type:'urn:shopify:params:oauth:token-type:offline-access-token',expiring:'0'});
  const res=await fetchImpl(`https://${shop}/admin/oauth/access_token`,{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:data});
  if(!res.ok)throw new Error('Shopify token exchange failed: '+res.status);
  const json=await res.json();
  if(!json.access_token||typeof json.access_token!=='string')throw new Error('Shopify did not issue an access token');
  return json.access_token;
}
export async function graphql(shop,token,query,variables={},fetchImpl=fetch){
  shop=assertShop(shop);
  const res=await fetchImpl(`https://${shop}/admin/api/${getApiVersion()}/graphql.json`,{
    method:'POST',headers:{'Content-Type':'application/json','X-Shopify-Access-Token':token},body:JSON.stringify({query,variables}),signal:AbortSignal.timeout(25000)
  });
  if(!res.ok)throw new Error(`Shopify GraphQL HTTP ${res.status}`);
  const obj=await res.json();
  if(obj.errors?.length)throw new Error('Shopify GraphQL: '+obj.errors.map(e=>e.message).join('; ').slice(0,500));
  return obj.data;
}
export async function authShopToken(pool,shop){
  const {rows}=await pool.query('SELECT access_token_cipher FROM shops WHERE shop=$1',[shop]);
  if(!rows[0]?.access_token_cipher)throw new Error('Shopify needs to be connected from the embedded admin dashboard');
  return decrypt(rows[0].access_token_cipher,process.env.ENCRYPTION_KEY);
}
export const PARENT=`query BundleParent($id:ID!){ productVariant(id:$id){id sku displayName product{id title status}
  metafield(namespace:"tt_preorders",key:"configuration"){value}
  liveField:metafield(namespace:"tt_preorders",key:"live_components"){value}
}}`;
export const SHARDS=`query PlanShards($id:ID!,$keys:[String!]!,$after:String){productVariant(id:$id){metafields(first:100,keys:$keys,after:$after){nodes{key value}pageInfo{hasNextPage endCursor}}}}`;
export async function fetchBundlePlan(shop,token,parentId,request=graphql){
  if(!/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(parentId))throw Error('Invalid parent variant ID');
  const p=(await request(shop,token,PARENT,{id:parentId}))?.productVariant;
  if(!p)throw Error('Shopify parent variant not found');
  if(!p.sku?.trim())throw Error('Give the bundle parent a unique SKU before syncing');
  const config=p.metafield?.value?JSON.parse(p.metafield.value):{};
  let components;
  try{
    if(!config.schemaVersion)throw Error('Save the component plan first');
    if(config.schemaVersion===3 && (config.shardCount<1||config.shardCount>1000))throw Error('Invalid plan shard count');
    const shards=[];
    if(config.schemaVersion===3){
      const keys=Array.from({length:config.shardCount},(_,i)=>`tt_preorders.plan_${config.bank}_${String(i).padStart(6,'0')}`);
      for(let i=0;i<keys.length;i+=100){let after=null;do{
        const r=(await request(shop,token,SHARDS,{id:parentId,keys:keys.slice(i,i+100),after}))?.productVariant?.metafields;
        if(!r)throw Error('Missing bundle plan pages');
        shards.push(...r.nodes);after=r.pageInfo.hasNextPage?r.pageInfo.endCursor:null;
      }while(after);}
    }
    components=decodeShopifyPlan(config,shards);
  }catch(error){
    if(!p.liveField?.value)throw error;
    components=decodeLiveComponents(p.liveField.value);
  }
  if(!components.length)throw Error('No linked singles found');
  if(components.some(c=>c.id===parentId))throw Error('A bundle cannot contain its own variant');
  return {parentVariantId:parentId,parentProductId:p.product.id,sku:p.sku.trim(),title:p.product.title,releaseDate:config.releaseDate||null,components};
}
export const ORDER_BY_ID=`query OrderForBundle($id:ID!){order(id:$id){id name cancelledAt displayFinancialStatus lineItems(first:100){nodes{currentQuantity unfulfilledQuantity variant{id}}pageInfo{hasNextPage}}}}`;
export const ORDER_SCAN=`query OrderScan($after:String,$q:String!){orders(first:40,after:$after,query:$q,sortKey:CREATED_AT,reverse:true){nodes{id name cancelledAt displayFinancialStatus lineItems(first:100){nodes{currentQuantity unfulfilledQuantity variant{id}}pageInfo{hasNextPage}}}pageInfo{hasNextPage endCursor}}}`;
export function skuQuery(sku){if(!sku||!/^[-a-zA-Z0-9_.:\/ ]{1,100}$/.test(sku))throw Error('Unsafe SKU; use a simple unique SKU for the parent');return `sku:"${sku}" status:any`;}

const CREATE_PRODUCT=`mutation CreateBundleProduct($product:ProductCreateInput!){productCreate(product:$product){product{id title variants(first:1){nodes{id}}}userErrors{field message}}}`;
const UPDATE_VARIANT=`mutation UpdateBundleVariant($productId:ID!,$variants:[ProductVariantsBulkInput!]!){productVariantsBulkUpdate(productId:$productId,variants:$variants){productVariants{id sku price}userErrors{field message}}}`;
const COMPONENTS=`query BundleComponents($ids:[ID!]!){nodes(ids:$ids){... on ProductVariant{id displayName requiresComponents inventoryPolicy inventoryItem{tracked}}}}`;
const SET_METAFIELDS=`mutation SaveBundleFields($metafields:[MetafieldsSetInput!]!){metafieldsSet(metafields:$metafields){metafields{key value}userErrors{field message code}}}`;
const CART_TRANSFORMS=`query ActiveCartTransforms{cartTransforms(first:10){nodes{id}}}`;
const CREATE_CART_TRANSFORM=`mutation ActivateBundleTransform($functionHandle:String!,$blockOnFailure:Boolean!){cartTransformCreate(functionHandle:$functionHandle,blockOnFailure:$blockOnFailure){cartTransform{id}userErrors{field message}}}`;

function checked(result,label){
  if(result?.userErrors?.length)throw Error(`${label}: `+result.userErrors.map(e=>e.message).join('; '));
  return result;
}
export function validateBundleInput(body){
  const title=String(body?.title||'').trim();
  const sku=String(body?.sku||'').trim();
  const price=String(body?.price||'').trim();
  if(!title||title.length>255)throw Error('Enter a bundle product name (maximum 255 characters)');
  if(!/^[-a-zA-Z0-9_.:\/ ]{1,100}$/.test(sku))throw Error('Enter a simple unique bundle SKU');
  if(!/^\d+(\.\d{1,2})?$/.test(price)||Number(price)<=0)throw Error('Enter a valid bundle price greater than zero');
  return {title,sku,price:Number(price).toFixed(2)};
}
export async function createBundleProduct(shop,token,body,request=graphql){
  const input=validateBundleInput(body);
  const created=checked((await request(shop,token,CREATE_PRODUCT,{product:{title:input.title,status:'DRAFT',productType:'Bundle',tags:['Thistle Bundle']}}))?.productCreate,'Create product');
  const productId=created?.product?.id, variantId=created?.product?.variants?.nodes?.[0]?.id;
  if(!productId||!variantId)throw Error('Shopify created the product but did not return its default variant');
  checked((await request(shop,token,UPDATE_VARIANT,{productId,variants:[{id:variantId,price:input.price,inventoryPolicy:'DENY',inventoryItem:{sku:input.sku,tracked:true}}]}))?.productVariantsBulkUpdate,'Update bundle variant');
  return {productId,parentVariantId:variantId,title:input.title,sku:input.sku,price:input.price,status:'DRAFT'};
}
export async function ensureCartTransform(shop,token,request=graphql){
  const existing=(await request(shop,token,CART_TRANSFORMS))?.cartTransforms?.nodes||[];
  if(existing.length)return {id:existing[0].id,created:false};
  const made=checked((await request(shop,token,CREATE_CART_TRANSFORM,{functionHandle:'thistle-preorder-cart-transform',blockOnFailure:true}))?.cartTransformCreate,'Activate checkout bundle transform');
  if(!made?.cartTransform?.id)throw Error('Shopify did not activate the checkout bundle transform');
  return {id:made.cartTransform.id,created:true};
}
export async function saveLiveBundle(shop,token,body,request=graphql){
  const parentId=String(body?.parentVariantId||'');
  if(!/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(parentId))throw Error('Select a valid parent product variant');
  const releaseDate=String(body?.releaseDate||'').trim();
  if(releaseDate&&!/^\d{4}-\d{2}-\d{2}$/.test(releaseDate))throw Error('Release date must use YYYY-MM-DD');
  const components=normaliseComponents(body?.components);
  encodeLiveComponents(components);
  if(components.some(c=>c.id===parentId))throw Error('A bundle cannot contain its own parent variant');
  const details=[];
  for(let i=0;i<components.length;i+=50){
    const result=(await request(shop,token,COMPONENTS,{ids:components.slice(i,i+50).map(c=>c.id)}))?.nodes||[];
    details.push(...result);
  }
  const byId=new Map(details.filter(Boolean).map(v=>[v.id,v]));
  const problems=[];
  for(const c of components){const v=byId.get(c.id);if(!v)problems.push(`${c.title}: variant not found`);else if(v.requiresComponents)problems.push(`${v.displayName}: nested bundles are not supported`);}
  if(problems.length)throw Error(problems.slice(0,5).join('; '));
  const liveValue=encodeLiveComponents(components);
  const config={schemaVersion:2,releaseDate,components};
  const saved=await request(shop,token,SET_METAFIELDS,{metafields:[
    {ownerId:parentId,namespace:'tt_preorders',key:'configuration',type:'json',value:JSON.stringify(config)},
    {ownerId:parentId,namespace:'tt_preorders',key:'live_components',type:'json',value:liveValue},
    {ownerId:parentId,namespace:'tt_preorders',key:'live_enabled',type:'boolean',value:'true'},
  ]});
  checked(saved?.metafieldsSet,'Activate bundle');
  await ensureCartTransform(shop,token,request);
  return {parentVariantId:parentId,components,releaseDate};
}

