import { liveWrites, norm, soldTag } from './config.js';
import * as shopify from './shopify.js';
import * as db from './db.js';

export function isInternalOrder(order) {
  const tags=String(order.tags||'').split(',').map(s=>s.trim());
  return tags.includes('Dropshipped_Order') || tags.includes('StockBridgeInternal') || tags.some(s=>s.startsWith('TS_'));
}
export function getOwner(stores, supplier) {
  const owner=stores.find(s=>norm(s.supplier)===norm(supplier));
  if (!owner) throw new Error(`No owner configured for custom.supplier=${supplier}`);
  return owner;
}
export function physicalKey(owner, sku) {
  return `${owner.key}:${norm(sku)}`;
}

export function classifyOrderError(error) {
  const message=String(error?.message||error||'');
  if (error?.code==='CLAIM_CONFLICT' || /CONFLICT: .*claimed by/.test(message)) return 'CONFLICT';
  if (error?.code==='UNCERTAIN_CREATE') return 'REVIEW';
  if (/\b(429|502|503|504)\b|network|timeout|timed out|fetch failed|ECONNRESET|ETIMEDOUT|throttled|rate.limit|temporarily unavailable/i.test(message)) return 'RETRY';
  return 'ERROR';
}

export async function processOrder(job, stores, deps={db,shopify,liveWrites}) {
  const database=deps.db, api=deps.shopify, live=deps.liveWrites;
  const seller=stores.find(s=>s.key===job.selling_key);
  if (!seller) throw new Error(`Selling store ${job.selling_key} not configured`);
  const order=job.payload;
  if (await database.cancelledOrPending?.(job.job_key)) return {skipped:'Order cancelled before processing'};
  if (isInternalOrder(order)) return {skipped:'Internal dropship order ignored'};
  const originalLines=(order.line_items||[]).filter(line=>line.variant_id && line.sku);
  if (!originalLines.length) return {skipped:'No physical Shopify line items with SKU'};
  await database.log?.(job.job_key,'INFO',`START: ${seller.name}; order ${order.name||order.id}; ${originalLines.length} SKU lines`);

  // Search only the SKUs in this order, on demand. Never import entire catalog.
  const entries=[];
  for (const line of originalLines) {
    const soldVariant=await api.fetchSourceVariant(seller,line.variant_id);
    if (!soldVariant) throw new Error(`Source variant ${line.variant_id} missing in store ${seller.key}`);
    if (norm(soldVariant.sku)!==norm(line.sku)) throw new Error(`SKU mismatch between order and source variant: ${line.sku}`);
    const supplier=soldVariant.product?.metafield?.value;
    if (!supplier) throw new Error(`Missing product metafield custom.supplier for SKU ${line.sku} on ${seller.key}`);
    const owner=getOwner(stores,supplier);
    if (Number(line.quantity)!==1) throw new Error(`Item ${line.sku}: expected thrift quantity 1; got ${line.quantity}`);
    const variants=new Map();
    for (const store of stores) {
      if (store.key===seller.key) { variants.set(store.key,soldVariant); continue; }
      const found=await api.findMatchingVariant(store,line.sku,supplier);
      if (found) variants.set(store.key,found);
    }
    if (!variants.has(owner.key)) throw new Error(`Original owner store ${owner.key} does not have matching SKU ${line.sku} + supplier ${supplier}`);
    entries.push({line,owner,sku:line.sku,supplier,variants,key:physicalKey(owner,line.sku)});
    await database.log?.(job.job_key,'INFO',`MATCH: SKU ${line.sku}; seller ${seller.name}; owner ${owner.name}; supplier ${supplier}; connected matches ${[...variants.keys()].join(',')}`);
    if(database.upsertSale)await database.upsertSale({storeKey:seller.key,orderId:order.id,lineId:line.id||line.variant_id,
      date:order.created_at||new Date().toISOString(),sku:line.sku,supplier,ownerKey:owner.key,
      brand:soldVariant.product?.brand?.value||'',type:soldVariant.product?.productType||'',
      qty:Number(line.quantity),value:Number(line.price||soldVariant.price||0)*Number(line.quantity),
      currency:order.currency||order.presentment_currency||'PKR',cancelled:!!order.cancelled_at,internal:false});
  }
  // Save exact per-store listing price at time of sale BEFORE mutation.
  // These figures power cross-store price comparison without fetching catalogs per report.
  if(database.saveSalePrice)for(const entry of entries)for(const [key, variant] of entry.variants){
    await database.saveSalePrice(seller.key, String(order.id), String(entry.line.id||entry.line.variant_id),key,Number(variant.price||0), order.currency||'PKR');
  }
  if (!live) {
    for (const entry of entries) await database.log(job.job_key,'INFO',`DRY RUN ${entry.sku}: owner ${entry.owner.key}; linked ${[...entry.variants.keys()].join(', ')}`);
    return {dryRun:true, items:entries.length};
  }
  if (new Set(entries.map(x=>x.key)).size!==entries.length) throw new Error('Order repeats same physical SKU + supplier; manual review required');
  await database.claimAll(entries.map(x=>x.key),job.job_key);
  await database.log?.(job.job_key,'OK',`CLAIMED: ${entries.map(x=>x.key).join(', ')}`);
  // Snapshots are saved before the first Shopify write so a later cancellation
  // can restore the original status/tags/location quantities without guessing.
  for (const entry of entries) for(const store of stores) {
    if(!entry.variants.has(store.key))continue;
    const v=entry.variants.get(store.key),item=v.inventoryItem;
    const levels=Object.fromEntries((item?.inventoryLevels?.nodes||[]).map(n=>[
      n.location.id,n.quantities?.find(q=>q.name==='available')?.quantity||0]));
    if(item?.inventoryLevels?.pageInfo?.hasNextPage)throw new Error('Too many inventory locations; no safe snapshot');
    await database.saveSnapshot?.(job.job_key,entry.key,store.key,{
      sku:entry.sku,supplier:entry.supplier,variantId:v.id,productId:v.product.id,
      status:v.product.status,tags:v.product.tags,tracked:!!item?.tracked,levels,
      sourceSale:store.key===seller.key,
      saleTag:soldTag(seller.name),
      // More than one inventory location and no stock after checkout is ambiguous.
      // The safe restoration flow will request manual review rather than invent locations.
      restoreLocationId:Object.keys(levels).length===1?Object.keys(levels)[0]:null
    });
  }

  // Create owner-side supplier orders FIRST, before editing linked storefronts.
  // If Shopify rejects orderCreate, no linked listings have been drafted by this worker.
  // DB claims & snapshots persist; retries reuse the same claim and reference tag.
  const saleTag=soldTag(seller.name);
  const owners=[...new Set(entries.filter(e=>e.owner.key!==seller.key).map(e=>e.owner.key))];
  if(!owners.length)await database.log?.(job.job_key,'INFO',`OWN SALE: ${seller.name}; no internal supplier order required`);
  for (const ownerKey of owners) {
    const owner=stores.find(s=>s.key===ownerKey);
    const lines=entries.filter(e=>e.owner.key===ownerKey);
    const tag=api.referenceTag(seller.key,order.id,ownerKey);
    let supplierOrder=await database.lookupSupplierOrder(job.job_key,ownerKey);
    if (!supplierOrder) {
      supplierOrder=await api.findExistingSupplierOrder(owner,tag);
      if (supplierOrder) {
        await database.saveSupplierOrder(job.job_key,ownerKey,supplierOrder);
        await database.log?.(job.job_key,'INFO',`OWNER ORDER REUSED: ${owner.name} ${supplierOrder}`);
      }
    }
    if (!supplierOrder) {
      for (const e of lines) {
        const v=await api.findMatchingVariant(owner,e.sku,e.supplier);
        if (!v) throw new Error(`Owner item not found: ${owner.key}/${e.sku}`);
        const onHand=(v.inventoryItem?.inventoryLevels?.nodes||[]).reduce((n,x)=>n+(x.quantities.find(q=>q.name==='available')?.quantity||0),0);
        if (v.inventoryItem?.tracked && onHand<1) throw new Error(`Owner ${owner.key} SKU ${e.sku} has no stock; refusing supplier order`);
      }
      const discount=Number(await database.getSetting?.('supplierDiscountPercent',Number(process.env.DEFAULT_DISCOUNT_PERCENT||99)) ?? 99);
      const freeShipping=await database.getSetting?.('freeInternalShipping',true) ?? true;
      await database.log?.(job.job_key,'INFO',`OWNER ORDER REQUEST: ${owner.name}; ${lines.map(e=>e.sku).join(', ')}; ${discount}% discount`);
      try {
        supplierOrder=await api.createSupplierOrder(owner,seller,order,lines.map(e=>({
          variantId:e.variants.get(owner.key).id,quantity:1,sku:e.sku
        })),tag,{discount,freeShipping});
      } catch(error) {
        // A network failure AFTER Shopify accepted orderCreate can be ambiguous.
        // Never blindly resend that mutation; check its deterministic tag first.
        const maybeCreated=await api.findExistingSupplierOrder(owner,tag).catch(()=>null);
        if(maybeCreated) {
          supplierOrder=maybeCreated;
          await database.log?.(job.job_key,'INFO',`OWNER ORDER FOUND AFTER API ERROR: ${owner.name} ${supplierOrder}`);
        } else if (/network|timeout|timed out|fetch failed|ECONNRESET|ETIMEDOUT|\b(502|503|504)\b/i.test(String(error?.message||''))) {
          error.code='UNCERTAIN_CREATE';
          error.message+=`; possible supplier order on ${owner.name}. Search order tag ${tag} before retry.`;
          throw error;
        } else throw error;
      }
      await database.saveSupplierOrder(job.job_key,ownerKey,supplierOrder);
      await database.log?.(job.job_key,'OK',`OWNER ORDER CREATED: ${owner.name} ${supplierOrder}; source ${seller.name} ${order.name||order.id}`);
    }
  }

  // Source Shopify checkout already reduced seller inventory. Owner's internal order
  // has reduced owner inventory. Now zero every linked listing and draft everywhere.
  // Re-find current variant so inventorySetQuantities uses correct changeFromQuantity.
  for (const entry of entries) {
    for (const store of stores) {
      if (!entry.variants.has(store.key)) continue;
      const current=await api.findMatchingVariant(store,entry.sku,entry.supplier);
      if (!current) throw new Error(`Linked product disappeared from ${store.key}: ${entry.sku}`);
      await api.markSold(store,current,saleTag,`${job.job_key}|${entry.key}`);
      await database.updateInventoryCache?.(store.key,current.id,0,'DRAFT');
      await database.log?.(job.job_key,'OK',`LISTING SOLD: ${store.name} | SKU ${entry.sku} | Qty 0 | DRAFT | ${saleTag}`);
    }
  }
  return {processed:entries.length,tag:saleTag};
}

