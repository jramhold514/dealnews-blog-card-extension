/* ─── Constants ─── */
const DATO = 'https://site-api.datocms.com';
// DealNews's own public content API (what blog-slider and the standalone Live Feed generator call). The key is the same shared, site-wide
// public key served to every visitor of dealnews.com (see index.html). Used only by Find offers.
const DN_CONTENT_API = 'https://api.dealnews.com/content';
const DN_CONTENT_API_AUTH = 'DN jxqfz29pbv9xpWSYnmJX';
const PROC_TARGET_CLASS = 'btn-cta';
// Matches full URL tokens containing either of DealNews's own tracking-link
// paths — "artclick" (e.g. dealnews.com/lw/artclick.html) or the plain
// "/lw/click.html" redirect — not just the bare keyword, so flagged matches
// are actionable (copyable/searchable URLs) instead of a plain yes/no.
// "/lw/click.html" is matched as the fuller path rather than a bare "click"
// keyword, unlike "artclick" above — "click" alone is common enough in
// unrelated URL text (onclick handlers, "clickbank", etc.) that matching it
// bare would false-positive far more than the distinctive "artclick" token does.
const TRACKING_LINK_PATTERN = /https?:\/\/[^\s"'<>]*(?:artclick|\/lw\/click\.html)[^\s"'<>]*/gi;
// CTA button text containing this is an editorial signal that the card is
// meant to stay on the page despite being expired (e.g. "Expired" as the
// button label) — not a stale card that should be swept up automatically.
const EXPIRED_CTA_PATTERN = /expired/i;
// The CTA text moveAllExpiredToGroup()/toggleMoveToExpiredGroup() write onto
// a card's button when moving it into the Expired group on regenerate (see
// "Expired group" in CLAUDE.md). Contains "expired," so a re-loaded copy of
// the regenerated article will detect these cards as keepDespiteExpired on
// its own — no special-casing needed to keep that in sync.
const EXPIRED_GROUP_CTA_TEXT = 'Expired Promo';

/* ─── State ─── */
let offers = [];
let cardLayout = 'grid'; // 'grid' | 'vertical' — see setCardLayout()
let cardStyle  = 'standard'; // 'standard' (row layout) | 'classic' (the original card) | 'compact' (experimental) | 'pick' (Creator Pick) | 'table' — see generateHTML()
let showImages = true;       // false drops each card's image column entirely — see generateHTML()
let trimLong   = true;       // Standard style: trim long value statements with a "more" (a small script)
let cpBar      = true;       // Creator Pick style: emit the sort + creator-filter bar (script) — see "Creator Pick card"
let showWasPrice = true;       // Standard and Creator Pick styles: the struck-through pre-discount price
let showMetaLine = true;       // Standard and Creator Pick styles: the "Store · Shipping" line (the end date has its own toggle)
let resizeImages = true;       // Standard and Creator Pick styles: request images at 2x display size instead of the full upload
let rememberOptions = true;    // keep the card options between sessions (see "Card options")
let showDetails = true;        // Table style: each row's description in an expandable "Details" (off = the table has no description text)
let showEndDates = true;       // Standard and Creator Pick styles: show "Ends Mon D" on cards whose offer has an end date
let articleOriginalHTML  = '';
let articleCards         = [];
let articleHTMLModified  = false; // set by edits that don't flag/reorder anything — see removeAndRegenerate()
let findMatches          = []; // [{start, end, text, selected}] — see previewArticleFindMatches()
let regenHTML            = '';
let detectedEditorSource = null;
let detectedEditorId     = null;

/* ─── Token ─── */
function getToken() {
  return document.getElementById('token-input').value.trim();
}

function initToken() {
  const input  = document.getElementById('token-input');
  const status = document.getElementById('token-status');

  chrome.storage.sync.get(['datoToken'], result => {
    if (result.datoToken) {
      input.value = result.datoToken;
      status.textContent = '✓ saved';
      status.className = 'token-status ok';
    }
  });

  input.addEventListener('change', () => {
    const val = input.value.trim();
    chrome.storage.sync.set({ datoToken: val });
    status.textContent = val ? '✓ saved' : '—';
    status.className = val ? 'token-status ok' : 'token-status';
  });
}

/* ─── Theme ─── */
const ICON_MOON = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>`;
const ICON_SUN  = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>`;

function setThemeIcon(isDark) {
  document.getElementById('theme-btn').innerHTML = isDark ? ICON_SUN : ICON_MOON;
}

function toggleTheme() {
  const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
  if (isDark) {
    document.documentElement.removeAttribute('data-theme');
    chrome.storage.sync.set({ theme: 'light' });
  } else {
    document.documentElement.setAttribute('data-theme', 'dark');
    chrome.storage.sync.set({ theme: 'dark' });
  }
  setThemeIcon(!isDark);
}

/* ─── Toast ─── */
let toastTimer;
function showToast(msg, isErr = false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast show' + (isErr ? ' err' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.className = 'toast'; }, 2800);
}

/* ─── Change Log ───
 * Records exactly what the Processor and Article tabs did to HTML each time
 * they run — removed cards, reordered cards, retexted buttons — so an editor
 * chasing down an unexpected result can see what actually happened rather
 * than having to reverse-engineer it from the output alone. Session-only
 * (not persisted to chrome.storage): it resets when the sidebar is reopened,
 * same as `offers`/`articleCards`. */
let changeLog = [];
const CHANGE_LOG_MAX = 50;

function logChange(source, summary, details) {
  const entry = { time: new Date(), source, summary, details: details || [] };
  changeLog.unshift(entry);
  if (changeLog.length > CHANGE_LOG_MAX) changeLog.length = CHANGE_LOG_MAX;
  console.log(`[Change Log] ${source}: ${summary}`, entry.details);
  renderChangeLog();
}

function renderChangeLog() {
  const list  = document.getElementById('change-log-list');
  const count = document.getElementById('change-log-count');
  count.textContent = changeLog.length ? `(${changeLog.length})` : '';

  if (!changeLog.length) {
    list.innerHTML = '<div class="change-log-empty">No changes logged yet.</div>';
    return;
  }

  list.innerHTML = changeLog.map(entry => `
    <div class="change-log-entry">
      <div class="change-log-entry-head">
        <span class="change-log-source">${esc(entry.source)}</span>
        <span class="change-log-time">${entry.time.toLocaleTimeString()}</span>
      </div>
      <div class="change-log-summary">${esc(entry.summary)}</div>
      ${entry.details.length
        ? `<ul class="change-log-details">${entry.details.map(d => `<li>${esc(d)}</li>`).join('')}</ul>`
        : ''}
    </div>`).join('');
}

function clearChangeLog() {
  changeLog = [];
  renderChangeLog();
}

function toggleChangeLog() {
  const body  = document.getElementById('change-log-body');
  const caret = document.querySelector('#change-log-toggle .change-log-caret');
  const isOpen = body.style.display !== 'none';
  body.style.display = isOpen ? 'none' : 'block';
  caret.textContent = isOpen ? '▸' : '▾';
}

/* ─── Tracking link detection ───
 * Flags dealnews.com/lw/artclick.html- and /lw/click.html-style tracking
 * links wherever raw HTML enters the tool (Article tab load, Article tab
 * regenerate output, Processor tab paste) — scans the raw string rather than
 * parsed DOM so it catches the pattern in any attribute or text node, not
 * just known link attributes. Both link shapes are flagged together in one
 * combined count/list rather than kept as separate checks, since either one
 * found anywhere means the same thing to the user: a tracking link snuck
 * into HTML that's about to be copied out. */
function findTrackingLinkMatches(html) {
  if (!html) return [];
  const matches = html.match(TRACKING_LINK_PATTERN) || [];
  return Array.from(new Set(matches));
}

function renderTrackingLinkBanner(prefix, matches) {
  const banner = document.getElementById(`${prefix}-tracking-banner`);
  if (!banner) return;
  if (!matches.length) { banner.style.display = 'none'; banner.innerHTML = ''; return; }
  banner.style.display = 'block';
  banner.innerHTML = `
    <div class="tracking-banner-head">⚠ ${matches.length} tracking URL${matches.length !== 1 ? 's' : ''} found</div>
    <ul class="tracking-banner-list">${matches.map(u => `<li>${esc(u)}</li>`).join('')}</ul>`;
}

/* ─── Tabs ─── */
function setTab(tab) {
  ['configure', 'processor', 'article', 'links'].forEach(t => {
    document.getElementById('pane-' + t).className = 'pane' + (t === tab ? ' active' : '');
    document.getElementById('tab-' + t).className = 'tab' + (t === tab ? ' active' : '');
  });
}

// The Configure tab's own Edit/Preview/HTML sub-views — Preview and HTML used
// to be separate top-level tabs; merged in here since they already shared the
// same `offers` state and already cross-linked ("View HTML →"). Re-renders on
// switch only (not live on every offers edit), matching the original tabs'
// behavior — setCardLayout() is still the one place that eagerly re-renders
// both regardless of which sub-view is currently visible.
function setSubTab(subtab) {
  ['edit', 'preview', 'html'].forEach(t => {
    document.getElementById('subpane-' + t).className = 'subpane' + (t === subtab ? ' active' : '');
    document.getElementById('subtab-' + t).className = 'subtab' + (t === subtab ? ' active' : '');
  });
  if (subtab === 'preview') renderPreview();
  if (subtab === 'html') renderHTMLOut();
}

/* ─── DatoCMS API ─── */
function datoHeaders() {
  const token = getToken();
  if (!token) throw new Error('No API token — save one in the token bar first');
  return {
    'Authorization': 'Bearer ' + token,
    'X-Api-Version': '3',
    'Accept': 'application/json',
  };
}

// DatoCMS structured-text (dast) mark type -> the HTML tag it becomes. Only
// covers inline marks; block-level node types (list, link, etc.) are handled
// directly in dastNodeToHTML() below.
const DAST_MARK_TAGS = {
  strong: 'strong',
  emphasis: 'em',
  underline: 'u',
  strikethrough: 's',
  highlight: 'mark',
  code: 'code',
};

// Converts a dast node tree to real HTML instead of flattening it to plain
// text — offer copy commonly has bullet lists and inline links, and a plain-
// text extraction was silently dropping both from generated cards. All leaf
// text goes through escText() so this is safe to insert directly (no additional
// escaping at the call site); only node types this function itself emits are
// trusted as real tags. itemLink (a link to another DatoCMS record) is
// rendered as plain text rather than a real <a> — resolving its target URL
// would need an extra fetch per link, which isn't worth it for what's likely
// a rare case in offer copy.
function dastNodeToHTML(node) {
  if (!node) return '';

  if (node.type === 'span') {
    let text = escText(node.value || '');
    (node.marks || []).forEach(mark => {
      const tag = DAST_MARK_TAGS[mark];
      if (tag) text = `<${tag}>${text}</${tag}>`;
    });
    return text;
  }

  const inner = (node.children || []).map(dastNodeToHTML).join('');

  switch (node.type) {
    case 'link':      return `<a href="${esc(node.url)}" target="_blank">${inner}</a>`;
    case 'list':       return `<${node.style === 'numbered' ? 'ol' : 'ul'}>${inner}</${node.style === 'numbered' ? 'ol' : 'ul'}>`;
    case 'listItem':   return `<li>${inner}</li>`;
    case 'paragraph':  return `<p>${inner}</p>`;
    case 'heading':    return `<p><strong>${inner}</strong></p>`;
    case 'blockquote': return `<p>${inner}</p>`;
    default:           return inner; // root, itemLink, and anything else: just its text/children
  }
}

function getValueStatement(contentBlocks) {
  if (!Array.isArray(contentBlocks)) return '';
  for (const block of contentBlocks) {
    const typeId =
      block?.relationships?.item_type?.data?.id ||
      block?.item_type?.id ||
      block?.__itemTypeId;
    if (typeId !== '2033526') continue;
    const c = block?.attributes?.content || block?.content;
    if (c?.schema === 'dast') return dastNodeToHTML(c.document).trim();
    if (c?.type === 'root') return dastNodeToHTML(c).trim();
  }
  return '';
}

async function fetchOffer(id) {
  const headers = datoHeaders();
  const res = await fetch(`${DATO}/items/${id}?nested=true`, { headers });
  if (res.status === 401) throw new Error('Invalid API token');
  if (res.status === 404) throw new Error('Record not found');
  if (!res.ok) throw new Error('API error ' + res.status);

  const json = await res.json();
  const attrs = (json.data || json).attributes || json;

  const title          = attrs.offer_title || '';
  const callout        = attrs.call_out_text || '';
  const landingUrl     = attrs.landing_url || '';
  const monetizedUrl   = attrs.monetized_url || landingUrl;
  const vendorDatoId   = attrs.vendor || null;
  const valueStatement = getValueStatement(attrs.content || []);
  // Same field resolveLegacyId() filters by — reading it here means the tool
  // itself never has to look this up separately for data-iref generation.
  const legacyId       = attrs.legacy_id != null ? String(attrs.legacy_id) : '0';

  // Creator Pick fields (see "Creator Pick card" in CLAUDE.md). All optional —
  // an offer with no pick just gets pick: null, and every other card style
  // ignores these fields entirely.
  const pickBlockList = pickBlocks(attrs.curators_pick);
  const meta          = (json.data || json).meta || {};

  const [imageUrl, vendorInfo, authors] = await Promise.all([
    (async () => {
      const uploadId = attrs.image?.upload_id;
      if (!uploadId) return null;
      try {
        const imgRes = await fetch(`${DATO}/uploads/${uploadId}`, { headers });
        if (!imgRes.ok) return null;
        const imgJson = await imgRes.json();
        return imgJson.data?.attributes?.url || null;
      } catch { return null; }
    })(),
    fetchVendor(vendorDatoId, headers),
    Promise.all(pickBlockList.map(b => fetchAuthor(b.author, headers))),
  ]);

  const num = v => (v === null || v === undefined || v === '' || isNaN(Number(v))) ? null : Number(v);
  // One entry per creator, in the CMS order. why_buy is a plain string field;
  // anything else (or whitespace) is not a usable quote, and that pick is skipped.
  const picks = pickBlockList.map((b, i) => ({
    quote: typeof b.why_buy === 'string' ? b.why_buy.trim() : '',
    authorName: authors[i]?.name || '',
    authorLegacyId: authors[i]?.legacyId || '',
    authorImage: authors[i]?.image || null,
  })).filter(p => p.quote);

  return {
    id, title, callout, landingUrl, monetizedUrl, vendor: vendorInfo.legacyId, valueStatement, imageUrl, legacyId,
    vendorName: vendorInfo.name,
    price: num(attrs.price),            // -1 / null when the offer has no single price (sale events)
    wasPrice: num(attrs.comparison_price), // price before the discount
    shipping: attrs.shipping_text || '',
    endISO: attrs.expiration_datetime || '',
    pubISO: meta.first_published_at || '',
    picks,
  };
}

// The pick lives in the offer's modular-content field `curators_pick`. With
// nested=true its blocks come back as objects (like `content` above); each pick
// carries why_buy (the quote) and author (a link to the Author record). An offer
// can have two picks (two creators).
function pickBlocks(blocks) {
  if (!Array.isArray(blocks)) return [];
  return blocks.map(b => b?.attributes || b).filter(a => a && typeof a === 'object' && 'why_buy' in a);
}

// Author and vendor records are shared by many offers, so each is fetched once
// per session. The promise is cached so concurrent adds share one request, but
// a failed lookup is evicted, so a transient error (429, offline) doesn't blank
// that creator or store for the rest of the session.
function cachedLookup(cache, key, load) {
  if (cache.has(key)) return cache.get(key);
  const p = load().then(result => { if (!result) cache.delete(key); return result; },
                        () => { cache.delete(key); return null; });
  cache.set(key, p);
  return p;
}

// Returns { name, legacyId, image } or null.
const authorCache = new Map();
function fetchAuthor(authorId, headers) {
  if (!authorId || typeof authorId !== 'string') return Promise.resolve(null);
  return cachedLookup(authorCache, authorId, async () => {
    const res = await fetch(`${DATO}/items/${authorId}`, { headers });
    if (!res.ok) return null;
    const a = (await res.json()).data?.attributes || {};
    let image = null;
    const uploadId = a.image?.upload_id;
    if (uploadId) {
      const r = await fetch(`${DATO}/uploads/${uploadId}`, { headers });
      if (r.ok) image = (await r.json()).data?.attributes?.url || null;
    }
    return { name: a.name || '', legacyId: a.legacy_id != null ? String(a.legacy_id) : '', image };
  });
}

// Returns { legacyId, name }; { '0', '' } when there is no vendor or the lookup
// fails (the existing "0 = no value" convention for vendor/brand/category).
const vendorCache = new Map();
const NO_VENDOR = { legacyId: '0', name: '' };
async function fetchVendor(vendorDatoId, headers) {
  if (!vendorDatoId) return NO_VENDOR;
  const found = await cachedLookup(vendorCache, vendorDatoId, async () => {
    const res = await fetch(`${DATO}/items/${vendorDatoId}`, { headers });
    if (!res.ok) return null;
    const va = (await res.json()).data?.attributes || {};
    return { legacyId: String(va.legacy_id ?? '0'), name: va.name || '' };
  });
  return found || NO_VENDOR;
}

async function resolveLegacyId(legacyId) {
  const headers = datoHeaders();
  const url = `${DATO}/items?filter[type]=offer&filter[fields][legacy_id][eq]=${encodeURIComponent(legacyId)}&page[limit]=1`;
  const res = await fetch(url, { headers });
  if (res.status === 401) throw new Error('Invalid API token');
  if (!res.ok) throw new Error('API error ' + res.status);
  const json = await res.json();
  const items = json.data || [];
  if (!items.length) throw new Error(`No offer found with Legacy ID ${legacyId}`);
  return items[0].id;
}

async function fetchOfferStatus(offerId, expiryField) {
  const headers = datoHeaders();
  let res;
  try {
    res = await fetch(`${DATO}/items/${offerId}`, { headers });
  } catch {
    return { status: 'unknown', reason: 'Network error' };
  }

  if (res.status === 404) return { status: 'deleted', reason: 'Record deleted in DatoCMS' };
  if (res.status === 401) throw new Error('Invalid API token');
  if (!res.ok) return { status: 'unknown', reason: 'API error ' + res.status };

  const json = await res.json();
  const attrs = (json.data || json).attributes || {};
  const meta  = (json.data || json).meta || {};
  // Read here (rather than a second fetch) since this endpoint already
  // returns it — lets applyIrefFix() resolve an offer's legacy ID for free
  // off the back of a status check instead of a dedicated lookup.
  const legacyId = attrs.legacy_id != null ? String(attrs.legacy_id) : '0';

  if (meta.status && meta.status !== 'published') {
    return { status: 'expired', reason: `DatoCMS status: ${meta.status}`, legacyId };
  }

  const expVal = attrs[expiryField];
  if (expVal) {
    const expDate = new Date(expVal);
    if (!isNaN(expDate) && expDate < new Date()) {
      return { status: 'expired', reason: `${expiryField}: ${expVal}`, legacyId };
    }
  }

  // If the configured field name isn't in the response at all (as opposed to
  // present but empty), the date check above silently never ran — surface
  // the record's real field names so the correct one can be found without
  // needing DatoCMS schema access.
  if (!(expiryField in attrs)) {
    return { status: 'active', reason: `No field named "${expiryField}" on this record — available fields: ${Object.keys(attrs).join(', ')}`, legacyId };
  }

  return { status: 'active', reason: '', legacyId };
}

/* ─── Configure tab ─── */
async function addOfferById() {
  const input      = document.getElementById('id-input');
  const errEl      = document.getElementById('add-err');
  const progressEl = document.getElementById('add-progress');
  errEl.style.display = 'none';
  progressEl.style.display = 'none';

  const raw = input.value.trim();
  if (!raw) return;

  const ids = raw.split(',').map(s => s.trim()).filter(Boolean);
  document.getElementById('add-btn').disabled = true;
  document.getElementById('spinner').style.display = 'inline-block';

  const errors = [];
  let added = 0;

  for (let i = 0; i < ids.length; i++) {
    const entry = ids[i];
    progressEl.textContent = `Adding ${i + 1} of ${ids.length}…`;
    progressEl.style.display = 'block';

    try {
      let datoId = entry;
      if (/^\d+$/.test(entry)) datoId = await resolveLegacyId(entry);

      if (offers.find(o => o.id === datoId)) {
        errors.push(`${entry}: already added`);
        continue;
      }

      const offer = await fetchOffer(datoId);
      offers.push(offer);
      added++;
      renderOffers();
    } catch (e) {
      errors.push(`${entry}: ${e.message}`);
    }
  }

  progressEl.style.display = 'none';
  document.getElementById('add-btn').disabled = false;
  document.getElementById('spinner').style.display = 'none';

  if (errors.length) {
    errEl.textContent = errors.join(' · ');
    errEl.style.display = 'block';
  }
  if (added > 0) input.value = '';
}

/* ─── Find offers ─────────────────────────────────────────────────────────
 * Search the site's own content API (the one blog-slider and the Live Feed
 * generator already use) for live offers by words, category, facet or vendor,
 * tick the ones to use, and hand their IDs to addOfferById() — so a ticked
 * offer becomes exactly the same card as one typed in by ID. See "Find offers"
 * in CLAUDE.md. */
const FIND_PAGE_SIZE = 30;
// excluded: vendor_id (string) -> display name, for the vendors the editor clicked twice. The content API has no
// "not this vendor" parameter (probed 2026-11-24: unknown parameters are ignored), so exclusion is applied here to
// the loaded results, and runFind() keeps loading pages until enough non-excluded offers are on screen.
let findState = { items: [], vendors: [], remaining: 0, loaded: 0, busy: false, selected: new Set(), excluded: new Map() };
const FIND_FILL_PASSES = 6;   // most extra pages runFind() will load to make up for excluded vendors

// "Creator" box: a creator's page link (https://www.dealnews.com/creators/Andy-Frank/184.html) or just its ID, several
// separated by commas or spaces. The content API's creator_id filter (probed 2026-11-25; takes a comma list and combines
// with search, category, facet and vendor) returns every live offer the creator picked, not just the 20 their page lists,
// and includes picks where they are the second creator on the offer.
function findCreatorIds() {
  const ids = [], bad = [];
  document.getElementById('find-creator').value.split(/[\s,]+/).filter(Boolean).forEach(tok => {
    const m = tok.match(/\/(?:creators|authors)\/[^/?#]*\/(\d+)(?:\.html)?(?:[?#].*)?$/i) || tok.match(/^(\d+)$/);
    if (!m) bad.push(tok);
    else if (!ids.includes(m[1])) ids.push(m[1]);
  });
  return { ids, bad };
}

function findParams(offset) {
  const p = [];
  const creators = findCreatorIds().ids;
  if (creators.length) p.push('creator_id=' + creators.join(','));
  const text = document.getElementById('find-text').value.trim();
  const cat  = document.getElementById('find-category').value.trim();
  const fac  = document.getElementById('find-facet').value.trim();
  const ven  = document.getElementById('find-vendor').value.trim();
  if (text) p.push('search=' + encodeURIComponent(text));
  if (cat)  p.push('category_id=' + encodeURIComponent(cat));
  if (fac)  p.push('facet_ids=' + encodeURIComponent(fac));
  if (ven)  p.push('vendor_id=' + encodeURIComponent(ven));
  if (!p.length) return null;
  if (document.getElementById('find-expired').checked) p.push('expired=1');
  // "Hottest first" is asked of the API too (probed 2026-11-25: sort=hotness orders the whole result set, roughly), so the
  // first page is the hottest of ALL matches instead of the hottest of whatever 30 the site order happened to load.
  if (document.getElementById('find-sort').value === 'hot') p.push('sort=hotness');
  p.push('count=' + FIND_PAGE_SIZE);
  if (offset) p.push('start=' + offset);
  return p.join('&');
}

async function runFind(append) {
  const msg = document.getElementById('find-msg');
  if (findState.busy) return;
  if (findCreatorIds().bad.length) {
    msg.textContent = 'Could not read a creator ID from "' + findCreatorIds().bad.join(' ') + '". Paste the creator page link (…/creators/Andy-Frank/184.html) or just the number.';
    msg.className = 'msg warn';
    return;
  }
  const qs = findParams(append ? findState.loaded : 0);
  if (!qs) {
    msg.textContent = 'Enter a search, a creator, a category, a facet or a vendor first.';
    msg.className = 'msg warn';
    return;
  }
  findState.busy = true;
  document.getElementById('find-spinner').style.display = 'inline-block';
  document.getElementById('find-btn').disabled = true;
  msg.textContent = '';
  try {
    if (!append) { findState.items = []; findState.selected = new Set(); findState.loaded = 0; }
    findState.sortSent = document.getElementById('find-sort').value;
    let pass = 0;
    do {
      const res = await fetch(`${DN_CONTENT_API}?${findParams(findState.loaded)}`, { headers: { Authorization: DN_CONTENT_API_AUTH } });
      if (!res.ok) throw new Error(`the site's content API answered ${res.status}`);
      const data = await res.json();
      const got = Array.isArray(data.content) ? data.content : [];
      const have = new Set(findState.items.map(o => String(o.id)));
      got.forEach(o => { if (!have.has(String(o.id))) findState.items.push(o); });
      findState.loaded += got.length;
      findState.remaining = (data.additional_content_ids || []).length;
      if (Array.isArray(data.vendors)) findState.vendors = data.vendors;
      pass++;
      // excluded vendors are hidden after loading, so top the list back up while there are more pages to load
    } while (findState.excluded.size && findState.remaining > 0 && findVisibleItems().length < FIND_PAGE_SIZE && pass < FIND_FILL_PASSES);
    if (!findState.items.length) {
      msg.textContent = 'No live offers matched. Try fewer filters, or tick "include expired".';
      msg.className = 'msg warn';
    } else if (findVisibleItems().length && findCreatorIds().ids.length) {
      // say whose picks these are and how many there are in all (the creator page itself lists only 20)
      const names = findCreatorIds().ids.map(id => {
        const hit = findState.items.find(o => o.author && String(o.author.author_id) === id);
        return hit ? hit.author.name : 'creator ' + id;
      });
      msg.textContent = `Picks by ${names.join(' and ')}: ${findState.items.length + findState.remaining} offers match.`;
      msg.className = 'msg';
    } else if (!findVisibleItems().length) {
      msg.textContent = 'Everything loaded is from an excluded store. Click an excluded store again to bring it back' + (findState.remaining ? ', or load more.' : '.');
      msg.className = 'msg warn';
    }
  } catch (e) {
    msg.textContent = 'Search failed: ' + e.message;
    msg.className = 'msg err';
  } finally {
    findState.busy = false;
    document.getElementById('find-spinner').style.display = 'none';
    document.getElementById('find-btn').disabled = false;
    renderFindResults();
  }
}

function findEndsText(o) {
  let ts = o.expiration_datetime_ts || o.available_end_datetime_ts || null;
  if (o.expired) return { text: 'expired', cls: 'expired' };
  if (!ts) return { text: 'no end date', cls: '' };
  ts = Number(ts);
  if (ts < 1e12) ts *= 1000;   // seconds → milliseconds
  const d = new Date(ts);
  const days = Math.ceil((ts - Date.now()) / 86400000);
  const label = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  return { text: days <= 0 ? 'ends today' : `ends ${label}`, cls: days <= 2 ? 'soon' : '' };
}

function findSortedItems() {
  const mode = document.getElementById('find-sort').value;
  const items = findState.items.slice();
  if (mode === 'hot') items.sort((a, b) => (b.hotness || 0) - (a.hotness || 0));
  if (mode === 'ending') {
    // live offers with the nearest end first; offers with no end date, then already-expired ones (shown only when "include expired" is ticked), last
    const end = o => {
      if (o.expired) return Number.MAX_VALUE;
      const t = o.expiration_datetime_ts || o.available_end_datetime_ts || Infinity;
      return t < 1e12 ? t * 1000 : t;
    };
    items.sort((a, b) => end(a) - end(b));
  }
  return items;
}

// The sorted results minus any excluded vendor's offers. An offer from the vendor typed/clicked into
// "Vendor ID" is never hidden, so a stale exclusion can't blank out the search it contradicts.
function findVisibleItems() {
  if (!findState.excluded.size) return findSortedItems();
  const only = document.getElementById('find-vendor').value.trim();
  return findSortedItems().filter(o => {
    const vid = o.vendor && o.vendor.vendor_id != null ? String(o.vendor.vendor_id) : '';
    return !vid || vid === only || !findState.excluded.has(vid);
  });
}

// Vendor chip: three states by clicking, off -> "only this store" -> "not this store" -> off.
function findChipClick(vid, name) {
  const input = document.getElementById('find-vendor');
  const current = input.value.trim();
  if (findState.excluded.has(vid)) {
    // excluded -> off: its offers are already loaded, so no new search is needed
    findState.excluded.delete(vid);
    renderFindResults();
  } else if (vid === current) {
    // only -> excluded: drop the vendor filter and search again without it (if anything else is left to search by)
    input.value = '';
    findState.excluded.set(vid, name);
    if (findParams(0)) runFind(false);
    else {
      renderFindResults();
      const msg = document.getElementById('find-msg');
      msg.textContent = `Excluding ${name} needs something else to search by (words, a category or a facet).`;
      msg.className = 'msg warn';
    }
  } else {
    // off -> only this store (it replaces any other "only" store)
    findState.excluded.delete(vid);
    input.value = vid;
    runFind(false);
  }
}

function renderFindResults() {
  const list = document.getElementById('find-results');
  const chips = document.getElementById('find-vendors');
  const bar = document.getElementById('find-bar');
  list.textContent = '';
  chips.textContent = '';
  const added = new Set(offers.map(o => String(o.legacyId)));

  // vendor chips: the vendors in the current results, with counts. Click once to show only that store,
  // twice to exclude it, a third time to clear. Excluded stores stay listed even when the current
  // results no longer include them, so there is always a way to undo.
  const currentVendor = document.getElementById('find-vendor').value.trim();
  const vendorList = (findState.vendors || []).slice(0, 12).map(v => ({ id: String(v.vendor_id), name: v.short_name || v.name, count: v.count }));
  findState.excluded.forEach((name, id) => { if (!vendorList.some(v => v.id === id)) vendorList.push({ id, name, count: null }); });
  vendorList.forEach(v => {
    const out = findState.excluded.has(v.id);
    const on = !out && v.id === currentVendor;
    const b = document.createElement('button');
    b.className = 'small find-chip' + (on ? ' on' : '') + (out ? ' off' : '');
    b.textContent = (out ? '✕ ' : '') + v.name + (v.count != null ? ` (${v.count})` : '');
    b.title = out ? `${v.name} is excluded. Click to clear.` : on ? `Only ${v.name}. Click again to exclude it.` : `Click: only ${v.name}. Click twice: exclude it.`;
    b.setAttribute('aria-pressed', out ? 'mixed' : on ? 'true' : 'false');
    b.addEventListener('click', () => findChipClick(v.id, v.name));
    chips.appendChild(b);
  });
  if (findState.excluded.size || currentVendor) {
    const clr = document.createElement('button');
    clr.className = 'small find-chip-clear';
    clr.textContent = 'Clear store filters';
    clr.addEventListener('click', () => {
      const hadOnly = !!document.getElementById('find-vendor').value.trim();
      document.getElementById('find-vendor').value = '';
      findState.excluded = new Map();
      if (hadOnly && findParams(0)) runFind(false); else renderFindResults();
    });
    chips.appendChild(clr);
  }

  const items = findVisibleItems();
  // hidden offers can't stay ticked
  const shown = new Set(items.map(o => String(o.id)));
  findState.selected.forEach(id => { if (!shown.has(id)) findState.selected.delete(id); });
  bar.style.display = findState.items.length ? 'flex' : 'none';
  items.forEach(o => {
    const id = String(o.id);
    const isAdded = added.has(id);
    const row = document.createElement('label');
    row.className = 'find-row-item' + (isAdded ? ' added' : '') + (o.expired ? ' is-expired' : '');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.disabled = isAdded;
    cb.checked = !isAdded && findState.selected.has(id);
    cb.addEventListener('change', () => {
      if (cb.checked) findState.selected.add(id); else findState.selected.delete(id);
      updateFindCount();
    });
    row.appendChild(cb);
    const img = o.images && (o.images.Small || o.images.Medium || o.images.Large);
    if (img && img.url) {
      const im = document.createElement('img');
      im.src = img.url; im.alt = ''; im.className = 'find-thumb';
      row.appendChild(im);
    }
    const body = document.createElement('div');
    body.className = 'find-body-text';
    const title = document.createElement('div');
    title.className = 'find-title';
    title.textContent = o.headline || '(no headline)';
    body.appendChild(title);
    const meta = document.createElement('div');
    meta.className = 'find-meta';
    const ends = findEndsText(o);
    const bits = [];
    if (o.call_out) bits.push(o.call_out);
    if (o.vendor && o.vendor.name) bits.push(o.vendor.name);
    if (o.editors_choice && o.author && o.author.name) bits.push('pick by ' + o.author.name);
    bits.push(ends.text);
    if (o.hotness) bits.push('hotness ' + o.hotness);
    if (Array.isArray(o.coupon_code) && o.coupon_code.length) bits.push('code');
    bits.push('#' + id);
    meta.textContent = bits.join(' · ');
    if (ends.cls) meta.classList.add(ends.cls);
    body.appendChild(meta);
    row.appendChild(body);
    if (isAdded) {
      const tag = document.createElement('span');
      tag.className = 'find-added-tag';
      tag.textContent = 'added';
      row.appendChild(tag);
    }
    list.appendChild(row);
  });

  const more = document.getElementById('find-more');
  more.style.display = findState.remaining > 0 ? 'inline-block' : 'none';
  more.textContent = `Load ${Math.min(findState.remaining, FIND_PAGE_SIZE)} more (${findState.remaining} left)`;
  updateFindCount();
}

function updateFindCount() {
  const n = findState.selected.size;
  const btn = document.getElementById('find-add-btn');
  btn.textContent = n ? `Add ${n} selected` : 'Add selected';
  btn.disabled = n === 0;
  const visible = findVisibleItems().length;
  const hidden = findState.items.length - visible;
  document.getElementById('find-count').textContent = findState.items.length
    ? `${visible} shown` + (hidden ? ` (${hidden} excluded)` : '') + (findState.remaining ? `, ${findState.remaining} more` : '')
    : '';
  updateFindIds();
}

// The reverse of the "Dato/Legacy IDs" box above: the found offers as a comma-separated list of legacy IDs.
// It covers the ticked offers when any are ticked, otherwise every offer shown (excluded stores left out).
// Only offers already loaded are listed; "Load more" brings in the rest.
function findExportIds() {
  const shown = findVisibleItems().map(o => String(o.id));
  if (!findState.selected.size) return { ids: shown, scope: 'all shown' };
  return { ids: shown.filter(id => findState.selected.has(id)), scope: 'ticked' };
}

function updateFindIds() {
  const box = document.getElementById('find-ids');
  const { ids, scope } = findExportIds();
  box.style.display = ids.length ? 'block' : 'none';
  document.getElementById('find-ids-label').textContent = `${ids.length} legacy ID${ids.length !== 1 ? 's' : ''} (${scope})` + (findState.remaining && scope === 'all shown' ? `, ${findState.remaining} more not loaded` : '');
  document.getElementById('find-ids-out').value = ids.join(', ');
}

function findCopyIds() {
  const text = document.getElementById('find-ids-out').value;
  if (!text) return;
  navigator.clipboard.writeText(text).then(() => {
    const btn = document.getElementById('find-ids-copy');
    const orig = btn.textContent;
    btn.textContent = 'Copied!';
    setTimeout(() => btn.textContent = orig, 2000);
  });
}

// "Cards -> HTML": the same IDs go through the existing Add path, then the HTML view opens with the full output.
async function findExportHtml() {
  const { ids } = findExportIds();
  if (!ids.length) return;
  document.getElementById('id-input').value = ids.join(', ');
  findState.selected = new Set();
  await addOfferById();
  renderFindResults();
  const err = document.getElementById('add-err');
  // "already added" is fine here (they are in the list already); any other failure keeps the Edit view open so the errors are seen
  const realErrors = err.style.display === 'none' ? [] : err.textContent.split(' · ').filter(e => !/already added$/.test(e));
  if (offers.length && !realErrors.length) setSubTab('html');
}

function findSelectAll(on) {
  const added = new Set(offers.map(o => String(o.legacyId)));
  findState.selected = new Set();
  if (on) findVisibleItems().forEach(o => { if (!added.has(String(o.id)) && !o.expired) findState.selected.add(String(o.id)); });
  renderFindResults();
}

async function findAddSelected() {
  const ids = Array.from(findState.selected);
  if (!ids.length) return;
  // same path as typing the IDs in: numeric IDs are resolved as legacy IDs, duplicates are skipped, errors are listed
  document.getElementById('id-input').value = ids.join(', ');
  findState.selected = new Set();
  await addOfferById();
  renderFindResults();
}

function removeOffer(id) {
  offers = offers.filter(o => o.id !== id);
  renderOffers();
}

function removeAllOffers() {
  if (!offers.length) return;
  if (!confirm(`Remove all ${offers.length} offer${offers.length !== 1 ? 's' : ''}?`)) return;
  offers = [];
  renderOffers();
}

function toggleLock(id) {
  const offer = offers.find(o => o.id === id);
  if (offer) offer.locked = !offer.locked;
  renderOffers();
}

function updateCTA(id, value) {
  const offer = offers.find(o => o.id === id);
  if (offer) offer.ctaText = value;
}

// Table style: the promo code shown for an offer. Typing in the Code box overrides
// the one found in the description; clearing the box means "no code" (not "look
// again"), so a wrong guess can be removed.
function updateCode(id, value) {
  const offer = offers.find(o => o.id === id);
  if (!offer) return;
  offer.code = value.trim();
  // The button's default text depends on whether there is a code, so keep the
  // CTA box in step (unless the editor typed their own CTA text).
  if (!offer.ctaText) {
    const box = Array.from(document.querySelectorAll('.cta-input:not(.code-input)')).find(b => b.dataset.id === id);
    if (box) box.value = ctaTextFor(offer);
  }
}

// Description editing — the offer's description is trusted HTML from
// dastNodeToHTML() (see "Offer description formatting" in CLAUDE.md), so it's
// edited by dropping whole top-level blocks (<p>, <ul>, ...) out of it
// rather than by free-text editing. The pre-edit HTML is kept on
// valueStatementOriginal the first time a block is removed so Restore works.
function descTemplate(offer) {
  const tpl = document.createElement('template');
  tpl.innerHTML = offer.valueStatement || '';
  return tpl;
}

function toggleDescEditor(id) {
  const offer = offers.find(o => o.id === id);
  if (!offer) return;
  offer.editingDesc = !offer.editingDesc;
  renderOffers();
}

function removeDescBlock(id, blockIndex) {
  const offer = offers.find(o => o.id === id);
  if (!offer) return;
  const tpl = descTemplate(offer);
  const el = tpl.content.children[blockIndex];
  if (!el) return;
  if (offer.valueStatementOriginal === undefined) offer.valueStatementOriginal = offer.valueStatement || '';
  el.remove();
  offer.valueStatement = tpl.innerHTML;
  renderOffers();
}

function restoreDescription(id) {
  const offer = offers.find(o => o.id === id);
  if (!offer || offer.valueStatementOriginal === undefined) return;
  offer.valueStatement = offer.valueStatementOriginal;
  delete offer.valueStatementOriginal;
  renderOffers();
}

function descEditorRowHTML(o) {
  const blocks = Array.from(descTemplate(o).content.children);
  const rows = blocks.length
    ? blocks.map((el, k) => {
        const text = el.textContent.trim().replace(/\s+/g, ' ');
        const label = text ? (text.length > 160 ? text.slice(0, 160) + '…' : text) : '(empty paragraph)';
        const tag = el.tagName === 'UL' || el.tagName === 'OL' ? 'List · ' : '';
        return `<div class="desc-block">
          <span class="desc-block-text${text ? '' : ' empty'}" title="${esc(text)}">${esc(tag + label)}</span>
          <button class="danger-text" data-action="remove-desc-block" data-id="${esc(o.id)}" data-block="${k}" title="Remove this part of the description">✕</button>
        </div>`;
      }).join('')
    : '<div class="desc-block"><span class="desc-block-text empty">(no description)</span></div>';
  const restore = o.valueStatementOriginal !== undefined
    ? `<button class="small" data-action="restore-desc" data-id="${esc(o.id)}">↺ Restore original</button>`
    : '';
  return `<tr class="desc-row"><td colspan="${cardStyle === 'table' ? 10 : 9}">${rows}${restore}</td></tr>`;
}

function moveOffer(id, rawVal) {
  const idx = offers.findIndex(o => o.id === id);
  if (idx === -1) return;
  if (offers[idx].locked) { renderOffers(); return; }
  const target = Math.min(Math.max(parseInt(rawVal, 10), 1), offers.length) - 1;
  if (target === idx) return;
  const [item] = offers.splice(idx, 1);
  offers.splice(target, 0, item);
  renderOffers();
}

/* ─── Sort ─── */
function parseCalloutValue(callout) {
  if (!callout) return null;
  const s = callout.trim().toLowerCase();

  const pctDiscount = s.match(/(?:up\s+to\s+)?(\d+(?:\.\d+)?)\s*%(?:\s*off|\s*savings?)?/) ||
                      s.match(/save\s+(\d+(?:\.\d+)?)\s*%/);
  if (pctDiscount && (s.includes('off') || s.includes('save') || s.includes('saving') || s.match(/up\s+to/))) {
    return { group: 'discount', value: parseFloat(pctDiscount[1]) };
  }

  const dollarDiscount = s.match(/(?:up\s+to\s+)?\$\s*([\d,]+(?:\.\d+)?)\s*off/) ||
                         s.match(/save\s+\$\s*([\d,]+(?:\.\d+)?)/);
  if (dollarDiscount) {
    return { group: 'discount', value: parseFloat(dollarDiscount[1].replace(/,/g, '')) };
  }

  const pctPlain = s.match(/^(\d+(?:\.\d+)?)\s*%$/);
  if (pctPlain) return { group: 'discount', value: parseFloat(pctPlain[1]) };

  const priceMatch = s.match(/\$\s*([\d,]+(?:\.\d+)?)/);
  if (priceMatch) return { group: 'price', value: parseFloat(priceMatch[1].replace(/,/g, '')) };

  return null;
}

/* ─── Card options ─────────────────────────────────────────────────────────
 * Style, Layout and the On/Off toggles below only change how generateHTML() and
 * renderPreview() render the existing `offers`; nothing about the offers list
 * itself is touched, so flipping them back and forth never loses setup work.
 *
 * The choices are remembered between sessions (chrome.storage.sync, key
 * `cardOptions`) unless "Remember my choices" is Off, in which case nothing is
 * stored and every session starts from the defaults. The offers list, the Blog
 * Content ID and the per-offer edits (CTA text, hidden end dates, trimmed
 * descriptions) are never saved: they belong to the article being worked on. */
const OPTION_DEFAULTS = {
  style: 'standard', layout: 'grid', images: true, endDates: true, trim: true,
  bar: true, wasPrice: true, metaLine: true, resize: true, details: true,
};
const OPTION_STYLES = ['standard', 'classic', 'compact', 'pick', 'table'];
const OPTION_LAYOUTS = ['grid', 'vertical'];
const OPTIONS_KEY = 'cardOptions';
let applyingOptions = false; // true while stored choices are being applied, so they are not saved back one by one

// Marks the On/Off pair whose button ids are `${base}-on-btn` and `${base}-off-btn`.
function markOnOff(base, on) {
  document.getElementById(`${base}-on-btn`).classList.toggle('active', on);
  document.getElementById(`${base}-off-btn`).classList.toggle('active', !on);
}

function currentOptions() {
  return {
    style: cardStyle, layout: cardLayout, images: showImages, endDates: showEndDates, trim: trimLong,
    bar: cpBar, wasPrice: showWasPrice, metaLine: showMetaLine, resize: resizeImages, details: showDetails,
  };
}

function saveOptions() {
  if (applyingOptions || typeof chrome === 'undefined' || !chrome.storage) return;
  // A rejected write (storage quota, write-rate limit) only means the choices are not remembered.
  Promise.resolve(chrome.storage.sync.set({ [OPTIONS_KEY]: rememberOptions ? { remember: true, ...currentOptions() } : { remember: false } })).catch(() => {});
}

// Applies stored or default choices. Anything missing or of the wrong type falls
// back to its default, so an older or damaged stored value can't break the panel.
function applyOptions(stored) {
  const flag = (key) => typeof stored?.[key] === 'boolean' ? stored[key] : OPTION_DEFAULTS[key];
  applyingOptions = true;
  try {
    setCardLayout(OPTION_LAYOUTS.includes(stored?.layout) ? stored.layout : OPTION_DEFAULTS.layout);
    setShowImages(flag('images'));
    setShowEndDates(flag('endDates'));
    setTrimLong(flag('trim'));
    setCpBar(flag('bar'));
    setShowWasPrice(flag('wasPrice'));
    setShowMetaLine(flag('metaLine'));
    setResizeImages(flag('resize'));
    setShowDetails(flag('details'));
    setCardStyle(OPTION_STYLES.includes(stored?.style) ? stored.style : OPTION_DEFAULTS.style); // last: it redraws everything
  } finally {
    applyingOptions = false;
  }
}

function setRememberOptions(on) {
  rememberOptions = on;
  markOnOff('remember', on);
  saveOptions(); // On: store the current choices now; Off: replace them with { remember: false }
}

function resetOptions() {
  applyOptions(OPTION_DEFAULTS);
  saveOptions();
}

// Runs once when the panel opens. Choices stored with Remember Off (or none at
// all) leave the defaults in place.
function initOptions() {
  if (typeof chrome === 'undefined' || !chrome.storage) return;
  chrome.storage.sync.get([OPTIONS_KEY], result => {
    const stored = result[OPTIONS_KEY];
    if (stored && stored.remember === false) {
      rememberOptions = false;
      markOnOff('remember', false);
    } else if (stored) {
      applyOptions(stored);
    }
  });
}

function setCardLayout(layout) {
  cardLayout = layout;
  document.getElementById('layout-grid-btn').classList.toggle('active', layout === 'grid');
  document.getElementById('layout-vertical-btn').classList.toggle('active', layout === 'vertical');
  renderPreview();
  renderHTMLOut();
  saveOptions();
}

function setCardStyle(style) {
  cardStyle = style;
  OPTION_STYLES.forEach(k =>
    document.getElementById('style-' + k + '-btn').classList.toggle('active', k === style)
  );
  const rowStyle = style === 'standard' || style === 'pick' || style === 'table'; // the row-style cards have the Details and image-resize options
  // Creator Pick has its own options (page script bar) and a different default
  // button wording, so the table and bar need a redraw too.
  document.getElementById('pick-options').style.display = style === 'pick' ? 'flex' : 'none';
  document.getElementById('details-bar').style.display = rowStyle ? 'flex' : 'none';
  document.getElementById('resize-opts').style.display = rowStyle ? 'contents' : 'none';
  document.getElementById('trim-opts').style.display = style === 'standard' ? 'contents' : 'none';
  document.getElementById('table-opts').style.display = style === 'table' ? 'contents' : 'none';
  // The row-style cards are always one per row in the plain container, so the
  // Grid/Vertical choice only applies to Classic and Compact.
  document.getElementById('layout-bar').style.display = rowStyle ? 'none' : '';
  renderOffers();
  renderPreview();
  renderHTMLOut();
  saveOptions();
}

function setShowDetails(on) {
  showDetails = on;
  markOnOff('details', on);
  renderPreview();
  renderHTMLOut();
  saveOptions();
}

function setTrimLong(on) {
  trimLong = on;
  markOnOff('trim', on);
  renderHTMLOut();
  saveOptions();
}

function setCpBar(on) {
  cpBar = on;
  markOnOff('cp-bar', on);
  renderPreview();
  renderHTMLOut();
  saveOptions();
}

function setShowEndDates(on) {
  showEndDates = on;
  markOnOff('end', on);
  renderPreview();
  renderHTMLOut();
  saveOptions();
}

function setShowWasPrice(on) {
  showWasPrice = on;
  markOnOff('was', on);
  renderPreview();
  renderHTMLOut();
  saveOptions();
}

function setShowMetaLine(on) {
  showMetaLine = on;
  markOnOff('meta', on);
  renderPreview();
  renderHTMLOut();
  saveOptions();
}

function setResizeImages(on) {
  resizeImages = on;
  markOnOff('resize', on);
  renderPreview();
  renderHTMLOut();
  saveOptions();
}

function toggleHideEnd(id) {
  const offer = offers.find(o => o.id === id);
  if (offer) offer.hideEnd = !offer.hideEnd;
  renderOffers();
  renderPreview();
  renderHTMLOut();
}

function setShowImages(on) {
  showImages = on;
  markOnOff('images', on);
  renderPreview();
  renderHTMLOut();
  saveOptions();
}

function sortOffers(direction) {
  ['sort-asc-btn', 'sort-desc-btn', 'sort-auto-btn'].forEach(id =>
    document.getElementById(id).classList.remove('active')
  );
  document.getElementById('sort-' + direction + '-btn').classList.add('active');

  const label = document.getElementById('sort-detect-label');

  if (direction !== 'auto') {
    label.textContent = '';
    const lockedPos = {};
    offers.forEach((o, i) => { if (o.locked) lockedPos[i] = o; });
    const unlocked = offers.filter(o => !o.locked).sort((a, b) => {
      const pa = parseCalloutValue(a.callout);
      const pb = parseCalloutValue(b.callout);
      if (!pa && !pb) return 0;
      if (!pa) return 1;
      if (!pb) return -1;
      return direction === 'asc' ? pa.value - pb.value : pb.value - pa.value;
    });
    const result = new Array(offers.length);
    Object.entries(lockedPos).forEach(([i, o]) => { result[parseInt(i)] = o; });
    let ui = 0;
    for (let i = 0; i < result.length; i++) {
      if (!result[i]) result[i] = unlocked[ui++];
    }
    offers = result;
    renderOffers();
    return;
  }

  const lockedPositions = {};
  offers.forEach((o, i) => { if (o.locked) lockedPositions[i] = o; });
  const unlocked = offers.filter(o => !o.locked);
  const parsed = unlocked.map(o => ({ offer: o, parsed: parseCalloutValue(o.callout) }));
  const discounts = parsed.filter(x => x.parsed?.group === 'discount');
  const prices    = parsed.filter(x => x.parsed?.group === 'price');
  const others    = parsed.filter(x => !x.parsed);

  discounts.sort((a, b) => b.parsed.value - a.parsed.value);
  prices.sort((a, b) => a.parsed.value - b.parsed.value);

  const parts = [];
  if (discounts.length) parts.push(`${discounts.length} discount${discounts.length !== 1 ? 's' : ''} ↓`);
  if (prices.length)    parts.push(`${prices.length} price${prices.length !== 1 ? 's' : ''} ↑`);
  if (others.length)    parts.push(`${others.length} unparsed`);
  label.textContent = parts.length ? parts.join(' · ') : 'nothing to sort';

  const sortedUnlocked = [...discounts, ...prices, ...others].map(x => x.offer);
  const result = new Array(offers.length);
  Object.entries(lockedPositions).forEach(([i, o]) => { result[parseInt(i)] = o; });
  let ui = 0;
  for (let i = 0; i < result.length; i++) {
    if (!result[i]) result[i] = sortedUnlocked[ui++];
  }
  offers = result;
  renderOffers();
}

// Table badge for Creator Pick style: an offer with no usable pick gets a plain
// card (no creator or quote).
function pickBadgeHTML(o) {
  return (o.picks && o.picks.length) ? '' : ' <span class="cp-nopick" title="No Creator Pick found on this offer, so its card will have no creator or quote.">no pick</span>';
}

/* ─── Render Configure table ─── */
function renderOffers() {
  const tbody   = document.getElementById('offers-tbody');
  const wrap    = document.getElementById('offers-tbl-wrap');
  const empty   = document.getElementById('offers-empty');
  const sortBar = document.getElementById('sort-bar-wrap');
  const countEl = document.getElementById('offer-count');

  if (!offers.length) {
    wrap.style.display = 'none';
    sortBar.style.display = 'none';
    empty.style.display = 'block';
    if (countEl) countEl.textContent = '';
    return;
  }
  wrap.style.display = 'block';
  sortBar.style.display = 'block';
  empty.style.display = 'none';
  if (countEl) countEl.textContent = `${offers.length} offer${offers.length !== 1 ? 's' : ''}`;

  document.getElementById('code-th').style.display = cardStyle === 'table' ? '' : 'none';
  tbody.innerHTML = offers.map((o, i) => `
    <tr draggable="${!o.locked}" data-index="${i}" class="${o.locked ? 'row-locked' : ''}">
      <td><span class="drag-handle" title="${o.locked ? 'Unlock to reorder' : 'Drag to reorder'}">⠿</span></td>
      <td style="text-align:center;">
        <input class="pos-input" type="number" min="1" max="${offers.length}"
          value="${i + 1}" data-id="${o.id}" ${o.locked ? 'disabled' : ''} />
      </td>
      <td class="cell-trunc">${esc(o.title)}${cardStyle === 'pick' ? pickBadgeHTML(o) : ''}</td>
      <td class="cell-muted" style="font-size:11px;">${esc(o.callout)}</td>
      <td><input class="cta-input" value="${esc(ctaTextFor(o))}" data-id="${o.id}" /></td>
      ${cardStyle === 'table' ? `<td><input class="cta-input code-input" value="${esc(offerCode(o))}" placeholder="no code" data-id="${o.id}" title="Promo code shown in the Code column (found in the description; edit or clear it here)" /></td>` : ''}
      <td><button class="lock-btn ${o.locked ? 'locked' : ''}" data-action="lock" data-id="${o.id}"
            title="${o.locked ? 'Unlock position' : 'Lock position'}">${o.locked ? '🔒' : '🔓'}</button></td>
      <td>${cardStyle === 'pick' ? '' : `<button class="lock-btn ${o.editingDesc || o.valueStatementOriginal !== undefined ? 'locked' : ''}" data-action="edit-desc" data-id="${o.id}"
            title="Edit description — remove parts of it">✂</button>`}</td>
      <td>${(cardStyle === 'standard' || cardStyle === 'pick' || cardStyle === 'table') && o.endISO
        ? `<button class="lock-btn ${o.hideEnd ? 'locked' : ''}" data-action="toggle-end" data-id="${o.id}"
            title="${o.hideEnd ? 'End date hidden on this card — click to show it' : 'Showing the end date (' + esc(endDateLabel(o.endISO)) + ') — click to hide it on this card'}">📅</button>`
        : ''}</td>
      <td><button class="danger-text" data-action="remove" data-id="${o.id}">Remove</button></td>
    </tr>${o.editingDesc ? descEditorRowHTML(o) : ''}`).join('');
  initDrag();
}

/* ─── Render Preview ─── */
function renderPreview() {
  const container = document.getElementById('cards-container');
  const empty = document.getElementById('preview-empty');
  if (!offers.length) { container.innerHTML = ''; empty.style.display = 'block'; return; }
  empty.style.display = 'none';

  // Table: the whole generated table (header row included) on one white tile.
  if (cardStyle === 'table') {
    container.innerHTML = `<div class="card-wrap"><div class="card-id">${offers.length} row${offers.length !== 1 ? 's' : ''} <span class="cell-muted">(the Code chip copies on the published page)</span></div><div class="html-preview">${tableHTML('')}</div></div>`;
    container.querySelectorAll('.html-preview a').forEach(a => { a.target = '_blank'; a.rel = 'noopener'; });
    return;
  }

  container.innerHTML = offers.map(o => {
    // Standard and Creator Pick: show the real generated card (same markup the
    // HTML tab emits, minus tracking attributes) on a white tile, since its
    // colors are chosen for the site's white page. The Creator Pick page script
    // doesn't run here, so long quotes show in full and there is no sort bar:
    // both only exist on the published page.
    if (cardStyle === 'standard' || cardStyle === 'pick') {
      const card = cardStyle === 'pick' ? pickCardHTML(o, '') : standardCardHTML(o, '');
      return `<div class="card-wrap">
      <div class="card-id">${o.id} <button class="danger-text" data-action="remove" data-id="${o.id}">Remove</button></div>
      <div class="html-preview">${card}</div>
    </div>`;
    }
    const url = o.monetizedUrl || o.landingUrl || '#';
    const imgHtml = o.imageUrl
      ? `<img src="${esc(o.imageUrl)}" alt="${esc(o.title)}">`
      : `<div class="no-img">no image</div>`;
    const compact = cardStyle === 'compact';
    const imgCol = showImages ? `<div class="card-img-col"><a href="${esc(url)}" target="_blank">${imgHtml}</a></div>` : '';
    const headline = compact
      ? `<h3 class="card-h3 card-h3-compact"><a href="${esc(url)}" target="_blank">${esc(compactHeadlineText(o.title, o.callout))}</a></h3>`
      : `<h3 class="card-h3"><a href="${esc(url)}" target="_blank">${esc(o.title)}</a></h3>
          <div class="card-price">${esc(o.callout)}</div>`;
    const cta = `<div class="card-cta-wrap">
            <a href="${esc(url)}" target="_blank" class="card-cta">${esc(ctaTextFor(o))}</a>
            <button class="danger-text" data-action="remove" data-id="${o.id}" style="flex-shrink:0;">Remove</button>
          </div>`;
    const desc = `<div class="card-desc">${o.valueStatement || ''}</div>`;
    return `<div class="card-wrap">
      <div class="card-id">${o.id}</div>
      <div class="card-preview">
        ${imgCol}
        <div class="card-content-col">
          ${headline}
          ${compact ? cta + desc : desc + cta}
        </div>
      </div>
    </div>`;
  }).join('');
  // The sidebar must never navigate to a card's link (that would lose the
  // in-memory offers list), so these preview links open in a new tab.
  container.querySelectorAll('.html-preview a').forEach(a => { a.target = '_blank'; a.rel = 'noopener'; });
}

/* ─── Generate HTML ─── */
// The iref tracking value itself — shared by buildDataIref() (which wraps it
// as a full HTML attribute string for generateHTML()'s template literals)
// and the Article tab's applyIrefFix() (which sets it directly via
// setAttribute() on an already-parsed element instead).
function irefValue(blogContentId, legacyId, linkType) {
  return `site-widget-card-blog-${blogContentId}-${legacyId || '0'}-${linkType}`;
}

// Builds the data-iref click-tracking attribute on each card link:
// site-widget-card-blog-{blog content ID}-{offer legacy ID}-{link type}.
// Returns '' (no attribute at all) when blogContentId is blank — a
// half-formed tracking string would silently corrupt reporting data, which
// is worse than the attribute simply being absent.
//
// This was named/built as `iref-append` through 2.23.x, which turned out to
// be the wrong attribute entirely: `iref-append` belongs to the unrelated
// "blog-slider" carousel widget (see "Blog Slider (removed)" in CLAUDE.md) —
// a different JS component with its own attribute reader that has nothing to
// do with these offer cards. It had no effect on the live site and didn't
// even survive the publish transform. DealNews's actual shared site JS
// (`DN.handleClickURLs`/`DN.iref`) instead uses a single delegated
// `mousedown` listener on `document.body` that reads a non-empty
// `data-iref` attribute off any same-origin anchor and appends
// `iref=<value>` onto its outbound URL — no extra widget wiring needed, it
// already listens globally. The value format itself was already correct and
// is unchanged; only the attribute name was wrong.
function buildDataIref(blogContentId, legacyId, linkType) {
  if (!blogContentId) return '';
  return ` data-iref="${irefValue(blogContentId, legacyId, linkType)}"`;
}

// Article tab counterpart to buildDataIref() — audits whether a card already
// loaded from an article (rather than one this tool just generated) actually
// carries the tracking attribute on its three tracked links. A missing link
// element (e.g. no CTA found at all) counts the same as a
// present-but-attribute-less link, since either way that link has no
// tracking. Also flags a present attribute whose own linkType suffix doesn't
// match the link it's actually on (e.g. "-image" sitting on the title link)
// — a mistake a bare presence check wouldn't catch, most likely from manual
// editing or a find/replace gone wrong.
// Finds the three tracked links on an already-parsed card. The image link is
// NOT simply the card's first <a> — a card generated with images turned off
// has no image link at all, and its first <a> is the title link (grabbing
// that as "the image link" would misreport the title's data-iref as a
// mismatch, and let applyIrefFix() overwrite it with an -image value). So
// it's the first anchor that isn't in the headline, isn't the CTA, and isn't
// inside any .bu-content block (description/CTA wrapper — which may hold
// links of their own); null when the card has none.
function findCardLinks(cardEl) {
  const h3 = cardEl.querySelector('h3');
  const title = h3 ? h3.querySelector('a') : null;
  const button = cardEl.querySelector('.' + PROC_TARGET_CLASS);
  const image = Array.from(cardEl.querySelectorAll('a')).find(a =>
    !(h3 && h3.contains(a)) && a !== button && !a.closest('.bu-content, .cp-quote')
  ) || null;
  // Creator Pick cards: one link per creator (none on other card styles). The link
  // is inside the .cp-pill span; cards pasted before 2.39.2 have the pill as the link.
  const creators = Array.from(cardEl.querySelectorAll('a.cp-pill, .cp-pill a'));
  return { image, title, button, creators };
}

// Headline text without the inline callout — compact-style cards fold the
// callout into the headline link (see generateHTML()), so the raw h3 text
// would read "Title for $33" instead of the offer's actual title.
function cardTitleText(h3) {
  const clone = h3.cloneNode(true);
  // Replaced with a space, not removed: promo-style headlines splice the
  // callout into the middle ("AliExpress<span>…</span>Promo Code"), and
  // removing it outright would glue the two halves into "AliExpressPromo Code".
  clone.querySelectorAll('.content-call-out').forEach(n => n.replaceWith(' '));
  return clone.textContent.replace(/\s+/g, ' ').trim();
}

// Callout text, minus the "for"/dash connector compact-style cards include
// inside the callout span.
function cardCalloutText(priceEl) {
  if (!priceEl) return '';
  const text = priceEl.textContent.trim();
  return priceEl.closest('h3') ? text.replace(/^(for|[–—-])\s+/i, '') : text;
}

function analyzeIrefTags(imageLinkEl, titleLinkEl, ctaLinkEl, creatorLinkEls = []) {
  const links = [['image', imageLinkEl], ['title', titleLinkEl], ['button', ctaLinkEl]];
  const missing = [];
  const mismatched = [];
  links.forEach(([type, el]) => {
    // No image link at all (images turned off) means there's nothing to
    // track — not a missing tag.
    if (type === 'image' && !el) return;
    const val = el ? el.getAttribute('data-iref') : null;
    if (!val) { missing.push(type); return; }
    if (!val.endsWith(`-${type}`)) mismatched.push(type);
  });
  // Creator Pick cards carry a fourth tracked link per creator. A card with no
  // creator link (other styles, or a creator with no page) has nothing to check.
  if (creatorLinkEls.length) {
    const vals = creatorLinkEls.map(el => el.getAttribute('data-iref'));
    if (vals.some(v => !v)) missing.push('creator');
    else if (vals.some(v => !v.endsWith('-creator'))) mismatched.push('creator');
  }
  return { missing, mismatched };
}

// "for" only reads right after a plain price ("$33"); anything else — "50%
// off", "$20 off", "Free", "from $19" — gets a dash instead ("Title for 50%
// off" would be nonsense). Empty callout adds nothing.
function compactCalloutConnector(callout) {
  const c = (callout || '').trim();
  if (!c) return '';
  return /^\$/.test(c) && !/%|\boff\b/i.test(c) ? 'for' : '–';
}

// Promo-code offers ("AliExpress Promo Code" + callout "$5 off $35+") read
// better with the discount spliced in before the promo phrase — "AliExpress
// $5 off $35 Promo Code" — than tacked on the end. Only applies to
// discount-style callouts (a bare price like "$33" before "Promo Code" would
// read wrong) and only when something precedes the phrase (the brand). A
// trailing "+" ("$35+") is dropped, since "$35+ Promo Code" reads oddly in a
// headline. Anything else falls back to the "for"/dash suffix.
const PROMO_PHRASE_PATTERN = /\b(?:promo|coupon|discount)(?:\s+code)?s?\b/i;

function compactHeadlineParts(title, callout) {
  const c = (callout || '').trim();
  if (!c) return { before: title, callout: '', after: '', connector: '' };
  if (/%|\boff\b/i.test(c)) {
    const m = PROMO_PHRASE_PATTERN.exec(title);
    if (m && m.index > 0) {
      return {
        before: title.slice(0, m.index).trimEnd(),
        callout: c.replace(/\s*\+$/, ''),
        after: title.slice(m.index),
        connector: '',
      };
    }
  }
  return { before: title, callout: c, after: '', connector: compactCalloutConnector(c) };
}

// Inner HTML of the compact headline link. The callout stays in a
// .content-call-out span either way so the Article tab can find/strip it.
function compactHeadlineHTML(title, callout) {
  const p = compactHeadlineParts(title, callout);
  if (!p.callout) return p.before;
  const span = txt => `<span class="content-call-out" style="font: inherit; color: inherit;">${txt}</span>`;
  return p.after
    ? `${p.before}${span(` ${p.callout} `)}${p.after}`
    : `${p.before}${span(` ${p.connector} ${p.callout}`)}`;
}

function compactHeadlineText(title, callout) {
  const p = compactHeadlineParts(title, callout);
  if (!p.callout) return p.before;
  return p.after ? `${p.before} ${p.callout} ${p.after}` : `${p.before} ${p.connector} ${p.callout}`;
}

/* ─── Row-style cards: Standard and Creator Pick ──────────────────────────
 * Both share one layout, built for pages with many cards read mostly on phones:
 * a wrapping flex row with NO media queries (inline styles only), image |
 * headline + price + store/shipping/end date | description | button. The
 * description column is the value statement on a Standard card and, on a Creator
 * Pick card, each creator's pill above their own "Why I picked it" quote. Wide,
 * everything sits on one row (~130-190px tall); on a phone the description and
 * button wrap under the image row (~260-340px). See "Standard card" and
 * "Creator Pick card" in CLAUDE.md for the decisions behind them.
 *
 * Hooks other code depends on are classes, because class names are known to
 * survive the CMS save: the page scripts read cp-list / cp-sort / cp-card /
 * cp-pill / cp-pick / cp-qtext / cp-bar-slot (Creator Pick) and dn-more / dn-text
 * (the trimmable value statement); the Article tab reads bu-card, content-call-out,
 * btn-cta, the h3 link, and cp-qtext or bu-is-flex-grow-1 (see parseAndDisplayCards()).
 * The data-* values the Creator Pick sort reads are extras the script degrades
 * without. */

// Palette and sizes for the row-style cards (Standard and Creator Pick).
// Everything is inline-styled (the CMS takes only inline styles), so this is the
// one place to retune them. The Creator Pick page script keeps its own copies of
// the few it needs, because it ships as standalone text and cannot see these.
const CARD = {
  muted: '#5b6066', was: '#6b7075', price: '#00a863',
  pillBg: '#d7eaf8', pillInk: '#214b82', rule: '#e3e3e3',
  pickImage: 88, standardImage: 96, face: 32,
};

// Height (px) of the sort bar the page script builds, reserved in the HTML as an
// empty slot so the bar appears without pushing the list down (layout shift).
// Measured in the test harness at 320-1024px wide: the bar is this tall when it
// has creator chips ("chips") and when it doesn't ("plain"); the script gives the
// bar the same minimum height as the slot, so the two always match.
const CP_BAR_HEIGHT = { chips: 88, plain: 50 };

// Visually hidden but read by screen readers (the struck-through price needs a
// "was" cue because <s> is not announced).
const SR_ONLY_STYLE = 'position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap;';

// Button wording: a single priced product reads "Buy Now"; a sale event or
// anything without a real price reads "Shop Now". Applies to the Standard and
// Creator Pick styles (Compact keeps "Buy Now"), and only until someone types
// their own text in the table.
function ctaTextFor(o, style = cardStyle) {
  if (o.ctaText) return o.ctaText;
  if (style === 'table' && offerCode(o)) return 'Use Promo Code';
  if ((style === 'pick' || style === 'standard') && o.price !== undefined && !(o.price > 0)) return 'Shop Now';
  return 'Buy Now';
}

// "M.A. Clancy" -> "M-A-Clancy", the slug shape on the site's creator pages
// (https://www.dealnews.com/creators/M-A-Clancy/158.html). Creator pages, NOT
// /authors/...: the old author URLs now 301 to the creators hub, so linking
// them would drop the reader on the hub instead of the person's page. Returns
// '' (no link) when a usable slug or ID is missing.
function cpCreatorUrl(name, legacyId) {
  if (!name || !legacyId) return '';
  const slug = name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug ? `https://www.dealnews.com/creators/${slug}/${legacyId}.html` : '';
}

// Product and creator images are full-size uploads (often 1000-2400px, shown at
// 88-96px and 32px). Both image hosts the site uses (the CMS asset host and
// d.dlnws.com) resize on request with the same w/h parameters, fitting the image
// inside the box without cropping, so ask for twice the display size (sharp on
// high-density screens) instead. auto=format lets the CMS host send a smaller
// modern format; the site's own host ignores it.
function resizedImageUrl(url, displayPx) {
  if (!url) return '';
  if (!resizeImages) return url; // editor chose the full-size original
  return url + (url.includes('?') ? '&' : '?') + `w=${displayPx * 2}&h=${displayPx * 2}&auto=format`;
}

function formatMoney(n) {
  const whole = Math.round(n * 100) % 100 === 0;
  return '$' + n.toLocaleString('en-US', whole ? { maximumFractionDigits: 0 } : { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

// Fixed date only (never "ends in 3 hours" — the card is static HTML). ET day,
// since the offer's end time is stored with the newsroom's UTC offset.
function endDateLabel(iso) {
  const d = new Date(iso);
  if (!iso || isNaN(d)) return '';
  return 'Ends ' + d.toLocaleDateString('en-US', { timeZone: 'America/New_York', month: 'short', day: 'numeric' });
}

function hasWasPrice(o) { return o.price > 0 && o.wasPrice > o.price; }

// An end date is shown (and sortable) only when the editor hasn't hidden it.
function showsEndDate(o) { return showEndDates && !o.hideEnd && !!o.endISO; }

// "Store · Shipping · Ends Nov 21". The store and shipping part and the end date
// each have their own toggle.
function cardMetaLine(o) {
  const ship = o.shipping ? o.shipping.charAt(0).toUpperCase() + o.shipping.slice(1) : '';
  const parts = showMetaLine ? [o.vendorName, ship] : [];
  if (showsEndDate(o)) parts.push(endDateLabel(o.endISO));
  return parts.filter(Boolean).join(' · ');
}

// Every attribute value below comes from the CMS, so it is escaped with esc()
// (which also encodes quotes); the older card styles interpolate URLs raw.
// `tracking` is the creator link's data-iref attribute (or '').
function cpPillHTML(pick, tracking) {
  if (!pick.authorName) return '';
  const nameAttr = esc(pick.authorName);
  const nameText = escText(pick.authorName);
  // The photo is decorative (the name sits right next to it), so empty alt.
  const face = pick.authorImage
    ? `<img src="${esc(resizedImageUrl(pick.authorImage, CARD.face))}" alt="" width="${CARD.face}" height="${CARD.face}" decoding="async" style="width: ${CARD.face}px; height: ${CARD.face}px; border-radius: 50%; object-fit: cover;">`
    : '';
  const style = `display: inline-flex; align-items: center; gap: 8px; background: ${CARD.pillBg}; color: ${CARD.pillInk}; border-radius: 24px; padding: 3px 14px 3px ${face ? '3px' : '14px'}; font: 500 14px/18px Roboto, sans-serif; margin-bottom: 6px;`;
  const url = cpCreatorUrl(pick.authorName, pick.authorLegacyId);
  // The pill's look lives on a span, and only the name is the link. The CMS link
  // plugin rewrites a link and drops its title, data-iref and style; when the pill
  // WAS the link, that took the whole pill look with it. The face stays outside
  // the link so the layout holds even if the link loses its style.
  const name = url
    ? `<a href="${esc(url)}" title="${nameAttr}"${tracking} style="color: inherit; text-decoration: none;">${nameText}</a>`
    : nameText;
  return `<span class="cp-pill" style="${style}">${face}${name}</span>`;
}

// One block per creator, each creator's pill directly above their own quote, so
// a reader can tell whose words are whose (an offer can carry two picks). Blocks
// after the first get a rule above them. .cp-pick is one creator's block;
// .cp-qtext is the part the page script clamps.
function cpQuoteHTML(picks, tracking) {
  const label = `<b style="font: 700 11px/16px Roboto, sans-serif; letter-spacing: .06em; color: ${CARD.muted}; text-transform: uppercase;">Why I picked it</b>`;
  const blocks = picks.map((pick, i) => {
    const rule = i ? ` style="border-top: 1px solid ${CARD.rule}; margin-top: 8px; padding-top: 8px;"` : '';
    return `<div class="cp-pick"${rule}>${cpPillHTML(pick, tracking)}<div class="cp-qtext">${label} “${escText(pick.quote)}”</div></div>`;
  }).join('');
  return `\n            <div class="cp-quote" style="flex: 2 1 320px; min-width: 0; font-size: 14px; font-weight: 400; line-height: 20px;">${blocks}</div>`;
}

// Pieces every row-style card (Standard and Creator Pick) shares: the image, the
// headline / price / store column, and the button. imagePx is the image box size.
// The monetized links (image, title, button) share every attribute except the
// tracking value; `link(type)` builds one, `track(type)` is just the data-iref
// attribute (the Creator Pick creator link goes to the creator's page and has its
// own attributes). `title` is the escaped title.
function cardLinkBuilder(o, blogContentId) {
  const href    = esc(o.monetizedUrl || o.landingUrl || '');
  const landing = esc(o.landingUrl || o.monetizedUrl || '');
  const title   = esc(o.title);
  const track = type => buildDataIref(blogContentId, o.legacyId, type);
  const link = type =>
    `href="${href}" landing_url="${landing}" vendor="${esc(o.vendor || '0')}" brand="0" category="0" title="${title}"${track(type)}`;
  return { title, track, link };
}

// The site's feature-page CSS gives every paragraph a top margin
// (`.feature-article p { margin-top: 1em }`, 14px), which pushed a description's
// first line 14px below the headline's first line beside it, so the two no longer
// started on the same line. Zero the top margin of the description's first block
// (a <p> or list; the generated markup never gives it a style attribute of its
// own). Inline, because the CMS takes only inline styles.
function flushFirstBlock(html) {
  return (html || '').replace(/^(\s*<(?:p|ul|ol))(\s[^>]*)?>/i, (m, open, attrs) =>
    /\bstyle=/i.test(attrs || '') ? m : `${open}${attrs || ''} style="margin-top: 0;">`);
}

function rowCardParts(o, blogContentId, imagePx) {
  const { title, track, link } = cardLinkBuilder(o, blogContentId);

  // Explicit width/height reserve the space before the image loads; contain
  // keeps the whole product visible, centered, whatever its proportions.
  const image = (showImages && o.imageUrl)
    ? `<a ${link('image')} style="flex: 0 0 ${imagePx}px; height: ${imagePx}px;"><img src="${esc(resizedImageUrl(o.imageUrl, imagePx))}" alt="${title}" width="${imagePx}" height="${imagePx}" decoding="async" style="width: ${imagePx}px; height: ${imagePx}px; object-fit: contain; object-position: left top;"></a>`
    : '';

  const was = (showWasPrice && hasWasPrice(o))
    ? ` <s style="font: 400 14px Roboto, sans-serif; color: ${CARD.was}; margin-left: 4px;"><span style="${SR_ONLY_STYLE}">was </span>${formatMoney(o.wasPrice)}</s>` : '';
  const meta = cardMetaLine(o);
  const metaLine = meta ? `\n                <div style="font-size: 13px; font-weight: 400; line-height: 18px; color: ${CARD.muted};">${escText(meta)}</div>` : '';
  const ctaText = ctaTextFor(o);
  const button = `<a class="btn btn-cta bu-m-0" ${link('button')} aria-label="${esc(ctaText)}: ${title}" style="flex: none; margin-left: auto; align-self: center;">${escText(ctaText)}</a>`;

  const textColumn = `<div style="flex: 1 1 180px; min-width: 0;">
              <h3 style="font-size: 17px; line-height: 22px; font-weight: 500; margin: 0;">
                <a ${link('title')}>${escText(o.title)}</a>
              </h3>
              <div style="margin-top: 2px;"><span class="content-call-out" style="font: 700 22px/28px 'Roboto Condensed', sans-serif; color: ${CARD.price};">${escText(o.callout)}</span>${was}</div>${metaLine}
            </div>`;
  return { track, image, textColumn, button };
}

// The shared shell: one wrapping flex row with no media queries, so the card
// adapts to any width from its inline styles alone. `middle` is the card's
// description column (a value statement or creator quote); `attrs` are the data
// attributes; `extraClass` is e.g. ' cp-card'.
function rowCardShell(parts, middle, attrs, extraClass) {
  return `      <div class="bu-card shadow-depth-0${extraClass}" ${attrs} style="border-bottom: 1px solid ${CARD.rule};">
        <div class="bu-card-content" style="padding: 12px 0;">
          <div style="display: flex; flex-wrap: wrap; gap: 10px 16px; align-items: flex-start;">
            ${parts.image}
            ${parts.textColumn}${middle}
            ${parts.button}
          </div>
        </div>
      </div>`;
}

// Standard card: image | headline + price + store/shipping/end date | value
// statement | button. The value statement is trusted HTML from dastNodeToHTML()
// (lists and links kept, leaf text already escaped), so it goes in as is;
// .bu-content gives it the site's list and paragraph styling, .bu-is-flex-grow-1
// is how the Article tab finds it, and .dn-more / .dn-text are what the shared
// "more" script trims (long statements only, when Trim is on).
function standardCardHTML(o, blogContentId) {
  const parts = rowCardParts(o, blogContentId, CARD.standardImage);
  const middle = o.valueStatement
    ? `\n            <div class="dn-more" style="flex: 2 1 320px; min-width: 0;"><div class="dn-text bu-content bu-is-flex-grow-1" style="margin: 0; font-size: 14px; font-weight: 400; line-height: 20px;">${flushFirstBlock(o.valueStatement)}</div></div>`
    : '';
  return rowCardShell(parts, middle, `data-offer-id="${esc(o.id)}"`, '');
}

// Creator Pick card: the same row, with each creator's pill + quote in place of
// the value statement, and the data the page script sorts on.
function pickCardHTML(o, blogContentId) {
  const parts = rowCardParts(o, blogContentId, CARD.pickImage);
  const picks = o.picks || [];
  // Blank when absent (or, for the end date, when the editor hid it, so a hidden
  // placeholder date can't affect the sort).
  const ms = iso => { const n = iso ? Date.parse(iso) : NaN; return Number.isNaN(n) ? '' : n; };
  const dataAttrs = [
    `data-offer-id="${esc(o.id)}"`,
    `data-price="${o.price > 0 ? o.price : ''}"`,
    `data-pub="${ms(o.pubISO)}"`,
    `data-end="${showsEndDate(o) ? ms(o.endISO) : ''}"`,
  ].join(' ');
  return rowCardShell(parts, picks.length ? cpQuoteHTML(picks, parts.track('creator')) : '', dataAttrs, ' cp-card');
}

// The empty slot that holds the sort bar. Reserving the bar's height in the HTML
// means the script fills it instead of pushing the list down. The bar is taller
// when there are creator chips, which only appear for two or more creators.
function cpBarSlotHTML() {
  const creators = new Set();
  offers.forEach(o => (o.picks || []).forEach(p => { if (p.authorName) creators.add(p.authorName); }));
  const h = creators.size > 1 ? CP_BAR_HEIGHT.chips : CP_BAR_HEIGHT.plain;
  return `      <div class="cp-bar-slot" style="min-height: ${h}px;"></div>\n`;
}

/* ─── Table style ──────────────────────────────────────────────────────────
 * One row per offer under a column-header row, built for pages that list many
 * near-identical offers (the AliExpress promo codes page: 26 tiered codes that took
 * ~16,000px as cards). Like the row-style cards it is a wrapping flex row with NO
 * media queries (inline styles only): wide, a row is one line, `Offer | Code |
 * button`, with the Code and button columns at fixed widths so they line up down the
 * page; on a phone the offer text takes the first line and the Code and button wrap
 * together onto the second. The header row uses the same widths, and is clipped to
 * one line, so it lines up above the columns when they are side by side and shows
 * only "Offer" when they wrap.
 *
 * Each row is still a .bu-card with data-offer-id, an h3 title link, a
 * .content-call-out span (the discount is folded into the headline, as in Compact),
 * a .btn-cta button and, in the optional expandable Details, a .bu-content
 * .bu-is-flex-grow-1 block, so the Article tab (expirations, flags, reorder, iref
 * audit and fix) treats a row like any other card. The one page script copies a
 * promo code when its chip is tapped; without it the chip is plain, selectable
 * text. */
const TB = { thumb: 56, code: 128, button: 148, main: 240, gap: 16 };

// A promo code the description names, quoted ("DBDEAL3") or after the word code
// (code SAVE20): 4-25 capitals, digits, - or _, with at least one letter so a
// quoted year can't match. Case matters on purpose, so ordinary quoted words don't.
const PROMO_CODE_QUOTED = /["“‘']((?=[A-Z0-9_-]*[A-Z])[A-Z0-9][A-Z0-9_-]{3,24})["”’']/g;
// After the word code the token must also contain a digit, so "Promo Code FREE
// shipping" and "Code TERMS apply" don't match; "code: SAVE20" does.
const PROMO_CODE_AFTER_WORD = /\b(?:[Cc]ode|CODE):?\s+((?=[A-Z0-9_-]*[A-Z])(?=[A-Z_-]*[0-9])[A-Z0-9][A-Z0-9_-]{3,24})\b/;
const BLOCK_END_PATTERN = /<\/(?:p|li|div|h[1-6])>/gi;

function detectPromoCode(o) {
  if (!o.valueStatement) return '';
  const tpl = document.createElement('template');
  tpl.innerHTML = o.valueStatement.replace(BLOCK_END_PATTERN, ' ');
  const text = tpl.content.textContent || '';
  // A quoted token counts when it has a digit (DBDEAL3) or the word "code" sits
  // just before it; a quoted all-letter word elsewhere ("the "SALE" tab") does not.
  const quoted = new RegExp(PROMO_CODE_QUOTED.source, 'g');
  let m;
  while ((m = quoted.exec(text))) {
    if (/\d/.test(m[1]) || /code/i.test(text.slice(Math.max(0, m.index - 40), m.index))) return m[1];
  }
  const w = PROMO_CODE_AFTER_WORD.exec(text);
  return w ? w[1] : '';
}

// An edited code (updateCode) wins over the detected one; '' means none.
function offerCode(o) { return o.code !== undefined ? o.code : detectPromoCode(o); }

// The header row. Same column widths as the rows (so it wraps at the same width),
// clipped to one line: the inner box is one 16px line tall with overflow hidden, so
// when the columns wrap only the first label shows.
function tableHeaderHTML(ctx) {
  const labelStyle = `font: 700 11px/16px Roboto, sans-serif; letter-spacing: .06em; text-transform: uppercase; color: ${CARD.muted};`;
  const offerPad = ctx.hasImages ? ` padding-left: ${TB.thumb + 12}px;` : '';
  const actW = ctx.hasCodes ? TB.code + TB.gap + TB.button : TB.button;
  const codeHead = ctx.hasCodes ? `<div role="columnheader" style="flex: 0 0 ${TB.code}px;">Code</div>` : '';
  return `      <div role="row" style="border-bottom: 2px solid ${CARD.rule}; padding-bottom: 6px;">
        <div style="display: flex; flex-wrap: wrap; gap: 0 ${TB.gap}px; max-height: 16px; overflow: hidden; ${labelStyle}">
          <div role="columnheader" style="flex: 3 1 ${TB.main}px; min-width: 0; box-sizing: border-box;${offerPad}">Offer</div>
          <div style="flex: 1 0 ${actW}px; display: flex; justify-content: ${ctx.hasCodes ? 'space-between' : 'flex-end'}; gap: ${TB.gap}px;">
            ${codeHead}
            <div role="columnheader" style="flex: 0 0 ${TB.button}px;"><span style="${SR_ONLY_STYLE}">Link</span></div>
          </div>
        </div>
      </div>`;
}

// One row. ctx = { hasCodes, hasImages } for the whole table, so every row has the
// same cells even when only some offers carry a code.
function tableRowHTML(o, blogContentId, ctx) {
  const { title, link } = cardLinkBuilder(o, blogContentId);

  // Headline with the discount folded in ("AliExpress $3 off $15 Promo Code"),
  // the discount in bold. The span keeps .content-call-out for the Article tab.
  const hp = compactHeadlineParts(o.title, o.callout);
  const span = txt => `<span class="content-call-out" style="font: inherit; font-weight: 700; color: inherit;">${escText(txt)}</span>`;
  const headline = !hp.callout ? escText(hp.before)
    : hp.after ? `${escText(hp.before)}${span(` ${hp.callout} `)}${escText(hp.after)}`
    : `${escText(hp.before)}${span(` ${hp.connector} ${hp.callout}`)}`;

  const was = (showWasPrice && hasWasPrice(o))
    ? `<s style="color: ${CARD.was};"><span style="${SR_ONLY_STYLE}">was </span>${formatMoney(o.wasPrice)}</s>` : '';
  // One line under the headline: "was price · store · shipping · end date", and,
  // when the description is on, a "Details" toggle at its end (a native <details>:
  // no script, and the text stays on the page). The summary is display: block
  // with no list style, so the browser draws no triangle of its own.
  const metaText = cardMetaLine(o);
  const metaHTML = [was, metaText ? escText(metaText) : ''].filter(Boolean).join(' · ');
  const metaStyle = `font: 400 13px/18px Roboto, sans-serif; color: ${CARD.muted};`;
  const below = (showDetails && o.valueStatement)
    ? `\n              <details class="tb-details" style="margin-top: 2px;"><summary style="${metaStyle} display: block; list-style: none; cursor: pointer;">${metaHTML ? metaHTML + ' · ' : ''}<span style="font-weight: 500; color: #2c65af;">Details<span aria-hidden="true"> ▾</span></span></summary><div class="bu-content bu-is-flex-grow-1" style="margin: 6px 0 0; font-size: 14px; font-weight: 400; line-height: 20px;">${flushFirstBlock(o.valueStatement)}</div></details>`
    : metaHTML ? `\n              <div style="${metaStyle} margin-top: 2px;">${metaHTML}</div>` : '';

  const thumb = (ctx.hasImages && o.imageUrl)
    ? `<a ${link('image')} style="flex: 0 0 ${TB.thumb}px; height: ${TB.thumb}px;"><img src="${esc(resizedImageUrl(o.imageUrl, TB.thumb))}" alt="${title}" width="${TB.thumb}" height="${TB.thumb}" decoding="async" style="width: ${TB.thumb}px; height: ${TB.thumb}px; object-fit: contain; object-position: left top;"></a>`
    : (ctx.hasImages ? `<div style="flex: 0 0 ${TB.thumb}px;"></div>` : '');

  const code = offerCode(o);
  const codeCell = !ctx.hasCodes ? '' : code
    ? `<div role="cell" style="flex: 0 0 ${TB.code}px; min-width: 0;"><span class="tb-code" data-code="${esc(code)}" style="display: inline-block; max-width: 100%; box-sizing: border-box; padding: 5px 10px; border: 1.5px dashed #868b91; border-radius: 6px; background: #f6f8fa; font: 700 15px/20px 'Roboto Mono', Consolas, Menlo, monospace; letter-spacing: .04em; color: #303437; overflow-wrap: anywhere; user-select: all;">${escText(code)}</span><span class="tb-cap" style="display: block; min-height: 14px; margin-top: 3px; font: 500 11px/14px Roboto, sans-serif; color: #2c65af;"></span></div>`
    : `<div role="cell" style="flex: 0 0 ${TB.code}px;"></div>`;

  const ctaText = ctaTextFor(o);
  const button = `<a class="btn btn-cta bu-m-0" ${link('button')} aria-label="${esc(ctaText)}: ${title}" style="display: block; width: 100%; box-sizing: border-box; text-align: center; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${escText(ctaText)}</a>`;
  const actW = ctx.hasCodes ? TB.code + TB.gap + TB.button : TB.button;

  return `      <div class="bu-card shadow-depth-0" role="row" data-offer-id="${esc(o.id)}" style="border-bottom: 1px solid ${CARD.rule}; border-radius: 0;">
        <div class="bu-card-content" style="padding: 12px 0;">
          <div style="display: flex; flex-wrap: wrap; align-items: center; gap: 8px ${TB.gap}px;">
            <div role="cell" style="flex: 3 1 ${TB.main}px; min-width: 0; display: flex; gap: 12px; align-items: flex-start;">
              ${thumb}
              <div style="flex: 1 1 0; min-width: 0;">
              <h3 style="font-size: 16px; line-height: 22px; font-weight: 500; margin: 0;">
                <a ${link('title')}>${headline}</a>
              </h3>${below}
              </div>
            </div>
            <div style="flex: 1 0 ${actW}px; display: flex; align-items: center; justify-content: ${ctx.hasCodes ? 'space-between' : 'flex-end'}; gap: ${TB.gap}px;">
              ${codeCell}
              <div role="cell" style="flex: 0 0 ${TB.button}px; min-width: 0;">${button}</div>
            </div>
          </div>
        </div>
      </div>`;
}

function tableHTML(blogContentId) {
  const ctx = {
    hasCodes: offers.some(o => offerCode(o)),
    hasImages: showImages && offers.some(o => o.imageUrl),
  };
  const rows = offers.map(o => tableRowHTML(o, blogContentId, ctx)).join('\n');
  const script = ctx.hasCodes ? `\n<script>\n${TABLE_SCRIPT}\n</script>` : '';
  return `<div id="custom-offers-list" class="bu-vertical-offers tb-list" role="table">\n${tableHeaderHTML(ctx)}\n${rows}\n    </div>${script}`;
}

// The page scripts. They are real functions so they are syntax-highlighted,
// lintable and testable here; the constants below turn their source into the text
// that ships after the list. They never run in the sidebar. Both are progressive
// enhancement: with the script blocked or stripped, the cards still show in order
// with their full text.
//
// Constraints on these functions' source: DOM calls and textContent only, no
// tag-shaped text and no less-than sign directly before a letter (the CMS save
// mangles scripts that contain it, see "Live Feed Generator" in CLAUDE.md), no
// references to anything outside the function (it is stringified), and ES5 style.

// Shared by the Standard and Creator Pick cards: trims long text with an inline
// "more"/"less". Creator quotes (.cp-qtext inside a .cp-pick block) trim at 3
// lines, value statements (.dn-text inside a .dn-more block) at 8; "more" only
// appears on the ones that overflow, so only the longer ones are trimmed.
function cardMoreScript() {
  var QUOTE_LINES = 3, TEXT_LINES = 8;
  var BASE = 'background:none;border:0;margin:0;font:500 14px/20px Roboto,sans-serif;color:#2c65af;cursor:pointer;';
  // Collapsed: "more" floats at the end of the last visible line (24px tall to
  // be a comfortable target). Open: "less" sits under the text.
  var SHUT = BASE + 'position:absolute;right:0;bottom:-2px;padding:2px 0 2px 28px;background:linear-gradient(to right,rgba(255,255,255,0),#fff 45%)';
  var OPEN = BASE + 'display:block;padding:2px 0';

  // Only units this run has not set up (two scripts on one page must not set
  // the same text up twice).
  var units = Array.prototype.filter.call(document.querySelectorAll('.cp-pick, .dn-more'), function (u) {
    if (u.dnReady) return false;
    u.dnReady = true;
    return true;
  });
  if (!units.length) return;

  function textOf(u) { return u.querySelector('.cp-qtext, .dn-text'); }
  // Clamp with individual properties, never by rewriting the whole style
  // attribute: the text blocks carry their own inline typography (size, line
  // height, margin), which has to survive.
  function setClamp(t, on) {
    var n = t.className.indexOf('dn-text') !== -1 ? TEXT_LINES : QUOTE_LINES;
    t.style.display = on ? '-webkit-box' : '';
    t.style.webkitBoxOrient = on ? 'vertical' : '';
    t.style.webkitLineClamp = on ? String(n) : '';
    t.style.overflow = on ? 'hidden' : '';
  }
  function lineHeightOf(t) { return parseFloat(window.getComputedStyle(t).lineHeight) || 20; }
  function hidden(u) { // inside a filtered-out card: can't be measured
    for (var n = u; n && n !== document; n = n.parentNode) {
      if (n.style && n.style.display === 'none') return true;
    }
    return false;
  }
  function addToggle(unit, t) {
    var pill = unit.querySelector('.cp-pill');
    var who = pill ? pill.textContent.trim() : '';
    var of = pill ? (who ? who + "'s pick" : 'this pick') : 'this description';
    var b = document.createElement('button');
    b.type = 'button';
    unit.style.position = 'relative';
    function state(open) {
      b.setAttribute('aria-expanded', open ? 'true' : 'false');
      b.setAttribute('aria-label', (open ? 'Show less of ' : 'Read more of ') + of);
      b.textContent = open ? 'less' : 'more';
      b.style.cssText = open ? OPEN : SHUT;
      setClamp(t, !open);
    }
    b.addEventListener('click', function () { state(b.getAttribute('aria-expanded') !== 'true'); });
    state(false);
    unit.appendChild(b);
  }
  // Three passes (write, read, write) so the browser lays out once, not once per
  // block. Hidden units are skipped and fitted when they are shown again.
  function fitUnits() {
    var items = [];
    units.forEach(function (u) {
      var t = textOf(u);
      if (!t || hidden(u)) return;
      var b = u.querySelector('button');
      if (b && b.getAttribute('aria-expanded') === 'true') return;
      setClamp(t, true);
      items.push({ unit: u, t: t, b: b });
    });
    // Overflow of less than a line is only trailing margin inside the clamped
    // box (a list or paragraph spacing), not hidden text.
    var tall = items.map(function (x) { return x.t.scrollHeight - x.t.clientHeight > lineHeightOf(x.t) * 0.75; });
    items.forEach(function (x, i) {
      if (!tall[i]) {
        setClamp(x.t, false);
        if (x.b) x.b.style.display = 'none';
      } else if (!x.b) {
        addToggle(x.unit, x.t);
      } else {
        x.b.style.cssText = SHUT;
      }
    });
  }
  fitUnits();
  window.addEventListener('load', fitUnits);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(fitUnits);
  var timer;
  window.addEventListener('resize', function () { clearTimeout(timer); timer = setTimeout(fitUnits, 150); });
  document.addEventListener('cards-refit', fitUnits); // the sort script fires this after showing or hiding cards
}

// Creator Pick only: creator-face filter chips and a "Sort by" menu above the
// cards, built into the slot the page reserved for it.
function cardSortScript() {
  var RULE = '1px solid #e3e3e3';
  var INK = '#214b82';

  Array.prototype.forEach.call(document.querySelectorAll('.cp-list'), function (list) {
    if (list.cpReady) return; // two scripts on one page must not set a list up twice
    list.cpReady = true;
    if (list.className.indexOf('cp-sort') === -1) return;
    var cards = Array.prototype.slice.call(list.querySelectorAll('.cp-card'));
    if (!cards.length) return;
    cards.forEach(function (c, i) { c.setAttribute('data-i', i); });

    function num(c, k) { var v = parseFloat(c.getAttribute(k)); return isNaN(v) ? null : v; }
    function pillName(p) { return p.textContent.trim(); }
    function names(c) { // every creator on this card (an offer can have two)
      return Array.prototype.map.call(c.querySelectorAll('.cp-pill'), pillName).filter(Boolean);
    }
    var now = Date.now();
    function endOf(c) { var e = num(c, 'data-end'); return e !== null && e > now ? e : null; } // past dates don't count
    var creators = [], faces = {};
    cards.forEach(function (c) {
      Array.prototype.forEach.call(c.querySelectorAll('.cp-pill'), function (p) {
        var n = pillName(p);
        if (!n || creators.indexOf(n) !== -1) return;
        creators.push(n);
        var im = p.querySelector('img');
        faces[n] = im ? im.getAttribute('src') : '';
      });
    });
    function has(k) { return cards.some(function (c) { var v = num(c, k); return v !== null && v > 0; }); }
    var modes = [['order', 'Our order']];
    if (has('data-pub')) modes.push(['new', 'Newest first']);
    if (has('data-price')) { modes.push(['lo', 'Price: low to high']); modes.push(['hi', 'Price: high to low']); }
    if (cards.some(function (c) { return endOf(c) !== null; })) modes.push(['end', 'Ending soonest']);

    // The bar goes into the slot the page reserved for it (same minimum height),
    // so it appears without moving the list.
    var slot = list.querySelector('.cp-bar-slot');
    var bar = document.createElement('div');
    bar.style.cssText = 'padding:8px 0 10px;border-bottom:' + RULE + ';box-sizing:border-box';
    if (slot) bar.style.minHeight = slot.style.minHeight;
    var current = '';
    var chipEls = [];
    function chipLabel(n) { // first name, unless it is an initial or two creators share it
      var first = n.split(' ')[0];
      var clash = creators.some(function (o) { return o !== n && o.split(' ')[0] === first; });
      return (clash || first.indexOf('.') !== -1) ? n : first;
    }
    function chip(parent, label, name, src) {
      var b = document.createElement('button');
      b.type = 'button';
      b.style.cssText = 'flex:none;display:inline-flex;align-items:center;gap:6px;border-radius:24px;padding:3px 12px 3px ' + (src ? '3px' : '12px') + ';font:500 13px/18px Roboto,sans-serif;cursor:pointer;border:1px solid ' + INK;
      if (src) {
        var im = document.createElement('img');
        im.src = src; im.alt = ''; im.width = 24; im.height = 24;
        im.style.cssText = 'width:24px;height:24px;border-radius:50%;object-fit:cover';
        b.appendChild(im);
      }
      b.appendChild(document.createTextNode(label));
      b.addEventListener('click', function () { current = name; apply(); });
      b._name = name;
      parent.appendChild(b);
      chipEls.push(b);
    }
    if (creators.length > 1) {
      var chips = document.createElement('div');
      chips.setAttribute('role', 'group');
      chips.setAttribute('aria-label', 'Filter by creator');
      chips.style.cssText = 'display:flex;gap:8px;overflow-x:auto;padding-bottom:6px;scrollbar-width:none';
      // No two '' on one line: the CMS editor reads a pair of them as wiki italics and writes <i></i> into the script.
      chip(chips, 'All picks', String(), null);
      creators.forEach(function (n) { chip(chips, chipLabel(n), n, faces[n]); });
      bar.appendChild(chips);
    }
    var line = document.createElement('div');
    line.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap';
    var lab = document.createElement('label');
    lab.style.cssText = 'font:500 13px/18px Roboto,sans-serif;color:#5b6066';
    lab.appendChild(document.createTextNode('Sort by '));
    var sel = document.createElement('select');
    sel.style.cssText = 'font:400 14px/20px Roboto,sans-serif;padding:4px 6px;border:1px solid #868b91;border-radius:4px;background:#fff;color:#303437';
    modes.forEach(function (m) {
      var o = document.createElement('option');
      o.value = m[0]; o.textContent = m[1];
      sel.appendChild(o);
    });
    lab.appendChild(sel);
    var count = document.createElement('span');
    count.setAttribute('role', 'status'); // announces the new count after a filter change
    count.style.cssText = 'font:400 13px/18px Roboto,sans-serif;color:#5b6066';
    line.appendChild(lab); line.appendChild(count);
    bar.appendChild(line);
    if (slot) slot.appendChild(bar); else list.insertBefore(bar, list.firstChild);

    function key(c) { // null = no value, sorted last
      var m = sel.value, v;
      if (m === 'new') { v = num(c, 'data-pub'); return v === null ? null : -v; }
      if (m === 'lo') return num(c, 'data-price');
      if (m === 'hi') { v = num(c, 'data-price'); return v === null ? null : -v; }
      if (m === 'end') return endOf(c);
      return +c.getAttribute('data-i');
    }
    function apply() {
      var shown = 0;
      var sorted = cards.slice().sort(function (a, b) {
        var ka = key(a), kb = key(b);
        if (ka === null && kb === null) return a.getAttribute('data-i') - b.getAttribute('data-i');
        if (ka === null) return 1;
        if (kb === null) return -1;
        return (ka - kb) || (a.getAttribute('data-i') - b.getAttribute('data-i'));
      });
      sorted.forEach(function (c) {
        var ok = !current || names(c).indexOf(current) !== -1; // either creator on a two-creator card
        c.style.display = ok ? '' : 'none';
        if (ok) shown++;
        list.appendChild(c);
      });
      chipEls.forEach(function (b) {
        var on = b._name === current;
        b.style.background = on ? INK : '#fff';
        b.style.color = on ? '#fff' : INK;
        b.setAttribute('aria-pressed', on ? 'true' : 'false');
      });
      count.textContent = shown + ' of ' + cards.length + ' picks';
      document.dispatchEvent(new Event('cards-refit')); // cards just shown have not been measured yet
    }
    // Opens on newest first (by when the offer was first published); with no
    // publish times on any card it stays in the order the cards were written.
    sel.value = has('data-pub') ? 'new' : 'order';
    sel.addEventListener('change', apply);
    apply();
  });
}
const CARD_MORE_SCRIPT = '(' + cardMoreScript.toString() + ')();';
// Creator Pick ships both, "more" first so the quotes are trimmed before the bar
// is built.
const CARD_PAGE_SCRIPT = CARD_MORE_SCRIPT + '\n(' + cardSortScript.toString() + ')();';

// Table style only: tapping a promo-code chip copies the code. Progressive
// enhancement: the chip is plain selectable text until this runs, and the caption
// line under it is reserved in the HTML so adding the "Tap to copy" text moves
// nothing.
function tableCopyScript() {
  Array.prototype.forEach.call(document.querySelectorAll('.tb-code'), function (chip) {
    if (chip.tbReady) return;
    chip.tbReady = true;
    var code = chip.getAttribute('data-code') || chip.textContent;
    var cap = chip.parentNode.querySelector('.tb-cap');
    var timer;
    // The caption is not a live region until a copy happens (26 of them
    // announcing "Tap to copy" at load would be noise); the role is added just
    // before the message so it is announced, and removed when it resets.
    function say(msg) {
      if (!cap) return;
      cap.setAttribute('role', 'status');
      setTimeout(function () { cap.textContent = msg; }, 60);
      clearTimeout(timer);
      timer = setTimeout(function () {
        cap.removeAttribute('role');
        cap.textContent = 'Tap to copy';
      }, 2400);
    }
    function fallback() { // no Clipboard API: select the code and ask the browser to copy it
      var r = document.createRange();
      r.selectNodeContents(chip);
      var s = window.getSelection();
      s.removeAllRanges();
      s.addRange(r);
      var ok = false;
      try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
      say(ok ? 'Copied!' : 'Press Ctrl+C to copy');
    }
    function copy() {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(code).then(function () { say('Copied!'); }, fallback);
      } else {
        fallback();
      }
    }
    chip.setAttribute('role', 'button');
    chip.setAttribute('tabindex', '0');
    chip.setAttribute('aria-label', 'Copy code ' + code);
    chip.style.cursor = 'pointer';
    if (cap) cap.textContent = 'Tap to copy';
    chip.addEventListener('click', copy);
    chip.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); copy(); }
    });
  });
}
const TABLE_SCRIPT = '(' + tableCopyScript.toString() + ')();';

// Classic (the original card generator) and Compact (experimental): the markup
// exactly as it was before the row-style redesign, kept as a selectable fallback
// in case the new Standard card is not wanted. Image-and-text columns use the
// site's Bulma column classes. Nothing here is hardened or resized on purpose: it
// is the original behavior, byte for byte, which is also why the body below keeps
// its original indentation (the whitespace inside the template strings is part of
// the generated HTML). `compact` folds the callout into the headline link as one
// line ("Title for $33") at a fixed size matching dealnews.com's own deal card
// headlines and moves the button up under it; the callout span keeps the
// .content-call-out class so the Article tab can still find it, but resets
// font/color (that class and .price carry large, green, condensed-font styling
// on the live site).
function legacyCardHTML(o, blogContentId, compact) {
    const href    = o.monetizedUrl || o.landingUrl || '';
    const landing = o.landingUrl || href;
    const v       = o.vendor || '0';
    const t       = o.title.replace(/"/g, '&quot;');
    const img     = o.imageUrl
      ? `<img src="${o.imageUrl}" alt="${t}" style="height: 100%; max-width: 100%; object-fit: contain;">`
      : '';
    // Already-safe HTML from dastNodeToHTML() (lists/links preserved, all
    // leaf text pre-escaped) — do not escape again here, that would turn the
    // real <ul>/<a> tags into visible text instead of rendering them.
    const vs = o.valueStatement || '';
    const irefImage  = buildDataIref(blogContentId, o.legacyId, 'image');
    const irefTitle  = buildDataIref(blogContentId, o.legacyId, 'title');
    const irefButton = buildDataIref(blogContentId, o.legacyId, 'button');
    const imageCol = showImages ? `            <div class="bu-column bu-is-full-tablet bu-is-one-third-desktop bu-is-one-fifth-widescreen bu-is-flex bu-is-justify-content-center" style="height: 200px; width: 200px; margin: auto;">
              <a href="${href}" landing_url="${landing}" vendor="${v}" brand="0" category="0" title="${t}"${irefImage}>
                ${img}
              </a>
            </div>
` : '';
    const descBlock = `              <div class="bu-content bu-is-flex-grow-1">${vs}</div>`;
    const ctaBlock = `              <div class="bu-content bu-ml-0 ${compact ? 'bu-mb-4' : 'bu-mb-0'} bu-is-flex-touch bu-is-justify-content-center">
                <a class="btn btn-cta bu-m-0" href="${href}" landing_url="${landing}" vendor="${v}" brand="0" category="0" title="${t}"${irefButton}>${o.ctaText || 'Buy Now'}</a>
              </div>`;
    // Standard: headline, then callout on its own line, description, button.
    // Compact (experimental): callout folds into the headline link as one
    // line ("Title for $33") at a fixed size matching dealnews.com's own deal
    // card headlines, and the button moves up into the callout's old slot.
    // The callout span keeps the .content-call-out class so the Article tab
    // can still find it, but resets font/color — that class (and .price)
    // carry large, green, condensed-font styling on the live site.
    const textBlocks = compact
      ? `              <h3 class="bu-mb-2" style="font-size: 24px; font-weight: 400; line-height: 32px;">
                <a href="${href}" landing_url="${landing}" vendor="${v}" brand="0" category="0" title="${t}"${irefTitle}>
                  ${compactHeadlineHTML(o.title, o.callout)}
                </a>
              </h3>
${ctaBlock}
${descBlock}`
      : `              <h3 class="bu-is-4 bu-mb-2">
                <a href="${href}" landing_url="${landing}" vendor="${v}" brand="0" category="0" title="${t}"${irefTitle}>
                  ${o.title}
                </a>
              </h3>
              <span class="price content-call-out bu-is-5 bu-mb-4">${o.callout}</span>
${descBlock}
${ctaBlock}`;
    return `      <div class="bu-card shadow-depth-0" data-offer-id="${o.id}">
        <div class="bu-card-content">
          <div class="bu-columns">
${imageCol}            <div class="bu-column bu-is-flex bu-is-flex-direction-column" style="min-width: 150px;">
${textBlocks}
            </div>
          </div>
        </div>
      </div>`;
}

function generateHTML() {
  const blogContentId = document.getElementById('blog-content-id').value.trim();
  if (cardStyle === 'table') return tableHTML(blogContentId);
  if (cardStyle === 'pick') {
    // Full-width rows, so always the plain vertical container (never the
    // Bulma multi-column grid), plus the hooks the page script looks for.
    const cards = offers.map(o => pickCardHTML(o, blogContentId)).join('\n');
    // The sort bar's slot goes first inside the list, only when the bar is on.
    return `<div id="custom-offers-list" class="bu-vertical-offers cp-list${cpBar ? ' cp-sort' : ''}">\n${cpBar ? cpBarSlotHTML() : ''}${cards}\n    </div>\n<script>\n${CARD_PAGE_SCRIPT}\n</script>`;
  }
  const cards = offers.map(o => {
    if (cardStyle === 'standard') return standardCardHTML(o, blogContentId);
    return legacyCardHTML(o, blogContentId, cardStyle === 'compact');
  }).join('\n');
  // Grid mode wraps cards in Bulma-style columns for a multi-column layout on the
  // live site; vertical mode omits those classes so each full-width .bu-card just
  // stacks in normal block flow, one per row. The Standard card is always vertical:
  // the Bulma container has -10.5px side margins that the old Classic card hid
  // behind its own padding, but a row card has none, so in Grid mode its content
  // sat 10.5px closer to both edges than the Creator Pick card's (image 2px from
  // the edge instead of 12px) and no longer lined up with the page text.
  const containerClass = (cardStyle === 'standard' || cardLayout === 'vertical')
    ? 'bu-vertical-offers'
    : 'bu-columns bu-is-multiline bu-is-3';
  // Standard cards trim long value statements with the shared "more" script (when
  // Trim is on); Classic and Compact have nothing to trim.
  const script = (cardStyle === 'standard' && trimLong && offers.some(o => o.valueStatement)) ? `\n<script>\n${CARD_MORE_SCRIPT}\n</script>` : '';
  return `<div id="custom-offers-list" class="${containerClass}">\n${cards}\n    </div>${script}`;
}

function renderHTMLOut() {
  const empty = document.getElementById('html-empty');
  const block = document.getElementById('html-out-block');
  const warn  = document.getElementById('iref-blog-id-warn');
  if (!offers.length) {
    empty.style.display = 'block';
    block.style.display = 'none';
    warn.style.display = 'none';
    return;
  }
  empty.style.display = 'none';
  block.style.display = 'block';
  const blogContentId = document.getElementById('blog-content-id').value.trim();
  warn.style.display = blogContentId ? 'none' : 'block';
  document.getElementById('html-out-pre').textContent = generateHTML();
}

function copyHTML() {
  navigator.clipboard.writeText(generateHTML()).then(() => {
    ['copy-btn', 'copy-btn-2'].forEach(id => {
      const btn = document.getElementById(id);
      if (btn) { const orig = btn.textContent; btn.textContent = 'Copied!'; setTimeout(() => btn.textContent = orig, 2000); }
    });
  });
}

/* ─── Deal Processor ─── */
// Sets a button's text. Buttons from the row-style card generators carry an
// aria-label ("Buy Now: {title}"); it is kept in step with the visible text so
// the accessible name never contradicts what is shown (e.g. an expired card
// moved to the Expired group must not still be announced as "Buy Now").
function setCtaText(el, text) {
  el.textContent = text;
  if (el.hasAttribute('aria-label')) {
    const title = el.getAttribute('title') || '';
    el.setAttribute('aria-label', title ? `${text}: ${title}` : text);
  }
}

function processHTML() {
  const raw     = document.getElementById('proc-htmlInput').value.trim();
  const newText = document.getElementById('proc-btnText').value.trim();
  if (!raw)     { alert('Please paste some HTML first.'); return; }
  if (!newText) { alert('Please enter new button text.'); return; }

  const trackingMatches = findTrackingLinkMatches(raw);
  renderTrackingLinkBanner('proc', trackingMatches);
  if (trackingMatches.length) {
    logChange(
      'Processor',
      `Found ${trackingMatches.length} tracking URL${trackingMatches.length !== 1 ? 's' : ''} in pasted HTML`,
      trackingMatches
    );
  }

  const parser = new DOMParser();
  const doc = parser.parseFromString(raw, 'text/html');
  // Match on the single identifying class token rather than the full class
  // string — the exact utility classes riding along with it (margin/flex
  // modifiers) have changed over time, and pasted HTML may be from an older
  // or newer generation of cards. Matching by token keeps this working
  // across all of them instead of silently finding nothing.
  const matches = Array.from(doc.querySelectorAll('.' + PROC_TARGET_CLASS));

  // Capture each button's existing text before overwriting it, so the
  // change log can show a real before → after rather than just a count.
  const changes = matches.map(el => ({ before: el.textContent.trim(), after: newText }));
  matches.forEach(el => setCtaText(el, newText));
  document.getElementById('proc-tallyNum').textContent = matches.length;
  document.getElementById('proc-outputArea').value = doc.body.innerHTML;

  const copyBtn = document.getElementById('proc-copyBtn');
  copyBtn.style.display = matches.length > 0 ? 'inline-block' : 'none';

  if (matches.length === 0) {
    alert('No matching buttons found. Make sure the HTML contains elements with class:\n"' + PROC_TARGET_CLASS + '"');
    logChange('Processor', `No buttons matched class ".${PROC_TARGET_CLASS}" — nothing changed.`);
  } else {
    logChange(
      'Processor',
      `Retexted ${matches.length} button${matches.length !== 1 ? 's' : ''} to "${newText}"`,
      changes.map((c, i) => `Button ${i + 1}: "${c.before}" → "${c.after}"`)
    );
  }
}

function copyProcessorOutput() {
  const val = document.getElementById('proc-outputArea').value;
  if (!val) return;
  navigator.clipboard.writeText(val).then(() => {
    const btn = document.getElementById('proc-copyBtn');
    const orig = btn.textContent;
    btn.textContent = '✓ Copied!';
    setTimeout(() => { btn.textContent = orig; }, 2000);
  });
}

function clearProcessor() {
  document.getElementById('proc-htmlInput').value = '';
  document.getElementById('proc-outputArea').value = '';
  document.getElementById('proc-tallyNum').textContent = '—';
  document.getElementById('proc-copyBtn').style.display = 'none';
}

/* ─── Article tab ─── */
function getEditorSelector() {
  return document.getElementById('editor-selector').value.trim() || null;
}

function sendToContentScript(message) {
  const selector = getEditorSelector();
  const fullMessage = selector ? { ...message, selector } : message;
  return new Promise((resolve, reject) => {
    chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
      if (!tabs || !tabs[0]) { reject(new Error('No active tab found')); return; }
      chrome.tabs.sendMessage(tabs[0].id, fullMessage, response => {
        if (chrome.runtime.lastError) { reject(new Error(chrome.runtime.lastError.message)); return; }
        if (response?.error) { reject(new Error(response.error)); return; }
        resolve(response);
      });
    });
  });
}

let manualModeActive = false;

function toggleManualMode() {
  manualModeActive = !manualModeActive;
  document.getElementById('manual-area').style.display = manualModeActive ? 'block' : 'none';
  document.getElementById('manual-toggle-btn').textContent = manualModeActive ? 'Cancel' : 'Paste manually';
  if (!manualModeActive) document.getElementById('manual-html-input').value = '';
}

function cancelManualMode() {
  manualModeActive = false;
  document.getElementById('manual-area').style.display = 'none';
  document.getElementById('manual-toggle-btn').textContent = 'Paste manually';
  document.getElementById('manual-html-input').value = '';
}

function parseManualHTML() {
  const html = document.getElementById('manual-html-input').value.trim();
  if (!html) { alert('Please paste some HTML first.'); return; }
  articleOriginalHTML = html;
  cancelManualMode();
  parseAndDisplayCards(html);
}

async function loadFromPage() {
  const errEl     = document.getElementById('article-load-err');
  const spinnerEl = document.getElementById('article-spinner');
  errEl.style.display = 'none';
  spinnerEl.style.display = 'inline-block';
  document.getElementById('load-page-btn').disabled = true;
  refreshBlogIdFromActiveTab();

  try {
    const response = await sendToContentScript({ type: 'GET_ARTICLE_HTML' });
    articleOriginalHTML = response.html;
    detectedEditorSource = response.source || null;
    detectedEditorId     = response.editorId || null;
    parseAndDisplayCards(response.html);
  } catch (e) {
    errEl.textContent = e.message.includes('Could not establish connection')
      ? 'Extension not active on this page. Use "Paste manually" instead.'
      : e.message;
    errEl.style.display = 'block';
  } finally {
    spinnerEl.style.display = 'none';
    document.getElementById('load-page-btn').disabled = false;
  }
}

// Browsers don't enforce id uniqueness for CSS selector matching, so this
// finds cards inside EVERY element with id="custom-offers-list" — not just
// the first — which matters when an article's cards have been split across
// more than one such container. parseAndDisplayCards() and
// removeAndRegenerate() must use this same lookup so a card's `index` means
// the same DOM position in both places.
function findCardElements(doc) {
  let cardEls = Array.from(doc.querySelectorAll('#custom-offers-list .bu-card'));
  if (!cardEls.length) cardEls = Array.from(doc.querySelectorAll('.bu-card'));
  return cardEls;
}

function parseAndDisplayCards(html) {
  const errEl = document.getElementById('article-load-err');
  errEl.style.display = 'none';
  // A fresh load/paste is the new baseline — any edit flag from a previous
  // article no longer applies.
  articleHTMLModified = false;

  // Runs regardless of whether cards are found below — a tracking URL
  // is worth flagging even in article HTML with no deal cards at all.
  const trackingMatches = findTrackingLinkMatches(html);
  renderTrackingLinkBanner('article', trackingMatches);
  if (trackingMatches.length) {
    logChange(
      'Article',
      `Found ${trackingMatches.length} tracking URL${trackingMatches.length !== 1 ? 's' : ''} in loaded article HTML`,
      trackingMatches
    );
  }

  // Shown whenever something's loaded, regardless of whether cards are found
  // below — plain-text edits (e.g. a typo in body text) don't require a
  // recognized .bu-card to be useful.
  document.getElementById('find-replace-section').style.display = 'block';
  document.getElementById('find-replace-tally').textContent = '';
  clearFindMatchesPreview();

  const parser = new DOMParser();
  const doc = parser.parseFromString(html, 'text/html');

  const cardEls = findCardElements(doc);

  if (!cardEls.length) {
    // Clear any cards left over from a previous article — otherwise
    // removeAndRegenerate() would act on stale card state against this HTML.
    articleCards = [];
    errEl.textContent = 'No deal cards (.bu-card) found in the loaded HTML. Find & Replace and Remove JSON-LD still work — use Regenerate below to get the edited HTML.';
    errEl.style.display = 'block';
    document.getElementById('cards-found-section').style.display = 'none';
    // Kept visible (it used to be hidden here) so edits made via Find &
    // Replace / Remove JSON-LD on card-less HTML can still be regenerated
    // into the copyable output block.
    document.getElementById('regen-section').style.display = 'block';
    document.getElementById('regen-out-block').style.display = 'none';
    regenHTML = '';
    updateJsonLdButton();
    return;
  }

  articleCards = cardEls.map((el, i) => {
    const h3 = el.querySelector('h3');
    const firstLink = el.querySelector('a');
    const ctaEl = el.querySelector('.' + PROC_TARGET_CLASS);
    // Fallback selectors below (`.price`, plain `p`) matter specifically for
    // older cards predating this template — see "Article visual preview" in
    // CLAUDE.md. Missing any of these just means a blank field, not a parse
    // failure, since the whole point is to still surface whatever text is
    // there for a human to read.
    const imgEl = el.querySelector('img');
    const priceEl = el.querySelector('.content-call-out') || el.querySelector('.price');
    // Matched by class token, not tag name — generateHTML() emits this as a
    // <div> (needs to legally hold block content like lists), but older cards
    // may have it as a <p>; .bu-is-flex-grow-1 distinguishes it from the CTA
    // wrapper div, which also carries the plain .bu-content class.
    const descEl = el.querySelector('.cp-qtext') || el.querySelector('.bu-content.bu-is-flex-grow-1') || el.querySelector('.bu-content') || el.querySelector('p');
    const links = findCardLinks(el);
    const title = h3 ? cardTitleText(h3) : `Card ${i + 1}`;
    const landingUrl = firstLink ? (firstLink.getAttribute('landing_url') || firstLink.href || '') : '';
    const offerId = el.getAttribute('data-offer-id') || null;
    const ctaText = ctaEl ? ctaEl.textContent.trim() : '';
    const imageUrl = imgEl ? imgEl.getAttribute('src') : null;
    const callout = cardCalloutText(priceEl);
    const valueStatement = descEl ? descEl.textContent.trim() : '';
    // Independent of live DatoCMS status — the card's own CTA text is the
    // source of truth for "an editor already decided this stays."
    const keepDespiteExpired = EXPIRED_CTA_PATTERN.test(ctaText);
    const { missing: irefMissing, mismatched: irefMismatched } = analyzeIrefTags(links.image, links.title, links.button, links.creators);
    return {
      index: i, title, landingUrl, offerId, ctaText, imageUrl, callout, valueStatement,
      keepDespiteExpired, irefMissing, irefMismatched, status: 'unchecked', flagged: false,
      moveToExpiredGroup: false,
    };
  });

  renderArticleCards();
  updateArticleStatusBar();
  document.getElementById('cards-found-section').style.display = 'block';
  document.getElementById('regen-section').style.display = 'block';
  document.getElementById('regen-out-block').style.display = 'none';
  regenHTML = '';
  updateJsonLdButton();
}

// Re-derives each articleCards entry's *display* fields (title, callout, CTA
// text, etc.) from the current articleOriginalHTML, without touching
// flagged/status/reason or array order — used after a find/replace edit so
// the list/preview reflect the new text without discarding removal progress
// the way a full re-parse (parseAndDisplayCards) would. Matches elements back
// to cards by card.index, the same stable original-DOM position used
// everywhere else in the Article tab.
function refreshArticleCardFields() {
  const parser = new DOMParser();
  const doc = parser.parseFromString(articleOriginalHTML, 'text/html');
  const cardEls = findCardElements(doc);

  articleCards.forEach(card => {
    const el = cardEls[card.index];
    if (!el) return;
    const h3 = el.querySelector('h3');
    const firstLink = el.querySelector('a');
    const ctaEl = el.querySelector('.' + PROC_TARGET_CLASS);
    const imgEl = el.querySelector('img');
    const priceEl = el.querySelector('.content-call-out') || el.querySelector('.price');
    // Matched by class token, not tag name — generateHTML() emits this as a
    // <div> (needs to legally hold block content like lists), but older cards
    // may have it as a <p>; .bu-is-flex-grow-1 distinguishes it from the CTA
    // wrapper div, which also carries the plain .bu-content class.
    const descEl = el.querySelector('.cp-qtext') || el.querySelector('.bu-content.bu-is-flex-grow-1') || el.querySelector('.bu-content') || el.querySelector('p');
    const links = findCardLinks(el);

    card.title = h3 ? cardTitleText(h3) : card.title;
    card.landingUrl = firstLink ? (firstLink.getAttribute('landing_url') || firstLink.href || '') : card.landingUrl;
    card.offerId = el.getAttribute('data-offer-id') || null;
    card.ctaText = ctaEl ? ctaEl.textContent.trim() : card.ctaText;
    card.imageUrl = imgEl ? imgEl.getAttribute('src') : card.imageUrl;
    card.callout = priceEl ? cardCalloutText(priceEl) : card.callout;
    card.valueStatement = descEl ? descEl.textContent.trim() : card.valueStatement;
    card.keepDespiteExpired = EXPIRED_CTA_PATTERN.test(card.ctaText);
    const { missing, mismatched } = analyzeIrefTags(links.image, links.title, links.button, links.creators);
    card.irefMissing = missing;
    card.irefMismatched = mismatched;
  });

  return cardEls.length;
}

// Finds the exact substring of articleOriginalHTML that one parsed card
// occupies, so a small in-place edit (see applyIrefFix()) can be spliced
// directly into the raw string instead of reserializing — and thereby
// reformatting — the rest of the article the way removeAndRegenerate()'s
// final output does. Cards are aligned by outerHTML in left-to-right order,
// walking the string forward one card at a time, rather than a bare
// indexOf() on just the target card — two cards with identical markup (rare,
// but possible for near-empty placeholder cards) would otherwise risk a
// match against the wrong one. Returns null if a card's re-serialized
// outerHTML doesn't appear verbatim in the original string (e.g. the source
// used unquoted attributes or different entity encoding than the browser's
// own serializer would produce) — callers must treat that as "can't safely
// apply this edit," not silently proceed.
function locateCardHTMLSpan(index) {
  const doc = new DOMParser().parseFromString(articleOriginalHTML, 'text/html');
  const cardEls = findCardElements(doc);
  if (!cardEls[index]) return null;

  let cursor = 0;
  for (let i = 0; i <= index; i++) {
    const html = cardEls[i].outerHTML;
    const pos = articleOriginalHTML.indexOf(html, cursor);
    if (pos === -1) return null;
    if (i === index) return { targetEl: cardEls[i], start: pos, end: pos + html.length };
    cursor = pos + html.length;
  }
  return null;
}

// Escapes regex metacharacters so the Find field is matched as a literal
// substring, not interpreted as a pattern — a user searching for "$5 off" or
// "20% off" should get exactly that, not a regex error or a wrong match.
function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// How much surrounding raw HTML to show around each match — enough that a
// header tag (or lack of one) is usually visible in the snippet itself, so
// the user can tell "in a header" from "in body copy" without this code
// needing to know anything about document structure.
const FIND_CONTEXT_RADIUS = 40;

function clearFindMatchesPreview() {
  findMatches = [];
  document.getElementById('find-matches-wrap').style.display = 'none';
  document.getElementById('find-matches-list').innerHTML = '';
}

// Lists every match instead of replacing immediately, so a find term that's
// common in body copy but only meant to change in a header (the stated use
// case — swapping a month/year) can be reviewed and selectively unchecked
// before anything is written back to articleOriginalHTML.
function previewArticleFindMatches() {
  const findVal       = document.getElementById('find-input').value;
  const caseSensitive  = document.getElementById('find-case-sensitive').checked;
  const errEl   = document.getElementById('find-replace-err');
  const tallyEl = document.getElementById('find-replace-tally');
  errEl.style.display = 'none';
  tallyEl.textContent = '';
  clearFindMatchesPreview();

  if (!articleOriginalHTML) return;
  if (!findVal) { errEl.textContent = 'Enter text to find.'; errEl.style.display = 'block'; return; }

  const pattern = new RegExp(escapeRegExp(findVal), caseSensitive ? 'g' : 'gi');
  let m;
  while ((m = pattern.exec(articleOriginalHTML)) !== null) {
    findMatches.push({ start: m.index, end: m.index + m[0].length, text: m[0], selected: true });
  }

  if (!findMatches.length) {
    tallyEl.textContent = 'No matches found.';
    return;
  }

  renderFindMatchesList();
}

function findMatchSnippetHTML(match) {
  const html   = articleOriginalHTML;
  const before = html.slice(Math.max(0, match.start - FIND_CONTEXT_RADIUS), match.start);
  const after  = html.slice(match.end, match.end + FIND_CONTEXT_RADIUS);
  const leadingEllipsis  = match.start - FIND_CONTEXT_RADIUS > 0 ? '…' : '';
  const trailingEllipsis = match.end + FIND_CONTEXT_RADIUS < html.length ? '…' : '';
  return `${leadingEllipsis}${esc(before)}<mark>${esc(match.text)}</mark>${esc(after)}${trailingEllipsis}`;
}

function renderFindMatchesList() {
  const wrap = document.getElementById('find-matches-wrap');
  const list = document.getElementById('find-matches-list');

  if (!findMatches.length) { wrap.style.display = 'none'; list.innerHTML = ''; return; }

  wrap.style.display = 'block';
  list.innerHTML = findMatches.map((match, i) => `
    <li class="find-match-row">
      <input type="checkbox" class="find-match-checkbox" data-index="${i}" ${match.selected ? 'checked' : ''} />
      <span class="find-match-snippet">${findMatchSnippetHTML(match)}</span>
    </li>`).join('');

  updateFindMatchesCounter();
}

function updateFindMatchesCounter() {
  const selected = findMatches.filter(m => m.selected).length;
  document.getElementById('find-matches-counter').textContent = `${selected} of ${findMatches.length} selected`;
}

function applySelectedFindReplacements() {
  const findVal       = document.getElementById('find-input').value;
  const replaceVal     = document.getElementById('replace-input').value;
  const caseSensitive  = document.getElementById('find-case-sensitive').checked;
  const errEl   = document.getElementById('find-replace-err');
  const tallyEl = document.getElementById('find-replace-tally');
  errEl.style.display = 'none';

  if (!findMatches.length) { errEl.textContent = 'Click "Find Matches" first.'; errEl.style.display = 'block'; return; }

  const selectedCount = findMatches.filter(m => m.selected).length;
  if (!selectedCount) { errEl.textContent = 'Select at least one match to apply.'; errEl.style.display = 'block'; return; }

  const beforeCardCount = findCardElements(new DOMParser().parseFromString(articleOriginalHTML, 'text/html')).length;

  // Rebuild from the original match offsets in one pass rather than calling
  // .replace() per match — since only some matches are being substituted,
  // sequential replacement would shift the string positions of every match
  // still to come.
  let result = '';
  let cursor = 0;
  findMatches.forEach(match => {
    result += articleOriginalHTML.slice(cursor, match.start);
    result += match.selected ? replaceVal : match.text;
    cursor = match.end;
  });
  result += articleOriginalHTML.slice(cursor);
  articleOriginalHTML = result;
  // Lets removeAndRegenerate() produce output even when this edit didn't
  // flag or reorder anything — see its "nothing to do" gate.
  articleHTMLModified = true;

  const afterCardCount = refreshArticleCardFields();

  renderArticleCards();
  updateArticleStatusBar();

  // A prior regenerate's output no longer reflects the just-edited text —
  // hide it rather than leave a stale "final" HTML visible, same as a fresh
  // parse does.
  document.getElementById('regen-out-block').style.display = 'none';
  regenHTML = '';

  const trackingMatches = findTrackingLinkMatches(articleOriginalHTML);
  renderTrackingLinkBanner('article', trackingMatches);

  const totalCount = findMatches.length;
  const skippedCount = totalCount - selectedCount;
  let tally = `Replaced ${selectedCount} of ${totalCount} occurrence${totalCount !== 1 ? 's' : ''}${skippedCount ? ` (${skippedCount} left as-is)` : ''}.`;
  if (afterCardCount !== beforeCardCount) {
    tally += ` ⚠ Deal card count changed (${beforeCardCount} → ${afterCardCount}) — check flags/order below before regenerating.`;
  }
  tallyEl.textContent = tally;

  logChange(
    'Article',
    `Find/Replace: "${findVal}" → "${replaceVal}" (${selectedCount} of ${totalCount} occurrence${totalCount !== 1 ? 's' : ''} applied${caseSensitive ? ', case-sensitive' : ''})`,
    afterCardCount !== beforeCardCount
      ? [`Deal card count changed: ${beforeCardCount} → ${afterCardCount}`]
      : []
  );

  // Match offsets are only valid against the pre-apply string — clear them
  // rather than leave a now-meaningless list showing.
  clearFindMatchesPreview();
}

function renderArticleCards() {
  const list = document.getElementById('article-card-list');
  list.innerHTML = articleCards.map((card, i) => `
    <li class="card-list-item" draggable="true" data-index="${i}">
      <span class="drag-handle" title="Drag to reorder">⠿</span>
      <input class="pos-input" type="number" min="1" max="${articleCards.length}"
        value="${i + 1}" data-card-index="${card.index}" />
      <span class="card-list-title" title="${esc(card.landingUrl)}">${esc(card.title)}</span>
      <span class="badge ${badgeClassForStatus(card)}" id="badge-${i}" title="${esc(badgeTitleForCard(card))}">${badgeLabelForStatus(card)}</span>
      <button class="${card.flagged ? 'flag-btn flagged' : 'flag-btn'}" data-index="${i}"
        title="${card.flagged ? 'Unflag' : 'Flag for removal'}">🚩</button>
      <button class="${card.moveToExpiredGroup ? 'expire-move-btn active' : 'expire-move-btn'}" data-index="${i}"
        title="${card.moveToExpiredGroup ? 'Cancel — will not move to the Expired group' : `Move to the Expired group on regenerate (CTA becomes ${EXPIRED_GROUP_CTA_TEXT})`}">🗄️</button>
    </li>`).join('');
  initArticleDrag();
  // Keep the visual preview in sync with reorders/re-parses without needing
  // every caller of renderArticleCards() to remember to also call this.
  if (articlePreviewVisible) renderArticlePreview();
}

/* ─── Article tab visual preview ───
 * Mimics the Configure tab's Preview (renderPreview) but for articleCards —
 * lets an editor eyeball each card's actual callout/description/CTA text for
 * expiry language ("Expired", "Ended", a past date, etc.) that a live
 * DatoCMS check can't catch, particularly on older cards that predate the
 * data-offer-id attribute and so can't be checked via the API at all. */
let articlePreviewVisible = false;

function toggleArticlePreview() {
  articlePreviewVisible = !articlePreviewVisible;
  const container = document.getElementById('article-preview-container');
  const hint = document.getElementById('article-preview-hint');
  const btn = document.getElementById('article-preview-toggle');
  container.style.display = articlePreviewVisible ? 'block' : 'none';
  hint.style.display = articlePreviewVisible ? 'block' : 'none';
  btn.textContent = articlePreviewVisible ? '🖼 Hide Visual Preview' : '🖼 Show Visual Preview';
  if (articlePreviewVisible) renderArticlePreview();
}

// Same "one badge per real issue" treatment as the Unverifiable badge below —
// a card with clean data-iref tags gets nothing, since there's nothing to
// call out.
function irefBadgeHTML(card) {
  const missing    = card.irefMissing    || [];
  const mismatched = card.irefMismatched || [];
  if (!missing.length && !mismatched.length) return '';

  const parts = [];
  if (missing.length)    parts.push(`missing on ${missing.join('/')} link${missing.length !== 1 ? 's' : ''}`);
  if (mismatched.length) parts.push(`wrong link type tagged on ${mismatched.join('/')}`);
  const title = `data-iref tracking attribute ${parts.join('; ')}.`;

  return `<span class="badge badge-unknown" style="margin-left:6px;" title="${esc(title)}">🔗⚠ iref issue</span>`;
}

// Companion to irefBadgeHTML() — a button that only appears alongside the
// badge, so there's nothing to click on a card that's already clean.
function irefFixButtonHTML(card, i) {
  if (!(card.irefMissing?.length || card.irefMismatched?.length)) return '';
  return `<button class="small" id="fix-iref-btn-${i}" data-action="fix-iref" data-index="${i}"
    style="margin-left:6px;font-size:10px;padding:2px 6px;" title="Resolve this offer's legacy ID from DatoCMS and write the missing/incorrect data-iref attribute(s) directly onto this card.">🔗 Fix iref</button>`;
}

function renderArticlePreview() {
  const container = document.getElementById('article-preview-container');
  if (!articleCards.length) { container.innerHTML = ''; return; }

  container.innerHTML = articleCards.map((card, i) => {
    const url = card.landingUrl || '#';
    const imgHtml = card.imageUrl
      ? `<img src="${esc(card.imageUrl)}" alt="${esc(card.title)}">`
      : `<div class="no-img">no image</div>`;
    const unverifiable = !card.offerId
      ? `<span class="badge badge-unknown" style="margin-left:6px;" title="No data-offer-id on this card — status can't be checked via DatoCMS. Read the text below for expiry language instead.">⚠ Unverifiable</span>`
      : '';
    return `<div class="card-wrap${card.flagged ? ' flagged' : ''}${card.moveToExpiredGroup ? ' moved-expired' : ''}">
      <div class="card-id">
        #${i + 1} · ${card.offerId ? esc(card.offerId) : 'no offer ID'}
        <span class="badge ${badgeClassForStatus(card)}" style="margin-left:6px;" title="${esc(badgeTitleForCard(card))}">${badgeLabelForStatus(card)}</span>
        ${unverifiable}
        ${irefBadgeHTML(card)}
        ${irefFixButtonHTML(card, i)}
      </div>
      <div class="card-preview">
        <div class="card-img-col"><a href="${esc(url)}" target="_blank">${imgHtml}</a></div>
        <div class="card-content-col">
          <h3 class="card-h3"><a href="${esc(url)}" target="_blank">${esc(card.title)}</a></h3>
          <div class="card-price">${esc(card.callout || '')}</div>
          <div class="card-desc">${esc(card.valueStatement || '')}</div>
          <div class="card-cta-wrap">
            <a href="${esc(url)}" target="_blank" class="card-cta">${esc(card.ctaText || '')}</a>
            <button class="${card.flagged ? 'flag-btn flagged' : 'flag-btn'}" data-action="toggle-flag" data-index="${i}"
              style="flex-shrink:0;font-size:11px;padding:4px 10px;">
              ${card.flagged ? '🚩 Flagged — click to unflag' : '🚩 Flag for Removal'}
            </button>
            <button class="${card.moveToExpiredGroup ? 'expire-move-btn active' : 'expire-move-btn'}" data-action="move-to-expired" data-index="${i}"
              style="flex-shrink:0;font-size:11px;padding:4px 10px;">
              ${card.moveToExpiredGroup ? '🗄️ Moving to Expired Group — click to cancel' : '🗄️ Move to Expired Group'}
            </button>
          </div>
        </div>
      </div>
    </div>`;
  }).join('');
}

// Repairs a single card's data-iref tracking in place, instead of the card
// needing to be regenerated fresh from the Configure tab. Only touches links
// analyzeIrefTags() already flagged as missing or mismatched — a clean link
// is left exactly as-is. Requires the same Blog Content ID field the
// Configure tab's Edit sub-view uses (#blog-content-id is shared, session-
// only state — not duplicated here) and the offer's legacy ID, which is
// resolved via fetchOfferStatus() (the same call Check Expirations already
// makes) if it wasn't already cached on the card from an earlier check.
async function applyIrefFix(i) {
  const card = articleCards[i];
  if (!card || !(card.irefMissing?.length || card.irefMismatched?.length)) return;

  if (!card.offerId) {
    showToast(`"${card.title}" has no data-offer-id (DatoCMS) — can't resolve a legacy ID automatically. Regenerate via the Configure tab or edit data-iref by hand.`, true);
    return;
  }

  const blogContentId = document.getElementById('blog-content-id').value.trim();
  if (!blogContentId) {
    showToast('Enter a Blog Content ID (Configure tab → Edit) before fixing data-iref tags.', true);
    return;
  }

  const btn = document.getElementById(`fix-iref-btn-${i}`);
  const originalLabel = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Fixing…'; }

  try {
    if (!card.legacyId) {
      const expiryField = document.getElementById('exp-field').value.trim() || 'expiration';
      const result = await fetchOfferStatus(card.offerId, expiryField);
      card.status = result.status;
      card.reason = result.reason;
      if (result.legacyId) card.legacyId = result.legacyId;
    }

    const span = locateCardHTMLSpan(card.index);
    if (!span) {
      showToast(`Couldn't locate "${card.title}" in the article HTML to apply the fix — try reloading the article.`, true);
      return;
    }

    const { targetEl } = span;
    const linkEls = findCardLinks(targetEl);

    const typesToFix = Array.from(new Set([...(card.irefMissing || []), ...(card.irefMismatched || [])]));
    const applied = [];
    typesToFix.forEach(type => {
      // 'creator' is one link per creator; the others are a single link.
      const els = [].concat(linkEls[type === 'creator' ? 'creators' : type]).filter(Boolean);
      if (!els.length) return; // the link itself doesn't exist on this card — nothing to tag
      els.forEach(el => {
        el.setAttribute('data-iref', irefValue(blogContentId, card.legacyId, type));
        // Cards generated by a previous version of this tool may still carry
        // the old, wrong attribute name (see buildDataIref()'s comment) —
        // clean it up here since we're already touching this exact link.
        el.removeAttribute('iref-append');
      });
      applied.push(type);
    });

    if (!applied.length) {
      showToast(`"${card.title}" is missing its ${typesToFix.join('/')} link entirely — nothing to tag.`, true);
      return;
    }

    const newCardHTML = targetEl.outerHTML;
    articleOriginalHTML = articleOriginalHTML.slice(0, span.start) + newCardHTML + articleOriginalHTML.slice(span.end);
    // Lets removeAndRegenerate() produce output even when this fix didn't
    // flag or reorder anything — see its "nothing to do" gate.
    articleHTMLModified = true;

    refreshArticleCardFields();
    renderArticleCards();
    updateArticleStatusBar();

    // A prior regenerate's output no longer reflects this edit — same
    // invalidation as Find & Replace applies.
    document.getElementById('regen-out-block').style.display = 'none';
    regenHTML = '';

    logChange(
      'Article',
      `Applied data-iref to "${card.title}" (offer ${card.offerId}): ${applied.join(', ')}`,
      [`Blog Content ID ${blogContentId}, Legacy ID ${card.legacyId}`]
    );
    showToast(`data-iref added to "${card.title}" (${applied.join(', ')}).`);
  } catch (e) {
    showToast(`Couldn't fix data-iref: ${e.message}`, true);
  } finally {
    // Harmless if the success path above already re-rendered the preview —
    // this button element is detached by then and setting properties on it
    // has no visible effect.
    if (btn) { btn.disabled = false; btn.textContent = originalLabel; }
  }
}

// Bulk counterpart to applyIrefFix() — runs the exact same per-card fix
// sequentially (never in parallel: each call re-parses and re-splices
// articleOriginalHTML fresh, so concurrent calls would race against each
// other's edits) for every card with an iref issue, instead of clicking
// "Fix iref" once per card. Reuses applyIrefFix() itself rather than
// duplicating its legacy-ID-resolution/splice logic — success is detected
// by re-checking irefMissing/irefMismatched afterward (refreshArticleCardFields()
// inside applyIrefFix() already recomputed them), not by having
// applyIrefFix() return anything.
async function fixAllIrefIssues() {
  const candidates = articleCards
    .map((c, i) => i)
    .filter(i => articleCards[i].irefMissing?.length || articleCards[i].irefMismatched?.length);

  if (!candidates.length) {
    showToast('No iref issues found to fix.', true);
    return;
  }

  // Checked once up front rather than letting every iteration hit the same
  // wall — applyIrefFix() would otherwise show this identical error once
  // per card instead of once total.
  const blogContentId = document.getElementById('blog-content-id').value.trim();
  if (!blogContentId) {
    showToast('Enter a Blog Content ID (Configure tab → Edit) before fixing data-iref tags.', true);
    return;
  }

  // Cards with no data-offer-id can never be fixed automatically (same rule
  // applyIrefFix() enforces per-card) — skip them here rather than let each
  // one flash its own identical error, and report the count once instead.
  const noOfferId = candidates.filter(i => !articleCards[i].offerId);
  const fixable = candidates.filter(i => articleCards[i].offerId);

  const btn = document.getElementById('fix-all-iref-btn');
  const originalLabel = btn ? btn.textContent : '';
  if (btn) { btn.disabled = true; btn.textContent = 'Fixing…'; }

  let fixed = 0;
  for (const i of fixable) {
    await applyIrefFix(i);
    const card = articleCards[i];
    if (!(card.irefMissing?.length || card.irefMismatched?.length)) fixed++;
  }

  if (btn) { btn.disabled = false; btn.textContent = originalLabel; }

  const failed = fixable.length - fixed;
  const parts = [`fixed ${fixed} of ${fixable.length} card${fixable.length !== 1 ? 's' : ''}`];
  if (noOfferId.length) parts.push(`${noOfferId.length} skipped — no offer ID`);
  showToast(`${parts.join(', ')}.`, failed > 0 || noOfferId.length > 0);
}

/* ─── Article card reorder ─── */
// Identifies the card by its stable original-DOM index (card.index), not its
// current display position — the keydown handler below re-renders (which
// destroys the focused input) and then calls .blur(), which re-fires this via
// the capturing blur listener with the same stale position-based args. Doing
// the lookup by position instead of by an identity that survives the reorder
// would move whatever card has since shifted into that slot. Looking the card
// up by its fixed identity makes the repeat call a no-op instead (idx already
// equals target), same trick as moveOffer() uses with offer id.
function moveArticleCard(cardIndex, rawVal) {
  const idx = articleCards.findIndex(c => c.index === cardIndex);
  if (idx === -1) return;
  const target = Math.min(Math.max(parseInt(rawVal, 10) || 1, 1), articleCards.length) - 1;
  if (target === idx) { renderArticleCards(); return; }
  const [item] = articleCards.splice(idx, 1);
  articleCards.splice(target, 0, item);
  renderArticleCards();
}

let articleDragSrcIndex = null;

function initArticleDrag() {
  const items = document.querySelectorAll('#article-card-list li[draggable]');
  items.forEach(li => {
    li.addEventListener('dragstart', e => {
      articleDragSrcIndex = parseInt(li.dataset.index);
      li.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    li.addEventListener('dragend', () => {
      items.forEach(i => i.classList.remove('dragging', 'drag-over'));
    });
    li.addEventListener('dragover', e => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      items.forEach(i => i.classList.remove('drag-over'));
      li.classList.add('drag-over');
    });
    li.addEventListener('drop', e => {
      e.preventDefault();
      const targetIndex = parseInt(li.dataset.index);
      if (articleDragSrcIndex === null || articleDragSrcIndex === targetIndex) return;
      const [item] = articleCards.splice(articleDragSrcIndex, 1);
      articleCards.splice(targetIndex, 0, item);
      articleDragSrcIndex = null;
      renderArticleCards();
    });
  });
}

function badgeClassForStatus(card) {
  if (card.flagged) return 'badge-flagged';
  // Mutually exclusive with card.flagged (see toggleFlag()/
  // toggleMoveToExpiredGroup()), so this and the flagged check above never
  // both apply — order between them doesn't matter functionally, but this
  // sits ahead of keepDespiteExpired since it's a pending action about to
  // happen on regenerate, not just a passive note.
  if (card.moveToExpiredGroup) return 'badge-move-expired';
  if (card.keepDespiteExpired) return 'badge-keep';
  switch (card.status) {
    case 'active':   return 'badge-active';
    case 'expired':  return 'badge-expired';
    case 'deleted':  return 'badge-deleted';
    case 'checking': return 'badge-checking';
    default:         return 'badge-unknown';
  }
}

function badgeLabelForStatus(card) {
  if (card.flagged) return 'Flagged';
  if (card.moveToExpiredGroup) return '→ Expired Group';
  if (card.keepDespiteExpired) return 'Keep (CTA: Expired)';
  switch (card.status) {
    case 'active':   return 'Active';
    case 'expired':  return 'Expired';
    case 'deleted':  return 'Deleted';
    case 'checking': return 'Checking…';
    default:         return card.status === 'unchecked' ? 'Unchecked' : 'Unknown';
  }
}

function badgeTitleForCard(card) {
  if (card.moveToExpiredGroup) {
    return `Will move into the Expired group on regenerate — CTA text will change to "${EXPIRED_GROUP_CTA_TEXT}".`;
  }
  if (card.keepDespiteExpired) {
    return `Kept intentionally — CTA button text says "${card.ctaText}". Skipped by "Flag Expired".`;
  }
  return card.reason || '';
}

function updateArticleStatusBar() {
  const total   = articleCards.length;
  const expired = articleCards.filter(c => c.status === 'expired' || c.status === 'deleted').length;
  const flagged = articleCards.filter(c => c.flagged).length;
  const noId    = articleCards.filter(c => !c.offerId).length;
  const kept    = articleCards.filter(c => c.keepDespiteExpired).length;
  const movingToExpiredGroup = articleCards.filter(c => c.moveToExpiredGroup).length;
  const irefIssues = articleCards.filter(c => (c.irefMissing?.length || c.irefMismatched?.length)).length;

  let msg = `<strong>${total}</strong> deal card${total !== 1 ? 's' : ''} found`;
  if (expired > 0) msg += ` · <strong style="color:var(--red)">${expired} expired/deleted</strong>`;
  if (flagged > 0) msg += ` · <strong style="color:var(--orange)">${flagged} flagged</strong>`;
  if (movingToExpiredGroup > 0) msg += ` · <strong style="color:var(--purple)">${movingToExpiredGroup} → Expired group</strong>`;
  if (kept > 0)    msg += ` · <strong style="color:var(--accent)">${kept} kept (CTA: expired)</strong>`;
  if (noId > 0)    msg += ` · ${noId} without offer ID`;
  if (irefIssues > 0) msg += ` · <strong style="color:var(--yellow)">${irefIssues} with data-iref issues</strong>`;
  if (detectedEditorSource) {
    const label = detectedEditorId ? `${detectedEditorSource} #${detectedEditorId}` : detectedEditorSource;
    msg += ` · <span style="color:var(--text-faint)">editor: ${label}</span>`;
  }
  document.getElementById('article-status-bar').innerHTML = msg;
}

function toggleFlag(index) {
  const card = articleCards[index];
  if (!card) return;
  card.flagged = !card.flagged;
  // Mutually exclusive with moveToExpiredGroup — a card is either removed
  // or moved into the Expired group on regenerate, never both.
  if (card.flagged) card.moveToExpiredGroup = false;

  // Full re-render rather than hand-patching this row's badge/button: once
  // flagging can also clear moveToExpiredGroup, that second button's state
  // needs to update too, and duplicating that patch logic for two buttons
  // isn't worth it over just re-rendering (renderArticleCards() already
  // re-renders the preview too when it's visible).
  renderArticleCards();
  updateArticleStatusBar();
}

// Mutually exclusive with card.flagged — see toggleFlag() above. Toggling
// this on marks the card to be relocated into the article's existing
// "Expired" #custom-offers-list section on regenerate, with its CTA text
// rewritten to EXPIRED_GROUP_CTA_TEXT, instead of being deleted. See
// "Expired group" in CLAUDE.md for the regenerate-time handling and why an
// existing second container is required.
function toggleMoveToExpiredGroup(index) {
  const card = articleCards[index];
  if (!card) return;
  card.moveToExpiredGroup = !card.moveToExpiredGroup;
  if (card.moveToExpiredGroup) card.flagged = false;
  renderArticleCards();
  updateArticleStatusBar();
}

// Bulk counterpart to toggleMoveToExpiredGroup() — sweeps every card that's
// expired by either signal this tool has: a live DatoCMS status check
// (status === 'expired'/'deleted') or the card's own CTA text already
// saying so (keepDespiteExpired). Unlike flagExpired()/flagAllExceptKept(),
// keepDespiteExpired cards are NOT skipped here — a card an editor already
// chose to keep despite being expired is exactly the kind of card this
// feature exists to consolidate into one section, not something to leave
// untouched.
function moveAllExpiredToGroup() {
  if (!articleCards.length) return;
  let moved = 0;
  articleCards.forEach(card => {
    const isExpired = card.status === 'expired' || card.status === 'deleted' || card.keepDespiteExpired;
    if (!isExpired) return;
    card.moveToExpiredGroup = true;
    card.flagged = false;
    moved++;
  });
  renderArticleCards();
  updateArticleStatusBar();
  showToast(
    moved ? `Marked ${moved} card${moved !== 1 ? 's' : ''} to move to the Expired group on regenerate.` : 'No expired cards found to move.',
    !moved
  );
}

function setAllFlags(flagged) {
  if (!articleCards.length) return;
  articleCards.forEach(card => { card.flagged = flagged; });
  renderArticleCards();
  updateArticleStatusBar();
}

function flagExpired() {
  if (!articleCards.length) return;
  let skipped = 0;
  articleCards.forEach(card => {
    if (card.status !== 'expired' && card.status !== 'deleted') return;
    // A card intentionally left on the page (CTA text says "expired") isn't
    // stale — it's an editorial choice, not something to sweep up here.
    // Per-card 🚩 flagging and "Flag All for Removal" still work on it, since
    // those are explicit per-card/bulk overrides, not an automatic scan.
    if (card.keepDespiteExpired) { skipped++; return; }
    card.flagged = true;
  });
  renderArticleCards();
  updateArticleStatusBar();
  if (skipped) {
    showToast(`Left ${skipped} card${skipped !== 1 ? 's' : ''} unflagged — CTA text says "expired," kept intentionally.`);
  }
}

function flagAllExceptKept() {
  if (!articleCards.length) return;
  let skipped = 0;
  articleCards.forEach(card => {
    // Same "editor already decided this stays" rule flagExpired() uses —
    // here it's the entire override for what gets flagged, not just a filter
    // on top of a status check, since this button ignores DatoCMS status.
    if (card.keepDespiteExpired) { skipped++; return; }
    card.flagged = true;
  });
  renderArticleCards();
  updateArticleStatusBar();
  if (skipped) {
    showToast(`Flagged all except ${skipped} card${skipped !== 1 ? 's' : ''} kept intentionally — CTA text says "expired."`);
  }
}

async function checkAllExpirations() {
  if (!articleCards.length) return;

  const errEl     = document.getElementById('check-err');
  const spinnerEl = document.getElementById('check-spinner');
  const btn       = document.getElementById('check-exp-btn');
  errEl.style.display = 'none';
  spinnerEl.style.display = 'inline-block';
  btn.disabled = true;

  const expiryField = document.getElementById('exp-field').value.trim() || 'expiration';
  const errors = [];

  for (let i = 0; i < articleCards.length; i++) {
    const card = articleCards[i];
    if (!card.offerId) { card.status = 'unknown'; updateCardBadge(i); continue; }
    card.status = 'checking';
    updateCardBadge(i);
    try {
      const result = await fetchOfferStatus(card.offerId, expiryField);
      card.status = result.status;
      card.reason = result.reason;
      // Piggybacks on this same fetch rather than a dedicated lookup —
      // applyIrefFix() uses whatever was resolved here instead of hitting
      // DatoCMS again, if this card's status has already been checked.
      if (result.legacyId) card.legacyId = result.legacyId;
    } catch (e) {
      card.status = 'unknown';
      errors.push(`Card ${i + 1}: ${e.message}`);
    }
    updateCardBadge(i);
  }

  spinnerEl.style.display = 'none';
  btn.disabled = false;
  if (errors.length) { errEl.textContent = errors.join(' · '); errEl.style.display = 'block'; }
  updateArticleStatusBar();
}

function updateCardBadge(index) {
  const card  = articleCards[index];
  const badge = document.getElementById('badge-' + index);
  if (badge) { badge.className = 'badge ' + badgeClassForStatus(card); badge.textContent = badgeLabelForStatus(card); badge.title = badgeTitleForCard(card); }
}

function removeAndRegenerate() {
  if (!articleOriginalHTML) return;

  // No deal cards in the loaded HTML — nothing to remove, move, or reorder,
  // so the only thing to output is the text edits (Find & Replace / Remove
  // JSON-LD). Emits articleOriginalHTML as-is rather than round-tripping it
  // through DOMParser, so the rest of the article isn't reformatted.
  if (!articleCards.length) {
    if (!articleHTMLModified) {
      showToast('No deal cards in this HTML and no edits made yet — nothing to do.', true);
      logChange('Article', 'Regenerate clicked — nothing to do (no deal cards, no edits).');
      return;
    }
    regenHTML = articleOriginalHTML;
    document.getElementById('regen-out-pre').textContent = regenHTML;
    document.getElementById('regen-out-block').style.display = 'block';

    const noCardTrackingMatches = findTrackingLinkMatches(regenHTML);
    renderTrackingLinkBanner('regen', noCardTrackingMatches);
    if (noCardTrackingMatches.length) {
      logChange(
        'Article',
        `Regenerated HTML still contains ${noCardTrackingMatches.length} tracking URL${noCardTrackingMatches.length !== 1 ? 's' : ''}`,
        noCardTrackingMatches
      );
    }
    showToast('Applied edits (no deal cards in this HTML). Review HTML below.');
    logChange('Article', 'Regenerated HTML — applied edits (Find & Replace / JSON-LD removal), no deal cards present');
    return;
  }

  // Flagged is the single source of truth for removal — flagExpired() /
  // flagAllExceptKept() / the bulk buttons / per-card 🚩 are all just ways to
  // SET card.flagged, not separate removal signals. Checking c.status here
  // too (as a prior version of this code did) silently removed every
  // expired/deleted-status card regardless of whether the user flagged it —
  // including moveToExpiredGroup cards (which are expired by definition,
  // that's why they're being moved) and keepDespiteExpired ("Keep") cards,
  // neither of which should ever be swept into removal just for having that
  // status.
  const toRemove = new Set(
    articleCards
      .filter(c => c.flagged)
      .map(c => c.index)
  );
  // Mutually exclusive with toRemove by construction (toggleFlag()/
  // toggleMoveToExpiredGroup() never let both be true on the same card),
  // but the !toRemove.has() guard costs nothing and protects against state
  // ever drifting out of sync.
  const toMoveToExpired = new Set(
    articleCards
      .filter(c => c.moveToExpiredGroup && !toRemove.has(c.index))
      .map(c => c.index)
  );
  const reordered = articleCards.some((c, i) => c.index !== i);

  // Removal/reorder aren't the only reasons to regenerate anymore — a Find &
  // Replace edit or a data-iref fix (applyIrefFix()) can change
  // articleOriginalHTML without flagging or moving a single card, and that
  // edited HTML still needs to reach this output block to be copied out.
  // Without articleHTMLModified here, those edits would be silently stuck:
  // "nothing to do" would fire even though the article's HTML genuinely
  // differs from what was loaded.
  if (toRemove.size === 0 && !reordered && !articleHTMLModified && toMoveToExpired.size === 0) {
    showToast('No cards flagged or expired, order is unchanged, and no edits have been made — nothing to do.', true);
    logChange('Article', 'Regenerate clicked — nothing to do (no flagged/expired cards, order unchanged, no edits).');
    return;
  }

  const parser = new DOMParser();
  const doc = parser.parseFromString(articleOriginalHTML, 'text/html');

  const cardEls = findCardElements(doc);

  // Reordering applies within whichever container a card already lives in
  // — it never moves a card between containers by itself (that's what the
  // Expired-group move button is for, see below). Supported for exactly 1
  // container (the original case) or exactly 2 (the same active+Expired
  // convention the Expired-group feature below already assumes) — anything
  // else, skip reordering but still remove. Checked before removal since a
  // removed card's parentNode goes null and would fail this check after.
  // parentByCardIndex is captured here too, before any mutation, so the
  // reorder-append loop below knows which container each surviving card
  // belongs to without re-querying after cards start moving around.
  const containers = Array.from(doc.querySelectorAll('#custom-offers-list'));
  const parentByCardIndex = new Map(cardEls.map((el, i) => [i, el.parentNode]));
  const canReorder = (containers.length === 1 || containers.length === 2)
    && cardEls.every(el => containers.includes(el.parentNode));

  // The Expired-group feature requires an EXISTING second container to move
  // into (deliberately — no attempt to fabricate a heading/section, since
  // there's no article-agnostic way to guess appropriate heading text).
  // Checked, and bailed out of if invalid, before any DOM mutation below —
  // this must be all-or-nothing, not a partial regenerate.
  let expiredContainer = null;
  if (toMoveToExpired.size > 0) {
    if (containers.length !== 2) {
      showToast(
        `Can't move ${toMoveToExpired.size} card${toMoveToExpired.size !== 1 ? 's' : ''} to an Expired group — found ${containers.length} #custom-offers-list container${containers.length !== 1 ? 's' : ''} in this article, but this needs exactly 2 (the active list, then an existing Expired section to move into). Unmark the card(s), or add that section to the article first.`,
        true
      );
      return;
    }
    // Document order, not creation order — the article's own second
    // #custom-offers-list (after whatever heading introduces it, e.g.
    // "Expired Promo Codes") is assumed to be the later one in the source.
    expiredContainer = containers[1];
  }

  toRemove.forEach(idx => { if (cardEls[idx]) cardEls[idx].remove(); });

  // Gated on `reordered`, not just `canReorder` — appendChild moves every
  // surviving card to the END of the container one at a time, so running
  // this when nothing was actually reordered has no benefit (a plain
  // .remove() already closes up the gap on its own — the flex/grid layout
  // reflows the remaining cards with no help needed) and one real cost: any
  // non-`.bu-card` content sitting inside #custom-offers-list (stray
  // whitespace, or a malformed card missing its own `.bu-card` wrapper —
  // see "Generated HTML" below) never gets moved, so once every recognized
  // card is hoisted past it to the end, that stray content is left stranded
  // wherever it happened to sit — typically near the top of the list —
  // instead of a plain gap where the removed card used to be.
  if (canReorder && reordered) {
    // appendChild on an already-attached node moves it — replaying
    // articleCards' current (possibly user-reordered) order here reorders
    // each container's children to match, skipping removed and moved cards
    // (a card moving to the Expired group has nothing to do with this
    // list's own order, and re-appending it here would fight the
    // appendChild into expiredContainer below over where it ends up).
    // Appending to parentByCardIndex's container — not a single shared one
    // — is what lets this apply within the active list even when a second,
    // Expired container also exists: a card only reorders relative to
    // other cards that already share its own original container, never
    // hopping into the other one just because it's earlier/later in
    // articleCards' flat array order.
    // Slot-based, not append-based: appendChild would hoist every card past
    // any non-.bu-card content in the container (whitespace, or a malformed
    // card missing its .bu-card wrapper), stranding that content at the top
    // as blank space. Instead, mark where each surviving card currently
    // sits with a placeholder, detach them all, then drop the cards back in
    // the new order into those same positions — so non-card content keeps
    // its place and the cards just swap among their own slots.
    const survivors = articleCards.filter(c => cardEls[c.index] && !toRemove.has(c.index) && !toMoveToExpired.has(c.index));
    const containersInUse = new Set(survivors.map(c => parentByCardIndex.get(c.index)));
    containersInUse.forEach(parent => {
      const inContainer = survivors.filter(c => parentByCardIndex.get(c.index) === parent);
      const slotEls = inContainer.map(c => cardEls[c.index]).sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING) ? -1 : 1);
      const placeholders = slotEls.map(el => {
        const ph = doc.createComment('');
        el.parentNode.insertBefore(ph, el);
        return ph;
      });
      slotEls.forEach(el => el.remove());
      inContainer.forEach((c, k) => placeholders[k].replaceWith(cardEls[c.index]));
    });
  }

  // Rewrites each moved card's CTA text and relocates it into the article's
  // existing Expired section, landing at the TOP of that section (ahead of
  // whatever's already there) rather than the end — a freshly-expired card
  // is the one an editor is most likely to want to glance at next, and the
  // section otherwise tends to accumulate oldest-first with newer arrivals
  // buried below a growing pile. `anchor` is captured once, before any
  // insertion, as the container's original first child (null if the
  // section was empty) — inserting every moved card via `insertBefore(el,
  // anchor)` places each new card immediately before that same fixed point,
  // so cards land in articleCards' order (first moved card ends up
  // topmost-of-the-new-arrivals, not bottommost) instead of each insertion
  // displacing the previous one and reversing the order.
  const anchor = expiredContainer ? expiredContainer.firstChild : null;
  const movedCards = [];
  articleCards.forEach(c => {
    if (!toMoveToExpired.has(c.index)) return;
    const el = cardEls[c.index];
    if (!el) return;
    const ctaEl = el.querySelector('.' + PROC_TARGET_CLASS);
    if (ctaEl) setCtaText(ctaEl, EXPIRED_GROUP_CTA_TEXT);
    expiredContainer.insertBefore(el, anchor);
    movedCards.push(c);
  });

  // Leading <script>/<style> blocks (e.g. JSON-LD structured data) get
  // parsed into the synthetic <head> by DOMParser since they're "metadata
  // content" and appear before any real body element forces the parser out
  // of "in head" mode. They belong at the top of the article, not the head.
  regenHTML = doc.head.innerHTML + doc.body.innerHTML;
  document.getElementById('regen-out-pre').textContent = regenHTML;
  document.getElementById('regen-out-block').style.display = 'block';

  // Re-check the regenerated output too — a surviving or reordered card can
  // still carry a tracking link even when the loaded article's own banner
  // (above) was clear, or vice versa if the flagged/removed card was the
  // only one carrying it.
  const regenTrackingMatches = findTrackingLinkMatches(regenHTML);
  renderTrackingLinkBanner('regen', regenTrackingMatches);
  if (regenTrackingMatches.length) {
    logChange(
      'Article',
      `Regenerated HTML still contains ${regenTrackingMatches.length} tracking URL${regenTrackingMatches.length !== 1 ? 's' : ''}`,
      regenTrackingMatches
    );
  }

  const removed = toRemove.size;
  const parts = [];
  if (removed) parts.push(`removed ${removed} card${removed !== 1 ? 's' : ''}`);
  if (movedCards.length) parts.push(`moved ${movedCards.length} card${movedCards.length !== 1 ? 's' : ''} to Expired group`);
  if (reordered) parts.push(canReorder ? 'applied new order' : "order unchanged — cards aren't split cleanly across 1 or 2 recognized containers");
  // Nothing was removed, moved, or reordered, but articleHTMLModified is
  // what got us past the gate above — say so, rather than showing an empty
  // ". Review HTML below." with no context for why there's new output.
  if (!parts.length) parts.push('applied edits (Find & Replace / iref fix)');
  showToast(`${parts.join(', ')}. Review HTML below.`);

  // Change log detail: exactly which cards were removed and why, exactly
  // which cards moved and where (both to the Expired group and via reorder),
  // and whether any <head>-parsed content (script/style blocks like JSON-LD)
  // was carried through — the kind of detail needed to tell a real bug
  // apart from expected behavior.
  const logDetails = [];
  articleCards
    .filter(c => toRemove.has(c.index))
    .forEach(c => {
      const why = (c.status === 'expired' || c.status === 'deleted')
        ? `flagged, ${c.status}`
        : 'flagged';
      logDetails.push(`Removed "${c.title}"${c.offerId ? ` (offer ${c.offerId})` : ''} — ${why}`);
    });
  movedCards.forEach(c => {
    logDetails.push(`Moved "${c.title}"${c.offerId ? ` (offer ${c.offerId})` : ''} to Expired group — CTA now reads "${EXPIRED_GROUP_CTA_TEXT}"`);
  });
  if (reordered) {
    if (canReorder) {
      articleCards.forEach((c, i) => {
        if (!toRemove.has(c.index) && !toMoveToExpired.has(c.index) && c.index !== i) {
          logDetails.push(`Moved "${c.title}" from position ${c.index + 1} to ${i + 1}`);
        }
      });
    } else {
      logDetails.push("Order was changed in the tool but NOT applied to the output — cards aren't split cleanly across 1 or 2 recognized #custom-offers-list containers");
    }
  }
  const headTags = Array.from(doc.head.children).map(el => el.tagName.toLowerCase());
  if (headTags.length) {
    logDetails.push(`Preserved ${headTags.length} block(s) parsed into <head> ahead of the body: ${headTags.join(', ')}`);
  }

  logChange('Article', `Regenerated HTML — ${parts.join(', ') || 'no changes'}`, logDetails);
}

