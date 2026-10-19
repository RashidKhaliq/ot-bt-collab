import express from 'express';
import crypto from 'node:crypto';
import {waitUntil} from '@vercel/functions';
import {liveWrites} from './config.js';
import {loadStores,listStoreSettings,saveStoreSettings,clearStoreCache} from './stores.js';
import * as db from './db.js';
import {testStore, getWebhookSubscriptions,ensureWebhookSubscriptions,recentShopifyOrders,getShopifyOrder,findMatchingVariant} from './shopify.js';
import {isInternalOrder,runQueue,runCancellations} from './engine.js';
import {reportData} from './reports.js';

const app=express();app.disable('x-powered-by');app.set('trust proxy',1);
app.use((req,res,next)=>{res.set({'X-Content-Type-Options':'nosniff','X-Frame-Options':'DENY','Referrer-Policy':'no-referrer','Cache-Control':'no-store'});next()});
const safe=fn=>(req,res)=>Promise.resolve(fn(req,res)).catch(e=>{console.error('StockBridge:',e.message);if(!res.headersSent)res.status(e.statusCode||500).json({error:e.message})});
export function verifyHmac(raw,secret,header){if(!secret||!header||!Buffer.isBuffer(raw))return false;const expected=crypto.createHmac('sha256',secret).update(raw).digest();let received;try{received=Buffer.from(header,'base64')}catch{return false}return expected.length===received.length&&crypto.timingSafeEqual(expected,received)}
function auth(req,res,next){const user=process.env.ADMIN_USER,pass=process.env.ADMIN_PASSWORD;
 if(!user||!pass||pass.length<12)return res.status(503).json({error:'Set ADMIN_USER and strong ADMIN_PASSWORD in Vercel ENV'});
 const expected=Buffer.from(`${user}:${pass}`),header=String(req.header('Authorization')||'');
 let received;try{received=Buffer.from(header.replace(/^Basic\s+/i,''),'base64')}catch{received=Buffer.alloc(0)}
 if(!header.startsWith('Basic ')||expected.length!==received.length||!crypto.timingSafeEqual(expected,received)){
 res.set('WWW-Authenticate','Basic realm="StockBridge"');return res.status(401).json({error:'Admin login required'})}
 next()}
function csrf(req,res,next){const origin=req.get('Origin');if(origin){try{if(new URL(origin).host!==req.get('host'))return res.status(403).json({error:'Invalid request origin'})}catch{return res.status(403).json({error:'Bad Origin'})}}next()}
async function worker(){const stores=await loadStores({refresh:true});return {orders:await runQueue(stores,3),cancellations:await runCancellations(stores,3)}}
function scheduleWorker(){const task=worker().catch(e=>console.error('Background job:',e.message));try{waitUntil(task)}catch{task.catch(()=>{})}}

// Accept ONLY authentic Shopify requests. Every connected store gets its own secret.
app.post('/api/webhooks',express.raw({type:'*/*',limit:'2mb'}),safe(async(req,res)=>{
 const domain=String(req.header('X-Shopify-Shop-Domain')||'').toLowerCase();
 const store=(await loadStores()).find(s=>s.domain===domain);
 if(!store)return res.status(401).json({error:'Unknown shop domain'});
 if(!verifyHmac(req.body,store.webhookSecret,req.header('X-Shopify-Hmac-Sha256')))return res.status(401).json({error:'Invalid webhook signature'});
 const topic=String(req.header('X-Shopify-Topic')||'');
 if(!['orders/create','orders/cancelled'].includes(topic))return res.status(200).json({ok:true,ignored:topic});
 let order;try{order=JSON.parse(req.body.toString('utf8'))}catch{return res.status(400).json({error:'Invalid JSON'})}
 if(!order.id)return res.status(422).json({error:'Missing order id'});
 if(isInternalOrder(order))return res.json({ok:true,ignored:'internal order'});
 const jobKey=topic==='orders/create'?await db.enqueue(store.key,order):await db.enqueueCancel(null,store.key,order);
 try{await db.recordWebhook(String(req.header('X-Shopify-Webhook-Id')||req.header('X-Shopify-Event-Id')||''),store.key,topic,order.id)}catch(e){console.warn('Webhook audit insert failed:',e.message)}
 res.status(200).json({ok:true,queued:jobKey,store:store.key});scheduleWorker();
}));
app.get('/api/worker',safe(async(req,res)=>{
 if(!process.env.CRON_SECRET||req.header('Authorization')!==`Bearer ${process.env.CRON_SECRET}`)return res.status(401).json({error:'Unauthorized'});
 res.json(await worker());
}));
app.use('/api',express.json({limit:'60kb'}));
app.use('/api',auth);