export async function runQueue(stores, limit=1, deps={db,shopify}) {
  const database=deps.db,api=deps.shopify;
  await database.ensureSchema();
  const results=[];
  for (let i=0;i<Math.min(limit,10);i++) {
    const job=await database.takeJob();
    if (!job) break;
    try {
      await database.log(job.job_key,'INFO',`WORKER: attempt ${job.attempts}; seller ${job.selling_key}; order ${job.order_name}`);
      const result=await processOrder(job,stores,{db:database,shopify:api,liveWrites:deps.liveWrites ?? await database.getSetting('liveWrites',false)});
      const state=result.dryRun?'DRY_RUN':result.skipped?'SKIPPED':'DONE';
      await database.finishJob(job.job_key,state);
      await database.log(job.job_key,'OK',`FINISHED: ${state} ${JSON.stringify(result)}`);
      results.push({job:job.job_key,result});
    } catch(e) {
      const classification=classifyOrderError(e);
      const retry=classification==='RETRY' && Number(job.attempts)<4 && typeof database.deferJob==='function';
      const state=retry?'RETRY':classification==='RETRY'?'ERROR':classification;
      if(retry)await database.deferJob(job.job_key,e.message,Math.min(15,2**Number(job.attempts)));
      else await database.finishJob(job.job_key,state,e.message);
      await database.log(job.job_key,['CONFLICT','REVIEW'].includes(state)?state:'ERROR',`${state}: ${e.message}`);
      results.push({job:job.job_key,state,error:e.message});
    }
  }
  return results;
}