// Matches a whole <script type="application/ld+json">…</script> block (any
// attribute order, either quote style) plus the whitespace after it so
// removing it doesn't leave a blank gap at the top of the article.
const JSON_LD_PATTERN = /<script\b[^>]*\btype\s*=\s*(["']?)application\/ld\+json\1[^>]*>[\s\S]*?<\/script\s*>\s*/gi;

function countJsonLdBlocks(html) {
  return (html.match(JSON_LD_PATTERN) || []).length;
}

// Shows the "Remove JSON-LD Script" button only while the loaded HTML
// actually contains one, with a count so it's clear what it will remove.
function updateJsonLdButton() {
  const btn  = document.getElementById('strip-jsonld-btn');
  const note = document.getElementById('strip-jsonld-note');
  const n = countJsonLdBlocks(articleOriginalHTML || '');
  btn.style.display = n ? '' : 'none';
  note.style.display = n ? '' : 'none';
  if (n) {
    btn.textContent = `🧹 Remove JSON-LD Script${n > 1 ? `s (${n})` : ''}`;
    note.textContent = `${n} JSON-LD structured-data block${n !== 1 ? 's' : ''} found in the loaded HTML.`;
  }
}

// A targeted string removal on articleOriginalHTML (not a DOM reserialize),
// same approach as Find & Replace / the iref fix, so nothing else in the
// article gets reformatted. Flags the HTML as modified so Regenerate
// produces output even if no card was flagged or moved.
function stripJsonLd() {
  const n = countJsonLdBlocks(articleOriginalHTML || '');
  if (!n) { showToast('No JSON-LD script found.', true); return; }

  const removed = (articleOriginalHTML.match(JSON_LD_PATTERN) || []);
  articleOriginalHTML = articleOriginalHTML.replace(JSON_LD_PATTERN, '');
  articleHTMLModified = true;

  // A prior regenerate's output still contains the script — hide it rather
  // than leave a stale "final" HTML visible.
  document.getElementById('regen-out-block').style.display = 'none';
  regenHTML = '';

  updateJsonLdButton();
  logChange(
    'Article',
    `Removed ${n} JSON-LD script block${n !== 1 ? 's' : ''} from loaded HTML`,
    removed.map(s => `${s.trim().length} characters, starts: ${s.trim().slice(0, 80)}…`)
  );
  showToast(`Removed ${n} JSON-LD script block${n !== 1 ? 's' : ''}. Click Regenerate for the cleaned HTML.`);
}

function copyRegenHTML() {
  if (!regenHTML) return;
  navigator.clipboard.writeText(regenHTML).then(() => {
    const btn = document.getElementById('regen-copy-btn');
    const orig = btn.textContent;
    btn.textContent = '✓ Copied!';
    setTimeout(() => { btn.textContent = orig; }, 2000);
  });
}

/* ─── Drag to reorder ─── */
let dragSrcIndex = null;

function initDrag() {
  const rows = document.querySelectorAll('#offers-tbody tr[draggable]');
  rows.forEach(row => {
    row.addEventListener('dragstart', e => {
      const idx = parseInt(row.dataset.index);
      if (offers[idx]?.locked) { e.preventDefault(); return; }
      dragSrcIndex = idx;
      row.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
    });
    row.addEventListener('dragend', () => {
      rows.forEach(r => r.classList.remove('dragging', 'drag-over'));
    });
    row.addEventListener('dragover', e => {
      const targetIndex = parseInt(row.dataset.index);
      if (offers[targetIndex]?.locked) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      rows.forEach(r => r.classList.remove('drag-over'));
      row.classList.add('drag-over');
    });
    row.addEventListener('drop', e => {
      e.preventDefault();
      const targetIndex = parseInt(row.dataset.index);
      if (dragSrcIndex === null || dragSrcIndex === targetIndex) return;
      if (offers[targetIndex]?.locked) return;
      const moved = offers.splice(dragSrcIndex, 1)[0];
      offers.splice(targetIndex, 0, moved);
      dragSrcIndex = null;
      renderOffers();
    });
  });
}

/* ─── Daily counter ───
 * Today's deals written and creator picks made, for one author. Replicates the
 * queries the DealNews Offer Creator extension's Offer Manager runs for a saved
 * search filtered on Author / Creator Picks + "Today" — same ET day boundary,
 * same default exclusion of automated (bulk) offers — so the counts here match
 * what those searches show. Deals use the offer's first-publish date; picks use
 * the date the pick itself was made (see fetchPicksTodayCount()). That extension can't be
 * observed directly (Chrome doesn't let one extension script another's pages),
 * so this asks DatoCMS instead. */
const AUTHOR_MODEL_ID = '2041376';
const DATO_CDA = 'https://graphql.datocms.com/';
const COUNT_REFRESH_MS = 5 * 60 * 1000;
let countAuthorId = '';

// Midnight today in America/New_York, as a UTC ISO string. Probes ET's offset
// at noon UTC of today's ET date (4h in EDT, 5h in EST) — same technique as the
// Offer Manager's etDateToUTC(), so DST days line up with its "Today" filter.
function etMidnightTodayISO() {
  const etDate = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const etNoonHour = parseInt(new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: '2-digit', hour12: false,
  }).format(new Date(`${etDate}T12:00:00Z`)), 10);
  return new Date(`${etDate}T${String(12 - etNoonHour).padStart(2, '0')}:00:00Z`).toISOString();
}

