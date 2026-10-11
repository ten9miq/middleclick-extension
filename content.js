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
  const CHATGPT_BRIDGE_SOURCE = "middleclick-plus-chatgpt-bridge-v1";
  const CHATGPT_PROJECT_ID_RE = /g-p-[0-9a-z-]+/i;
  const CHATGPT_CONVERSATION_PATH_RE = /\/c\/([0-9a-f-]{20,})(?:[/?#]|$)/i;
  const CHATGPT_PROJECT_PATH_RE = /\/g\/(g-p-[0-9a-z-]+)\/project(?:[/?#]|$)/i;

  const CHATGPT_FIXED_ROUTES = new Map([
    ["chatgpt", "/"],
    ["home", "/"],
    ["\u30db\u30fc\u30e0", "/"],
    ["new chat", "/"],
    ["start new chat", "/"],
    ["\u65b0\u3057\u3044\u30c1\u30e3\u30c3\u30c8", "/"],
    ["\u65b0\u898f\u30c1\u30e3\u30c3\u30c8", "/"],
    ["plugins", "/plugins"],
    ["\u30d7\u30e9\u30b0\u30a4\u30f3", "/plugins"],
    ["schedule", "/schedules"],
    ["scheduled", "/schedules"],
    ["schedules", "/schedules"],
    ["\u30b9\u30b1\u30b8\u30e5\u30fc\u30eb", "/schedules"],
    ["\u30b9\u30b1\u30b8\u30e5\u30fc\u30eb\u6e08\u307f", "/schedules"]
  ]);

  const chatGPTMappings = new Map();
  let requestSequence = 0;
  let lastHandledMiddle = { url: "", time: 0 };

  function normalizeText(value) {
    return String(value ?? "").replace(/\s+/g, " ").trim();
  }

  function normalizeKey(value) {
    return normalizeText(value).toLocaleLowerCase();
  }

  function isChatGPTHost() {
    const host = location.hostname.toLowerCase();
    return host === "chatgpt.com" || host === "www.chatgpt.com";
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
    if (tag === "a" || tag === "area") {
      const url = toWebUrl(el.getAttribute("href"));
      if (url) return url;
    }

    for (const attr of URL_ATTRS) {
      const url = toWebUrl(el.getAttribute(attr));
      if (url) return url;
    }

    if (el.dataset) {
      for (const [key, value] of Object.entries(el.dataset)) {
        const normalizedKey = key.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`);
        if (!DATA_URL_KEY.test(normalizedKey)) continue;
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

  function chatGPTRouteFromValue(value) {
    const raw = String(value ?? "").trim();
    if (!raw) return null;

    const projectPath = raw.match(CHATGPT_PROJECT_PATH_RE);
    if (projectPath) return `/g/${projectPath[1]}/project`;

    const conversationPath = raw.match(CHATGPT_CONVERSATION_PATH_RE);
    if (conversationPath) return `/c/${conversationPath[1]}`;

    const projectId = raw.match(CHATGPT_PROJECT_ID_RE);
    if (projectId) return `/g/${projectId[0]}/project`;

    return null;
  }

  function rememberChatGPT(name, route) {
    const key = normalizeKey(name);
    route = chatGPTRouteFromValue(route);
    if (!key || !route) return;

    let urls = chatGPTMappings.get(key);
    if (!urls) {
      urls = new Set();
      chatGPTMappings.set(key, urls);
    }
    urls.add(route);
  }

  function lookupChatGPT(name) {
    const key = normalizeKey(name);
    if (!key) return null;

    const fixed = CHATGPT_FIXED_ROUTES.get(key);
    if (fixed) return fixed;

    const urls = chatGPTMappings.get(key);
    if (!urls || urls.size !== 1) return null;
    return [...urls][0];
  }

  function isChatGPTMenuControl(target) {
    if (!(target instanceof Element)) return false;

    if (target.closest('[aria-haspopup="menu"]')) return true;

    const button = target.closest("button");
    if (!button) return false;

    const label = normalizeKey(button.getAttribute("aria-label") ?? button.getAttribute("title"));
    return (
      label === "more" ||
      label === "options" ||
      label === "\u305d\u306e\u4ed6" ||
      label === "\u30aa\u30d7\u30b7\u30e7\u30f3" ||
      label.includes("more options") ||
      label.includes("\u305d\u306e\u4ed6\u306e\u30aa\u30d7\u30b7\u30e7\u30f3")
    );
  }

  function isChatGPTSidebarTarget(target, event) {
    if (!(target instanceof Element)) return false;

    try {
      if (target.closest([
        ".sidebar-item",
        "aside",
        "nav",
        '[data-testid*="sidebar"]',
        '[data-testid*="history"]',
        '[class*="sidebar"]',
        '[id*="sidebar"]'
      ].join(","))) return true;
    } catch {
      // Continue to geometry fallback.
    }

    return (
      Number.isFinite(event?.clientX) &&
      event.clientX >= 0 &&
      event.clientX <= 440
    );
  }

  function chatGPTCandidateTexts(target) {
    const result = [];
    const seen = new Set();
    let element = target instanceof Element ? target : null;

    for (let depth = 0; element && depth < 7; depth++, element = element.parentElement) {
      const values = [
        element.getAttribute?.("aria-label"),
        element.getAttribute?.("title"),
        element.textContent
      ];

      for (const value of values) {
        const text = normalizeText(value);
        if (!text || text.length > 300) continue;
        const key = normalizeKey(text);
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(text);
      }
    }

    return result;
  }

  function chatGPTUrlFromAttributes(target) {
    let element = target instanceof Element ? target : null;

    for (let depth = 0; element && depth < 8; depth++, element = element.parentElement) {
      for (const attr of element.attributes ?? []) {
        const route = chatGPTRouteFromValue(attr.value);
        if (route) return route;
      }
    }

    return null;
  }

  function resolveChatGPTUrl(e) {
    if (!isChatGPTHost()) return null;
    if (!isChatGPTSidebarTarget(e.target, e)) return null;
    if (isChatGPTMenuControl(e.target)) return null;

    const attrRoute = chatGPTUrlFromAttributes(e.target);
    if (attrRoute) return toWebUrl(attrRoute);

    for (const text of chatGPTCandidateTexts(e.target)) {
      const route = lookupChatGPT(text);
      if (route) return toWebUrl(route);
    }

    return null;
  }

  function resolveUrl(e) {
    const elements = getEventElements(e);

    for (const el of elements) {
      const url = urlFromElementAttributes(el);
      if (url) return url;
    }

    const chatGPTUrl = resolveChatGPTUrl(e);
    if (chatGPTUrl) return chatGPTUrl;

    const formUrl = urlFromGetForm(e.target);
    if (formUrl) return formUrl;

    for (const el of elements.slice(0, 8)) {
      const url = uniqueDescendantUrl(el);
      if (url) return url;
    }

    return null;
  }

  function maybeOpen(url) {
    if (!url) return;
    chrome.runtime.sendMessage({
      type: "maybeOpenOnMiddle",
      url,
      requestId: `${Date.now()}:${++requestSequence}`
    });
  }

  function shouldForceExtensionBackground(e, nativeAnchor) {
    if (!isChatGPTHost()) return false;
    if (!isChatGPTSidebarTarget(e.target, e)) return false;
    if (isChatGPTMenuControl(e.target)) return false;

    // ChatGPT sometimes handles sidebar navigation itself even when an <a>
    // exists. Letting the page/native handler win can create an active tab.
    // For sidebar navigation we therefore route the middle click through the
    // extension so chrome.tabs.create({ active: false }) is authoritative.
    if (nativeAnchor && toWebUrl(nativeAnchor.getAttribute?.("href"))) return true;
    return Boolean(resolveChatGPTUrl(e));
  }

  function handleResolvedMiddle(e) {
    if (e.button !== 1 || hasMods(e)) return;

    const native = findNativeAnchor(e);
    const forceBackground = shouldForceExtensionBackground(e, native);
    if (!forceBackground && native && toWebUrl(native.getAttribute?.("href"))) return;

    const url = forceBackground
      ? (toWebUrl(native?.getAttribute?.("href")) || resolveChatGPTUrl(e) || resolveUrl(e))
      : resolveUrl(e);
    if (!url) return;

    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();

    const now = performance.now();
    if (lastHandledMiddle.url === url && now - lastHandledMiddle.time < 120) return;
    lastHandledMiddle = { url, time: now };
    maybeOpen(url);
  }

  function suppressResolvedMiddle(e) {
    if (e.button !== 1 || hasMods(e)) return;

    const native = findNativeAnchor(e);
    const forceBackground = shouldForceExtensionBackground(e, native);
    if (!forceBackground && native && toWebUrl(native.getAttribute?.("href"))) return;

    const url = forceBackground
      ? (toWebUrl(native?.getAttribute?.("href")) || resolveChatGPTUrl(e) || resolveUrl(e))
      : resolveUrl(e);
    if (!url) return;

    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }

  document.addEventListener("auxclick", (e) => {
    if (e.button !== 1 || hasMods(e)) return;

    const a = findNativeAnchor(e);
    if (!a || a.hasAttribute?.("download")) return;

    // ChatGPT sidebar middle clicks are handled at pointerdown/mousedown and
    // intentionally forced through the extension's background-tab path.
    if (shouldForceExtensionBackground(e, a)) return;

    const url = toWebUrl(a.getAttribute?.("href"));
    if (url) maybeOpen(url);
  }, { capture: true, passive: true });

  document.addEventListener("pointerdown", handleResolvedMiddle, { capture: true, passive: false });
  document.addEventListener("mousedown", handleResolvedMiddle, { capture: true, passive: false });
  document.addEventListener("mouseup", suppressResolvedMiddle, { capture: true, passive: false });
  document.addEventListener("auxclick", suppressResolvedMiddle, { capture: true, passive: false });

  function learnChatGPTDomLinks(root) {
    if (!isChatGPTHost() || !root?.querySelectorAll) return;

    let anchors;
    try {
      anchors = root.querySelectorAll('a[href*="/c/"], a[href*="/g/"][href*="/project"]');
    } catch {
      return;
    }

    let count = 0;
    for (const anchor of anchors) {
      if (++count > 500) break;
      const route = chatGPTRouteFromValue(anchor.getAttribute("href"));
      if (!route) continue;

      const names = [
        anchor.getAttribute("aria-label"),
        anchor.getAttribute("title"),
        anchor.textContent,
        anchor.closest?.('[data-testid], [role="link"], li, div')?.textContent
      ];

      for (const name of names) {
        const text = normalizeText(name);
        if (text && text.length <= 300) rememberChatGPT(text, route);
      }
    }
  }

  function setupChatGPTLearning() {
    if (!isChatGPTHost() || window !== top) return;

    window.addEventListener("message", (event) => {
      if (event.source !== window) return;
      const data = event.data;
      if (data?.source !== CHATGPT_BRIDGE_SOURCE || data?.type !== "mapping") return;
      if (typeof data.name !== "string" || typeof data.url !== "string") return;
      rememberChatGPT(data.name, data.url);
    });

    window.postMessage({ source: CHATGPT_BRIDGE_SOURCE, type: "ready" }, location.origin);

    let domScanTimer = 0;
    const scheduleDomScan = () => {
      clearTimeout(domScanTimer);
      domScanTimer = setTimeout(() => learnChatGPTDomLinks(document), 100);
    };

    if (document.documentElement) {
      learnChatGPTDomLinks(document);
      new MutationObserver(scheduleDomScan).observe(document.documentElement, {
        childList: true,
        subtree: true
      });
    } else {
      document.addEventListener("DOMContentLoaded", () => {
        learnChatGPTDomLinks(document);
        if (document.documentElement) {
          new MutationObserver(scheduleDomScan).observe(document.documentElement, {
            childList: true,
            subtree: true
          });
        }
      }, { once: true });
    }

    document.addEventListener("click", (event) => {
      if (event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      if (!isChatGPTSidebarTarget(event.target, event)) return;
      if (isChatGPTMenuControl(event.target)) return;

      const names = chatGPTCandidateTexts(event.target).slice(0, 4);
      if (!names.length) return;

      const before = location.pathname;
      const delays = [50, 150, 350, 800, 1600];

      for (const delay of delays) {
        setTimeout(() => {
          if (location.pathname === before) return;
          const route = chatGPTRouteFromValue(location.pathname);
          if (!route) return;
          for (const name of names) rememberChatGPT(name, route);
        }, delay);
      }
    }, true);
  }

  setupChatGPTLearning();
})();
