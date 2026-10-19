import {normaliseComponents} from '../extensions/preorder-manager/src/logic.js';

export const MODES=Object.freeze({PREORDER:'PREORDER',ALLOCATING:'ALLOCATING',READY_FOR_LIVE:'READY_FOR_LIVE',LIVE:'LIVE',PAUSED:'PAUSED'});

export function allocationDemand(components,outstandingSets){
  const list=normaliseComponents(components);
  if(!Number.isSafeInteger(outstandingSets)||outstandingSets<0)throw Error('Outstanding set quantity is invalid');
  return list.map(c=>({...c,quantityPerSet:c.quantity,required:c.quantity*outstandingSets}));
}

export function packingManifest(order,components){
  const sets=Number(order?.outstanding);
  if(!Number.isSafeInteger(sets)||sets<1)throw Error('Order has no outstanding bundle quantity');
  return {orderId:order.order_id,orderName:order.order_name||order.order_id,bundleQuantity:sets,
    items:allocationDemand(components,sets).map(c=>({variantId:c.id,title:c.title,quantity:c.required}))};
}

export function liveParts(components,size=150){
  const list=normaliseComponents(components);
  if(!list.length)throw Error('Link at least one component variant');
  if(!Number.isSafeInteger(size)||size<1||size>150)throw Error('A live checkout part supports at most 150 variants');
  return Array.from({length:Math.ceil(list.length/size)},(_,i)=>({partNumber:i+1,components:list.slice(i*size,(i+1)*size)}));
}

export function assertTransition(bundle,next,{outstanding=0,reservedSets=0,activeParts=0}={}){
  const mode=bundle?.mode;
  if(!Object.values(MODES).includes(mode)||!Object.values(MODES).includes(next))throw Error('Unknown bundle lifecycle mode');
  if(next===MODES.ALLOCATING){
    if(mode!==MODES.PREORDER)throw Error('Only a pre-order bundle can begin allocation');
    if(!bundle.location_id)throw Error('Choose one Shopify inventory location before allocation');
    if(!bundle.reconciled_at)throw Error('Reconcile outstanding pre-orders before allocation');
    if(!normaliseComponents(bundle.components).length)throw Error('Link and save the component variants before allocation');
  }else if(next===MODES.READY_FOR_LIVE){
    if(mode!==MODES.ALLOCATING)throw Error('Complete allocation before preparing live mode');
    if(outstanding!==reservedSets)throw Error(`Reserved sets (${reservedSets}) do not match outstanding pre-orders (${outstanding})`);
  }else if(next===MODES.LIVE){
    if(mode!==MODES.READY_FOR_LIVE)throw Error('Bundle must pass the ready-for-live checks first');
    const expected=liveParts(bundle.components).length;
    if(activeParts!==expected)throw Error(`Live checkout parts are incomplete (${activeParts}/${expected})`);
  }else if(next!==MODES.PAUSED)throw Error(`Unsupported transition from ${mode} to ${next}`);
  return true;
}
