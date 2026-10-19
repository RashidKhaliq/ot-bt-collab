import { getStores, normalizeDomain, norm } from './config.js';
import * as db from './db.js';

// Secrets always come from Vercel ENV; non-secret config comes from Neon.
// Fallback to old ENV metadata until the store is saved in dashboard.
let cached=null, cacheAt=0;
export function clearStoreCache(){cached=null;cacheAt=0}
export async function loadStores({refresh=false}={}){
  if(!refresh && cached && Date.now()-cacheAt<30_000)return cached;
  const envStores=getStores();
  let records=[];
  try {records=(await db.query('SELECT * FROM sb_stores WHERE enabled=true ORDER BY store_key')).rows;}
  catch(err){if(err.code!=='42P01')throw err;}
  const byKey=new Map(envStores.map(s=>[s.key,s]));
  for(const row of records){
    const prev=byKey.get(row.store_key)||{key:row.store_key,token:'',webhookSecret:''};
    const a=row.owner_address||{};
    byKey.set(row.store_key,{...prev, key:row.store_key, name:row.display_name,domain:row.domain,
      supplier:row.supplier,ownerEmail:row.owner_email||'',ownerPhone:row.owner_phone||'',
      address:{...a,firstName:a.firstName||row.display_name,lastName:a.lastName||''}});
  }
  const disabled=new Set();
  try{const rows=(await db.query('SELECT store_key FROM sb_stores WHERE enabled=false')).rows;rows.forEach(x=>disabled.add(x.store_key))}
  catch(err){if(err.code!=='42P01')throw err;}
  const result=[...byKey.values()].filter(s=>!disabled.has(s.key)).sort((a,b)=>a.key.localeCompare(b.key));
  if(new Set(result.map(s=>norm(s.supplier))).size!==result.length)throw new Error('Duplicate supplier ownership codes in store settings');
  const nonEmpty=result.map(s=>s.domain).filter(Boolean);if(new Set(nonEmpty).size!==nonEmpty.length)throw new Error('Duplicate Shopify domains in store settings');
  cached=result;cacheAt=Date.now();return result;
}
export async function listStoreSettings(){
 const stores=await loadStores({refresh:true});
 const records=(await db.query('SELECT * FROM sb_stores ORDER BY store_key')).rows;
 const recordMap=new Map(records.map(r=>[r.store_key,r]));
 const list=[...new Set([...stores.map(s=>s.key),...records.map(r=>r.store_key)])].sort();
 return list.map(key=>{
   const s=stores.find(s=>s.key===key);const r=recordMap.get(key);
   const env=getStores().find(s=>s.key===key);
   const row={key,name:r?.display_name||s?.name||'Store '+key,domain:r?.domain||s?.domain||'',supplier:r?.supplier||s?.supplier||'Store'+key,
     email:r?.owner_email||s?.ownerEmail||'',phone:r?.owner_phone||s?.ownerPhone||'', address:r?.owner_address||s?.address||{},
     enabled:r?.enabled??true, hasToken:!!env?.token, hasWebhookSecret:!!env?.webhookSecret, savedInDatabase:!!r};
   return row;
 });
}
export async function saveStoreSettings(data){
 const key=String(data.key||'').trim().toUpperCase();
 if(!/^[A-Z][A-Z0-9]{0,6}$/.test(key))throw new Error('Store key must be A, B, C, D etc.');
 const name=String(data.name||'').trim(),domain=normalizeDomain(data.domain),supplier=String(data.supplier||'').trim();
 if(!name||name.length>100||!domain.endsWith('.myshopify.com')||!/^[-a-z0-9]+\.myshopify\.com$/.test(domain)||!supplier||supplier.length>100)throw new Error('Valid display name, .myshopify.com domain and supplier code required');
 const address=data.address && typeof data.address==='object' && !Array.isArray(data.address)?data.address:{};
 await db.query(`INSERT INTO sb_stores(store_key,display_name,domain,supplier,owner_email,owner_phone,owner_address,enabled)
  VALUES($1,$2,$3,$4,$5,$6,$7::jsonb,$8)
  ON CONFLICT(store_key) DO UPDATE SET display_name=$2,domain=$3,supplier=$4,owner_email=$5,owner_phone=$6,owner_address=$7::jsonb,enabled=$8,updated_at=NOW()`,
 [key,name,domain,supplier,String(data.email||'').slice(0,160),String(data.phone||'').slice(0,50),JSON.stringify(address),data.enabled!==false]);
 clearStoreCache();return {key,name,domain,supplier};
}
