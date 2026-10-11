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
  let requestSequence = 0;
  let lastHandledMiddle = { url: "", time: 0 };

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

  function resolveUrl(e) {
    const elements = getEventElements(e);

    for (const el of elements) {
      const url = urlFromElementAttributes(el);
      if (url) return url;
    }

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

  function handleResolvedMiddle(e) {
    if (e.button !== 1 || hasMods(e)) return;

    const native = findNativeAnchor(e);
    if (native && toWebUrl(native.getAttribute?.("href"))) return;

    const url = resolveUrl(e);
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
    if (native && toWebUrl(native.getAttribute?.("href"))) return;

    const url = resolveUrl(e);
    if (!url) return;

    e.preventDefault();
    e.stopPropagation();
    e.stopImmediatePropagation();
  }

  document.addEventListener("auxclick", (e) => {
    if (e.button !== 1 || hasMods(e)) return;

    const a = findNativeAnchor(e);
    if (!a || a.hasAttribute?.("download")) return;

    const url = toWebUrl(a.getAttribute?.("href"));
    if (url) maybeOpen(url);
  }, { capture: true, passive: true });

  document.addEventListener("mousedown", handleResolvedMiddle, { capture: true, passive: false });
  document.addEventListener("mouseup", suppressResolvedMiddle, { capture: true, passive: false });
  document.addEventListener("auxclick", suppressResolvedMiddle, { capture: true, passive: false });

})();