async function fetchDealsTodayCount(authorId, sinceISO) {
  const p = new URLSearchParams();
  p.set('filter[type]', 'offer');
  p.set('page[limit]', '1');
  p.set('filter[fields][author][eq]', authorId);
  p.append('filter[fields][curation_level][not_in][]', 'bulk');
  p.append('filter[fields][curation_level][not_in][]', 'verified_bulk');
  p.set('filter[fields][_first_published_at][gte]', sinceISO);
  const res = await fetch(`${DATO}/items?${p}`, { headers: datoHeaders() });
  if (!res.ok) throw new Error(`DatoCMS ${res.status}`);
  const json = await res.json();
  return json.meta?.total_count ?? 0;
}

// GET/POST with a few retries on 429 (DatoCMS rate limit) — the pick-date check
// below can make dozens of version-history requests in one refresh.
async function datoRequest(url, opts, maxRetries = 4) {
  for (let attempt = 0; ; attempt++) {
    const res = await fetch(url, opts);
    if (res.status !== 429 || attempt >= maxRetries) return res;
    const resetMs = parseInt(res.headers.get('x-ratelimit-reset') || '3', 10) * 1000;
    await new Promise(r => setTimeout(r, resetMs + Math.random() * 500));
  }
}

async function datoCdaQuery(query, variables) {
  const res = await datoRequest(DATO_CDA, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + getToken(),
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-Environment': 'main',
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || json?.errors) {
    throw new Error(json?.errors?.[0]?.message || `DatoCMS ${res.status}`);
  }
  return json.data;
}

