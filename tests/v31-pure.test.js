import test from 'node:test';
import assert from 'node:assert/strict';
import {getStores,norm} from '../src/config.js';
import {dateRange} from '../src/report-utils.js';
import {getShopifyOrder,recentShopifyOrders} from '../src/shopify.js';

test('ENV token-only setup permits store metadata in DB and avoids duplicate A entries',()=>{
 const env={STORE_A_ACCESS_TOKEN:'offline',STORE_A_WEBHOOK_SECRET:'secret',STORE_B_ACCESS_TOKEN:'offline2',STORE_B_WEBHOOK_SECRET:'secret2'};
 const stores=getStores(env);assert.deepEqual(stores.map(s=>s.key),['A','B']);
 assert.equal(stores[0].domain,'');assert.equal(norm('Store A'),norm('StoreA'));
 assert.equal(norm('Store-B'),norm('Store_B'));
});
test('date range validation blocks future, inverted and >12 month reports',()=>{
 assert.equal(dateRange({period:'30'}).from.length,10);
 assert.throws(()=>dateRange({period:'custom',from:'2025-01-01',to:'2025-01-31'}));
 assert.throws(()=>dateRange({period:'custom',from:'2099-10-01',to:'2099-10-02'}));
 assert.throws(()=>dateRange({period:'custom',from:'2026-10-15',to:'2026-10-01'}));
});
test('Shopify order recovery maps GraphQL order variants to normal webhook payload',async()=>{
 const original=global.fetch;
 global.fetch=async (_url,opts)=>{
  const body=JSON.parse(opts.body);assert.match(body.query,/order\(id:\$id\)/);
  return {ok:true,status:200,async text(){return JSON.stringify({data:{order:{id:'gid://shopify/Order/88',name:'#88',createdAt:'2026-10-19T12:00:00Z',cancelledAt:null,currencyCode:'PKR',tags:[],lineItems:{nodes:[{id:'gid://shopify/LineItem/11',quantity:1,sku:'WKT-342-UK-12-P',originalUnitPriceSet:{shopMoney:{amount:'1500'}},variant:{id:'gid://shopify/ProductVariant/42',sku:'WKT-342-UK-12-P'}}]}}}})}};
 };
 try{const order=await getShopifyOrder({key:'B',domain:'store-b.myshopify.com',token:'offline'},88);assert.equal(order.id,'88');assert.equal(order.line_items[0].variant_id,'42');assert.equal(order.line_items[0].price,'1500')}
 finally{global.fetch=original}
});
