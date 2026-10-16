import {createHmac,timingSafeEqual,createCipheriv,createDecipheriv,randomBytes} from 'node:crypto';
const shopPattern=/^[a-z0-9][a-z0-9-]*\.myshopify\.com$/;
export function assertShop(value,allowlist=process.env.SHOPIFY_SHOP_DOMAIN){
  const shop=String(value||'').toLowerCase();
  if(!shopPattern.test(shop)||shop.length>255)throw new Error('Invalid shop domain');
  if(allowlist&&shop!==allowlist.toLowerCase())throw new Error('Shop is not allowed');
  return shop;
}
const equal=(a,b)=>{if(a.length!==b.length)return false;return timingSafeEqual(a,b);};
export function verifyWebhook(raw,signature,secret){
  if(!secret||!signature||!Buffer.isBuffer(raw))return false;
  const expected=createHmac('sha256',secret).update(raw).digest();
  const supplied=Buffer.from(String(signature),'base64');
  return equal(expected,supplied);
}
function decodeBase64Url(value){return Buffer.from(value,'base64url');}
export function verifyIdToken(jwt,{secret,clientId,allowedShop,now=Math.floor(Date.now()/1000)}={}){
  if(typeof jwt!=='string'||jwt.length>8192)throw new Error('Missing Shopify ID token');
  const parts=jwt.split('.');
  if(parts.length!==3)throw new Error('Invalid ID token');
  let header,payload;
  try{header=JSON.parse(decodeBase64Url(parts[0]));payload=JSON.parse(decodeBase64Url(parts[1]));}catch{throw new Error('Invalid ID token encoding');}
  if(header?.alg!=='HS256'||header?.typ&&header.typ!=='JWT')throw new Error('Unsupported token signature');
  const computed=createHmac('sha256',secret).update(parts[0]+'.'+parts[1]).digest();
  if(!equal(computed,decodeBase64Url(parts[2])))throw new Error('Invalid token signature');
  if(payload.aud!==clientId||!Number.isInteger(payload.exp)||payload.exp<=now-5||
    !Number.isInteger(payload.nbf)||payload.nbf>now+5||!Number.isInteger(payload.iat)||payload.iat>now+5)throw new Error('Expired or invalid token claims');
  let shop;
  try{const dest=new URL(payload.dest);if(dest.protocol!=='https:'||dest.username||dest.password||dest.port||dest.pathname!=='/'||dest.search||dest.hash)throw Error();shop=assertShop(dest.hostname,allowedShop);}
  catch{throw new Error('Invalid token destination');}
  if(payload.iss!==`https://${shop}/admin` && payload.iss!==`https://${shop}/admin/`)throw new Error('Invalid token issuer');
  return {shop,user:payload.sub};
}
function encryptionKey(key){const result=Buffer.from(key||'','base64');if(result.length!==32)throw new Error('ENCRYPTION_KEY must be 32-byte base64');return result;}
export function encrypt(value,key){const iv=randomBytes(12);const cipher=createCipheriv('aes-256-gcm',encryptionKey(key),iv);const encrypted=Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);return [iv,cipher.getAuthTag(),encrypted].map(b=>b.toString('base64url')).join('.');}
export function decrypt(value,key){const [iv,tag,data]=String(value).split('.').map(s=>Buffer.from(s||'','base64url'));if(iv.length!==12||tag.length!==16||!data.length)throw Error('Invalid token ciphertext');const decipher=createDecipheriv('aes-256-gcm',encryptionKey(key),iv);decipher.setAuthTag(tag);return Buffer.concat([decipher.update(data),decipher.final()]).toString('utf8');}