/* Picks are counted by when the pick was MADE, not when the offer was published
 * (an older offer picked today counts; a pick on a newly published offer made
 * yesterday doesn't). DatoCMS keeps no timestamp on a pick block, so — like the
 * Offer Creator's "pick date" mode — it's read from version history: a pick's
 * date is the oldest version of the offer that holds the block's ID (editing a
 * pick keeps its ID; removing and re-adding one gives it a new ID). A pick made
 * today means the offer was saved today, so `_updatedAt >= since` narrows the
 * candidates before any history is read. */
const PICK_CANDIDATE_PAGE = 500;
const PICK_MAX_CANDIDATES = 1000;
const PICK_HISTORY_CONCURRENCY = 4;

// versions: newest first, each { at: ms, blocks: [block IDs] }. Returns
// { decided, at }: at = when the pick was made if on/after sinceMs, null if it
// predates sinceMs. Undecided means older versions are still needed.
function pickCreatedAt(versions, blockId, sinceMs, exhausted) {
  let last = null;
  for (const v of versions) {
    if (v.blocks.includes(blockId)) {
      if (v.at < sinceMs) return { decided: true, at: null };
      last = v.at;
    } else {
      if (last !== null) return { decided: true, at: last };
      // Not seen yet (e.g. removed in a newer unpublished edit) and already before the cutoff.
      if (v.at < sinceMs) return { decided: true, at: null };
    }
  }
  return exhausted ? { decided: true, at: last } : { decided: false, at: null };
}

