(function () {
  'use strict';
  const api = globalThis.MiddleClickEventAnalysis;
  if (!api || window !== top || !/^https?:$/.test(location.protocol)) return;
  const QUERY = 'middleclick-plus:event-query:v1', REPLY = 'middleclick-plus:event-reply:v1';
  const registry = new api.Registry();
  const fetched = new Set();
  let preparing = null, totalBytes = 0, queued = false, lastWarm = 0, warmedSourceCount = -1;
  const own = api.own;
  const controlSelector = 'button, [role="button"], [role="link"], a';

  function eligible(control) {
    return control instanceof Element && control.matches(controlSelector) && control.isConnected &&
      !control.closest('form, input, textarea, select, [contenteditable="true"]') && !control.form &&
      !control.hasAttribute('disabled') && control.getAttribute('aria-disabled') !== 'true' && !control.hasAttribute('aria-haspopup');
  }
  function scriptUrls() {
    const urls = new Set();
    const add = value => {
      try {
        if (typeof value !== 'string') return;
        const url = new URL(value, location.href);
        // Only source assets already declared/loaded by this page, never API data.
        if (url.origin === location.origin && /\.m?js$/.test(url.pathname) && !url.search && !url.hash) urls.add(url.href);
      } catch { /* Invalid metadata. */ }
    };
    const manifest = own(window, '__reactRouterManifest');
    const entry = own(manifest, 'entry');
    add(own(entry, 'module'));
    const imports = own(entry, 'imports');
    if (Array.isArray(imports)) imports.slice(0, 64).forEach(add);
    const routes = own(manifest, 'routes'), loaded = own(window, '__reactRouterRouteModules');
    if (routes && typeof routes === 'object' && loaded && typeof loaded === 'object') {
      for (const id of Object.keys(loaded).slice(0, 20)) {
        const route = own(routes, id);
        add(own(route, 'module'));
        const dependencies = own(route, 'imports');
        if (Array.isArray(dependencies)) dependencies.slice(0, 64).forEach(add);
      }
    }
    for (const script of document.scripts) add(script.src);
    for (const resource of performance.getEntriesByType('resource')) if (resource.initiatorType === 'script') add(resource.name);
    return [...urls].slice(0, 64);
  }
  async function prepare() {
    if (preparing) return preparing;
    const urls = scriptUrls().filter(url => !fetched.has(url));
    if (!urls.length) return;
    preparing = (async () => {
      let index = 0;
      await Promise.allSettled(Array.from({ length: 3 }, async () => {
        while (index < urls.length && fetched.size < 64 && totalBytes < 20000000) {
          const url = urls[index++]; fetched.add(url);
          const abort = new AbortController(), timer = setTimeout(() => abort.abort(), 4000);
          try {
            const response = await fetch(url, { cache: 'force-cache', credentials: 'same-origin', signal: abort.signal, redirect: 'error' });
            if (!response.ok || !/(?:javascript|ecmascript)/i.test(response.headers.get('content-type') || '')) continue;
            const size = Number(response.headers.get('content-length') || 0);
            if (size > 2500000) continue;
            const source = await response.text();
            if (source.length > 2500000 || totalBytes + source.length > 20000000) continue;
            totalBytes += source.length;
            registry.addSource(source, url);
          } catch { /* No other transport or code execution fallback. */ }
          finally { clearTimeout(timer); }
        }
      }));
    })().finally(() => { preparing = null; });
    return preparing;
  }
  function inspect(control) {
    const fiberKey = Object.getOwnPropertyNames(control).find(key => key.startsWith('__reactFiber$'));
    let fiber = fiberKey ? own(control, fiberKey) : null;
    const propsKey = Object.getOwnPropertyNames(control).find(key => key.startsWith('__reactProps$'));
    const currentProps = propsKey ? own(control, propsKey) : null;
    const currentHandler = own(currentProps, 'onClick');
    if (fiberKey && (!propsKey || typeof currentHandler !== 'function')) fiber = null;
    if (fiber && typeof currentHandler === 'function' && own(own(fiber, 'memoizedProps'), 'onClick') !== currentHandler) {
      const alternate = own(fiber, 'alternate');
      // React retains both trees. Never combine an old host handler with new
      // compiler values, or vice versa.
      fiber = own(own(alternate, 'memoizedProps'), 'onClick') === currentHandler ? alternate : null;
    }
    const frames = [], handlers = [], navigationFunctions = [], forwardingFunctions = [];
    const router = own(window, '__reactRouterDataRouter'), navigate = own(router, 'navigate');
    if (typeof navigate === 'function') navigationFunctions.push(navigate);
    let canCollectHandler = true;
    const seen = new Set();
    for (let depth = 0; fiber && typeof fiber === 'object' && depth < 90 && !seen.has(fiber); depth++, fiber = own(fiber, 'return')) {
      seen.add(fiber);
      const type = own(fiber, 'type'), props = own(fiber, 'memoizedProps');
      if (depth > 0 && typeof type === 'string') canCollectHandler = false;
      if (canCollectHandler) {
        const handler = own(props, 'onClick');
        if (typeof handler === 'function' && !handlers.includes(handler)) handlers.push(handler);
      }
      const queue = own(fiber, 'updateQueue'), memo = own(queue, 'memoCache'), data = own(memo, 'data');
      const caches = Array.isArray(data) ? data.slice(0, 8).filter(Array.isArray) : [];
      for (const candidate of [type, own(type, 'render'), own(type, 'type')]) {
        if (typeof candidate !== 'function') continue;
        const source = api.functionSource(candidate);
        if (source && source.length <= 180000) frames.push({ source, props, caches });
      }
      let hook = own(fiber, 'memoizedState');
      for (let count = 0; hook && typeof hook === 'object' && count < 180; count++, hook = own(hook, 'next')) {
        const state = own(hook, 'memoizedState');
        if (!Array.isArray(state) || typeof state[0] !== 'function' || !Array.isArray(state[1])) continue;
        if (router && state[1].some(value => value === router || (typeof navigate === 'function' && own(value, 'navigate') === navigate))) forwardingFunctions.push(state[0]);
      }
    }
    // The host handler must be followed, never borrowed from an ancestor control.
    if (!fiberKey && !handlers.length) {
      const inline = control.onclick;
      if (typeof inline === 'function') handlers.push(inline);
    }
    return { frames, handler: handlers[0], navigationFunctions, forwardingFunctions, baseUrl: location.href, registry };
  }
  function analyze(control) {
    if (!eligible(control)) return { url: null, reason: 'ineligible' };
    try {
      const context = inspect(control);
      if (!context.handler) return { url: null, reason: 'no-handler' };
      return { ...new api.Resolver(context).resolve(context.handler), needsSources: context.frames.length > 0 };
    } catch { return { url: null, reason: 'unsupported-handler' }; }
  }
  document.addEventListener(QUERY, async event => {
    const control = event.target;
    let query;
    try { query = JSON.parse(event.detail); } catch { return; }
    if (!query || typeof query.id !== 'string' || query.id.length > 100 || query.sourceUrl !== location.href || !eligible(control)) return;
    const sourceUrl = location.href;
    let result = analyze(control);
    if (!result.url && result.needsSources) { await prepare(); if (sourceUrl === location.href && control.isConnected) result = analyze(control); }
    if (sourceUrl !== location.href || !control.isConnected) return;
    control.dispatchEvent(new CustomEvent(REPLY, { bubbles: true, detail: JSON.stringify({ id: query.id, sourceUrl, url: result.url, reason: result.reason }) }));
  }, true);

  function warm() {
    if (queued || Date.now() - lastWarm < 1500) return;
    queued = true;
    setTimeout(async () => {
      queued = false; lastWarm = Date.now();
      if (document.visibilityState === 'hidden') return;
      if (!document.querySelector('[role="navigation"], nav, aside')) return;
      const hasReact = [...document.querySelectorAll(controlSelector)].slice(0, 150).some(control =>
        control.closest('nav, aside, [role="navigation"]') && Object.getOwnPropertyNames(control).some(key => key.startsWith('__reactFiber$')));
      if (!hasReact) return;
      await prepare();
      if (warmedSourceCount === registry.files.length) return;
      warmedSourceCount = registry.files.length;
      // A few mounted controls warm the relevant module ASTs without walking
      // every sidebar action or retaining a URL computed from old state.
      let count = 0;
      for (const control of document.querySelectorAll(controlSelector)) {
        if (count >= 4) break;
        if (eligible(control) && control.closest('nav, aside, [role="navigation"]')) {
          analyze(control); count++;
          await new Promise(resolve => setTimeout(resolve, 0));
        }
      }
    }, 300);
  }
  document.addEventListener('DOMContentLoaded', warm, { once: true });
  document.addEventListener('visibilitychange', warm);
  document.addEventListener('pointerover', event => { if (event.target?.closest?.(controlSelector)) warm(); }, { passive: true });
  new MutationObserver(warm).observe(document, { childList: true, subtree: true });
  warm();
})();
