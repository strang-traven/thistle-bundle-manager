import '@shopify/ui-extensions/preact';
import {Component, render} from 'preact';
import {useEffect, useState} from 'preact/hooks';
import {ReservationPanel} from './ReservationPanel.jsx';
import {InsightsPanel} from './InsightsPanel.jsx';
import {
  APP_TAG, META_KEY, META_NAMESPACE,
  normaliseComponents, decodeLiveComponents,
  productAdminUrl,
  makePlanShards, decodePlanShards,
} from './logic.js';

// Products created in v1 keep the same tag and tt_preorders.configuration metafield.
const BUNDLE_INDEX = `
  query BundleIndex($after: String, $q: String!) {
    products(first: 30, after: $after, query: $q, sortKey: UPDATED_AT, reverse: true) {
      nodes {
        id title status productType updatedAt
        variants(first: 1) { nodes {
          id inventoryQuantity inventoryPolicy requiresComponents
          metafield(namespace: "tt_preorders", key: "configuration") { value }
          liveField: metafield(namespace: "tt_preorders", key: "live_components") { value }
          allocationJob: metafield(namespace: "tt_preorders", key: "allocation_job") { value }
        } }
      }
      pageInfo { hasNextPage endCursor }
    }
  }
`;
const PARENT_QUERY = `
  query Parent($id: ID!) {
    productVariant(id: $id) {
      id displayName inventoryQuantity inventoryPolicy requiresComponents
      product { id title status }
      metafield(namespace: "tt_preorders", key: "configuration") { value compareDigest }
      liveField: metafield(namespace: "tt_preorders", key: "live_components") { value compareDigest }
      allocationJob: metafield(namespace: "tt_preorders", key: "allocation_job") { value }
    }
  }
`;
const PLAN_SHARDS_QUERY = `
  query PlanShards($id: ID!, $keys: [String!]!, $after: String) {
    productVariant(id:$id) {
      metafields(first:100, keys:$keys, after:$after) {
        nodes { key value }
        pageInfo { hasNextPage endCursor }
      }
    }
  }
`;
const COMPONENT_QUERY = `
  query ComponentDetails($ids: [ID!]!) {
    nodes(ids: $ids) {
      ... on ProductVariant {
        id displayName inventoryQuantity inventoryPolicy requiresComponents
        inventoryItem { tracked }
      }
    }
  }
`;
const CREATE_PRODUCT = `
  mutation CreatePreorder($product: ProductCreateInput!) {
    productCreate(product: $product) {
      product { id variants(first: 1) { nodes { id } } }
      userErrors { field message }
    }
  }
`;
const SAVE_FIELDS = `
  mutation SaveFields($metafields: [MetafieldsSetInput!]!) {
    metafieldsSet(metafields: $metafields) {
      metafields { key value compareDigest }
      userErrors { field message }
    }
  }
`;
const ADD_TAG = `
  mutation TagBundle($id: ID!, $tags: [String!]!) {
    tagsAdd(id: $id, tags: $tags) { userErrors { field message } }
  }
`;

async function query(q, variables = {}) {
  const res = await shopify.query(q, {variables, version: '2026-07'});
  if (res.errors?.length) throw new Error(res.errors.map(x => x.message).join('; '));
  if (!res.data) throw new Error('Shopify did not return data. Verify the app permissions.');
  return res.data;
}
function checked(result) {
  if (result?.userErrors?.length) throw new Error(result.userErrors.map(x => x.message).join('; '));
  return result;
}
function parseConfig(field) {
  if (!field?.value) return {};
  try { return JSON.parse(field.value); }
  catch { throw new Error('A saved pre-order configuration has invalid JSON.'); }
}
function variantStatus(v) {
  if (!v) return 'No variant';
  if (v.allocationJob?.value) return 'Stock allocation managed';
  if (v.requiresComponents) return 'Legacy fixed bundle';
  if (v.liveField?.value) {
    try { if (decodeLiveComponents(v.liveField.value).length) return 'Live · Shopify 150-component checkout'; }
    catch { return 'Check configuration'; }
  }
  return 'Pre-order · Not linked';
}
function normaliseForCompare(items) { return (items||[]).map(x=>[x.id,Number(x.quantity)]).sort((a,b)=>a[0].localeCompare(b[0])); }
function shortDate(v) { return v ? String(v).slice(0, 10) : 'Not set'; }
const indexedSearch = (term, allProducts = false) => {
  const value = String(term || '').trim().replace(/["'\\]/g, ' ').slice(0, 90);
  return allProducts ? value : `tag:"${APP_TAG}"${value ? ` AND ${value}` : ''}`;
};

class AppErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = {error: null};
  }

  componentDidCatch(error) {
    this.setState({error});
  }

  render() {
    if (this.state.error) {
      return <s-page heading="Thistle · Pre-order Bundles">
        <s-section heading="The app could not start">
          <s-banner tone="critical">{this.state.error?.message || String(this.state.error)}</s-banner>
        </s-section>
      </s-page>;
    }
    return this.props.children;
  }
}

