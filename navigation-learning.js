(function () {
  "use strict";

  const STORAGE_KEY = "middleclickLearnedNavigationV1";
  const SITE_PERMISSION_KEY = "middleclickSiteLearningPermissionsV1";
  const MAX_AGE_MS = 90 * 24 * 60 * 60 * 1000;
  const MAX_ENTRIES = 500;

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
    webUrl, learnableUrl, clean, remember, lookup, siteOrigins, siteAllowed, setSiteAllowed });
  globalThis.MiddleClickLearning = api;
  if (typeof module !== "undefined") module.exports = api;
})();
