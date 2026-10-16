import {render} from 'preact';
import {useEffect, useState} from 'preact/hooks';
import {createReservationService,summarizeAllocation} from './reservations.js';

const service=createReservationService(async(doc,variables,version)=>shopify.query(doc,{variables,version}));

export function ReservationPanel({parentId,cards,planDigest,savedPlanMatches,disabledLegacy,onLocked,onUpdated}){
  const [details,setDetails]=useState(null);
  const [locationId,setLocationId]=useState('');
  const [sets,setSets]=useState('1');
  const [fulfilled,setFulfilled]=useState('1');
  const [ready,setReady]=useState(false);
  const [busy,setBusy]=useState(false);
  const [notice,setNotice]=useState('');
  const [error,setError]=useState('');
  const [agree,setAgree]=useState(false);
  const [progress,setProgress]=useState('');
  const job=details?.job||null;
  const status=summarizeAllocation(job);
  const hasJob=!!job;
  const pending=job && ['reserving','publishing','consuming'].includes(job.status);
  const locations=details?.variant?.inventoryItem?.inventoryLevels?.nodes||[];
  const canStart=!!details&&!busy&&!pending&&!disabledLegacy&&!hasJob||!!details&&!busy&&job?.status==='active'&&!disabledLegacy;

  useEffect(()=>{setDetails(null);setLocationId('');setReady(false);setError('');setProgress('');void refresh();},[parentId]);
  useEffect(()=>{onLocked(!!hasJob);},[hasJob]);
  async function refresh(){
    try {const data=await service.readParent(parentId);setDetails(data);
      setLocationId(v=>data.job?.locationId||v||data.variant.inventoryItem.inventoryLevels.nodes?.[0]?.location.id||'');
      onLocked(!!data.job);
    }catch(e){setError(String(e.message||e));}
  }
  async function perform(action){
    if(busy)return;
    setBusy(true);setNotice('');setError('');setProgress('');
    try{await action();await refresh();onUpdated?.();}
    catch(e){setError(String(e.message||e));await refresh();}
    finally{setBusy(false);setAgree(false);}
  }
  const validateSaved=()=>{
    if(!savedPlanMatches||!planDigest)throw new Error('Save the current card list, then reload this product before allocating stock.');
    if(disabledLegacy)throw new Error('Existing fixed or Cart Transform bundle requires manual migration first.');
  };
  function start(){void perform(async()=>{
    validateSaved();
    const state=await service.begin({variantId:parentId,cards,planDigest,
      locationId,sets:Number(sets),onProgress:setProgress});
    setDetails(x=>({...x,...state}));
    await service.resume({variantId:parentId,cards,onProgress:setProgress});
    setNotice('Reservation complete: the parent product can now sell the newly allocated sets.');
  });}
  function resume(){void perform(async()=>{
    validateSaved();
    await service.resume({variantId:parentId,cards,onProgress:setProgress});
    setNotice('Shopify reservation/consumption batch completed.');
  });}
  function consume(){void perform(async()=>{
    validateSaved();
    await service.beginConsume({variantId:parentId,planDigest,count:Number(fulfilled)});
    await service.resume({variantId:parentId,cards,onProgress:setProgress});
    setNotice('Physical card stock adjusted after fulfillment.');
  });}
  function check(){void perform(async()=>{
    validateSaved();
    await service.verifyCards(cards,locationId,Number(sets),parentId,setProgress);
    setNotice(`Stock check passed for ${cards.length} components at the selected location. This is only a snapshot; reservation performs additional checks.`);
  });}

  return <s-section heading="Reserve cards and enable checkout — no bundle component cap">
    <s-stack direction="block" gap="base">
      <s-banner tone="info">This mode sells ONE ordinary Shopify tracked product. Each card is moved from available stock into Shopify reserved inventory BEFORE the parent product is made purchasable. No Shopify fixed bundle or Cart Transform is used for these allocations.</s-banner>
      <s-stack direction="inline" gap="base" alignItems="center">
        <s-badge tone={job?.status==='active'?'success':pending?'warning':'info'}>{job?.status||'Not allocated'}</s-badge>
        <s-text>Allocated: {status.allocated} sets</s-text>
        <s-text>Card inventory consumed for fulfilled sets: {status.consumed}</s-text>
        <s-text>Components: {cards.length}</s-text>
        <s-button variant="secondary" onClick={()=>void refresh()} disabled={busy}>Refresh Shopify stock</s-button>
      </s-stack>
      {details?.variant?.inventoryItem?.tracked!==true&&<s-banner tone="critical">Enable inventory tracking on the parent variant in Shopify before selling pre-orders.</s-banner>}
      {details?.variant?.inventoryPolicy!=='DENY'&&<s-banner tone="critical">Turn OFF “Continue selling when out of stock” on the parent product in Shopify.</s-banner>}
      {disabledLegacy&&<s-banner tone="critical">This product has legacy Shopify bundle configuration. Do not reserve its cards until you migrate it and reconcile earlier orders.</s-banner>}
      {job?.status==='active'&&<s-paragraph>Location: {job.locationName} · Total stock allocated: {job.totalAllocated} · Total physically consumed: {job.totalConsumed}. Card lists are locked while allocations exist, preventing accidental mismatches.</s-paragraph>}
      {pending&&<s-banner tone="warning">A {job.status} batch is unfinished. The parent stock will not increase until ALL cards have been reserved. Progress: {job.cursor} / {cards.length}. Do not change the saved card list, Shopify parent stock, or location. Resume in this app; after 23 hours an ambiguous step requires manual reconciliation.</s-banner>}
      {!hasJob&&<s-banner tone="warning">The parent Shopify product must have ZERO existing on-hand stock or committed orders before the first allocation. Any earlier pre-orders must be reconciled first. Choose a location that fulfils online orders and has the physical cards set aside.</s-banner>}
      <s-stack direction="inline" gap="base" alignItems="end">
        <s-select label="Reserve cards from location" value={locationId} disabled={busy||hasJob} onChange={e=>setLocationId(e.currentTarget.value)}>
          {locations.map(l=><s-option key={l.location.id} value={l.location.id}>{l.location.name}</s-option>)}
        </s-select>
        <s-number-field label="Complete sets to allocate" min="1" step="1" value={sets} onInput={e=>setSets(e.currentTarget.value)} disabled={busy||pending}/>
        <s-button variant="secondary" onClick={check} disabled={busy||pending||!cards.length||!locationId||disabledLegacy}>Check all component stock</s-button>
      </s-stack>
      {!pending&&<s-checkbox checked={agree} disabled={busy} onChange={e=>setAgree(e.currentTarget.checked)}>
        I confirm the card list is final for this allocation, the parent product is configured for tracked stock and no overselling, and no historical orders have unreserved stock requirements.
      </s-checkbox>}
      {!pending&&<s-button variant="primary" disabled={!canStart||!agree||!savedPlanMatches||!cards.length||!locationId} onClick={start}>
        {hasJob?'Reserve additional complete sets':'Reserve cards and add available complete sets'}
      </s-button>}
      {pending&&<s-button variant="primary" onClick={resume} disabled={busy||!savedPlanMatches}>Resume unfinished batch</s-button>}
      {job?.status==='active'&&<s-stack direction="inline" gap="base" alignItems="end">
        <s-number-field label="Sets fulfilled in Shopify (not yet consumed)" min="1" step="1" value={fulfilled} onInput={e=>setFulfilled(e.currentTarget.value)} disabled={busy}/>
        <s-button disabled={!agree||busy||!savedPlanMatches} onClick={consume}>Consume shipped card stock</s-button>
      </s-stack>}
      {job?.status==='active'&&<s-paragraph>To dispatch: fulfil the parent's orders in Shopify first, then enter how many complete sets have been fulfilled and click Consume shipped card stock. This reduces Shopify's reserved card inventory and physical on-hand inventory. This is an explicit staff action, not an automatic order webhook.</s-paragraph>}
      <s-banner tone="warning">Do not cancel, refund, unpublish, manually alter inventory, or change bundle contents without reconciling the reserved card pool. No automatic cancellations, release-to-available workflow, or order-by-order component fulfillment is included in this version. Reserve/consume one batch at a time and keep this page open; you can resume if interrupted.</s-banner>
      {busy&&<s-text>{progress||'Working with Shopify inventory…'}</s-text>}
      {error&&<s-banner tone="critical">{error}</s-banner>}
      {notice&&<s-banner tone="success">{notice}</s-banner>}
    </s-stack>
  </s-section>;
}
