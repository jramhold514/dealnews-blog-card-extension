# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A Chrome MV3 sidebar extension for DealNews editorial use. It has two purposes:
1. **Card generator** — look up offers in DatoCMS and generate styled HTML deal cards for longform articles
2. **Article scanner** — read an article's HTML from the CMS editor, identify deal cards, check expiration status via DatoCMS, remove flagged cards, and regenerate clean HTML for the editor to copy/paste back in

The extension is loaded unpacked at `chrome://extensions`. There is no build step, bundler, package.json, test suite, or linter — all files are vanilla JS/HTML/CSS loaded directly by Chrome, and verification is manual (reload the extension, exercise the tab in the sidebar).

This repo also holds `index.html`, a standalone Live Feed generator tool unrelated to the extension's own load path — see `docs/live-feed-generator.md`.

## Reloading after changes

After editing any file, go to `chrome://extensions`, find "DealNews Blog Card Editor", and click the reload (↻) icon. Then close and reopen the sidebar.

## Versioning

Bump `"version"` in `manifest.json` (semver) whenever a change lands that alters what the extension *does* — new functions, changed behavior, bug fixes. Purely cosmetic edits (comments, formatting, this file) don't need a bump.

- Patch (`x.x.PATCH`) — bug fixes, small behavior corrections
- Minor (`x.MINOR.x`) — new functionality, non-breaking additions
- Major (`MAJOR.x.x`) — significant overhauls or breaking changes to how a tab/flow works

Currently at `2.39.2`. Each bump gets a short entry at the top of CHANGELOG.md (what changed and why, function names). Don't put version history in this file.

## Architecture

```
manifest.json       MV3 manifest — declares permissions, content script, side panel
background.js       Service worker — opens side panel on toolbar icon click; answers monetized-link requests from bridge.js
magic-link.js       Shared monetized-link logic (DNMagic): magic URL service call, vendor lookup, tag building, flags
bridge.js           Content script on file:/// pages that declare themselves working copies; forwards link requests to the service worker
content.js          Injected into secure.dealnews.com — handles editor detection and read/write
sidebar.html        3-tab UI + daily counter strip — no inline event handlers (blocked by MV3 CSP)
sidebar.css         All styles — dark mode via [data-theme="dark"] CSS variables
sidebar.js          All sidebar logic — DatoCMS API calls, card generation, article flow
icons/
  generate-icons.html   Open in browser to regenerate PNG icons
index.html          Live Feed Generator — standalone, not part of the extension, see docs/live-feed-generator.md
```

### Tabs (`sidebar.html` / `sidebar.js`)

- **Configure** — add offers by DatoCMS or legacy ID or by searching the site's live offers (`findState`/`runFind`, see "Find offers" in `docs/configure-tab.md`), reorder/sort/lock them, edit CTA text (`addOfferById`, `sortOffers`, `moveOffer`); has its own Edit/Preview/HTML sub-nav — see "Configure sub-tabs" in `docs/configure-tab.md`
- **Processor** — standalone bulk find/replace utility: pastes arbitrary HTML and rewrites the text of every element carrying the `PROC_TARGET_CLASS` class token (`btn-cta`); unrelated to the offers list state (`processHTML`)
- **Links** — monetized links: lines of `Link text / address` become the CMS plugin's tags through the magic URL service (`makeLinks`, `renderLinks`, see "Links tab and the working-copy bridge" in `docs/links-and-bridge.md`)
- **Article** — the article scanner flow described above (`loadFromPage`, `checkAllExpirations`, `removeAndRegenerate`); also has an optional visual preview of loaded cards (`toggleArticlePreview`/`renderArticlePreview`, see "Article visual preview" in `docs/article-tab.md`), an automatic data-iref tag audit with a per-card and bulk in-place fix (`analyzeIrefTags`/`applyIrefFix`/`fixAllIrefIssues`, see "Iref tag audit" and "Iref fix" in `docs/article-tab.md`), an optional per-card/bulk move into an article's existing Expired-cards grouping instead of removal (`toggleMoveToExpiredGroup`/`moveAllExpiredToGroup`, see "Expired group" in `docs/article-tab.md`), and a plain-text Find & Replace against the loaded HTML with a preview-then-apply match list (`previewArticleFindMatches`/`applySelectedFindReplacements`, see "Find & Replace" in `docs/article-tab.md`)