export async function runCancellations(stores,limit=2,deps={db,shopify}) {
  const database=deps.db,api=deps.shopify,live=deps.liveWrites ?? await database.getSetting('liveWrites',false);
  await database.ensureSchema();
  const results=[];
  for(let i=0;i<Math.min(10,limit);i++) {
    const cancellation=await database.takeCancel();if(!cancellation)break;
    const jobKey=cancellation.job_key;
    try {
      const source=(await database.query('SELECT * FROM ts_jobs WHERE job_key=$1',[jobKey])).rows[0];
      if(!source){await database.finishCancel(jobKey,'WAITING','Original order webhook not yet received');results.push({job:jobKey,waiting:true});continue;}
      if(source.state==='PENDING'||source.state==='PROCESSING'){
        await database.finishCancel(jobKey,'WAITING','Original order still processing');results.push({job:jobKey,waiting:true});continue;
      }
      if(!live){await database.finishCancel(jobKey,'DRY_RUN');results.push({job:jobKey,dryRun:true});continue;}
      await database.log(jobKey,'INFO',`CANCELLATION START: ${jobKey}`);
      const ownerOrders=await database.lookupSupplierOrders(jobKey);
      // Avoid restoring stock while an internal owner order remains open.
      for(const linked of ownerOrders) {
        const owner=stores.find(s=>s.key===linked.owner_key);
        if(!owner)throw new Error('Owner store missing; cancellation stopped');
        await api.cancelSupplierOrder(owner,linked.owner_order_gid);
        await database.log(jobKey,'OK',`OWNER ORDER CANCELLED: ${owner.name} ${linked.owner_order_gid}`);
      }
      const entries=await database.snapshots(jobKey);
      if(!entries.length){
        // Source order may have been safely skipped before writes (or was DRY_RUN).
        if(source.state!=='DONE'&&source.state!=='ERROR'){
          await database.markSaleCancelled(source.selling_key,source.order_id);
          await database.finishCancel(jobKey,'DONE');results.push({job:jobKey,skipped:true});continue;
        }
        throw new Error('No pre-sale snapshots found. Do not guess original inventory. Manual review required');
      }
      const saleTag=soldTag(stores.find(s=>s.key===source.selling_key)?.name||`Store ${source.selling_key}`);
      for(const snap of entries) {
        const store=stores.find(s=>s.key===snap.store_key);
        if(!store)throw new Error(`Store ${snap.store_key} disconnected`);
        // Do not restore inventory if someone else owns the physical claim.
        const owner=(await database.query('SELECT job_key FROM ts_claims WHERE item_key=$1',[snap.item_key])).rows[0];
        if(owner&&owner.job_key!==jobKey)throw new Error('Item now claimed by another order; manual review required');
        await api.restoreListing(store,snap.snapshot,snap.snapshot.saleTag||saleTag,jobKey);
        const restoredQty=Object.values(snap.snapshot.levels||{}).reduce((a,b)=>a+Number(b||0),0);
        await database.updateInventoryCache?.(store.key,snap.snapshot.variantId,restoredQty,snap.snapshot.status);
        await database.log(jobKey,'OK',`Restored ${snap.sku||snap.snapshot.sku} on ${store.key}`);
      }
      await database.releaseClaims(jobKey);
      await database.markSaleCancelled(source.selling_key,source.order_id);
      await database.finishCancel(jobKey,'DONE');
      await database.log(jobKey,'OK',`CANCELLATION FINISHED: ${entries.length} listings restored; claims released`);
      results.push({job:jobKey,restored:entries.length});
    } catch(error) {
      await database.finishCancel(jobKey,'ERROR',error.message);
      await database.log(jobKey,'ERROR','Cancellation: '+error.message);
      results.push({job:jobKey,error:error.message});
    }
  }
  return results;
}
