import {assertShop,decrypt} from './security.js';
import {decodeShopifyPlan} from './plan.js';
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
}}`;
export const SHARDS=`query PlanShards($id:ID!,$keys:[String!]!,$after:String){productVariant(id:$id){metafields(first:100,keys:$keys,after:$after){nodes{key value}pageInfo{hasNextPage endCursor}}}}`;
export async function fetchBundlePlan(shop,token,parentId,request=graphql){
  if(!/^gid:\/\/shopify\/ProductVariant\/\d+$/.test(parentId))throw Error('Invalid parent variant ID');
  const p=(await request(shop,token,PARENT,{id:parentId}))?.productVariant;
  if(!p)throw Error('Shopify parent variant not found');
  if(!p.sku?.trim())throw Error('Give the bundle parent a unique SKU before syncing');
  const config=p.metafield?.value?JSON.parse(p.metafield.value):{};
  if(!config.schemaVersion)throw Error('Save the component plan in the v5 editor first');
  if(config.schemaVersion===3 && (config.shardCount<1||config.shardCount>1000))throw Error('Invalid plan shard count');
  const shards=[];
  if(config.schemaVersion===3){
    const keys=Array.from({length:config.shardCount},(_,i)=>`tt_preorders.plan_${config.bank}_${String(i).padStart(6,'0')}`);
    for(let i=0;i<keys.length;i+=100){let after=null;do{
      const r=(await request(shop,token,SHARDS,{id:parentId,keys:keys.slice(i,i+100),after}))?.productVariant?.metafields;
      if(!r)throw Error('Missing bundle plan shards');
      shards.push(...r.nodes);after=r.pageInfo.hasNextPage?r.pageInfo.endCursor:null;
    }while(after);}
  }
  const components=decodeShopifyPlan(config,shards);
  if(!components.length)throw Error('No linked singles found');
  if(components.some(c=>c.id===parentId))throw Error('A bundle cannot contain its own variant');
  return {parentVariantId:parentId,parentProductId:p.product.id,sku:p.sku.trim(),title:p.product.title,releaseDate:config.releaseDate||null,components};
}
export const ORDER_BY_ID=`query OrderForBundle($id:ID!){order(id:$id){id name cancelledAt displayFinancialStatus lineItems(first:100){nodes{currentQuantity unfulfilledQuantity variant{id}}pageInfo{hasNextPage}}}}`;
export const ORDER_SCAN=`query OrderScan($after:String,$q:String!){orders(first:40,after:$after,query:$q,sortKey:CREATED_AT,reverse:true){nodes{id name cancelledAt displayFinancialStatus lineItems(first:100){nodes{currentQuantity unfulfilledQuantity variant{id}}pageInfo{hasNextPage}}}pageInfo{hasNextPage endCursor}}}`;
export function skuQuery(sku){if(!sku||!/^[-a-zA-Z0-9_.:\/ ]{1,100}$/.test(sku))throw Error('Unsafe SKU; use a simple unique SKU for the parent');return `sku:"${sku}" status:any`;}