// One time per block ID: ms when it was picked, or null if before sinceMs.
async function fetchPickTimes(itemId, blockIds, sinceMs) {
  const versions = [];
  for (let off = 0; ; off += 50) {
    const res = await datoRequest(`${DATO}/items/${itemId}/versions?page[limit]=50&page[offset]=${off}`, { headers: datoHeaders() });
    if (!res.ok) throw new Error(`version history ${res.status}`);
    const json = await res.json();
    const page = (json.data || []).map(v => ({
      at: Date.parse(v.meta?.created_at),
      blocks: Array.isArray(v.attributes?.curators_pick)
        ? v.attributes.curators_pick.map(b => (b && typeof b === 'object') ? b.id : b)
        : [],
    }));
    versions.push(...page);
    const exhausted = page.length < 50;
    const results = blockIds.map(id => pickCreatedAt(versions, id, sinceMs, exhausted));
    if (results.every(r => r.decided)) return results.map(r => r.at);
  }
}

// Block-level filtering (a pick authored by X) is only exposed by the GraphQL
// Content Delivery API, not the CMA's /items filters, so candidates come from
// there and their pick dates from the CMA's version history.
async function fetchPicksTodayCount(authorId, sinceISO) {
  const sinceMs = Date.parse(sinceISO);
  const query = `query PickCandidates($f: OfferModelFilter, $first: IntType, $skip: IntType) {
    allOffers(filter: $f, orderBy: [_updatedAt_DESC], first: $first, skip: $skip) { id curatorsPick { id author { id } } }
    _allOffersMeta(filter: $f) { count }
  }`;
  const f = {
    curatorsPick: { any: { curatorsPick: { author: { eq: authorId } } } },
    curationLevel: { notIn: ['bulk', 'verified_bulk'] },
    _updatedAt: { gte: sinceISO },
  };
  const rows = [];
  for (let skip = 0; skip < PICK_MAX_CANDIDATES; skip += PICK_CANDIDATE_PAGE) {
    const data = await datoCdaQuery(query, { f, first: PICK_CANDIDATE_PAGE, skip });
    const page = data.allOffers || [];
    rows.push(...page);
    if (page.length < PICK_CANDIDATE_PAGE || rows.length >= (data._allOffersMeta?.count ?? 0)) break;
  }

  // Counts offers carrying at least one of this author's picks made today.
  let count = 0, next = 0;
  const worker = async () => {
    while (next < rows.length) {
      const row = rows[next++];
      const blockIds = (row.curatorsPick || []).filter(b => b?.id && b.author?.id === authorId).map(b => b.id);
      if (!blockIds.length) continue;
      const times = await fetchPickTimes(row.id, blockIds, sinceMs);
      if (times.some(t => t !== null && t >= sinceMs)) count++;
    }
  };
  await Promise.all(Array.from({ length: Math.min(PICK_HISTORY_CONCURRENCY, rows.length) }, worker));
  return count;
}