export default function extension() {
  try {
    render(<AppErrorBoundary><App /></AppErrorBoundary>, document.body);
  } catch (error) {
    render(<s-page heading="Thistle · Pre-order Bundles">
      <s-section heading="The app could not start">
        <s-banner tone="critical">{error?.message || String(error)}</s-banner>
      </s-section>
    </s-page>, document.body);
  }
}

function App() {
  const [list, setList] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [hasMore, setHasMore] = useState(false);
  const [listingBusy, setListingBusy] = useState(false);
  const [find, setFind] = useState('');
  const [appliedFind, setAppliedFind] = useState('');
  const [browseAll, setBrowseAll] = useState(false);
  const [parent, setParent] = useState(null);
  const [components, setComponents] = useState([]);
  const [releaseDate, setReleaseDate] = useState('');
  const [newTitle, setNewTitle] = useState('');
  const [componentSearch, setComponentSearch] = useState('');
  const [componentPage, setComponentPage] = useState(0);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [digest, setDigest] = useState(null);
  const [liveDigest, setLiveDigest] = useState(null);
  const [locked, setLocked] = useState(false);
  const [savedComponents, setSavedComponents] = useState([]);
  const [savedRelease, setSavedRelease] = useState('');
  const [liveComponents, setLiveComponents] = useState([]);
  const [planBank, setPlanBank] = useState(null);

  useEffect(() => { void refreshList(); }, []);
  async function safe(task) {
    setBusy(true); setError(''); setMessage('');
    try { await task(); }
    catch (e) { setError(e?.message || String(e)); }
    finally { setBusy(false); }
  }
  async function refreshList(append = false, currentSearch = appliedFind, allProducts = browseAll) {
    setListingBusy(true);
    try {
      const data = await query(BUNDLE_INDEX, {after: append ? cursor : null, q: indexedSearch(currentSearch, allProducts)});
      const collection = data.products;
      setList(old => append ? [...old, ...collection.nodes] : collection.nodes);
      setCursor(collection.pageInfo.endCursor);
      setHasMore(collection.pageInfo.hasNextPage);
      setAppliedFind(currentSearch); setBrowseAll(allProducts);
    } catch (e) { setError(e?.message || String(e)); }
    finally { setListingBusy(false); }
  }
  async function readDetails(staged) {
    if (!staged.length) return [];
    const collected = new Map();
    // Avoid Shopify GraphQL query complexity and throttle limits on 150 variants.
    for (let offset = 0; offset < staged.length; offset += 25) {
      const ids = staged.slice(offset, offset + 25).map(x => x.id);
      const data = await query(COMPONENT_QUERY, {ids});
      for (const variant of data.nodes || []) if (variant) collected.set(variant.id, variant);
    }
    return staged.map(item => {
      const v = collected.get(item.id);
      return {
        ...item,
        title: v?.displayName || item.title || item.id,
        inventoryQuantity: v?.inventoryQuantity ?? null,
        inventoryPolicy: v?.inventoryPolicy ?? 'UNKNOWN',
        requiresComponents: v?.requiresComponents ?? false,
        tracked: v?.inventoryItem?.tracked ?? false,
        missing: !v,
      };
    });
  }
  async function loadShards(variantId, config) {
    const keys = Array.from({length:config.shardCount},(_,i)=>
      `${META_NAMESPACE}.plan_${config.bank}_${String(i).padStart(6,'0')}`);
    const values = [];
    for (let offset=0;offset<keys.length;offset+=100) {
      const selected=keys.slice(offset,offset+100);
      let cursor=null;
      do {
        const data=await query(PLAN_SHARDS_QUERY,{id:variantId,keys:selected,after:cursor});
        const connection=data.productVariant?.metafields;
        if (!connection) throw new Error('Unable to load Shopify plan pages.');
        values.push(...connection.nodes);
        cursor=connection.pageInfo.hasNextPage ? connection.pageInfo.endCursor : null;
      } while(cursor);
    }
    return decodePlanShards(config,values);
  }
  async function openEditor(id) {
    const data = await query(PARENT_QUERY, {id});
    const v = data.productVariant;
    if (!v) throw new Error('The selected pre-order variant no longer exists.');
    const config = parseConfig(v.metafield);
    let live = [];
    if (v.liveField?.value) live = decodeLiveComponents(v.liveField.value);
    const planned = config.schemaVersion===3
      ? await loadShards(id,config)
      : normaliseComponents(config.components || live);
    // Load stock lazily. Fetching thousands of variants just to open an editor
    // is slow and can exhaust Shopify GraphQL capacity.
    setParent(v); setComponents(planned); setLiveComponents(live);
    setPlanBank(config.schemaVersion===3 ? config.bank : null);
    setDigest(v.metafield?.compareDigest ?? null);
    setLiveDigest(v.liveField?.compareDigest ?? null);
    setReleaseDate(config.releaseDate || ''); setSavedRelease(config.releaseDate || '');
    setSavedComponents(planned); setLocked(!!v.allocationJob?.value);
    setComponentSearch(''); setComponentPage(0);
    setMessage(`Editing: ${v.product.title} · ${planned.length} cards in the saved plan`);
  }
  async function pickParent() {
    const chosen = await shopify.resourcePicker({type: 'variant', multiple: false, action: 'select'});
    if (!chosen?.length) return;
    await safe(async () => openEditor(chosen[0].id));
  }
  async function createProduct() {
    if (!newTitle.trim()) {setError('Enter the pre-order product name.'); return;}
    await safe(async () => {
      const data = await query(CREATE_PRODUCT, {product: {
        title: newTitle.trim(), status: 'DRAFT', productType: 'Pre-Order Bundle',
        tags: ['Pre Order', APP_TAG],
        descriptionHtml: '<p>Pre-order product. Contents will be confirmed before release. Please review expected delivery date and pre-order terms.</p>',
      }});
      const created = checked(data.productCreate);
      const variantId = created.product?.variants?.nodes?.[0]?.id;
      if (!variantId) throw new Error('Created product, but Shopify did not return the default variant.');
      await openEditor(variantId);
      setNewTitle(''); await refreshList(false, '');
      setMessage('Draft created. Set its price, initial pre-order limit, and publication in Shopify Admin.');
    });
  }
  async function pickComponents() {
    if (!parent || locked) return;
    const chosen = await shopify.resourcePicker({type: 'variant', multiple: true, action: 'add'});
    if (!chosen?.length) return;
    await safe(async () => {
      const next = components.map(c => ({id:c.id, quantity:c.quantity, title:c.title}));
      const ids = new Set(next.map(c => c.id));
      for (const v of chosen) {
        if (!ids.has(v.id)) {
          next.push({id:v.id, quantity:1, title:v.displayName || v.title || v.id});
          ids.add(v.id);
        }
      }
      const added=normaliseComponents(next);
      const details=await readDetails(added.filter(x => !components.some(old=>old.id===x.id)));
      const updates=new Map(details.map(x=>[x.id,x]));
      setComponents(added.map(x=>updates.get(x.id) || components.find(c=>c.id===x.id) || x));
      setMessage('Cards added. Save your plan before reserving stock.');
    });
  }
  function updateQty(id, value) {
    const qty = Number(value);
    setComponents(old => old.map(v => v.id === id ? {...v, quantity:qty} : v));
  }
  function removeComponent(id) { setComponents(old => old.filter(v => v.id !== id)); }
  async function savePlan(planned = components) {
    if (!parent) throw new Error('Select a pre-order first.');
    if (locked) throw new Error('This card list is locked because Shopify stock has already been allocated. Reconcile allocations before making changes.');
    const clean = normaliseComponents(planned);
    if (releaseDate && !/^\d{4}-\d{2}-\d{2}$/.test(releaseDate)) throw new Error('Use YYYY-MM-DD for release date.');
    // Two banks: write every page of the *inactive* bank first. Commit the
    // tiny index LAST with Shopify's compareDigest concurrency control.
    // Failed writes leave the previous full card list intact.
    const nextBank=planBank==='a'?'b':'a';
    const {index,fields}=makePlanShards(clean,nextBank,releaseDate);
    for (let offset=0; offset<fields.length; offset+=20) {
      const payload=fields.slice(offset,offset+20).map(f=>({...f,ownerId:parent.id,namespace:META_NAMESPACE}));
      checked((await query(SAVE_FIELDS,{metafields:payload})).metafieldsSet);
    }
    const saved=checked((await query(SAVE_FIELDS, {metafields:[{
      ownerId:parent.id,namespace:META_NAMESPACE,key:META_KEY,type:'json',
      value:JSON.stringify(index),compareDigest:digest,
    }]})).metafieldsSet);
    setDigest(saved.metafields?.[0]?.compareDigest ?? null);
    setSavedComponents(clean); setSavedRelease(releaseDate);
    setPlanBank(nextBank);
    checked((await query(ADD_TAG,{id:parent.product.id,tags:[APP_TAG]})).tagsAdd);
    return clean;
  }
  async function saveDraft() {
    await safe(async () => {
      await savePlan();
      await refreshList(false, appliedFind);
      setMessage('Card list saved in Shopify. You can now reserve component stock from a selected store location.');
    });
  }
  const live = liveComponents.length > 0;
  const savedPlanMatches = JSON.stringify(normaliseForCompare(components))===JSON.stringify(normaliseForCompare(savedComponents)) && releaseDate===savedRelease;
  const filtered = components.filter(c => String(c.title).toLowerCase().includes(componentSearch.toLowerCase()) || c.id.includes(componentSearch));
  const pageCount = Math.max(1, Math.ceil(filtered.length / 20));
  const visible = filtered.slice(componentPage * 20, (componentPage + 1) * 20);
  const legacyFixed = !!parent?.requiresComponents;
  async function checkVisibleStock() {
    await safe(async()=>{
      const updates=await readDetails(visible);
      const byId=new Map(updates.map(x=>[x.id,x]));
      setComponents(old=>old.map(x=>byId.get(x.id)||x));
      setMessage(`Checked current Shopify stock for ${updates.length} visible cards.`);
    });
  }
  const allocatedCount = list.filter(x=>!!x.variants?.nodes?.[0]?.allocationJob?.value).length;

  return <s-page heading="Thistle · Pre-order Bundles">
    <s-section heading="Overview">
      <s-stack direction="block" gap="base">
        <s-paragraph>Plan very large card sets, allocate the real cards from Shopify inventory, then sell one tracked pre-order product. No 30/150-card checkout bundle component limit and no external server.</s-paragraph>
        <s-stack direction="inline" gap="base"><s-badge>{list.length} Shopify listings loaded</s-badge><s-badge tone="info">{allocatedCount} listings with allocation journals</s-badge><s-button onClick={()=>void refreshList(false,appliedFind)}>Refresh listings</s-button></s-stack>
        <s-banner tone="warning">Stock allocation is completed by an admin action, not a perpetual live sync. Do not sell the parent until reservations are complete. Use the new order and singles-stock preview to plan allocations. Historical orders and cancellations still require reconciliation.</s-banner>
      </s-stack>
    </s-section>

    <s-section heading="Your pre-order listings">
      <s-stack direction="block" gap="base">
        <s-stack direction="inline" gap="base" alignItems="end">
          <s-text-field label="Find pre-orders" placeholder="Search by product or set name" value={find} onInput={e=>setFind(e.currentTarget.value)} />
          <s-button onClick={()=>void refreshList(false,find)} disabled={listingBusy}>Search</s-button>
          <s-button variant="tertiary" onClick={()=>{setFind(''); void refreshList(false, '');}} disabled={listingBusy}>Clear</s-button>
          <s-button variant="secondary" onClick={()=>{setFind(''); void refreshList(false,'',!browseAll);}} disabled={busy || listingBusy}>{browseAll ? 'Show pre-orders only' : 'Browse all Shopify products'}</s-button>
          <s-button onClick={pickParent} disabled={busy}>Import existing Shopify product</s-button>
        </s-stack>
        <s-text>{browseAll ? 'Viewing all Shopify products; search by product name to find an untagged pre-order.' : 'Viewing pre-order products tagged Thistle Pre-Order Bundle.'}</s-text>
        {listingBusy && <s-text>Loading Shopify products…</s-text>}
        {!listingBusy && list.length === 0 && <s-box border="base" padding="base" borderRadius="base">
          <s-paragraph>No products found in this view. Select Browse all Shopify products to find untagged listings, or use <s-text type="strong">Import existing Shopify product</s-text>, then Save to add it to your list.</s-paragraph>
        </s-box>}
        {list.map(p => {
          const v = p.variants?.nodes?.[0];
          const status = variantStatus(v);
          let data = {};
          try { data = parseConfig(v?.metafield); } catch { data = {}; }
          const count = Number.isSafeInteger(data.componentCount) ? data.componentCount : Array.isArray(data.components) ? data.components.length : 0;
          return <s-box key={p.id} padding="base" border="base" borderRadius="base">
            <s-stack direction="inline" gap="base" alignItems="center">
              <s-stack direction="block" gap="small">
                <s-text type="strong">{p.title}</s-text>
                <s-stack direction="inline" gap="small">
                  <s-badge tone={v?.allocationJob?.value?'success':status.includes('Legacy')?'warning':'info'}>{v?.allocationJob?.value?'Reservation managed':status}</s-badge>
                  <s-badge>{p.status}</s-badge>
                  <s-text>{count} planned cards · Release: {shortDate(data.releaseDate)}</s-text>
                </s-stack>
              </s-stack>
              <s-button variant="primary" onClick={()=>void safe(()=>openEditor(v?.id))} disabled={busy || !v}>Edit set</s-button>
              <s-link href={productAdminUrl(p.id)}>Shopify product</s-link>
            </s-stack>
          </s-box>;
        })}
        {hasMore && <s-button onClick={()=>void refreshList(true,appliedFind)} disabled={listingBusy}>Load more pre-orders</s-button>}
      </s-stack>
    </s-section>

    <s-section heading="Create a new pre-order">
      <s-stack direction="inline" gap="base" alignItems="end">
        <s-text-field label="New product name" placeholder="e.g. Riftbound · Full Set Pre-order" value={newTitle} onInput={e=>setNewTitle(e.currentTarget.value)}/>
        <s-button variant="primary" onClick={createProduct} disabled={busy || !newTitle.trim()}>Create draft</s-button>
      </s-stack>
    </s-section>

    {parent && <s-section heading={`Editing · ${parent.product.title}`}>
      <s-stack direction="block" gap="base">
        <s-stack direction="inline" gap="base" alignItems="center">
          <s-badge tone={legacyFixed||live?'warning':'info'}>{legacyFixed ? 'Legacy fixed bundle' : live ? 'Prior Cart Transform configuration' : locked?'Stock reserved':'Plan only'}</s-badge>
          <s-badge>{parent.product.status}</s-badge>
          <s-text>Standalone parent stock: {parent.inventoryQuantity ?? 'Unknown'}</s-text>
          <s-link href={productAdminUrl(parent.product.id)}>Edit product price and stock in Shopify</s-link>
          <s-button variant="tertiary" onClick={()=>{setParent(null); setComponents([]);}}>Close editor</s-button>
        </s-stack>
        {(legacyFixed||live) && <s-banner tone="critical">This product has an older Shopify bundle configuration. Do not allocate stock until migrated and previous orders have been reviewed. The old checkout expansion cannot run simultaneously with stock-reserved parent products.</s-banner>}
        <s-text-field label="Expected release date (YYYY-MM-DD)" value={releaseDate} placeholder="2027-04-23" disabled={locked} onInput={e=>setReleaseDate(e.currentTarget.value)} />
        <s-stack direction="inline" gap="base" alignItems="center">
          <s-button variant="primary" onClick={pickComponents} disabled={busy || legacyFixed || locked}>Add cards from Shopify</s-button>
          <s-text type="strong">{components.length} planned cards (no app-set cap)</s-text>
          <s-text>Large set planning and Shopify card reservations</s-text>
        </s-stack>
        <s-paragraph>Card lists are saved in Shopify. Once stock is allocated, the list locks so reserved cards cannot be silently swapped.</s-paragraph>
        <s-stack direction="inline" gap="base" alignItems="end">
          <s-text-field label="Filter selected cards" placeholder="Card name or variant ID" value={componentSearch} onInput={e=>{setComponentSearch(e.currentTarget.value);setComponentPage(0);}} />
          <s-badge>{filtered.length} matches</s-badge>
          <s-button variant="secondary" onClick={checkVisibleStock} disabled={busy || !visible.length}>Check visible card stock</s-button>
        </s-stack>
        {visible.length === 0 && <s-box padding="base" border="base" borderRadius="base"><s-text>No selected cards match the filter. Add some card variants above.</s-text></s-box>}
        {visible.map(c=><s-box key={c.id} padding="base" border="base" borderRadius="base">
          <s-stack direction="inline" gap="base" alignItems="center">
            <s-stack direction="block" gap="small">
              <s-text type="strong">{c.title}</s-text>
              <s-text>Shopify stock: {c.inventoryQuantity ?? 'Not checked'} · {c.tracked === undefined ? 'Not checked' : c.tracked ? 'Tracked' : 'Not tracked'} · {c.inventoryPolicy || 'Not checked'}</s-text>
            </s-stack>
            <s-number-field label="Cards per set" min="1" max="2000" step="1" value={String(c.quantity)} disabled={locked} onInput={e=>updateQty(c.id,e.currentTarget.value)}/>
            <s-button variant="tertiary" tone="critical" onClick={()=>removeComponent(c.id)} disabled={busy||locked}>Remove</s-button>
          </s-stack>
        </s-box>)}
        {pageCount > 1 && <s-stack direction="inline" gap="base" alignItems="center">
          <s-button variant="secondary" disabled={componentPage===0} onClick={()=>setComponentPage(p=>Math.max(0,p-1))}>Previous</s-button>
          <s-text>Page {componentPage + 1} of {pageCount}</s-text>
          <s-button variant="secondary" disabled={componentPage>=pageCount-1} onClick={()=>setComponentPage(p=>Math.min(pageCount-1,p+1))}>Next</s-button>
        </s-stack>}
        <s-button onClick={saveDraft} disabled={busy||locked}>Save card list (draft)</s-button>
        <InsightsPanel parentId={parent.id} cards={savedComponents}/>
        <ReservationPanel parentId={parent.id} cards={components} planDigest={digest} savedPlanMatches={savedPlanMatches} disabledLegacy={legacyFixed||live} onLocked={setLocked} onUpdated={()=>void refreshList(false,appliedFind)}/>
      </s-stack>
    </s-section>}

    {error && <s-banner tone="critical">{error}</s-banner>}
    {message && <s-banner tone="success">{message}</s-banner>}
    <s-section heading="How inventory allocation works">
      <s-paragraph>Shopify moves each card from available to reserved at one physical location. Only after all required cards have been reserved does the app increase the sellable stock of the ordinary bundle parent. Customers buy that parent as a single Shopify line. Staff fulfil parent orders in Shopify, then use the Consume fulfilled card stock action. No automatic webhook/server or unlimited native Shopify checkout bundle is claimed.</s-paragraph>
    </s-section>
  </s-page>;
}
