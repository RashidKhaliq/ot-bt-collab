import * as db from './db.js';
import {loadStores} from './stores.js';
import {dateRange,numeric} from './report-utils.js';

const round=n=>Math.round(Number(n||0)*100)/100;
const val=s=>Number(s||0);
const label=(lookup,key)=>lookup.get(key)||key;
export async function reportData(input={}){
  const range=dateRange(input), stores=await loadStores();
  const seller=input.selling||'all',owner=input.owner||'all',type=input.type||'all';
  const allowed=new Set(stores.map(s=>s.key));
  const names=new Map(stores.map(s=>[s.key,s.name]));
  const rows=(await db.query(`SELECT s.store_key,s.order_id,s.line_id,s.order_date,s.sku,s.owner_key,s.product_type,s.brand,
     s.quantity,s.gross_value,s.currency,
     COALESCE(jsonb_object_agg(p.price_store_key,p.unit_price) FILTER(WHERE p.price_store_key IS NOT NULL),'{}'::jsonb) prices
   FROM sb_sales s LEFT JOIN sb_sale_prices p
     ON p.store_key=s.store_key AND p.order_id=s.order_id AND p.line_id=s.line_id
   WHERE s.order_date >= $1::date AND s.order_date < ($2::date+INTERVAL '1 day')
     AND NOT s.cancelled AND NOT s.is_internal AND s.owner_key<>''
   GROUP BY s.store_key,s.order_id,s.line_id`,[range.from,range.to])).rows;
  const records=rows.filter(x=>allowed.has(x.store_key)&&allowed.has(x.owner_key)&&x.owner_key!==x.store_key&&
    (seller==='all'||x.store_key===seller)&&(owner==='all'||x.owner_key===owner)&&
    (type==='all'||x.product_type===type));
  const map=new Map(), competitors=new Map(), byType=new Map();
  let missingPrices=0, gross=0,qty=0;
  for(const r of records){
    const category=r.product_type||'Uncategorized';
    const key=[r.store_key,r.owner_key,category].join('|');
    const agg=map.get(key)||{sellerKey:r.store_key,sellingStore:label(names,r.store_key),ownerKey:r.owner_key,ownerStore:label(names,r.owner_key),type:category,qty:0,sellingValue:0,priceByStore:{}};
    agg.qty+=Number(r.quantity);agg.sellingValue+=val(r.gross_value);
    for(const [k,v] of Object.entries(r.prices||{}))agg.priceByStore[k]=(agg.priceByStore[k]||0)+val(v)*Number(r.quantity);
    if(!Object.keys(r.prices||{}).length)missingPrices++;
    map.set(key,agg);qty+=Number(r.quantity);gross+=val(r.gross_value);
    const comp=competitors.get(r.store_key)||{storeKey:r.store_key,storeName:label(names,r.store_key),units:0,customerSales:0};
    comp.units+=Number(r.quantity);comp.customerSales+=val(r.gross_value);competitors.set(r.store_key,comp);
    const typeAgg=byType.get(category)||{type:category,byStore:{},total:0};
    typeAgg.byStore[r.store_key]=(typeAgg.byStore[r.store_key]||0)+Number(r.quantity);
    typeAgg.total+=Number(r.quantity);byType.set(category,typeAgg);
  }
  let entries=[...map.values()].map(r=>({...r,sellingValue:round(r.sellingValue),priceByStore:Object.fromEntries(Object.entries(r.priceByStore).map(([k,v])=>[k,round(v)]))})).sort((a,b)=>b.qty-a.qty);
  const kinds=[...byType.values()].sort((a,b)=>b.total-a.total);
  const competitorsSorted=[...competitors.values()].sort((a,b)=>b.units-a.units).map(c=>({...c,customerSales:round(c.customerSales)}));
  const currentInventory=(await db.query(`SELECT store_key,owner_key,product_type,sku,supplier,quantity,price,currency,synced_at
    FROM sb_inventory WHERE quantity>0 AND status='ACTIVE' AND store_key=owner_key`)).rows;
  const invMap=new Map(),unique=new Set();
  for(const v of currentInventory){
    if(!allowed.has(v.store_key))continue;
    const id=`${v.store_key}:${String(v.sku||'').trim().toLowerCase()}:${String(v.supplier||'').trim().toLowerCase()}`;
    if(unique.has(id))continue; unique.add(id);
    const k=`${v.store_key}|${v.product_type||'Uncategorized'}`;
    const agg=invMap.get(k)||{ownerKey:v.store_key,type:v.product_type||'Uncategorized',available:0,stockValue:0,asOf:v.synced_at};
    agg.available+=Number(v.quantity);agg.stockValue+=Number(v.quantity)*val(v.price);
    if(String(v.synced_at)<String(agg.asOf))agg.asOf=v.synced_at;
    invMap.set(k,agg);
  }
  const snapshotInfo=(await db.query('SELECT store_key,cursor,synced_at FROM sb_sync')).rows;
  const syncInfo=Object.fromEntries(stores.map(s=>[s.key,{
    storeName:s.name,initialized:snapshotInfo.some(x=>x.store_key===s.key && !x.cursor),
    lastCompletedAt:snapshotInfo.find(x=>x.store_key===s.key&&!x.cursor)?.synced_at||null,
    inProgress:snapshotInfo.some(x=>x.store_key===s.key && x.cursor)
  }]));
  entries=entries.map(e=>{const stock=invMap.get(`${e.ownerKey}|${e.type}`);const ready=syncInfo[e.ownerKey]?.initialized;return {...e,ownerAvailable:ready?(stock?.available??0):null,ownerStockValue:ready?round(stock?.stockValue??0):null,stockSnapshotAt:ready?syncInfo[e.ownerKey].lastCompletedAt:null}});
  const available=[...invMap.values()].filter(r=>(owner==='all'||r.ownerKey===owner)&&(type==='all'||r.type===type)).map(r=>({...r,ownerName:label(names,r.ownerKey),stockValue:round(r.stockValue)}));
  return {range,stores:stores.map(s=>({key:s.key,name:s.name})),filters:{types:[...new Set([...rows.map(r=>r.product_type||'Uncategorized'),...available.map(i=>i.type)])].sort()},
    totals:{dropshipUnits:qty,dropshipSalesValue:round(gross)},rows:entries,competition:competitorsSorted,
    categories:kinds,availableByOwnerType:available,inventoryState:syncInfo,
    warnings:[...(missingPrices?[
      `${missingPrices} historical sale lines lack saved per-store catalog prices; only original selling value is available. New webhooks snapshot prices. For past prices, no reliable reconstruction.`]:[]),
      'Available quantities are from stored Shopify inventory snapshots; an owner stock snapshot is reliable only after completing its initial catalog import. No automatic bulk fetch runs per dashboard view.',
      'Compare prices only between stores sharing same currency; no FX conversion is performed.',
      'Sales values use original line prices; order-wide discounts, returns and shipping are not allocated here.']};
}