function setCountStat(key, value, error) {
  document.getElementById(`count-${key}`).textContent = error ? '!' : value;
  const stat = document.getElementById(`count-${key}-stat`);
  stat.classList.toggle('err', !!error);
  stat.title = error ? `Couldn't load: ${error}` : '';
}

async function refreshDailyCounts() {
  const updated = document.getElementById('count-updated');
  if (!getToken()) { updated.textContent = 'needs API token'; return; }
  if (!countAuthorId) { updated.textContent = 'choose author ⚙'; return; }

  updated.textContent = 'updating…';
  const since = etMidnightTodayISO();
  // Independent requests: one failing (e.g. a token without GraphQL access)
  // still lets the other count show.
  const [deals, picks] = await Promise.allSettled([
    fetchDealsTodayCount(countAuthorId, since),
    fetchPicksTodayCount(countAuthorId, since),
  ]);
  setCountStat('deals', deals.value, deals.status === 'rejected' && deals.reason.message);
  setCountStat('picks', picks.value, picks.status === 'rejected' && picks.reason.message);
  updated.textContent = new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

async function loadCountAuthors() {
  const select = document.getElementById('count-author');
  if (!getToken()) {
    select.innerHTML = '<option value="">Save an API token first</option>';
    return;
  }
  try {
    const res = await fetch(`${DATO}/items?filter[type]=${AUTHOR_MODEL_ID}&page[limit]=500`, { headers: datoHeaders() });
    if (!res.ok) throw new Error(`DatoCMS ${res.status}`);
    const json = await res.json();
    const authors = (json.data || [])
      .map(i => ({ id: i.id, name: i.attributes?.real_name || i.attributes?.name || '' }))
      .filter(a => a.name)
      .sort((a, b) => a.name.localeCompare(b.name));
    select.innerHTML = '<option value="">— Choose your name —</option>' +
      authors.map(a => `<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('');
    select.value = countAuthorId;
  } catch (e) {
    select.innerHTML = `<option value="">Couldn't load authors (${esc(e.message)})</option>`;
  }
}

function toggleCountSettings() {
  const el = document.getElementById('count-settings');
  const opening = el.style.display === 'none';
  el.style.display = opening ? '' : 'none';
  if (opening) loadCountAuthors();
}

function initDailyCounter() {
  document.getElementById('count-refresh-btn').addEventListener('click', refreshDailyCounts);
  document.getElementById('count-settings-btn').addEventListener('click', toggleCountSettings);
  document.getElementById('count-author').addEventListener('change', e => {
    countAuthorId = e.target.value;
    chrome.storage.sync.set({ countAuthorId });
    if (countAuthorId) document.getElementById('count-settings').style.display = 'none';
    refreshDailyCounts();
  });
  // A token saved/changed in the token bar should take effect without a reopen.
  document.getElementById('token-input').addEventListener('change', refreshDailyCounts);
  // Catch up immediately when the panel comes back into view, rather than
  // waiting out the rest of the interval.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) refreshDailyCounts();
  });

  // initToken() fills the token input from its own async storage read; read the
  // token here too and fill it ourselves rather than depend on callback order.
  chrome.storage.sync.get(['countAuthorId', 'datoToken'], r => {
    const tokenInput = document.getElementById('token-input');
    if (r.datoToken && !tokenInput.value) tokenInput.value = r.datoToken;
    countAuthorId = r.countAuthorId || '';
    if (!countAuthorId && r.datoToken) toggleCountSettings();
    refreshDailyCounts();
  });
  setInterval(() => {
    if (!document.hidden) refreshDailyCounts();
  }, COUNT_REFRESH_MS);
}

