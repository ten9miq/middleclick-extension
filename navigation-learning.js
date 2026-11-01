(function () {
  "use strict";

  const STORAGE_KEY = "middleclickLearnedNavigationV1";
  const SITE_PERMISSION_KEY = "middleclickSiteLearningPermissionsV1";
  const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
  const MAX_ENTRIES = 500;
  const ENTITY_ATTRIBUTE = /^data-(?:account|tenant|organization|org|workspace|project|space|board|folder|collection|conversation|thread|chat|document|file|record|row|item|entity|resource)-(?:id|key)$/;

  function entityIds(attributes) {
    const result = [];
    for (const attr of attributes ?? []) {
      if (!ENTITY_ATTRIBUTE.test(attr.name)) continue;
      const value = attr.value;
      // Bare row numbers and common generated UI IDs are not ownership proof.
      if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9_.:-]{1,159}$/i.test(value) || !/[a-z]/i.test(value) ||
        /^(?:true|false|null|undefined|none|default|unknown)$/i.test(value) ||
        /^(?:radix[-_:]|react[-_:]|headlessui[-_:]|mui[-_:]|rc[-_:]|(?:row|item|index)[-_:]?\d+$)/i.test(value)) return null;
      result.push([attr.name, value]);
    }
    return result.sort((a, b) => a[0].localeCompare(b[0]));
  }

  function webUrl(value, base) {
    try {
      const url = new URL(value, base);
      if (!/^https?:$/.test(url.protocol) || url.username || url.password) return null;
      return url;
    } catch {
      return null;
    }
  }

  function learnableUrl(value) {
    const url = webUrl(value);
    if (!url || url.href.length > 4096) return null;
    if (/(?:^|\/)(?:login|logout|signout|signin|oauth|authorize|callback)(?:\/|$)/i.test(url.pathname)) return null;
    for (const key of url.searchParams.keys()) {
      if (/token|password|secret|session|csrf|assertion|(?:^|_)code$/i.test(key)) return null;
    }
    return url;
  }

  function clean(value, now = Date.now()) {
    if (value?.version !== 1 || !Array.isArray(value.entries)) return [];
    return value.entries.filter(entry => {
      if (!entry || typeof entry.key !== "string" || !entry.key || entry.key.length > 2048) return false;
      const origin = webUrl(entry.origin);
      if (!origin || origin.origin !== entry.origin) return false;
      if (!Number.isFinite(entry.updatedAt) || now - entry.updatedAt > MAX_AGE_MS || entry.updatedAt > now) return false;
      if (entry.ambiguous === true) return entry.url === null;
      const url = learnableUrl(entry.url);
      return Boolean(url && url.origin === entry.origin);
    }).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, MAX_ENTRIES);
  }

  function remember(entries, origin, key, destination, now = Date.now()) {
    const url = learnableUrl(destination);
    if (!url || url.origin !== origin || typeof key !== "string" || !key || key.length > 2048) return entries;
    const result = clean({ version: 1, entries }, now);
    const previous = result.find(entry => entry.origin === origin && entry.key === key);
    const ambiguous = Boolean(previous && (previous.ambiguous || previous.url !== url.href));
    return [{ origin, key, url: ambiguous ? null : url.href, ambiguous, updatedAt: now },
      ...result.filter(entry => entry !== previous)].slice(0, MAX_ENTRIES);
  }

  function lookup(entries, origin, key, now = Date.now()) {
    const matches = clean({ version: 1, entries }, now).filter(entry => entry.origin === origin && entry.key === key);
    if (matches.length !== 1 || matches[0].ambiguous) return null;
    return matches[0].url;
  }

  function withoutSourcePath(key) {
    try {
      const identity = JSON.parse(key);
      if (!Array.isArray(identity)) return null;
      if (identity.length === 3 && identity[0] === 'section-v1' && typeof identity[2] === 'string') {
        const base = withoutSourcePath(identity[1]);
        return base ? JSON.stringify(['section-v1', base, identity[2]]) : null;
      }
      if (identity.length !== 7 || identity[0] !== 'v1' || !Array.isArray(identity[3]) ||
        identity[3].length || typeof identity[4] !== 'string' || !identity[4] ||
        !Array.isArray(identity[5]) || typeof identity[6] !== 'string' || !identity[6].startsWith('/')) return null;
      identity[6] = '*';
      return JSON.stringify(identity);
    } catch { return null; }
  }

  // Only called for explicitly labelled navigation controls. Retain the stored
  // path-specific keys so old mappings work and conflicting routes stay local.
  function lookupAcrossPaths(entries, origin, key, now = Date.now()) {
    const identity = withoutSourcePath(key);
    if (!identity) return null;
    const matches = clean({ version: 1, entries }, now)
      .filter(entry => entry.origin === origin && withoutSourcePath(entry.key) === identity);
    if (!matches.length || matches.some(entry => entry.ambiguous) ||
      new Set(matches.map(entry => entry.key)).size !== matches.length) return null;
    const urls = new Set(matches.map(entry => entry.url));
    return urls.size === 1 ? matches[0].url : null;
  }

  function ownedIdentity(key) {
    try {
      const wrapper = JSON.parse(key);
      if (!Array.isArray(wrapper) || wrapper.length !== 3 || wrapper[0] !== 'owned-v1' ||
        !Array.isArray(wrapper[2]) || !wrapper[2].length || wrapper[2].length > 32) return null;
      const base = JSON.parse(wrapper[1]);
      if (!Array.isArray(base) || base.length !== 7 || base[0] !== 'v1' ||
        typeof base[1] !== 'string' || typeof base[2] !== 'string' || !Array.isArray(base[3]) ||
        typeof base[4] !== 'string' || !Array.isArray(base[5]) || typeof base[6] !== 'string' || !base[6].startsWith('/')) return null;
      const own = entityIds(base[3].map(([name, value]) => ({ name, value })));
      if (!own?.length) return null;
      for (const owner of wrapper[2]) {
        if (!Array.isArray(owner) || !owner.length || owner.some(pair => !Array.isArray(pair) || pair.length !== 2)) return null;
        const ids = entityIds(owner.map(([name, value]) => ({ name, value })));
        if (!ids || ids.length !== owner.length || new Set(ids.map(pair => pair[0])).size !== ids.length) return null;
      }
      const ownValues = new Set(own.map(pair => pair[1]));
      if (!wrapper[2].some(owner => owner.some(pair => !ownValues.has(pair[1])))) return null;
      const source = webUrl(base[6], 'https://owned.invalid');
      if (!source || source.origin !== 'https://owned.invalid') return null;
      // Query and hash can encode selection/filter/account state. Only the
      // pathname is eligible for cross-page reuse.
      base[6] = JSON.stringify([source.search, source.hash]);
      return JSON.stringify(['owned-v1', base, wrapper[2]]);
    } catch { return null; }
  }

  function lookupOwned(entries, origin, key, now = Date.now()) {
    const identity = ownedIdentity(key);
    if (!identity) return null;
    const valid = clean({ version: 1, entries }, now).filter(entry => entry.origin === origin);
    // Preserve a known exact-page observation, including a conflict blocking
    // that exact key. Never fall back to owner-free legacy keys.
    if (valid.some(entry => entry.key === key)) return lookup(valid, origin, key, now);
    const matches = valid.filter(entry => ownedIdentity(entry.key) === identity);
    if (matches.length < 2 || matches.some(entry => entry.ambiguous) ||
      new Set(matches.map(entry => entry.key)).size !== matches.length) return null;
    return new Set(matches.map(entry => entry.url)).size === 1 ? matches[0].url : null;
  }

  function lookupChatGPT(entries, origin, key, label, now = Date.now()) {
    if (!/^https:\/\/(?:www\.)?chatgpt\.com$/.test(origin)) return null;
    let identity;
    try { identity = JSON.parse(key); } catch { return null; }
    if (!Array.isArray(identity) || identity.length !== 3 || identity[0] !== 'chatgpt-nav-v1' ||
      !['new-chat', 'project'].includes(identity[1]) || typeof identity[2] !== 'string' ||
      (identity[2] && !/^g-p-[0-9a-f]{32}$/i.test(identity[2])) || (identity[1] === 'project' && !identity[2])) return null;
    const valid = clean({ version: 1, entries }, now).filter(entry => entry.origin === origin);
    // A canonical conflict must not be bypassed using an older alias.
    if (valid.some(entry => entry.key === key)) return lookup(valid, origin, key, now);
    const projectId = identity[2];
    const matches = valid.filter(entry => {
      let old;
      try {
        old = JSON.parse(entry.key);
        if (Array.isArray(old) && old[0] === 'section-v1' && old.length === 3) old = JSON.parse(old[1]);
      } catch { return false; }
      if (!Array.isArray(old) || old.length !== 7 || old[0] !== 'v1' || !Array.isArray(old[3]) ||
        !Array.isArray(old[5]) || !['nav', 'aside'].includes(old[5][0]) || typeof old[4] !== 'string') return false;
      if (identity[1] === 'project') {
        if (!old[3].some(attr => Array.isArray(attr) && attr[0] === 'data-app-action-sidebar-project-id' && attr[1] === projectId)) return false;
      } else {
        if (old[1] !== 'button' || old[3].length) return false;
        if (projectId ? old[4] !== label :
          !/^(?:新しいチャット|New chat)$/i.test(old[4]) || !/^(?:ホーム|Home)$/i.test(old[5][1] || '')) return false;
      }
      if (entry.ambiguous) return true;
      const destination = webUrl(entry.url);
      if (!projectId) return true;
      const segment = destination?.pathname.split('/')[2];
      return destination?.pathname.startsWith('/g/') && (segment === projectId || segment?.startsWith(projectId + '-'));
    });
    if (!matches.length || matches.some(entry => entry.ambiguous) ||
      new Set(matches.map(entry => entry.key)).size !== matches.length) return null;
    if (!projectId && matches.some(entry => webUrl(entry.url)?.pathname !== '/')) return null;
    return new Set(matches.map(entry => entry.url)).size === 1 ? matches[0].url : null;
  }

  function siteOrigins(value) {
    if (value?.version !== 1 || !Array.isArray(value.origins)) return [];
    return [...new Set(value.origins.filter(origin => {
      if (typeof origin !== "string") return false;
      const url = webUrl(origin);
      return Boolean(url && url.origin === origin);
    }))];
  }

  function siteAllowed(value, origin) {
    return siteOrigins(value).includes(origin);
  }

  function setSiteAllowed(value, origin, allowed) {
    const url = webUrl(origin);
    if (!url || url.origin !== origin) throw new Error("Invalid site origin");
    const origins = siteOrigins(value).filter(item => item !== origin);
    if (allowed) origins.push(origin);
    return { version: 1, origins: origins.sort() };
  }

  const api = Object.freeze({ STORAGE_KEY, SITE_PERMISSION_KEY, MAX_AGE_MS, MAX_ENTRIES,
    webUrl, learnableUrl, clean, remember, lookup, lookupAcrossPaths, lookupChatGPT, entityIds, lookupOwned,
    siteOrigins, siteAllowed, setSiteAllowed });
  globalThis.MiddleClickLearning = api;
  if (typeof module !== "undefined") module.exports = api;
})();
