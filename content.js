// Detects the legacy editor type and exposes GET/SET HTML messaging to the sidebar.

function detectEditor(selectorOverride) {
  // User-specified CSS selector takes highest priority
  if (selectorOverride) {
    const el = document.querySelector(selectorOverride);
    if (el) {
      if (el.tagName === 'TEXTAREA') return { source: 'textarea', id: el.id || el.name || null, el };
      if (el.isContentEditable)      return { source: 'contenteditable', id: el.id || null, el };
    }
  }

  // TinyMCE — activeEditor can be null if the editor hasn't been focused yet;
  // fall back to the first editor in the collection.
  if (window.tinymce) {
    const editor = tinymce.activeEditor || (tinymce.editors && Object.values(tinymce.editors)[0]);
    if (editor) return { source: 'tinymce', id: editor.id };
  }

  // CKEditor 4
  if (window.CKEDITOR) {
    const instances = Object.values(CKEDITOR.instances);
    if (instances.length > 0) {
      return { source: 'ckeditor4', id: instances[0].name };
    }
  }

  // Textarea containing deal card HTML
  const textareas = Array.from(document.querySelectorAll('textarea'));
  const dealTextarea = textareas.find(t =>
    t.value.includes('bu-card') || t.value.includes('bu-columns') || t.value.includes('custom-offers-list')
  );
  if (dealTextarea) {
    return { source: 'textarea', id: dealTextarea.id || dealTextarea.name || null };
  }

  // Largest textarea by content length (most likely to be the article body)
  if (textareas.length > 0) {
    const largest = textareas.reduce((a, b) => b.value.length > a.value.length ? b : a);
    const taId = largest.id || largest.name || null;

    // TinyMCE is often keyed by the textarea's id — check before falling back to raw textarea
    if (window.tinymce && taId) {
      const tinyEditor = tinymce.get(taId);
      if (tinyEditor) return { source: 'tinymce', id: tinyEditor.id };
    }

    // CodeMirror attaches itself directly to the textarea element
    if (largest.CodeMirror) {
      return { source: 'codemirror', id: taId };
    }

    return { source: 'textarea', id: taId };
  }

  // Contenteditable
  const ce = document.querySelector('[contenteditable="true"]');
  if (ce) {
    return { source: 'contenteditable', id: ce.id || null };
  }

  return null;
}

function getEditorHTML(editorInfo) {
  if (!editorInfo) return null;

  if (editorInfo.source === 'codemirror') {
    const el = editorInfo.id ? document.getElementById(editorInfo.id) : null;
    if (el && el.CodeMirror) return el.CodeMirror.getValue();
  }

  if (editorInfo.source === 'tinymce' && window.tinymce && tinymce.activeEditor) {
    return tinymce.activeEditor.getContent();
  }

  if (editorInfo.source === 'ckeditor4' && window.CKEDITOR && editorInfo.id && CKEDITOR.instances[editorInfo.id]) {
    return CKEDITOR.instances[editorInfo.id].getData();
  }

  if (editorInfo.source === 'textarea') {
    const el = editorInfo.id
      ? (document.getElementById(editorInfo.id) || document.querySelector(`textarea[name="${editorInfo.id}"]`))
      : document.querySelector('textarea');
    return el ? el.value : null;
  }

  if (editorInfo.source === 'contenteditable') {
    const el = editorInfo.id
      ? document.getElementById(editorInfo.id)
      : document.querySelector('[contenteditable="true"]');
    return el ? el.innerHTML : null;
  }

  return null;
}