There was previously a 4th "Live Feed" tab; it was removed in `2.20.1` and now lives only in the standalone `index.html` — see `docs/live-feed-generator.md`.

### Rules that apply everywhere

Each one comes from a past bug.

- **Card lookup:** always use the shared `findCardElements(doc)`, which matches cards in *every* `#custom-offers-list`. `card.index` is the card's position in the original DOM and never changes; array order is display order.
- **Removal is decided by `card.flagged` only.** Never re-derive removal from `card.status`. `flagged` and `moveToExpiredGroup` are mutually exclusive.
- **In-place edits splice strings, they don't reserialize.**
  - Find & Replace and Fix iref rewrite `articleOriginalHTML` by character span (`locateCardHTMLSpan()`).
  - Only the final Regenerate reserializes, and it keeps `doc.head.innerHTML + doc.body.innerHTML`.
- **Reordering** runs only when `canReorder && reordered`. It works per container and is slot-based (placeholders), never `appendChild` to the end.
- **The tracking attribute is `data-iref`:** `site-widget-card-blog-{blog ID}-{offer legacy ID}-{image|title|button|creator}`, built by `irefValue()`/`buildDataIref()`.
  - Never `iref-append`, which belongs to the blog-slider widget.
  - Omit the attribute entirely when the Blog Content ID is blank.
- **Escaping:** `esc()` for attributes, `escText()` for text (it writes `&nbsp;` and leaves quotes alone). `dastNodeToHTML()` output is trusted HTML; don't escape it again.
- **Match classes by token** (`.btn-cta`, `.bu-content.bu-is-flex-grow-1`), never by exact `class` string or tag name.
- **Classic and Compact are frozen:** `legacyCardHTML()` must stay byte-identical to the original generator, indentation included.
- **Page scripts** (`cardMoreScript()`, `cardSortScript()`, `tableCopyScript()`, Live Feed) use DOM calls and `textContent` only. No `<tag`-shaped text in the source, no outside references, ES5 only. Never two `''` on one line: the CMS editor reads a pair as wiki italics and writes `<i>` into the script.
- **`setTab()` and `setSubTab()` stay separate** functions with separate name arrays.
- **Network data goes in with `textContent`**, never `innerHTML`.
- **Tokens** (`datoToken`, `magicToken`) never go into the repo, generated output, or a page.

### Detailed docs

Read the relevant file before changing that area.

| File | Covers |
|---|---|
| `docs/card-styles.md` | Card options, Standard / Classic / Compact / Creator Pick / Table cards, offer description formatting (dast to HTML), the generated HTML |
| `docs/configure-tab.md` | Configure sub-tabs, Find offers |
| `docs/article-tab.md` | Keep (intentionally-expired) cards, visual preview, iref audit and fix, Find & Replace, reordering, regenerating, Expired group, Change Log, tracking link detection |
| `docs/links-and-bridge.md` | Links tab and the working-copy bridge (monetized links) |
| `docs/sidebar-extras.md` | Daily counter, update check, Blog Content ID auto-detect |
| `docs/live-feed-generator.md` | Live Feed Generator (`index.html`), removed Blog Slider |
| `CHANGELOG.md` | Version history, newest first |

### Message passing

The sidebar cannot access the page DOM directly. `sidebar.js` sends messages to `content.js` via `chrome.tabs.sendMessage`, and `content.js` responds:

- `GET_ARTICLE_HTML` → returns `{ html, source, editorId }` — reads article body from detected editor
- `GET_DIAGNOSTICS` → returns editor environment info for debugging (run on demand via the "Run Diagnostics" button only — not on every `GET_ARTICLE_HTML` call, to avoid extra UI scroll)

Both messages accept an optional `selector` field (from `#editor-selector` input, persisted to `chrome.storage.sync`) to override auto-detection.

`content.js` also defines `SET_ARTICLE_HTML`/`setEditorHTML()`, but nothing in `sidebar.js` currently sends that message — see "No Save to Page" below.

### Editor detection (`content.js`)