/* ─── Update check ───
 * Compares the installed version against manifest.json on GitHub's main
 * branch and shows a banner when main is ahead — this extension is loaded
 * unpacked, so Chrome never updates it on its own and people otherwise drift
 * onto old versions. Reads raw.githubusercontent.com directly (it sends
 * Access-Control-Allow-Origin: *, so no extra host permission is needed).
 * Cached 6 hours in chrome.storage.local so reopening the panel doesn't
 * re-fetch every time. A failed fetch (offline, repo made private again)
 * just means no banner. */
const UPDATE_MANIFEST_URL = 'https://raw.githubusercontent.com/jramhold514/dealnews-blog-card-extension/main/manifest.json';
// The newest code as a zip, for people who installed from a download instead of git clone.
const UPDATE_ZIP_URL = 'https://github.com/jramhold514/dealnews-blog-card-extension/archive/refs/heads/main.zip';
const UPDATE_CHECK_INTERVAL_MS = 6 * 60 * 60 * 1000;
const VERSION_PATTERN = /^\d+\.\d+\.\d+$/;

// > 0 when a is newer than b.
function compareVersions(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

async function checkForUpdate() {
  const installed = chrome.runtime.getManifest().version;
  const stored = await chrome.storage.local.get(['updateCheck', 'updateDismissed']);
  let latest = stored.updateCheck?.latest || null;

  const stale = !stored.updateCheck || Date.now() - stored.updateCheck.checkedAt > UPDATE_CHECK_INTERVAL_MS;
  if (stale) {
    try {
      const res = await fetch(UPDATE_MANIFEST_URL, { cache: 'no-store' });
      if (res.ok) {
        const version = (await res.json()).version;
        // The remote file is untrusted data — only accept a plain x.y.z.
        if (typeof version === 'string' && VERSION_PATTERN.test(version)) latest = version;
      }
    } catch { /* offline or unreachable — keep whatever we had */ }
    // Recorded even on failure so a broken fetch isn't retried on every open.
    chrome.storage.local.set({ updateCheck: { checkedAt: Date.now(), latest } });
  }

  const banner = document.getElementById('update-banner');
  const show = latest && VERSION_PATTERN.test(installed) && compareVersions(latest, installed) > 0
    && stored.updateDismissed !== latest;
  if (!show) { banner.style.display = 'none'; return; }

  const text = document.getElementById('update-banner-text');
  text.textContent = '';
  text.append(
    `Update available: ${latest} (you have ${installed}). Installed with git? In the extension folder run `,
    Object.assign(document.createElement('code'), { textContent: 'git pull' }),
    '. Installed from a zip? ',
    Object.assign(document.createElement('a'), { textContent: 'Download the new zip', href: UPDATE_ZIP_URL, target: '_blank', rel: 'noopener' }),
    ' and copy its files over the same folder. Then reload the extension at chrome://extensions and reopen this panel.'
  );
  banner.dataset.latest = latest;
  banner.style.display = '';
}

function initUpdateCheck() {
  document.getElementById('update-banner-dismiss').addEventListener('click', () => {
    const banner = document.getElementById('update-banner');
    chrome.storage.local.set({ updateDismissed: banner.dataset.latest });
    banner.style.display = 'none';
  });
  checkForUpdate();
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) checkForUpdate();
  });
}

