import test from 'node:test';import assert from 'node:assert/strict';import {createHmac,randomBytes} from 'node:crypto';
import {verifyWebhook,verifyIdToken,encrypt,decrypt,assertShop} from './security.js';
test('valid and forged Shopify webhook signatures',()=>{
 const body=Buffer.from('{"id":123}');const signature=createHmac('sha256','secret').update(body).digest('base64');
 assert.equal(verifyWebhook(body,signature,'secret'),true);
 assert.equal(verifyWebhook(Buffer.from('{"id":124}'),signature,'secret'),false);
 assert.equal(verifyWebhook(body,signature.slice(2),'secret'),false);
});
test('Shopify ID tokens validate signature, claims, dest, issuer and shop',()=>{
 const now=1750000000,shop='thistle-tavern.myshopify.com';
 const header=Buffer.from(JSON.stringify({alg:'HS256',typ:'JWT'})).toString('base64url');
 function token(p){const pay=Buffer.from(JSON.stringify(p)).toString('base64url');const body=header+'.'+pay;return body+'.'+createHmac('sha256','secret').update(body).digest('base64url');}
 const p={aud:'client',exp:now+50,nbf:now-20,iat:now-20,dest:'https://'+shop+'/',iss:`https://${shop}/admin`,sub:'123'};
 assert.equal(verifyIdToken(token(p),{secret:'secret',clientId:'client',allowedShop:shop,now}).shop,shop);
 assert.throws(()=>verifyIdToken(token({...p,aud:'other'}),{secret:'secret',clientId:'client',now}),/claims/);
 assert.throws(()=>verifyIdToken(token({...p,dest:'https://evil.net/'}),{secret:'secret',clientId:'client',now}),/destination/);
 assert.throws(()=>verifyIdToken(token({...p,exp:now-100}),{secret:'secret',clientId:'client',now}),/claims/);
});
test('AES-256-GCM access-token encryption round trips and rejects altered ciphertext',()=>{
 const key=randomBytes(32).toString('base64'), value=encrypt('shpat_secret',key);
 assert.equal(decrypt(value,key),'shpat_secret');
 const parts=value.split('.');parts[2]=Buffer.from('broken').toString('base64url');
 assert.throws(()=>decrypt(parts.join('.'),key));
});
test('shop domain allowlist rejects external domains',()=>{
 assert.equal(assertShop('shop.myshopify.com'),'shop.myshopify.com');
 assert.throws(()=>assertShop('evil.com'));
 assert.throws(()=>assertShop('someone.myshopify.com','mine.myshopify.com'));
});
