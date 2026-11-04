# DealNews Blog Card Editor

A Chrome sidebar extension for DealNews editorial use. It does two things:

1. **Card generator** — look up offers in DatoCMS and generate styled `.bu-card` HTML for longform articles.
2. **Article scanner** — read an article's HTML out of the CMS editor, check each deal card's expiration status against DatoCMS, flag/remove/reorder stale cards, and regenerate clean HTML to paste back in.

It's a plain Manifest V3 extension — vanilla JS/HTML/CSS, no build step, no dependencies.

## Installing

1. Clone this repo:
   ```
   git clone https://github.com/jramhold514/dealnews-blog-card-extension.git
   ```
2. In Chrome, go to `chrome://extensions`.
3. Turn on **Developer mode** (top right).
4. Click **Load unpacked** and select the cloned folder.
5. Pin the extension and click its icon to open the sidebar.
6. On first use, paste a DatoCMS read-only API token into the token field at the top of the sidebar (it's saved locally in your browser via `chrome.storage.sync` — never committed to this repo, never sent anywhere but DatoCMS/DealNews).

## Getting updates

This extension is loaded in **developer mode**, which does not auto-update. To pick up changes pushed to this repo:

```
git pull
```

Then go back to `chrome://extensions` and click the reload icon (↻) on "DealNews Blog Card Editor." Close and reopen the sidebar afterward.

The sidebar checks this repo's `main` branch for a newer version and shows a yellow banner at the top when one is available — that's your cue to run the steps above.

## For contributors

See [CLAUDE.md](CLAUDE.md) for a detailed architecture reference, function-level rationale, and full version history — it's written for AI-assisted development but is equally useful as human documentation of *why* things work the way they do.

`manifest.json`'s `"version"` field is bumped for every behavior-changing commit; see CLAUDE.md's "Versioning" section for the convention.