/* ─── Blog Content ID auto-detect ───
 * The CMS article edit page carries the article's ID in its URL
 * (secure.dealnews.com/admin/phews/features/article/?article_id=2218015), and
 * that same ID is what data-iref needs as the Blog Content ID. The sidebar
 * can read the active tab's URL directly (the "tabs" permission), so no
 * content-script change is needed. Only the `article_id` param on
 * secure.dealnews.com is trusted, and only when it's all digits — a wrong
 * auto-fill would mis-tag every card, which is worse than leaving it blank.
 *
 * Switching to a different article always replaces the field (the old value
 * belonged to the previous article); on the same article a manual edit is
 * respected and not overwritten. Nothing happens on non-article tabs, so a
 * value you typed stays put. */
let lastDetectedBlogId = null;
let blogIdEditedByUser = false;

function articleIdFromUrl(url) {
  try {
    const u = new URL(url);
    if (u.hostname !== 'secure.dealnews.com') return null;
    const id = u.searchParams.get('article_id');
    return id && /^\d+$/.test(id) ? id : null;
  } catch { return null; }
}

function updateBlogIdSourceLabel() {
  const label = document.getElementById('blog-id-source');
  const value = document.getElementById('blog-content-id').value.trim();
  if (value && value === lastDetectedBlogId) {
    label.textContent = '✓ from page URL';
    label.className = 'blog-id-source ok';
  } else {
    label.textContent = value ? 'entered manually' : '';
    label.className = 'blog-id-source';
  }
}

function applyDetectedBlogId(url) {
  const id = articleIdFromUrl(url);
  if (!id) return;
  if (id === lastDetectedBlogId && blogIdEditedByUser) return;
  lastDetectedBlogId = id;
  blogIdEditedByUser = false;
  const input = document.getElementById('blog-content-id');
  if (input.value.trim() !== id) {
    input.value = id;
    renderHTMLOut(); // refreshes the "missing Blog Content ID" warning if that view is showing
  }
  updateBlogIdSourceLabel();
}

function refreshBlogIdFromActiveTab() {
  chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
    if (tabs && tabs[0] && tabs[0].url) applyDetectedBlogId(tabs[0].url);
  });
}

function initBlogIdDetection() {
  document.getElementById('blog-content-id').addEventListener('input', () => {
    blogIdEditedByUser = true;
    updateBlogIdSourceLabel();
  });
  refreshBlogIdFromActiveTab();
  chrome.tabs.onActivated.addListener(refreshBlogIdFromActiveTab);
  chrome.tabs.onUpdated.addListener((_id, changeInfo, tab) => {
    if (tab.active && (changeInfo.url || changeInfo.status === 'complete')) refreshBlogIdFromActiveTab();
  });
}

/* ─── Utilities ─── */
// A non-breaking space (CMS text has them) is written as &nbsp;, which is how a
// browser re-serializes it, so a card written here is still found verbatim in
// the article source by locateCardHTMLSpan().
const NBSP_PATTERN = new RegExp(String.fromCharCode(160), 'g');

function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(NBSP_PATTERN, '&nbsp;');
}

// For text between tags. Leaves quotation marks alone, which is how a browser
// re-serializes text, so a card written with this can be found verbatim in the
// article source by locateCardHTMLSpan() (the Article tab's in-place edits) even
// when its text contains quotes. Use esc() for attribute values.
function escText(str) {
  if (!str) return '';
  return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(NBSP_PATTERN, '&nbsp;');
}

/* ─── Links tab: monetized links through the magic URL service ───
 * One link = a landing address run through the magic URL service (magic-link.js),
 * then written out as the <a> the CMS expects. The tokens live in
 * chrome.storage.local (this browser only, never synced, never written into
 * generated output). Anything the service cannot monetize is flagged, not guessed. */
let linksRows = [];   // [{ text, url, button, selection, res, tag }]

function linksSettings() {
  return {
    token: document.getElementById('links-token').value.trim(),
    email: document.getElementById('links-email').value.trim(),
  };
}

function updateLinksStatus() {
  const s = linksSettings(), st = document.getElementById('links-status');
  const ok = !!(s.token && s.email && getToken());
  st.textContent = ok ? '✓ ready' : (!getToken() ? 'needs DatoCMS token above' : '—');
  st.className = ok ? 'token-status ok' : 'token-status';
}

// "Use Promo Code / https://example.com/" or just "https://example.com/".
function parseLinkLine(line) {
  const t = line.trim();
  if (!t) return null;
  const m = t.match(/^(.*?)\s+\/\s+(\S+)$/);
  if (m) return { text: m[1].trim(), url: m[2] };
  return { text: '', url: t };
}

function linkRowTag(row) {
  const r = row.res;
  if (!r || !r.ok) return '';
  const text = row.text || r.vendorName || r.landing;
  return DNMagic.buildTag({ href: r.href, vendor: r.vendorLegacyId, landing: r.landing, info: r.info, text, button: row.button });
}

async function resolveLinkRow(row) {
  const s = linksSettings();
  row.res = await DNMagic.resolveLink({ url: row.url, token: s.token, email: s.email, datoToken: getToken(), selection: row.selection });
  row.tag = linkRowTag(row);
}

function renderLinks() {
  const box = document.getElementById('links-results');
  box.textContent = '';
  linksRows.forEach((row, i) => {
    const r = row.res;
    const card = document.createElement('div');
    card.className = 'proc-card links-row' + (r && r.ok ? ' ok' : (r ? ' bad' : ''));

    const head = document.createElement('div');
    head.className = 'links-row-head';
    head.textContent = (row.text ? row.text + ' → ' : '') + row.url;
    card.appendChild(head);

    if (!r) {
      const p = document.createElement('div'); p.className = 'links-note'; p.textContent = 'Working…'; card.appendChild(p);
    } else {
      (r.flags || []).forEach(f => {
        const d = document.createElement('div');
        d.className = 'links-flag ' + f.level;
        d.textContent = (f.level === 'stop' ? 'Stopped: ' : 'Note: ') + f.msg;
        card.appendChild(d);
      });
      if (r.options && r.options.length > 1) {
        const sel = document.createElement('select');
        sel.className = 'links-program';
        sel.dataset.index = String(i);
        r.options.forEach(o => {
          const op = document.createElement('option');
          op.value = String(o.value); op.textContent = o.clean || o.label;
          if (String(o.value) === String(r.selection)) op.selected = true;
          sel.appendChild(op);
        });
        const lab = document.createElement('label'); lab.className = 'links-note'; lab.textContent = 'Program: ';
        lab.appendChild(sel);
        card.appendChild(lab);
      }
      if (r.ok) {
        const meta = document.createElement('div');
        meta.className = 'links-note';
        meta.textContent = (r.vendorName || 'Vendor') + ' (' + r.vendorLegacyId + ') · ' + r.info;
        card.appendChild(meta);
        const ta = document.createElement('textarea');
        ta.readOnly = true; ta.rows = 3; ta.value = row.tag;
        card.appendChild(ta);
        const b = document.createElement('button');
        b.className = 'small'; b.textContent = 'Copy tag'; b.dataset.copy = String(i);
        card.appendChild(b);
      }
    }
    box.appendChild(card);
  });
  const okCount = linksRows.filter(r => r.res && r.res.ok).length;
  document.getElementById('links-copyall-btn').style.display = okCount ? '' : 'none';
}

async function makeLinks() {
  const s = linksSettings();
  if (!s.token || !s.email) { showToast('Add the magic URL token and your email first.', true); return; }
  if (!getToken()) { showToast('Add the DatoCMS token in the bar above first (it looks up the vendor).', true); return; }
  const asButton = document.getElementById('links-button').checked;
  const parsed = document.getElementById('links-input').value.split('\n').map(parseLinkLine).filter(Boolean);
  if (!parsed.length) { showToast('Nothing to make: add at least one address.', true); return; }
  linksRows = parsed.map(p => ({ text: p.text, url: p.url, button: asButton, selection: null, res: null, tag: '' }));
  renderLinks();
  const btn = document.getElementById('links-make-btn');
  btn.disabled = true;
  try {
    // Three at a time, so a long list does not hammer the service.
    let next = 0;
    const worker = async () => {
      while (next < linksRows.length) {
        const row = linksRows[next++];
        try { await resolveLinkRow(row); }
        catch (e) { row.res = { ok: false, flags: [{ code: 'service', level: 'stop', msg: e.message }], options: [] }; }
        renderLinks();
      }
    };
    await Promise.all([worker(), worker(), worker()]);
  } finally { btn.disabled = false; }
  const ok = linksRows.filter(r => r.res && r.res.ok).length;
  logChange('Links', `Made ${ok} of ${linksRows.length} monetized link${linksRows.length === 1 ? '' : 's'}`,
    linksRows.map(r => (r.res && r.res.ok ? 'OK: ' : 'Flagged: ') + r.url));
}

async function copyText(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch (e) { return false; }
}

function initLinks() {
  const tok = document.getElementById('links-token');
  const em  = document.getElementById('links-email');
  chrome.storage.local.get(['magicToken', 'magicEmail'], r => {
    if (r.magicToken) tok.value = r.magicToken;
    if (r.magicEmail) em.value = r.magicEmail;
    updateLinksStatus();
  });
  tok.addEventListener('change', () => { chrome.storage.local.set({ magicToken: tok.value.trim() }); updateLinksStatus(); });
  em.addEventListener('change',  () => { chrome.storage.local.set({ magicEmail: em.value.trim() }); updateLinksStatus(); });
  document.getElementById('token-input').addEventListener('change', updateLinksStatus);
  document.getElementById('links-make-btn').addEventListener('click', makeLinks);
  document.getElementById('links-clear-btn').addEventListener('click', () => {
    document.getElementById('links-input').value = '';
    linksRows = []; renderLinks();
  });
  document.getElementById('links-copyall-btn').addEventListener('click', async () => {
    const all = linksRows.filter(r => r.res && r.res.ok).map(r => r.tag).join('\n');
    showToast(all && await copyText(all) ? 'Copied all tags.' : 'Copy failed.', !all);
  });
  document.getElementById('links-results').addEventListener('click', async e => {
    const b = e.target.closest('button[data-copy]');
    if (!b) return;
    const row = linksRows[Number(b.dataset.copy)];
    showToast(row && await copyText(row.tag) ? 'Copied the tag.' : 'Copy failed.', !(row && row.tag));
  });
  document.getElementById('links-results').addEventListener('change', async e => {
    const sel = e.target.closest('select.links-program');
    if (!sel) return;
    const row = linksRows[Number(sel.dataset.index)];
    row.selection = sel.value; row.res = null; renderLinks();
    try { await resolveLinkRow(row); } catch (err) { row.res = { ok: false, flags: [{ code: 'service', level: 'stop', msg: err.message }], options: [] }; }
    renderLinks();
  });
}

/* ─── Wire up all event listeners ─── */
document.addEventListener('DOMContentLoaded', () => {

  // Theme — restore from storage, then wire button
  chrome.storage.sync.get(['theme'], result => {
    const isDark = result.theme === 'dark';
    if (isDark) document.documentElement.setAttribute('data-theme', 'dark');
    setThemeIcon(isDark);
  });
  document.getElementById('theme-btn').addEventListener('click', toggleTheme);

  // Change Log
  renderChangeLog();
  document.getElementById('change-log-toggle').addEventListener('click', toggleChangeLog);
  document.getElementById('change-log-clear').addEventListener('click', clearChangeLog);

  // Token + persisted settings
  initToken();
  initLinks();
  initUpdateCheck();
  initBlogIdDetection();
  initDailyCounter();
  initOptions();
  const selectorInput = document.getElementById('editor-selector');
  chrome.storage.sync.get(['editorSelector'], r => {
    if (r.editorSelector) selectorInput.value = r.editorSelector;
  });
  selectorInput.addEventListener('change', () => {
    chrome.storage.sync.set({ editorSelector: selectorInput.value.trim() });
  });

  // Tabs
  document.querySelectorAll('.tab[data-tab]').forEach(btn => {
    btn.addEventListener('click', () => setTab(btn.dataset.tab));
  });
  document.querySelectorAll('.subtab[data-subtab]').forEach(btn => {
    btn.addEventListener('click', () => setSubTab(btn.dataset.subtab));
  });

  // Configure
  document.getElementById('add-btn').addEventListener('click', addOfferById);
  document.getElementById('id-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') addOfferById();
  });
  // Configure → Find offers
  document.getElementById('find-btn').addEventListener('click', () => runFind(false));
  document.getElementById('find-more').addEventListener('click', () => runFind(true));
  ['find-text', 'find-creator', 'find-category', 'find-facet', 'find-vendor'].forEach(id => {
    document.getElementById(id).addEventListener('keydown', e => { if (e.key === 'Enter') runFind(false); });
  });
  document.getElementById('find-sort').addEventListener('change', () => {
    // hotness is also sent to the API, so changing to or from it with more pages unloaded needs a fresh search
    if (findState.items.length && findState.remaining > 0 && (findState.sortSent === 'hot') !== (document.getElementById('find-sort').value === 'hot')) runFind(false);
    else renderFindResults();
  });
  document.getElementById('find-expired').addEventListener('change', () => { if (findState.items.length) runFind(false); });
  document.getElementById('find-all-btn').addEventListener('click',  () => findSelectAll(true));
  document.getElementById('find-none-btn').addEventListener('click', () => findSelectAll(false));
  document.getElementById('find-add-btn').addEventListener('click', findAddSelected);
  document.getElementById('find-ids-copy').addEventListener('click', findCopyIds);
  document.getElementById('find-html-btn').addEventListener('click', findExportHtml);
  document.getElementById('find-ids-out').addEventListener('focus', e => e.target.select());
  document.getElementById('sort-asc-btn').addEventListener('click',  () => sortOffers('asc'));
  document.getElementById('sort-desc-btn').addEventListener('click', () => sortOffers('desc'));
  document.getElementById('sort-auto-btn').addEventListener('click', () => sortOffers('auto'));
  document.getElementById('remove-all-btn').addEventListener('click', removeAllOffers);
  document.getElementById('layout-grid-btn').addEventListener('click', () => setCardLayout('grid'));
  document.getElementById('layout-vertical-btn').addEventListener('click', () => setCardLayout('vertical'));
  document.getElementById('style-standard-btn').addEventListener('click', () => setCardStyle('standard'));
  document.getElementById('style-classic-btn').addEventListener('click', () => setCardStyle('classic'));
  document.getElementById('style-compact-btn').addEventListener('click', () => setCardStyle('compact'));
  document.getElementById('style-pick-btn').addEventListener('click', () => setCardStyle('pick'));
  document.getElementById('style-table-btn').addEventListener('click', () => setCardStyle('table'));
  document.getElementById('details-on-btn').addEventListener('click', () => setShowDetails(true));
  document.getElementById('details-off-btn').addEventListener('click', () => setShowDetails(false));
  document.getElementById('cp-bar-on-btn').addEventListener('click', () => setCpBar(true));
  document.getElementById('cp-bar-off-btn').addEventListener('click', () => setCpBar(false));
  document.getElementById('end-on-btn').addEventListener('click', () => setShowEndDates(true));
  document.getElementById('end-off-btn').addEventListener('click', () => setShowEndDates(false));
  document.getElementById('was-on-btn').addEventListener('click', () => setShowWasPrice(true));
  document.getElementById('was-off-btn').addEventListener('click', () => setShowWasPrice(false));
  document.getElementById('meta-on-btn').addEventListener('click', () => setShowMetaLine(true));
  document.getElementById('meta-off-btn').addEventListener('click', () => setShowMetaLine(false));
  document.getElementById('resize-on-btn').addEventListener('click', () => setResizeImages(true));
  document.getElementById('resize-off-btn').addEventListener('click', () => setResizeImages(false));
  document.getElementById('remember-on-btn').addEventListener('click', () => setRememberOptions(true));
  document.getElementById('remember-off-btn').addEventListener('click', () => setRememberOptions(false));
  document.getElementById('options-reset-btn').addEventListener('click', resetOptions);
  document.getElementById('trim-on-btn').addEventListener('click', () => setTrimLong(true));
  document.getElementById('trim-off-btn').addEventListener('click', () => setTrimLong(false));
  document.getElementById('images-on-btn').addEventListener('click', () => setShowImages(true));
  document.getElementById('images-off-btn').addEventListener('click', () => setShowImages(false));

  // Offers table — event delegation
  const tbody = document.getElementById('offers-tbody');
  tbody.addEventListener('click', e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    if (btn.dataset.action === 'remove') removeOffer(btn.dataset.id);
    if (btn.dataset.action === 'lock')   toggleLock(btn.dataset.id);
    if (btn.dataset.action === 'edit-desc') toggleDescEditor(btn.dataset.id);
    if (btn.dataset.action === 'toggle-end') toggleHideEnd(btn.dataset.id);
    if (btn.dataset.action === 'remove-desc-block') removeDescBlock(btn.dataset.id, parseInt(btn.dataset.block, 10));
    if (btn.dataset.action === 'restore-desc') restoreDescription(btn.dataset.id);
  });
  tbody.addEventListener('input', e => {
    if (e.target.matches('.code-input')) updateCode(e.target.dataset.id, e.target.value);
    else if (e.target.matches('.cta-input')) updateCTA(e.target.dataset.id, e.target.value);
  });
  tbody.addEventListener('keydown', e => {
    if (e.target.matches('.pos-input') && e.key === 'Enter') {
      moveOffer(e.target.dataset.id, e.target.value);
      e.target.blur();
    }
  });
  tbody.addEventListener('blur', e => {
    if (e.target.matches('.pos-input')) moveOffer(e.target.dataset.id, e.target.value);
  }, true);

  // Preview — event delegation for remove buttons
  document.getElementById('cards-container').addEventListener('click', e => {
    const btn = e.target.closest('[data-action="remove"]');
    if (btn) { removeOffer(btn.dataset.id); renderPreview(); }
  });

  // HTML Output
  document.getElementById('copy-btn').addEventListener('click',   copyHTML);
  document.getElementById('copy-btn-2').addEventListener('click', copyHTML);
  document.getElementById('view-html-btn').addEventListener('click', () => setSubTab('html'));

  // Deal Processor
  document.getElementById('proc-process-btn').addEventListener('click', processHTML);
  document.getElementById('proc-clear-btn').addEventListener('click',   clearProcessor);
  document.getElementById('proc-copyBtn').addEventListener('click',     copyProcessorOutput);

  // Article
  document.getElementById('diag-btn').addEventListener('click', async () => {
    const spinner = document.getElementById('diag-spinner');
    const out     = document.getElementById('diag-out');
    spinner.style.display = 'inline-block';
    out.style.display = 'none';
    try {
      const result = await sendToContentScript({ type: 'GET_DIAGNOSTICS' });
      out.textContent = JSON.stringify(result, null, 2);
      out.style.display = 'block';
    } catch (e) {
      out.textContent = 'Error: ' + e.message;
      out.style.display = 'block';
    } finally {
      spinner.style.display = 'none';
    }
  });

  document.getElementById('load-page-btn').addEventListener('click',    loadFromPage);
  document.getElementById('manual-toggle-btn').addEventListener('click', toggleManualMode);
  document.getElementById('parse-manual-btn').addEventListener('click',  parseManualHTML);
  document.getElementById('cancel-manual-btn').addEventListener('click', cancelManualMode);
  document.getElementById('check-exp-btn').addEventListener('click',    checkAllExpirations);
  document.getElementById('flag-expired-btn').addEventListener('click', flagExpired);
  document.getElementById('flag-all-btn').addEventListener('click',     () => setAllFlags(true));
  document.getElementById('flag-all-except-kept-btn').addEventListener('click', flagAllExceptKept);
  document.getElementById('unflag-all-btn').addEventListener('click',   () => setAllFlags(false));
  document.getElementById('move-all-expired-btn').addEventListener('click', moveAllExpiredToGroup);
  document.getElementById('fix-all-iref-btn').addEventListener('click', fixAllIrefIssues);
  document.getElementById('article-preview-toggle').addEventListener('click', toggleArticlePreview);
  document.getElementById('find-replace-btn').addEventListener('click', previewArticleFindMatches);
  document.getElementById('find-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') previewArticleFindMatches();
  });
  document.getElementById('replace-input').addEventListener('keydown', e => {
    if (e.key === 'Enter') previewArticleFindMatches();
  });
  // The find term or case-sensitivity changing invalidates any matches
  // already shown — their offsets/text were computed against the old term,
  // so force a fresh "Find Matches" click rather than let a stale list be
  // applied under a since-changed search.
  document.getElementById('find-input').addEventListener('input', clearFindMatchesPreview);
  document.getElementById('find-case-sensitive').addEventListener('change', clearFindMatchesPreview);
  document.getElementById('find-apply-btn').addEventListener('click', applySelectedFindReplacements);
  document.getElementById('find-matches-select-all').addEventListener('click', () => {
    findMatches.forEach(m => { m.selected = true; });
    renderFindMatchesList();
  });
  document.getElementById('find-matches-select-none').addEventListener('click', () => {
    findMatches.forEach(m => { m.selected = false; });
    renderFindMatchesList();
  });
  document.getElementById('find-matches-list').addEventListener('change', e => {
    const cb = e.target.closest('.find-match-checkbox');
    if (!cb) return;
    findMatches[parseInt(cb.dataset.index)].selected = cb.checked;
    updateFindMatchesCounter();
  });
  document.getElementById('regen-btn').addEventListener('click',        removeAndRegenerate);
  document.getElementById('strip-jsonld-btn').addEventListener('click', stripJsonLd);
  document.getElementById('regen-copy-btn').addEventListener('click',   copyRegenHTML);

  // Article card list — event delegation for flag buttons and reorder input
  const articleCardList = document.getElementById('article-card-list');
  articleCardList.addEventListener('click', e => {
    const btn = e.target.closest('.flag-btn');
    if (btn) { toggleFlag(parseInt(btn.dataset.index)); return; }
    const moveBtn = e.target.closest('.expire-move-btn');
    if (moveBtn) toggleMoveToExpiredGroup(parseInt(moveBtn.dataset.index));
  });
  articleCardList.addEventListener('keydown', e => {
    if (e.target.matches('.pos-input') && e.key === 'Enter') {
      moveArticleCard(parseInt(e.target.dataset.cardIndex), e.target.value);
      e.target.blur();
    }
  });
  articleCardList.addEventListener('blur', e => {
    if (e.target.matches('.pos-input')) moveArticleCard(parseInt(e.target.dataset.cardIndex), e.target.value);
  }, true);

  // Article visual preview — event delegation for its own flag/remove and
  // fix-iref buttons
  document.getElementById('article-preview-container').addEventListener('click', e => {
    const flagBtn = e.target.closest('[data-action="toggle-flag"]');
    if (flagBtn) { toggleFlag(parseInt(flagBtn.dataset.index)); return; }
    const moveBtn = e.target.closest('[data-action="move-to-expired"]');
    if (moveBtn) { toggleMoveToExpiredGroup(parseInt(moveBtn.dataset.index)); return; }
    const fixBtn = e.target.closest('[data-action="fix-iref"]');
    if (fixBtn) applyIrefFix(parseInt(fixBtn.dataset.index));
  });
});