// Fast report: database aggregation, no Shopify requests, no polling or catalog import.
app.get('/api/reports',safe(async(req,res)=>res.json(await reportData(req.query))));
app.get('/api/stores',safe(async(req,res)=>res.json({stores:await listStoreSettings()})));
app.put('/api/stores',csrf,safe(async(req,res)=>res.json({ok:true,store:await saveStoreSettings(req.body||{})})));
app.get('/api/settings',safe(async(req,res)=>res.json({
 discount:await db.getSetting('supplierDiscountPercent',99),
 freeShipping:await db.getSetting('freeInternalShipping',true),
 liveWrites:await db.getSetting('liveWrites',false),
 publicUrl:await db.getSetting('publicUrl','')
})));
app.put('/api/settings',csrf,safe(async(req,res)=>{
 const b=req.body||{};if(typeof b.discount!=='number'||b.discount<0||b.discount>100||!Number.isFinite(b.discount)||typeof b.freeShipping!=='boolean'||typeof b.liveWrites!=='boolean')return res.status(422).json({error:'Invalid discount/freeShipping/liveWrites values'});
 if(b.liveWrites===true && b.confirmLive!=='ENABLE')return res.status(422).json({error:'Type ENABLE to activate live Shopify writes'});
 await db.setSetting('supplierDiscountPercent',b.discount);await db.setSetting('freeInternalShipping',b.freeShipping);
 const publicUrl=String(b.publicUrl||'').trim().replace(/\/$/,'');
 if(publicUrl && (!/^https:\/\/[-a-zA-Z0-9.]+(?::\d+)?$/.test(publicUrl)||publicUrl.length>220))return res.status(422).json({error:'HTTPS base URL required without any path'});
 await db.setSetting('liveWrites',b.liveWrites);await db.setSetting('publicUrl',publicUrl);res.json({ok:true});
}));
app.get('/api/stores/:key/diagnostics',safe(async(req,res)=>{
 const s=(await loadStores({refresh:true})).find(s=>s.key===req.params.key.toUpperCase());if(!s)return res.status(404).json({error:'Unknown store'});
 const warnings=[];
 let connection=null,webhooks=[],orders=[];
 try{connection=await testStore(s)}catch(e){warnings.push('Shopify connection: '+e.message)}
 if(connection){try{webhooks=await getWebhookSubscriptions(s)}catch(e){warnings.push('Webhook list unavailable: '+e.message)}
   try{orders=await recentShopifyOrders(s,10)}catch(e){warnings.push('Recent orders unavailable: '+e.message)}}
 const watchedIds=orders.map(o=>`${s.key}:${o.id}`);
 const jobs=watchedIds.length?(await db.query('SELECT job_key,state,last_error FROM ts_jobs WHERE job_key = ANY($1::text[])',[watchedIds])).rows:[];
 const jobMap=new Map(jobs.map(j=>[j.job_key,j]));
 const uri=String(await db.getSetting('publicUrl','')).replace(/\/$/,'')+'/api/webhooks';
 const seen=(await db.query('SELECT topic,received_at,order_id FROM sb_webhook_events WHERE store_key=$1 ORDER BY received_at DESC LIMIT 10',[s.key])).rows;
 const status={store:s.key,name:s.name,domain:s.domain,supplier:s.supplier,connected:!!connection,shop:connection?.shop?.name,
  missingScopes:connection?['read_products','write_products','read_inventory','write_inventory','read_orders','write_orders'].filter(x=>!connection.scopes.includes(x)):[],
  expectedWebhook:uri,webhooks,hasOrderCreateWebhook:webhooks.some(x=>x.topic==='ORDERS_CREATE'&&x.uri===uri),
  hasOrderCancelWebhook:webhooks.some(x=>x.topic==='ORDERS_CANCELLED'&&x.uri===uri),
  recentEvents:seen,orders:orders.filter(o=>!isInternalOrder(o)).map(o=>({id:o.id,name:o.name,createdAt:o.created_at,cancelled:!!o.cancelled_at,
   sku:o.line_items.map(l=>l.sku).filter(Boolean).join(', '),job:jobMap.get(`${s.key}:${o.id}`)||null})),warnings};
 res.json(status);
}));
app.post('/api/stores/:key/webhooks',csrf,safe(async(req,res)=>{
 const s=(await loadStores({refresh:true})).find(s=>s.key===req.params.key.toUpperCase());if(!s)return res.status(404).json({error:'Unknown store'});
 const base=String(await db.getSetting('publicUrl','')).trim().replace(/\/$/,'');if(!base.startsWith('https://'))return res.status(422).json({error:'Save HTTPS App URL in dashboard Settings first'});
 res.json({ok:true,...await ensureWebhookSubscriptions(s,base+'/api/webhooks')});
}));
app.post('/api/recover',csrf,safe(async(req,res)=>{
 const key=String(req.body?.store||'').toUpperCase();const s=(await loadStores()).find(s=>s.key===key);
 if(!s)return res.status(404).json({error:'Unknown store'});
 const original=await getShopifyOrder(s,String(req.body?.orderId||''));if(!original)return res.status(404).json({error:'Shopify order not found'});
 if(original.cancelled_at||isInternalOrder(original))return res.status(409).json({error:'Cancelled/internal order; not eligible for recovery'});
 const jobKey=await db.enqueue(s.key,original);
 const found=(await db.query('SELECT state,last_error FROM ts_jobs WHERE job_key=$1',[jobKey])).rows[0];
 // Existing ERROR jobs can be explicitly retried, never auto-resend a DONE job.
 if(['ERROR','DRY_RUN'].includes(found?.state))await db.query("UPDATE ts_jobs SET state='PENDING',last_error=NULL,updated_at=now() WHERE job_key=$1 AND state IN ('ERROR','DRY_RUN')",[jobKey]);
 scheduleWorker();res.json({ok:true,jobKey,previousStatus:found?.state||'new'});
}));
app.get('/api/jobs',safe(async(req,res)=>{
 const [jobs,logs,events]=await Promise.all([
 db.query('SELECT job_key,selling_key,order_name,state,attempts,last_error,created_at FROM ts_jobs ORDER BY created_at DESC LIMIT 30'),
 db.query('SELECT job_key,level,message,created_at FROM ts_logs ORDER BY id DESC LIMIT 30'),
 db.query('SELECT store_key,topic,received_at FROM sb_webhook_events ORDER BY received_at DESC LIMIT 20')]);
 res.json({jobs:jobs.rows,logs:logs.rows,events:events.rows});
}));
app.post('/api/jobs/process',csrf,safe(async(req,res)=>res.json({ok:true,results:await worker()})));
app.post('/api/jobs/retry',csrf,safe(async(req,res)=>{
 const key=String(req.body?.jobKey||'');if(!/^[A-Z0-9]+:\d+$/.test(key))return res.status(422).json({error:'Valid jobKey required'});
 await db.query("UPDATE ts_jobs SET state='PENDING',last_error=NULL,updated_at=now() WHERE job_key=$1 AND state='ERROR'",[key]);
 scheduleWorker();res.json({ok:true});
}));
// Focused SKU check: exact matching metafield + location qty, only on manual click.
app.get('/api/stores/:key/check-sku',safe(async(req,res)=>{
 const stores=await loadStores();const s=stores.find(x=>x.key===req.params.key.toUpperCase());if(!s)return res.status(404).json({error:'Unknown store'});
 const sku=String(req.query.sku||'').trim(),supplier=String(req.query.supplier||'').trim();
 if(!sku||sku.length>120||!supplier||supplier.length>120)return res.status(422).json({error:'SKU and supplier required'});
 const matched=await findMatchingVariant(s,sku,supplier);
 res.json({store:s.name,found:!!matched,product:matched&&{id:matched.product.id,status:matched.product.status,
   supplier:matched.product.metafield?.value,price:matched.price,quantity:matched.inventoryItem?.inventoryLevels?.nodes?.reduce((acc,l)=>acc+Number(l.quantities?.[0]?.quantity||0),0),tags:matched.product.tags}});
}));
app.get('/api/version',(req,res)=>res.json({name:'StockBridge',version:'3.1.0'}));
export default app;