`detectEditor()` tries in order: user CSS selector override → TinyMCE → CKEditor 4 → textarea containing deal card HTML → largest textarea by content length → contenteditable. CodeMirror is detected via `el.CodeMirror` on the textarea element, not `window.CodeMirror`.

**Do not read article HTML from the live rich-text iframe instead of the textarea mirror** — this was tried (to fix a suspected stale-mirror read issue) and broke card parsing entirely. The iframe's `designMode` document sanitizes/normalizes content as soon as it's loaded, stripping the custom classes (`.bu-card`, `.bu-columns`, etc.) that `parseAndDisplayCards()` depends on. The textarea's raw `.value` is the only reliable read source, despite being a periodically-synced mirror.

### No "Save to Page" — copy/paste only

A "Save to Page" button once wrote the regenerated HTML directly into the editor via `chrome.scripting.executeScript` (`world: 'MAIN'`). It was removed because the article body field on secure.dealnews.com is a legacy WYSIWYG rich-text iframe (see below) whose own internal content-sync logic can't handle the nested `.bu-card` markup this tool generates — writing into the iframe's `body.innerHTML` renders fine, but the editor's own sync-back-to-textarea routine flattens the DOM to plain text (even leaking hidden `<script>`/`<style>` text as visible prose), destroying structure and styling. Writing straight to the underlying textarea doesn't work either — the iframe periodically re-syncs and clobbers it. The Article tab's "Copy" button is the reliable path: it copies the regenerated HTML (with structured data and inline styles intact, see "Generated HTML" in `docs/card-styles.md`) for the editor to paste in manually.

### MV3 CSP constraint

**No inline `onclick=""` attributes anywhere in sidebar.html** — they are silently blocked. All event listeners are wired in the `DOMContentLoaded` handler in `sidebar.js`. Offers table (`#offers-tbody`) and article card list (`#article-card-list`) use event delegation for dynamically rendered rows.

### Storage

- API token: `chrome.storage.sync` key `datoToken`
- Theme preference: `chrome.storage.sync` key `theme`
- Editor selector override: `chrome.storage.sync` key `editorSelector`
- Daily counter author: `chrome.storage.sync` key `countAuthorId` (a DatoCMS Author record ID)
- Magic URL token and the user's email: `chrome.storage.local` keys `magicToken` and `magicEmail` (this browser only)
- Update-check cache/dismissal: `chrome.storage.local` keys `updateCheck` and `updateDismissed` (per-machine, deliberately not synced)
- Card options (Style, Layout and every On/Off choice): `chrome.storage.sync` key `cardOptions`, see "Card options" in `docs/card-styles.md`
- None of these use `localStorage`

### DatoCMS API

Base URL: `https://site-api.datocms.com`. Offer expiration is checked against the `expiration_datetime` field (configurable via `#exp-field` in the Article tab settings — this API key is specific to the DealNews offer model and isn't discoverable from schema access alone). Legacy numeric IDs are resolved to Dato IDs before fetching item details.

If the configured expiry field name is wrong, `fetchOfferStatus()` doesn't error — it silently treats every offer as active unless DatoCMS `meta.status` is non-`published` or the record 404s. To make a misconfigured field name discoverable without DatoCMS schema access, `fetchOfferStatus()` distinguishes "field key not present in the response at all" from "field present but empty," and in the former case returns a reason listing every real attribute key on that record; `checkAllExpirations()` stores this on `card.reason` and it's surfaced as the status badge's tooltip.

## Known editor environment (secure.dealnews.com article edit pages)

- No TinyMCE, no CKEditor, no CodeMirror on the main window
- Article body lives in `textarea#normal-body-editor`, but that textarea is just a mirror — the real editing surface is a same-origin `iframe` (`src="javascript:false"`, `contentDocument.designMode === "on"`) that a legacy WYSIWYG library injects next to it. The container wrapping both textarea and iframe uses the id convention `<field>` (e.g. `normal-body` wraps `normal-body-editor`, `teaser-body` wraps `teaser-body-editor`).
- `window.YAHOO` is not present, so this isn't YUI2's Editor despite matching its `javascript:false` iframe signature — likely an in-house or vendored fork.
- The iframe sanitizes complex nested markup both on load and on sync-back (see "No Save to Page" and the editor-detection note above) — treat this field as read-*and*-write-unreliable for anything beyond the textarea's raw value.
