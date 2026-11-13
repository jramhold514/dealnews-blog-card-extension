/* ─── Constants ─── */
const DATO = 'https://site-api.datocms.com';
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
let cardStyle  = 'standard'; // 'standard' | 'compact' (experimental) — see generateHTML()
let showImages = true;       // false drops each card's image column entirely — see generateHTML()
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
  ['configure', 'processor', 'article'].forEach(t => {
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
// text goes through esc() so this is safe to insert directly (no additional
// escaping at the call site); only node types this function itself emits are
// trusted as real tags. itemLink (a link to another DatoCMS record) is
// rendered as plain text rather than a real <a> — resolving its target URL
// would need an extra fetch per link, which isn't worth it for what's likely
// a rare case in offer copy.
function dastNodeToHTML(node) {
  if (!node) return '';

  if (node.type === 'span') {
    let text = esc(node.value || '');
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

  const [imageUrl, vendorLegacyId] = await Promise.all([
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
    (async () => {
      if (!vendorDatoId) return '0';
      try {
        const vRes = await fetch(`${DATO}/items/${vendorDatoId}`, { headers });
        if (!vRes.ok) return '0';
        const vJson = await vRes.json();
        return String(vJson.data?.attributes?.legacy_id ?? '0');
      } catch { return '0'; }
    })(),
  ]);

  return { id, title, callout, landingUrl, monetizedUrl, vendor: vendorLegacyId, valueStatement, imageUrl, legacyId };
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
  return `<tr class="desc-row"><td colspan="8">${rows}${restore}</td></tr>`;
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

function setCardLayout(layout) {
  cardLayout = layout;
  ['layout-grid-btn', 'layout-vertical-btn'].forEach(id =>
    document.getElementById(id).classList.remove('active')
  );
  document.getElementById('layout-' + layout + '-btn').classList.add('active');
  renderPreview();
  renderHTMLOut();
}

// Both toggles only change how generateHTML()/renderPreview() render the
// existing `offers` — nothing about the offers list itself is touched, so
// flipping back and forth never loses setup work.
function setCardStyle(style) {
  cardStyle = style;
  ['standard', 'compact'].forEach(k =>
    document.getElementById('style-' + k + '-btn').classList.toggle('active', k === style)
  );
  renderPreview();
  renderHTMLOut();
}

function setShowImages(on) {
  showImages = on;
  document.getElementById('images-on-btn').classList.toggle('active', on);
  document.getElementById('images-off-btn').classList.toggle('active', !on);
  renderPreview();
  renderHTMLOut();
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

  tbody.innerHTML = offers.map((o, i) => `
    <tr draggable="${!o.locked}" data-index="${i}" class="${o.locked ? 'row-locked' : ''}">
      <td><span class="drag-handle" title="${o.locked ? 'Unlock to reorder' : 'Drag to reorder'}">⠿</span></td>
      <td style="text-align:center;">
        <input class="pos-input" type="number" min="1" max="${offers.length}"
          value="${i + 1}" data-id="${o.id}" ${o.locked ? 'disabled' : ''} />
      </td>
      <td class="cell-trunc">${esc(o.title)}</td>
      <td class="cell-muted" style="font-size:11px;">${esc(o.callout)}</td>
      <td><input class="cta-input" value="${esc(o.ctaText || 'Buy Now')}" data-id="${o.id}" /></td>
      <td><button class="lock-btn ${o.locked ? 'locked' : ''}" data-action="lock" data-id="${o.id}"
            title="${o.locked ? 'Unlock position' : 'Lock position'}">${o.locked ? '🔒' : '🔓'}</button></td>
      <td><button class="lock-btn ${o.editingDesc || o.valueStatementOriginal !== undefined ? 'locked' : ''}" data-action="edit-desc" data-id="${o.id}"
            title="Edit description — remove parts of it">✂</button></td>
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

  container.innerHTML = offers.map(o => {
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
            <a href="${esc(url)}" target="_blank" class="card-cta">${esc(o.ctaText || 'Buy Now')}</a>
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
    !(h3 && h3.contains(a)) && a !== button && !a.closest('.bu-content')
  ) || null;
  return { image, title, button };
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

function analyzeIrefTags(imageLinkEl, titleLinkEl, ctaLinkEl) {
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

function generateHTML() {
  const blogContentId = document.getElementById('blog-content-id').value.trim();
  const cards = offers.map(o => {
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
    const ctaBlock = `              <div class="bu-content bu-ml-0 ${cardStyle === 'compact' ? 'bu-mb-4' : 'bu-mb-0'} bu-is-flex-touch bu-is-justify-content-center">
                <a class="btn btn-cta bu-m-0" href="${href}" landing_url="${landing}" vendor="${v}" brand="0" category="0" title="${t}"${irefButton}>${o.ctaText || 'Buy Now'}</a>
              </div>`;
    // Standard: headline, then callout on its own line, description, button.
    // Compact (experimental): callout folds into the headline link as one
    // line ("Title for $33") at a fixed size matching dealnews.com's own deal
    // card headlines, and the button moves up into the callout's old slot.
    // The callout span keeps the .content-call-out class so the Article tab
    // can still find it, but resets font/color — that class (and .price)
    // carry large, green, condensed-font styling on the live site.
    const textBlocks = cardStyle === 'compact'
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
  }).join('\n');
  // Grid mode wraps cards in Bulma-style columns for a multi-column layout on the
  // live site; vertical mode omits those classes so each full-width .bu-card just
  // stacks in normal block flow, one per row.
  const containerClass = cardLayout === 'vertical'
    ? 'bu-vertical-offers'
    : 'bu-columns bu-is-multiline bu-is-3';
  return `<div id="custom-offers-list" class="${containerClass}">\n${cards}\n    </div>`;
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
  matches.forEach(el => { el.textContent = newText; });
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
    const descEl = el.querySelector('.bu-content.bu-is-flex-grow-1') || el.querySelector('.bu-content') || el.querySelector('p');
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
    const { missing: irefMissing, mismatched: irefMismatched } = analyzeIrefTags(links.image, links.title, links.button);
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
    const descEl = el.querySelector('.bu-content.bu-is-flex-grow-1') || el.querySelector('.bu-content') || el.querySelector('p');
    const links = findCardLinks(el);

    card.title = h3 ? cardTitleText(h3) : card.title;
    card.landingUrl = firstLink ? (firstLink.getAttribute('landing_url') || firstLink.href || '') : card.landingUrl;
    card.offerId = el.getAttribute('data-offer-id') || null;
    card.ctaText = ctaEl ? ctaEl.textContent.trim() : card.ctaText;
    card.imageUrl = imgEl ? imgEl.getAttribute('src') : card.imageUrl;
    card.callout = priceEl ? cardCalloutText(priceEl) : card.callout;
    card.valueStatement = descEl ? descEl.textContent.trim() : card.valueStatement;
    card.keepDespiteExpired = EXPIRED_CTA_PATTERN.test(card.ctaText);
    const { missing, mismatched } = analyzeIrefTags(links.image, links.title, links.button);
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
      const el = linkEls[type];
      if (!el) return; // the link itself doesn't exist on this card — nothing to tag
      el.setAttribute('data-iref', irefValue(blogContentId, card.legacyId, type));
      // Cards generated by a previous version of this tool may still carry
      // the old, wrong attribute name (see buildDataIref()'s comment) —
      // clean it up here since we're already touching this exact link.
      el.removeAttribute('iref-append');
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
    if (ctaEl) ctaEl.textContent = EXPIRED_GROUP_CTA_TEXT;
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
 * search filtered on Author / Creator Picks + "Today" — same publish-date field,
 * same ET day boundary, same default exclusion of automated (bulk) offers — so
 * the counts here match what those searches show. That extension can't be
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

// Block-level filtering (a pick authored by X) is only exposed by the GraphQL
// Content Delivery API, not the CMA's /items filters.
async function fetchPicksTodayCount(authorId, sinceISO) {
  const query = `query PicksToday($f: OfferModelFilter) { _allOffersMeta(filter: $f) { count } }`;
  const f = {
    curatorsPick: { any: { curatorsPick: { author: { eq: authorId } } } },
    curationLevel: { notIn: ['bulk', 'verified_bulk'] },
    _firstPublishedAt: { gte: sinceISO },
  };
  const res = await fetch(DATO_CDA, {
    method: 'POST',
    headers: {
      'Authorization': 'Bearer ' + getToken(),
      'Content-Type': 'application/json',
      'Accept': 'application/json',
      'X-Environment': 'main',
    },
    body: JSON.stringify({ query, variables: { f } }),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || json?.errors) {
    throw new Error(json?.errors?.[0]?.message || `DatoCMS ${res.status}`);
  }
  return json.data?._allOffersMeta?.count ?? 0;
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
    `Update available: ${latest} (you have ${installed}). In the extension folder run `,
    Object.assign(document.createElement('code'), { textContent: 'git pull' }),
    ', then reload it at chrome://extensions and reopen this panel.'
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
function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
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
  initUpdateCheck();
  initBlogIdDetection();
  initDailyCounter();
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
  document.getElementById('sort-asc-btn').addEventListener('click',  () => sortOffers('asc'));
  document.getElementById('sort-desc-btn').addEventListener('click', () => sortOffers('desc'));
  document.getElementById('sort-auto-btn').addEventListener('click', () => sortOffers('auto'));
  document.getElementById('remove-all-btn').addEventListener('click', removeAllOffers);
  document.getElementById('layout-grid-btn').addEventListener('click', () => setCardLayout('grid'));
  document.getElementById('layout-vertical-btn').addEventListener('click', () => setCardLayout('vertical'));
  document.getElementById('style-standard-btn').addEventListener('click', () => setCardStyle('standard'));
  document.getElementById('style-compact-btn').addEventListener('click', () => setCardStyle('compact'));
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
    if (btn.dataset.action === 'remove-desc-block') removeDescBlock(btn.dataset.id, parseInt(btn.dataset.block, 10));
    if (btn.dataset.action === 'restore-desc') restoreDescription(btn.dataset.id);
  });
  tbody.addEventListener('input', e => {
    if (e.target.matches('.cta-input')) updateCTA(e.target.dataset.id, e.target.value);
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
