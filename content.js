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
  let requestSequence = 0;
  let lastHandledMiddle = { url: '', time: 0 };
  let lastProbeGesture = { control: null, time: 0 };
  let activeProbe = false;
  let probeAttempt = 0;

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
    const driveUrl = driveItemDestination(control);
    if (driveUrl) return driveUrl;
    const elements = scopedElements(e, control);
    for (const element of elements) {
      const url = urlFromElementAttributes(element);
      if (url) return url;
    }
    const formUrl = urlFromGetForm(e.target);
    if (formUrl) return formUrl;
    return uniqueDescendantUrl(control || elements[0]);
  }

  function driveItemDestination(control) {
    // Drive list rows and grid cells expose an item ID, not an href. The
    // /open endpoint resolves both files and folders without guessing a type
    // from localized labels or icon artwork. Never borrow a parent item's ID
    // when the clicked control is its owner button, toolbar, or action menu.
    if (location.origin !== 'https://drive.google.com' || !/^\/drive(?:\/|$)/.test(location.pathname) ||
      !control || !/^(row|gridcell)$/.test(control.getAttribute('role') || '') ||
      control.getAttribute('data-target') !== 'doc' || !control.hasAttribute('data-selectable') ||
      control.closest('form') || control.form) return null;
    const id = control.getAttribute('data-id') || '';
    if (!/^[A-Za-z0-9_-]{10,200}$/.test(id)) return null;
    const url = new URL('https://drive.google.com/open');
    url.searchParams.set('id', id);
    const account = location.pathname.match(/^\/drive\/u\/(\d+)(?:\/|$)/)?.[1] ||
      new URLSearchParams(location.search).get('authuser');
    if (account) url.searchParams.set('authuser', account);
    return url.href;
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

  function uniqueLearningKey(control) {
    const key = fingerprint(control);
    if (!key) return null;
    const candidates = document.querySelectorAll(CLICKABLE_SELECTOR);
    if (candidates.length > 1000) return null;
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
      (lastProbeGesture.control === clickControl(e) && Date.now() - lastProbeGesture.time < 12000))) suppressEvent(e);
  }

  document.addEventListener('pointerdown', handleResolvedMiddle, { capture: true, passive: false });
  document.addEventListener('mousedown', handleResolvedMiddle, { capture: true, passive: false });
  document.addEventListener('mouseup', suppressResolvedMiddle, { capture: true, passive: false });
  document.addEventListener('auxclick', suppressResolvedMiddle, { capture: true, passive: false });

  chrome.runtime.onMessage.addListener((message, sender, respond) => {
    if (sender.id !== chrome.runtime.id) return;
    if (message?.type === 'navigationProbeFeedback') {
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
    chrome.storage.local.get(STORAGE_KEY).then(data => {
      if (learnedRevision === initialRevision) learnedEntries = clean(data[STORAGE_KEY]);
    }).catch(() => {});

    const cancel = () => { activeProbe = false; probeAttempt++; sendMessage({ type: 'cancelNavigationLearning' }); };
    document.addEventListener('click', e => {
      if (!e.isTrusted) return;
      activeProbe = false;
      probeAttempt++;
      const control = clickControl(e);
      if (e.button !== 0 || hasMods(e) || blockedControl(control, e.target) || codexDestination(control) || staticUrl(e, control)) {
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
