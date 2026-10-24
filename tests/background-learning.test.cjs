const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const learning = require('../navigation-learning.js');
const source = fs.readFileSync(path.join(__dirname, '../background.js'), 'utf8');
const sender = { tab: { id: 10 }, frameId: 0, documentId: 'source-document', url: 'https://example.com/start' };

function harness(seed = {}, { failPermissionWrite = false } = {}) {
  let now = 1_000_000;
  let nextTimer = 0;
  const timers = new Map();
  const storage = structuredClone(seed);
  const warnings = [];
  const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); } });
  const chrome = {
    runtime: { onMessage: event(), onInstalled: event() },
    contextMenus: { onClicked: event(), create() {}, removeAll() {} },
    tabs: { onCreated: event(), onRemoved: event(), async sendMessage() {} },
    webNavigation: { onHistoryStateUpdated: event(), onReferenceFragmentUpdated: event(), onCommitted: event(), onErrorOccurred: event() },
    storage: { local: {
      async get() { return structuredClone(storage); },
      async set(data) {
        if (failPermissionWrite && Object.hasOwn(data, learning.SITE_PERMISSION_KEY)) throw new Error('Storage unavailable');
        Object.assign(storage, structuredClone(data));
      },
    } },
  };
  class Clock extends Date { static now() { return now; } }
  const context = vm.createContext({ chrome, URL, Date: Clock,
    setTimeout(fn, delay) { const id = ++nextTimer; timers.set(id, { fn, at: now + delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
    console: { warn(...args) { warnings.push(args); } },
  });
  context.importScripts = file => vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context);
  vm.runInContext(source, context);
  const emit = (event, ...args) => event.listeners.forEach(fn => fn(...args));
  async function advance(ms) {
    const end = now + ms;
    while (true) {
      const pending = [...timers.entries()].filter(([, timer]) => timer.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!pending) break;
      const [id, timer] = pending;
      now = timer.at;
      timers.delete(id);
      timer.fn();
      await vm.runInContext('learningWrites', context);
    }
    now = end;
  }
  return {
    storage, warnings, advance,
    click(key = 'report', who = sender) { emit(chrome.runtime.onMessage, { type: 'observeNavigationClick', key, sourceUrl: 'https://example.com/start' }, who); },
    cancel(who = sender) { emit(chrome.runtime.onMessage, { type: 'cancelNavigationLearning' }, who); },
    navigate(url, kind = 'onHistoryStateUpdated', detail = {}) {
      emit(chrome.webNavigation[kind], { tabId: 10, frameId: 0, documentId: 'source-document', url, ...detail });
    },
    forget(url = 'https://example.com/start') { emit(chrome.contextMenus.onClicked, { menuItemId: 'forgetLearnedNavigation', pageUrl: url }); },
    revoke(url = 'https://example.com/start') { emit(chrome.contextMenus.onClicked,
      { menuItemId: 'revokeSiteLearningPermission', pageUrl: url }, { id: 10 }); },
    request(message, who = sender) { return new Promise(resolve => emit(chrome.runtime.onMessage, message, who, resolve)); },
    close(tabId = 10) { emit(chrome.tabs.onRemoved, tabId); },
    flush() { return vm.runInContext('learningWrites', context); },
    flushPermissions() { return vm.runInContext('sitePermissionWrites', context); },
    entries() { return storage[learning.STORAGE_KEY]?.entries || []; },
  };
}

test('SPA, fragment and full-document navigation learn only after an observed click', async () => {
  for (const kind of ['onHistoryStateUpdated', 'onReferenceFragmentUpdated', 'onCommitted']) {
    const h = harness();
    h.navigate('https://example.com/unrelated', kind);
    await h.advance(400);
    assert.equal(h.entries().length, 0);
    h.click();
    h.navigate('https://example.com/report', kind, { documentId: kind === 'onCommitted' ? 'new-document' : 'source-document' });
    await h.advance(400);
    assert.equal(h.entries()[0].url, 'https://example.com/report', kind);
  }
});

test('short redirect chains settle to the final destination', async () => {
  const h = harness();
  h.click();
  h.navigate('https://example.com/intermediate', 'onCommitted', { documentId: 'next' });
  await h.advance(100);
  h.navigate('https://example.com/final', 'onCommitted', { documentId: 'last' });
  await h.advance(400);
  assert.equal(h.entries().length, 1);
  assert.equal(h.entries()[0].url, 'https://example.com/final');
});

test('cancel, expiry, wrong tab/frame/document, back navigation and incognito do not learn', async () => {
  for (const kind of ['cancel', 'expired', 'tab', 'frame', 'document', 'back', 'incognito', 'closed', 'origin']) {
    const h = harness();
    h.click('report', kind === 'incognito' ? { ...sender, tab: { id: 10, incognito: true } } :
      kind === 'origin' ? { ...sender, url: 'https://other.example/' } : sender);
    if (kind === 'cancel') h.cancel();
    if (kind === 'expired') await h.advance(2600);
    if (kind === 'closed') h.close();
    h.navigate('https://example.com/report', 'onHistoryStateUpdated', {
      ...(kind === 'tab' ? { tabId: 11 } : {}),
      ...(kind === 'frame' ? { frameId: 1 } : {}),
      ...(kind === 'document' ? { documentId: 'another-document' } : {}),
      ...(kind === 'back' ? { transitionQualifiers: ['forward_back'] } : {}),
    });
    await h.advance(400);
    assert.equal(h.entries().length, 0, kind);
  }
});

test('cross-origin or sensitive navigation cancels learning instead of keeping an earlier route', async () => {
  for (const url of ['https://other.example/report', 'https://example.com/report?token=private']) {
    const h = harness();
    h.click();
    h.navigate('https://example.com/intermediate');
    await h.advance(100);
    h.navigate(url);
    await h.advance(400);
    assert.equal(h.entries().length, 0);
  }
});

test('typed URLs, bookmarks, reloads and form submissions are not attributed to a prior click', async () => {
  for (const transitionType of ['typed', 'auto_bookmark', 'reload', 'form_submit']) {
    const h = harness();
    h.click();
    h.navigate('https://example.com/unrelated', 'onCommitted', { transitionType });
    await h.advance(400);
    assert.equal(h.entries().length, 0, transitionType);
  }
});

test('serialized writes preserve simultaneous learning from different tabs', async () => {
  const h = harness();
  h.click('one');
  h.navigate('https://example.com/one');
  h.click('two', { ...sender, tab: { id: 11 } });
  h.navigate('https://example.com/two', 'onHistoryStateUpdated', { tabId: 11 });
  await h.advance(400);
  assert.equal(h.entries().length, 2);
});

test('worker restart preserves routes and conflicting observations invalidate them', async () => {
  const first = harness();
  first.click();
  first.navigate('https://example.com/one');
  await first.advance(400);
  const next = harness(first.storage);
  next.click();
  next.navigate('https://example.com/two');
  await next.advance(400);
  assert.equal(next.entries()[0].ambiguous, true);
  assert.equal(next.entries()[0].url, null);
});

test('forget menu removes only that origin and cancels outstanding learning', async () => {
  const entries = [
    ...learning.remember([], 'https://example.com', 'one', 'https://example.com/one', 999_999),
    ...learning.remember([], 'https://other.example', 'two', 'https://other.example/two', 999_999),
  ];
  const h = harness({ [learning.STORAGE_KEY]: { version: 1, entries } });
  h.click();
  h.navigate('https://example.com/report');
  h.forget();
  await h.advance(400);
  await h.flush();
  assert.equal(h.entries().length, 1);
  assert.equal(h.entries()[0].origin, 'https://other.example');
});

test('site consent must be explicit, same-origin, top-frame and outside incognito', async () => {
  for (const [overrides, who] of [
    [{ confirmed: false }, sender], [{ origin: 'https://other.example' }, sender],
    [{}, { ...sender, frameId: 1 }], [{}, { ...sender, tab: { id: 10, incognito: true } }],
  ]) {
    const h = harness();
    const response = await h.request({ type: 'grantSiteLearningPermission', origin: 'https://example.com', confirmed: true, ...overrides }, who);
    assert.equal(response.ok, false);
    assert.equal(h.storage[learning.SITE_PERMISSION_KEY], undefined);
  }
});

test('site grants survive worker restart; revocation retains mappings and other site grants', async () => {
  const entries = learning.remember([], 'https://example.com', 'one', 'https://example.com/one', 999_999);
  const h = harness({ [learning.STORAGE_KEY]: { version: 1, entries } });
  assert.equal((await h.request({ type: 'grantSiteLearningPermission', origin: 'https://example.com', confirmed: true })).ok, true);
  const other = { ...sender, url: 'https://other.example/start' };
  assert.equal((await h.request({ type: 'grantSiteLearningPermission', origin: 'https://other.example', confirmed: true }, other)).ok, true);
  const next = harness(h.storage);
  assert.equal((await next.request({ type: 'getSiteLearningPermission', origin: 'https://example.com' })).allowed, true);
  next.revoke(); await next.flushPermissions();
  assert.equal((await next.request({ type: 'getSiteLearningPermission', origin: 'https://example.com' })).allowed, false);
  assert.equal((await next.request({ type: 'getSiteLearningPermission', origin: 'https://other.example' }, other)).allowed, true);
  assert.equal(next.entries()[0].url, 'https://example.com/one');
});

test('concurrent grants are serialized without losing another site permission', async () => {
  const h = harness();
  const other = { ...sender, url: 'https://other.example/start' };
  const results = await Promise.all([
    h.request({ type: 'grantSiteLearningPermission', origin: 'https://example.com', confirmed: true }),
    h.request({ type: 'grantSiteLearningPermission', origin: 'https://other.example', confirmed: true }, other),
  ]);
  assert.equal(results.every(result => result.ok), true);
  assert.deepEqual(h.storage[learning.SITE_PERMISSION_KEY].origins, ['https://example.com', 'https://other.example']);
});

test('failed grants stay denied and cannot authorize an unknown-target discovery', async () => {
  const h = harness({}, { failPermissionWrite: true });
  assert.equal((await h.request({ type: 'grantSiteLearningPermission', origin: 'https://example.com', confirmed: true })).ok, false);
  assert.equal((await h.request({ type: 'getSiteLearningPermission', origin: 'https://example.com' })).allowed, false);
  const response = await h.request({ type: 'beginSiteNavigationProbe', key: 'unknown', entryKey: 'entry', sourceUrl: sender.url });
  assert.equal(response.reason, 'permission-required');
});

test('forgetting learned mappings does not silently revoke the separately granted site permission', async () => {
  const h = harness();
  await h.request({ type: 'grantSiteLearningPermission', origin: 'https://example.com', confirmed: true });
  h.forget(); await h.flush();
  assert.equal((await h.request({ type: 'getSiteLearningPermission', origin: 'https://example.com' })).allowed, true);
});

test('revoking site consent cancels a pending discovery and blocks the next unknown target', async () => {
  const h = harness();
  await h.request({ type: 'grantSiteLearningPermission', origin: 'https://example.com', confirmed: true });
  const request = { type: 'beginSiteNavigationProbe', key: 'first', entryKey: 'entry', sourceUrl: sender.url };
  assert.equal((await h.request(request)).ok, true);
  h.revoke(); await h.flushPermissions();
  assert.equal((await h.request({ ...request, key: 'second' })).reason, 'permission-required');
  assert.equal(h.entries().length, 0);
});
