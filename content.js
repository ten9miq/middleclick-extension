(function () {
  "use strict";

  const URL_ATTRS = [
    "href",
    "routerLink",
    "routerlink",
    "ng-reflect-router-link",
    "data-href",
    "data-url",
    "data-link",
    "data-target-url",
    "data-destination",
    "data-path",
    "data-route",
    "data-router-link",
    "data-navigate",
    "data-nav",
    "data-permalink",
    "data-uri",
    "data-page-url",
    "data-detail-url",
    "data-action-url",
    "to"
  ];

  const DATA_URL_KEY = /(?:^|[-_])(?:url|href|link|route|path|destination|permalink|uri|navigate|nav)(?:$|[-_])/i;

  const CLICKABLE_SELECTOR = 'a, area, button, input[type="button"], input[type="submit"], input[type="image"], [role="link"], [role="button"], [onclick], [tabindex]';
  const STABLE_DATA_KEY = /^data-(?:[a-z0-9]+-)*(?:id|key|destination|route|action|target|testid)$/i;
  const RESOURCE_DATA_KEY = /(?:^|-)(?:icon|sprite|image|thumbnail|avatar|asset|background)(?:-|$)/i;
  let learnedEntries = [];
  let learnedRevision = 0;
  let learningReady = Promise.resolve();
  let requestSequence = 0;
  let lastHandledMiddle = { url: '', time: 0 };
  let lastProbeGesture = { control: null, time: 0 };
  let activeProbe = false;
  let probeAttempt = 0;
  let driveOpen = null;
  let lastDriveGesture = { control: null, time: 0 };

  function normalizeText(value) {
    return String(value ?? '').replace(/\s+/g, ' ').trim();
  }

  function isChatGPTHost() {
    return /^(www\.)?chatgpt\.com$/i.test(location.hostname);
  }

  function hasMods(e) {
    return e.ctrlKey || e.metaKey || e.shiftKey || e.altKey;
  }

  function composedPath(e) {
    if (typeof e.composedPath === "function") return e.composedPath();
    return e.target ? [e.target] : [];
  }

  function isElement(node) {
    return !!node && node.nodeType === Node.ELEMENT_NODE;
  }

  function rawIsMeaningful(raw) {
    if (raw === null || raw === undefined) return false;
    const s = String(raw).trim();
    if (!s || s === "#" || s.startsWith("#")) return false;

    const lower = s.toLowerCase();
    if (
      lower.startsWith("javascript:") ||
      lower.startsWith("data:") ||
      lower.startsWith("vbscript:")
    ) return false;

    return true;
  }

  function toWebUrl(raw) {
    if (!rawIsMeaningful(raw)) return null;
    try {
      const u = new URL(String(raw).trim(), document.baseURI || location.href);
      if (u.protocol !== "http:" && u.protocol !== "https:") return null;
      return u.href;
    } catch {
      return null;
    }
  }

  function getEventElements(e) {
    const result = [];
    const seen = new Set();

    for (const node of composedPath(e)) {
      if (!isElement(node) || seen.has(node)) continue;
      seen.add(node);
      result.push(node);
    }

    let el = isElement(e.target) ? e.target.parentElement : null;
    for (let hops = 0; el && hops < 12; hops++, el = el.parentElement) {
      if (seen.has(el)) continue;
      seen.add(el);
      result.push(el);
    }

    return result;
  }

  function findNativeAnchor(e) {
    for (const el of getEventElements(e)) {
      const tag = el.tagName?.toLowerCase();
      if (tag === "a" || tag === "area") return el;
    }
    return null;
  }

  function urlFromInlineOnclick(code) {
    if (!code) return null;

    const patterns = [
      /(?:window\s*\.\s*)?open\s*\(\s*(['"`])([^'"`]+)\1/i,
      /(?:(?:window|document|top|parent|self)\s*\.\s*)?location\s*\.\s*(?:assign|replace)\s*\(\s*(['"`])([^'"`]+)\1/i,
      /(?:(?:window|document|top|parent|self)\s*\.\s*)?location(?:\s*\.\s*href)?\s*=\s*(['"`])([^'"`]+)\1/i,
      /(?:^|[^\w$])(?:navigate|navigateTo|goTo|routeTo|redirectTo|openPage|openUrl)\s*\(\s*(['"`])([^'"`]+)\1/i,
      /(?:\$?router|history|navigation)\s*\.\s*(?:push|replace|navigate)\s*\(\s*(['"`])([^'"`]+)\1/i
    ];

    for (const re of patterns) {
      const m = String(code).match(re);
      if (!m) continue;
      const url = toWebUrl(m[2]);
      if (url) return url;
    }

    return null;
  }

  function urlFromElementAttributes(el) {
    if (!el?.getAttribute) return null;

    const tag = el.tagName?.toLowerCase();
    // Global document metadata (e.g. data-icon-sprite-url on <html>) is not
    // a destination of an arbitrary descendant control.
    if (tag === "html" || tag === "body") return null;
    if (tag === "a" || tag === "area") {
      const url = toWebUrl(el.getAttribute("href"));
      if (url) return url;
    }

    for (const attr of URL_ATTRS) {
      // SVG <use>, <image>, etc. reference drawing resources, not click
      // destinations. Keep SVG <a href> navigation and parent button/link URLs.
      if (attr === "href" && el.namespaceURI === "http://www.w3.org/2000/svg" && tag !== "a") continue;
      const url = toWebUrl(el.getAttribute(attr));
      if (url) return url;
    }

    if (el.dataset) {
      for (const [key, value] of Object.entries(el.dataset)) {
        const normalizedKey = key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
        if (!DATA_URL_KEY.test(normalizedKey) || RESOURCE_DATA_KEY.test(normalizedKey)) continue;
        if (!/^(?:https?:\/\/|\/|\.{1,2}\/|\?)/i.test(String(value).trim())) continue;
        const url = toWebUrl(value);
        if (url) return url;
      }
    }

    return urlFromInlineOnclick(el.getAttribute("onclick"));
  }

  function getSubmitter(start) {
    function isSubmitControl(el) {
      if (!isElement(el)) return false;
      const tag = el.tagName?.toLowerCase();
      if (tag === "button") {
        const type = (el.getAttribute("type") || "submit").toLowerCase();
        return type === "submit";
      }
      if (tag === "input") {
        const type = (el.getAttribute("type") || "text").toLowerCase();
        return type === "submit" || type === "image";
      }
      return false;
    }

    if (isSubmitControl(start)) return start;

    try {
      const candidate = start?.closest?.("button, input[type='submit'], input[type='image']") || null;
      return isSubmitControl(candidate) ? candidate : null;
    } catch {
      return null;
    }
  }

  function urlFromGetForm(start) {
    const submitter = getSubmitter(start);
    if (!submitter) return null;

    const form = submitter.form || submitter.closest?.("form");
    if (!form) return null;

    const method = (submitter.getAttribute("formmethod") || form.getAttribute("method") || "get").toLowerCase();
    if (method !== "get") return null;

    const actionRaw = submitter.getAttribute("formaction") || form.getAttribute("action") || location.href;
    const action = toWebUrl(actionRaw);
    if (!action) return null;

    try {
      const url = new URL(action);
      const params = new URLSearchParams();
      let data;

      try {
        data = new FormData(form, submitter);
      } catch {
        data = new FormData(form);
        if (submitter.name) data.append(submitter.name, submitter.value || "");
      }

      for (const [key, value] of data.entries()) {
        if (typeof value === "string") params.append(key, value);
      }

      url.search = params.toString();
      return url.href;
    } catch {
      return null;
    }
  }

  function uniqueDescendantUrl(container) {
    if (!container?.querySelectorAll) return null;

    const tag = container.tagName?.toLowerCase();
    if (tag === "html" || tag === "body") return null;

    let nodes;
    try {
      nodes = container.querySelectorAll("a[href], area[href], [data-href], [data-url], [data-link], [data-route], [data-path], [routerLink], [routerlink], [to]");
    } catch {
      return null;
    }

    const urls = new Set();
    let inspected = 0;
    for (const node of nodes) {
      if (++inspected > 40) break;
      const url = urlFromElementAttributes(node);
      if (!url) continue;
      urls.add(url);
      if (urls.size > 1) return null;
    }

    return urls.size === 1 ? [...urls][0] : null;
  }


  function clickControl(e) {
    return getEventElements(e).find(el => el.matches?.(CLICKABLE_SELECTOR)) || null;
  }

  function blockedControl(control, target) {
    const editable = target?.closest?.('input, textarea, select, [contenteditable="true"]');
    if (editable && !(editable.tagName.toLowerCase() === 'input' &&
      /^(button|submit|image)$/i.test(editable.getAttribute('type') || 'text'))) return true;
    return Boolean(control && (control.hasAttribute('disabled') || control.getAttribute('aria-disabled') === 'true' ||
      control.hasAttribute('aria-haspopup')));
  }

  function scopedElements(e, control) {
    const elements = getEventElements(e);
    if (control) return elements.slice(0, elements.indexOf(control) + 1);
    const boundary = elements.findIndex(el => /^(nav|aside|main|body|html)$/i.test(el.tagName || ''));
    return elements.slice(0, boundary < 0 ? 6 : Math.min(boundary, 6));
  }

  function staticUrl(e, control = clickControl(e)) {
    if (blockedControl(control, e.target)) return null;
    const elements = scopedElements(e, control);
    for (const element of elements) {
      const url = urlFromElementAttributes(element);
      if (url) return url;
    }
    const formUrl = urlFromGetForm(e.target);
    if (formUrl) return formUrl;
    return uniqueDescendantUrl(control || elements[0]);
  }

  function driveItemId(control) {
    if (location.origin !== 'https://drive.google.com' || !/^\/drive(?:\/|$)/.test(location.pathname) ||
      !control || !/^(row|gridcell)$/.test(control.getAttribute('role') || '') ||
      control.getAttribute('data-target') !== 'doc' || !control.hasAttribute('data-selectable') ||
      blockedControl(control, control) || control.closest('form') || control.form) return null;
    const id = control.getAttribute('data-id') || '';
    return /^[A-Za-z0-9_-]{10,200}$/.test(id) ? id : null;
  }

  function cancelDriveOpen() {
    if (!driveOpen) return;
    sendMessage({ type: 'cancelDriveDefaultOpen', requestId: driveOpen.requestId });
    driveOpen = null;
  }

  function visibleDrivePreview() {
    return [...document.querySelectorAll('iframe')].find(frame => {
      try {
        const url = new URL(frame.src);
        return url.origin === location.origin && url.pathname === '/viewer/main' && frame.checkVisibility() &&
          frame.getBoundingClientRect().width > 0;
      } catch { return false; }
    });
  }

  function driveLeftClick(target) {
    const rect = target.getBoundingClientRect();
    for (const type of ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      const EventType = type.startsWith('pointer') ? PointerEvent : MouseEvent;
      target.dispatchEvent(new EventType(type, { bubbles: true, cancelable: true, composed: true,
        button: 0, buttons: type.endsWith('down') ? 1 : 0, detail: 1,
        pointerId: 1, pointerType: 'mouse', isPrimary: true,
        clientX: rect.x + rect.width / 2, clientY: rect.y + rect.height / 2 }));
    }
  }

  function requestDriveOpen(e) {
    const control = clickControl(e);
    const itemId = driveItemId(control);
    if (!itemId || blockedControl(control, e.target) || window !== top) return false;
    suppressEvent(e);
    const now = performance.now();
    if (lastDriveGesture.control === control && now - lastDriveGesture.time < 120) return true;
    lastDriveGesture = { control, time: now };
    if (driveOpen) { notify('busy'); return true; }
    if (visibleDrivePreview()) { notify('drive-open-failed'); return true; }
    const request = { requestId: Date.now() + ':' + (++requestSequence), sourceUrl: location.href, itemId,
      entryKey: window.navigation?.currentEntry?.key || '' };
    driveOpen = request;
    Promise.resolve(chrome.runtime.sendMessage({ type: 'beginDriveDefaultOpen', ...request })).then(async response => {
      if (driveOpen !== request) return;
      if (!response?.ok || location.href !== request.sourceUrl || !control.isConnected || driveItemId(control) !== itemId) {
        cancelDriveOpen(); notify('drive-open-failed'); return;
      }
      // Select only this item, then let Drive choose the current default app.
      // The label is bound to the same ID; nested action buttons are excluded.
      const target = [...control.querySelectorAll('[data-id]')].find(el =>
        el.getAttribute('data-id') === itemId && el.hasAttribute('data-tooltip'));
      if (!target) { cancelDriveOpen(); notify('drive-open-failed'); return; }
      driveLeftClick(target);
      // Drive updates its keyboard selection after processing the mouse action.
      await new Promise(resolve => setTimeout(resolve, 50));
      if (driveOpen !== request) return;
      if (location.href !== request.sourceUrl || !control.isConnected || driveItemId(control) !== itemId) {
        cancelDriveOpen(); notify('drive-open-failed'); return;
      }
      const selected = document.querySelectorAll('[data-target="doc"][data-selectable][aria-selected="true"]');
      if (control.getAttribute('aria-selected') !== 'true' || selected.length !== 1) {
        cancelDriveOpen(); notify('drive-open-failed'); return;
      }
      control.focus({ preventScroll: true });
      control.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true,
        key: 'Enter', code: 'Enter', keyCode: 13, which: 13 }));
      // Ctrl+Enter alone forces a preview even for Markdown with a Docs default.
      // Use it only after the normal Open action actually produced a preview.
      for (let attempt = 0; attempt < 60 && driveOpen === request; attempt++) {
        await new Promise(resolve => setTimeout(resolve, 50));
        if (driveOpen !== request || location.href !== request.sourceUrl) return;
        const preview = visibleDrivePreview();
        if (!preview) continue;
        // Drive's parent-page close control also handles the embedded viewer;
        // it remains in the DOM while the iframe owns the visible toolbar.
        const parentClose = document.querySelector('button.wIYhq[aria-label]');
        const close = parentClose || preview.contentDocument?.querySelector('button[jsname="plIjzf"]');
        if (!close || (!parentClose && !close.checkVisibility())) continue;
        if (parentClose) parentClose.click();
        else driveLeftClick(close);
        for (let closing = 0; closing < 20 && driveOpen === request && visibleDrivePreview(); closing++) {
          await new Promise(resolve => setTimeout(resolve, 50));
        }
        if (driveOpen !== request) return;
        if (visibleDrivePreview() || !control.isConnected || driveItemId(control) !== itemId ||
          control.getAttribute('aria-selected') !== 'true') {
          cancelDriveOpen(); notify('drive-open-failed'); return;
        }
        control.focus({ preventScroll: true });
        control.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true,
          key: 'Enter', code: 'Enter', keyCode: 13, which: 13, ctrlKey: true }));
        return;
      }
    }).catch(() => { if (driveOpen === request) { cancelDriveOpen(); notify('drive-open-failed'); } });
    return true;
  }

  function codexDestination(control) {
    if (!isChatGPTHost() || control?.getAttribute('data-sidebar-destination') !== 'builtin:codex') return null;
    return toWebUrl('/#middleclick-plus-codex');
  }

  function fingerprint(control) {
    if (!control || blockedControl(control, control) || control.closest('form') || control.form) return null;
    const attrs = [];
    for (const attr of control.attributes ?? []) {
      if (attr.name !== 'id' && !STABLE_DATA_KEY.test(attr.name)) continue;
      if (RESOURCE_DATA_KEY.test(attr.name)) continue;
      const value = normalizeText(attr.value);
      if (!value || value.length > 160 || /^(?:[:_]|radix-)/i.test(value)) continue;
      attrs.push([attr.name, value]);
    }
    attrs.sort((a, b) => a[0].localeCompare(b[0]));
    const label = normalizeText(control.getAttribute('aria-label') || control.getAttribute('title') || control.textContent);
    if ((!label || label.length > 160) && !attrs.length) return null;
    const region = control.parentElement?.closest?.('nav, aside, [role="navigation"]');
    const context = region ? [region.tagName.toLowerCase(), region.getAttribute('aria-label') || '', region.getAttribute('id') || ''] : [];
    const scope = attrs.length ? '*' : location.pathname + location.search;
    const key = JSON.stringify(['v1', control.tagName.toLowerCase(), control.getAttribute('role') || '', attrs,
      label.length <= 160 ? label : '', context, scope]);
    return key.length <= 2048 ? key : null;
  }

  function chatgptNavigationKey(control) {
    if (!isChatGPTHost() || location.protocol !== 'https:' || !control || blockedControl(control, control) || control.closest('form') || control.form ||
      control.closest('main, [role="main"]')) return null;
    const region = control.parentElement?.closest('nav, aside, [role="navigation"]');
    if (!region) return null;
    const label = normalizeText(control.getAttribute('aria-label') || control.getAttribute('title') || control.textContent);
    const ownerSelector = '[data-app-action-sidebar-project-id], [data-sidebar-project-container-id]';
    let project = control.closest(ownerSelector);
    // The Recents/Pinned wrappers use this same container attribute with
    // values such as "chats". Only project:... denotes a project owner.
    for (let depth = 0; project && depth < 32 && !project.hasAttribute('data-app-action-sidebar-project-id') &&
      !/^project:/.test(project.getAttribute('data-sidebar-project-container-id') || ''); depth++) {
      project = project.parentElement?.closest(ownerSelector) || null;
    }
    const projectId = project?.getAttribute('data-app-action-sidebar-project-id') ||
      project?.getAttribute('data-sidebar-project-container-id')?.replace(/^project:/, '') || '';
    if (project && !/^g-p-[0-9a-f]{32}$/i.test(projectId)) return null;
    if (control === project && control.hasAttribute('data-app-action-sidebar-project-row')) {
      return JSON.stringify(['chatgpt-nav-v1', 'project', projectId]);
    }
    if (control.tagName.toLowerCase() !== 'button') return null;
    if (!project && !/^(?:ホーム|Home)$/i.test(region.getAttribute('aria-label') || '')) return null;
    const newChat = /^(?:新しいチャット|New chat)$/i.test(label);
    const projectNewChat = /(?: で新しいチャット$|^New chat in .+$)/i.test(label);
    if (!newChat && !(project && projectNewChat)) return null;
    return JSON.stringify(['chatgpt-nav-v1', 'new-chat', projectId]);
  }

  function uniqueLearningKey(control) {
    // Equivalent New chat buttons share an action. Project IDs identify their
    // owner across reorder, rename and source-page changes, without URL guesses.
    const chatgptKey = chatgptNavigationKey(control);
    if (chatgptKey) return chatgptKey;
    const key = fingerprint(control);
    if (!key) return null;
    const owned = ownedLearningKey(control, key);
    const candidates = document.querySelectorAll(CLICKABLE_SELECTOR);
    if (candidates.length > 1000) return null;
    if (owned) {
      const matches = [...candidates].filter(candidate => {
        const base = fingerprint(candidate);
        return base === key && ownedLearningKey(candidate, base) === owned;
      });
      return matches.length === 1 ? owned : null;
    }
    const matches = [...candidates].filter(candidate => fingerprint(candidate) === key);
    if (matches.length === 1) return key; // Keep existing unambiguous cache keys.
    if (matches.length === 0) return null;

    // Equal labels can belong to different sections of the same navigation.
    // Refine collisions with semantic ancestor identity, never an ordinal index
    // that could silently identify another control after a list is reordered.
    const context = sectionContext(control);
    if (matches.filter(candidate => sectionContext(candidate) === context).length !== 1) return null;
    const refined = JSON.stringify(['section-v1', key, context]);
    return refined.length <= 2048 ? refined : null;
  }

  function ownedLearningKey(control, key) {
    const ownIds = MiddleClickLearning.entityIds(control.attributes);
    if (!ownIds?.length) return null;
    const owners = [];
    let ancestor = control.parentElement;
    for (let depth = 0; ancestor && depth < 32; depth++, ancestor = ancestor.parentElement) {
      const ids = MiddleClickLearning.entityIds(ancestor.attributes);
      if (!ids) return null;
      if (ids.length) owners.push(ids);
    }
    if (ancestor || !owners.length) return null;
    const ownValues = new Set(ownIds.map(pair => pair[1]));
    if (!owners.some(owner => owner.some(pair => !ownValues.has(pair[1])))) return null;
    const base = JSON.parse(key);
    base[6] = location.pathname + location.search + location.hash;
    const owned = JSON.stringify(['owned-v1', JSON.stringify(base), owners]);
    return owned.length <= 2048 ? owned : null;
  }

  function sectionContext(control) {
    const result = [];
    let element = control.parentElement;
    for (let depth = 0; element && depth < 12; depth++, element = element.parentElement) {
      const tag = element.tagName.toLowerCase();
      const role = element.getAttribute('role') || '';
      const attrs = [];
      for (const attr of element.attributes ?? []) {
        if (!/^(id|aria-label)$/.test(attr.name) && !STABLE_DATA_KEY.test(attr.name) &&
          !/^data-(?:[a-z0-9]+-)*(heading|name|label|section|region|group)$/i.test(attr.name)) continue;
        if (RESOURCE_DATA_KEY.test(attr.name)) continue;
        const value = normalizeText(attr.value);
        if (!value || value.length > 160 || /^(?:[:_]|radix-)/i.test(value)) continue;
        attrs.push([attr.name, value]);
      }
      attrs.sort((a, b) => a[0].localeCompare(b[0]));
      if (attrs.length || /^(nav|aside|section|header|footer|article)$/.test(tag) || /^(region|group|navigation)$/.test(role)) {
        result.push([tag, role, attrs]);
      }
      if (/^(nav|aside|body|html)$/.test(tag) || role === 'navigation') break;
    }
    return JSON.stringify(result);
  }

  function resolveUrl(e) {
    const control = clickControl(e);
    if (blockedControl(control, e.target)) return null;
    const special = codexDestination(control);
    if (special) return special;
    const detected = staticUrl(e, control);
    if (detected) return detected;
    const key = uniqueLearningKey(control);
    if (!key) return null;
    if (chatgptNavigationKey(control)) {
      return MiddleClickLearning.lookupChatGPT(learnedEntries, location.origin, key,
        normalizeText(control.getAttribute('aria-label') || control.getAttribute('title') || control.textContent));
    }
    if (key.startsWith('["owned-v1",')) return MiddleClickLearning.lookupOwned(learnedEntries, location.origin, key);
    const saved = MiddleClickLearning.lookup(learnedEntries, location.origin, key);
    if (saved) return saved;
    // Explicit labels in navigation can identify the same destination while
    // the main view changes. Text-only and main-content controls remain local.
    const region = control.parentElement?.closest?.('nav, aside, [role="navigation"]');
    const label = normalizeText(control.getAttribute('aria-label') || control.getAttribute('title'));
    if (!region || control.closest('main, [role="main"]') || !label || label.length > 160) return null;
    return MiddleClickLearning.lookupAcrossPaths(learnedEntries, location.origin, key);
  }

  function sendMessage(message) {
    try { chrome.runtime.sendMessage(message)?.catch?.(() => {}); } catch { /* Extension may have reloaded. */ }
  }

  function extensionMiddleUrl(e) {
    const native = findNativeAnchor(e);
    if (native && toWebUrl(native.getAttribute('href'))) {
      // Retain the small ChatGPT workaround for foreground sidebar tabs.
      if (!isChatGPTHost() || !native.closest('nav, aside, [class*="sidebar"], [id*="sidebar"]')) return null;
    }
    return resolveUrl(e);
  }

  function suppressEvent(e) {
    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }

  function notify(reason) {
    globalThis.MiddleClickFeedback?.show(reason);
  }

  function requestConfirmedProbe(e) {
    const control = clickControl(e);
    if (!control || blockedControl(control, e.target) || control.closest('form') || control.form) return false;
    // Native links retain browser handling, including links outside ChatGPT.
    if (findNativeAnchor(e) && toWebUrl(findNativeAnchor(e).getAttribute('href'))) return false;
    const key = uniqueLearningKey(control);
    if (!key) { notify('ambiguous'); return false; }
    suppressEvent(e);
    if (lastProbeGesture.control === control && Date.now() - lastProbeGesture.time < 250) return true;
    lastProbeGesture = { control, time: Date.now() };
    if (activeProbe) { notify('busy'); return true; }
    if (learnedEntries.some(entry => entry.origin === location.origin && entry.key === key && entry.ambiguous)) {
      notify('ambiguous'); return true;
    }
    if (window !== top || chrome.extension?.inIncognitoContext || !MiddleClickLearning.learnableUrl(location.href)) {
      notify('unavailable'); return true;
    }
    const sourceUrl = location.href;
    const origin = location.origin;
    const attempt = ++probeAttempt;
    activeProbe = true;
    const stillCurrent = () => activeProbe && probeAttempt === attempt && location.href === sourceUrl &&
      control.isConnected && uniqueLearningKey(control) === key;
    Promise.resolve().then(async () => {
      // A first middle click may arrive before storage finishes loading.
      // Recheck the cache before asking permission or executing a discovery.
      await learningReady;
      if (!stillCurrent()) { if (probeAttempt === attempt) activeProbe = false; return; }
      const cached = resolveUrl(e);
      if (cached) {
        activeProbe = false;
        sendMessage({ type: 'maybeOpenOnMiddle', url: cached, requestId: Date.now() + ':' + (++requestSequence) });
        return;
      }
      // MAIN-world inspection is read-only. Unknown syntax/state returns to the
      // existing permission/learning path without executing an event handler.
      let analyzed = null;
      try { analyzed = await globalThis.MiddleClickEventClient?.resolve(control, sourceUrl); }
      catch { /* A broken/unavailable analyzer must retain normal learning. */ }
      if (!stillCurrent()) { if (probeAttempt === attempt) activeProbe = false; return; }
      if (analyzed) {
        activeProbe = false;
        sendMessage({ type: 'maybeOpenOnMiddle', url: analyzed, requestId: Date.now() + ':' + (++requestSequence) });
        return;
      }
      const permission = await chrome.runtime.sendMessage({ type: 'getSiteLearningPermission', origin });
      if (!stillCurrent()) { if (probeAttempt === attempt) activeProbe = false; return; }
      if (!permission?.ok) { activeProbe = false; notify('unavailable'); return; }
      if (!permission.allowed) {
        // This first consent is explicitly SITE-wide, including future unknown
        // targets. No target is clicked unless this grant is saved successfully.
        if (typeof window.confirm !== 'function' || !window.confirm(
          `${origin} で自動学習を許可しますか？\n\n` +
          '今後このサイトでは、未学習の項目も確認なしで左クリック動作を実行して移動先を調べます。\n' +
          '元のページへ戻ってから移動先を別タブで開き、次回から学習結果を使います。\n\n' +
          'クリックに伴う送信・削除・データ変更は、ページを戻しても取り消せません。\n' +
          '許可はこのサイトに保存され、右クリックメニューから取り消せます。')) {
          activeProbe = false; lastProbeGesture.time = Date.now(); return;
        }
        lastProbeGesture.time = Date.now();
        if (!stillCurrent()) { activeProbe = false; notify('unavailable'); return; }
        const grant = await chrome.runtime.sendMessage({ type: 'grantSiteLearningPermission', origin, confirmed: true });
        if (!stillCurrent()) { if (probeAttempt === attempt) activeProbe = false; return; }
        if (!grant?.ok) { activeProbe = false; notify('permission-save-failed'); return; }
      }
      if (!stillCurrent()) { if (probeAttempt === attempt) activeProbe = false; return; }
      return chrome.runtime.sendMessage({ type: 'beginSiteNavigationProbe', key,
        sourceUrl, entryKey: window.navigation?.currentEntry?.key || '' });
    }).then(response => {
      if (!response || probeAttempt !== attempt || !activeProbe) return;
      if (!response?.ok) { activeProbe = false; notify(response?.reason || 'unavailable'); return; }
      if (!stillCurrent()) {
        activeProbe = false;
        sendMessage({ type: 'cancelNavigationLearning' });
        notify('unavailable');
        return;
      }
      notify('checking');
      // The origin grant is rechecked by the background before every discovery.
      control.click();
    }).catch(() => { if (probeAttempt === attempt) { activeProbe = false; notify('unavailable'); } });
    return true;
  }

  function handleResolvedMiddle(e) {
    if (e.button !== 1 || hasMods(e)) return;
    if (requestDriveOpen(e)) return;
    const url = extensionMiddleUrl(e);
    if (!url) { requestConfirmedProbe(e); return; }
    suppressEvent(e);
    const now = performance.now();
    if (lastHandledMiddle.url === url && now - lastHandledMiddle.time < 120) return;
    lastHandledMiddle = { url, time: now };
    sendMessage({ type: 'maybeOpenOnMiddle', url, requestId: Date.now() + ':' + (++requestSequence) });
  }

  function suppressResolvedMiddle(e) {
    if (e.button === 1 && !hasMods(e) && (extensionMiddleUrl(e) ||
      (lastDriveGesture.control === clickControl(e) && performance.now() - lastDriveGesture.time < 5000) ||
      (lastProbeGesture.control === clickControl(e) && Date.now() - lastProbeGesture.time < 12000))) suppressEvent(e);
  }

  document.addEventListener('pointerdown', handleResolvedMiddle, { capture: true, passive: false });
  document.addEventListener('mousedown', handleResolvedMiddle, { capture: true, passive: false });
  document.addEventListener('mouseup', suppressResolvedMiddle, { capture: true, passive: false });
  document.addEventListener('auxclick', suppressResolvedMiddle, { capture: true, passive: false });

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return;
    if (message?.type === 'driveOpenFeedback') {
      if (driveOpen?.requestId === message.requestId) {
        driveOpen = null;
        if (message.reason !== 'drive-opened') notify(message.reason);
      }
    } else if (message?.type === 'navigationProbeFeedback') {
      activeProbe = false;
      notify(message.reason);
    } else if (message?.type === 'navigationProbeLearned') {
      learnedRevision++;
      learnedEntries = MiddleClickLearning.remember(learnedEntries, location.origin, message.key, message.destination);
    } else if (message?.type === 'readConfirmedNavigationEntry') {
      respond({ url: location.href, entryKey: window.navigation?.currentEntry?.key || '' });
    } else if (message?.type === 'restoreConfirmedNavigationProbe') {
      const source = MiddleClickLearning.learnableUrl(message.sourceUrl);
      const navigation = window.navigation;
      const entry = source?.origin === location.origin && navigation?.entries().find(item =>
        item.key === message.entryKey && item.url === source.href);
      if (!entry || entry.key === navigation.currentEntry?.key) { respond({ traversing: false }); return; }
      respond({ traversing: true });
      try { navigation.traverseTo(entry.key).committed.catch(() => {}); } catch { /* Background can reload the source URL. */ }
    }
  });

  function setupNavigationLearning() {
    if (!/^https?:$/.test(location.protocol) || chrome.extension?.inIncognitoContext) return;
    const { STORAGE_KEY, clean } = MiddleClickLearning;
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== 'local' || !Object.hasOwn(changes, STORAGE_KEY)) return;
      learnedRevision++;
      learnedEntries = clean(changes[STORAGE_KEY].newValue);
    });
    const initialRevision = learnedRevision;
    learningReady = chrome.storage.local.get(STORAGE_KEY).then(data => {
      if (learnedRevision === initialRevision) learnedEntries = clean(data[STORAGE_KEY]);
    }).catch(() => {});

    const cancel = () => { cancelDriveOpen(); activeProbe = false; probeAttempt++; sendMessage({ type: 'cancelNavigationLearning' }); };
    document.addEventListener('click', e => {
      if (!e.isTrusted) return;
      cancelDriveOpen();
      activeProbe = false;
      probeAttempt++;
      const control = clickControl(e);
      if (e.button !== 0 || hasMods(e) || blockedControl(control, e.target) || driveItemId(control) || codexDestination(control) || staticUrl(e, control)) {
        cancel();
        return;
      }
      const key = uniqueLearningKey(control);
      if (!key || !MiddleClickLearning.learnableUrl(location.href)) { cancel(); return; }
      sendMessage({ type: 'observeNavigationClick', key, sourceUrl: location.href });
    }, true);
    document.addEventListener('submit', e => { if (e.isTrusted) cancel(); }, true);
    document.addEventListener('keydown', e => { if (e.isTrusted) cancel(); }, true);
  }

  function setupChatGPTRequestedMode() {
    if (!isChatGPTHost() || window !== top || location.pathname !== "/") return;
    if (location.hash !== "#middleclick-plus-codex") return;

    // Only this known navigation control is activated, in the newly opened
    // tab. Never execute arbitrary click handlers to discover a destination.
    let attempts = 0;
    const selectCodex = () => {
      if (location.pathname !== "/") return;
      const button = document.querySelector('button[data-sidebar-destination="builtin:codex"]');
      if (document.readyState === "complete" && button) {
        if (button.hasAttribute("data-selected")) {
          if (location.hash === "#middleclick-plus-codex") {
            history.replaceState(history.state, "", location.pathname + location.search);
          }
          return;
        }
        button.click();
      }
      // Hydration may attach handlers after the button first appears.
      if (++attempts < 150) setTimeout(selectCodex, 100);
      else console.warn("MiddleClick+: Codex mode selection timed out.");
    };
    selectCodex();
  }

  setupNavigationLearning();
  setupChatGPTRequestedMode();
})();