function setEditorHTML(editorInfo, html) {
  if (!editorInfo) return false;

  if (editorInfo.source === 'codemirror') {
    const el = editorInfo.id ? document.getElementById(editorInfo.id) : null;
    if (el && el.CodeMirror) {
      el.CodeMirror.setValue(html);
      el.CodeMirror.save(); // syncs value back to the underlying textarea
      return true;
    }
    return false;
  }

  if (editorInfo.source === 'tinymce' && window.tinymce && tinymce.activeEditor) {
    const editor = tinymce.activeEditor;
    editor.setContent(html);
    // Mark editor dirty and notify the CMS that content changed
    editor.fire('change');
    editor.fire('input');
    try { editor.undoManager.add(); } catch (_) {}
    return true;
  }

  if (editorInfo.source === 'ckeditor4' && window.CKEDITOR && editorInfo.id && CKEDITOR.instances[editorInfo.id]) {
    const editor = CKEDITOR.instances[editorInfo.id];
    editor.setData(html, {
      callback: () => { editor.fire('change'); }
    });
    return true;
  }

  if (editorInfo.source === 'textarea') {
    const el = editorInfo.id
      ? (document.getElementById(editorInfo.id) || document.querySelector(`textarea[name="${editorInfo.id}"]`))
      : document.querySelector('textarea');
    if (el) {
      // Use the native value setter so React/Vue/etc. pick up the change
      const nativeSetter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
      if (nativeSetter) nativeSetter.call(el, html);
      else el.value = html;
      el.dispatchEvent(new Event('input',  { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    return false;
  }

  if (editorInfo.source === 'contenteditable') {
    const el = editorInfo.id
      ? document.getElementById(editorInfo.id)
      : document.querySelector('[contenteditable="true"]');
    if (el) {
      el.innerHTML = html;
      el.dispatchEvent(new Event('input',  { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    return false;
  }

  return false;
}

let cachedEditorInfo = null;

function getDiagnostics() {
  const result = { hasTinymce: false, tinymceEditorIds: [], tinymceActiveId: null, hasCKEditor: false, textareas: [] };
  try { result.hasTinymce = typeof window.tinymce !== 'undefined'; } catch (_) {}
  try { result.tinymceEditorIds = result.hasTinymce ? Object.keys(tinymce.editors || {}) : []; } catch (_) {}
  try { result.tinymceActiveId = result.hasTinymce && tinymce.activeEditor ? String(tinymce.activeEditor.id) : null; } catch (_) {}
  try { result.hasCKEditor = typeof window.CKEDITOR !== 'undefined'; } catch (_) {}
  try { result.hasCodeMirror = typeof window.CodeMirror !== 'undefined'; } catch (_) {}
  try {
    result.textareas = Array.from(document.querySelectorAll('textarea')).map(t => ({
      id: t.id || null,
      name: t.name || null,
      valueLength: t.value.length,
      hasCodeMirror: !!t.CodeMirror,
    }));
  } catch (_) {}
  try {
    result.iframes = Array.from(document.querySelectorAll('iframe')).map(f => {
      const info = { id: f.id || null, name: f.name || null, src: f.src || null, accessible: false };
      try {
        const doc = f.contentDocument;
        info.accessible = !!doc;
        if (doc) {
          info.bodyLength = doc.body ? doc.body.innerHTML.length : null;
          info.hasContentEditable = !!doc.querySelector('[contenteditable="true"]');
          info.designMode = doc.designMode || null;
          info.docTitle = doc.title || null;
        }
      } catch (_) {}
      // Walk up to find the nearest ancestor with an id, to correlate the
      // iframe back to the field it belongs to (YUI wraps a hidden textarea
      // and its RTE iframe in a shared container).
      try {
        let node = f.parentElement;
        while (node && !node.id) node = node.parentElement;
        info.ancestorId = node ? node.id : null;
      } catch (_) {}
      return info;
    });
  } catch (_) {}
  try {
    result.hasYUI = typeof window.YAHOO !== 'undefined';
    result.yuiEditorInstanceIds = [];
    if (result.hasYUI) {
      const info = window.YAHOO.widget && window.YAHOO.widget.EditorInfo;
      if (info && info._instances) result.yuiEditorInstanceIds = Object.keys(info._instances);
    }
  } catch (_) {}
  return result;
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'GET_DIAGNOSTICS') {
    sendResponse(getDiagnostics());
    return true;
  }
  if (message.type === 'GET_ARTICLE_HTML') {
    cachedEditorInfo = detectEditor(message.selector || null);
    if (!cachedEditorInfo) {
      sendResponse({ error: 'No editor detected on this page' });
      return true;
    }
    const html = getEditorHTML(cachedEditorInfo);
    if (html === null) {
      sendResponse({ error: 'Could not read editor content' });
      return true;
    }
    sendResponse({ html, source: cachedEditorInfo.source, editorId: cachedEditorInfo.id });
    return true;
  }

  if (message.type === 'SET_ARTICLE_HTML') {
    const editorInfo = message.selector
      ? detectEditor(message.selector)
      : (cachedEditorInfo || detectEditor(null));
    if (!editorInfo) {
      sendResponse({ error: 'No editor detected on this page' });
      return true;
    }
    const ok = setEditorHTML(editorInfo, message.html);
    sendResponse(ok ? { ok: true } : { error: 'Failed to write to editor' });
    return true;
  }

  return false;
});
