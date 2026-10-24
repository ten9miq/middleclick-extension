const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const learning = require('../navigation-learning.js');
const source = fs.readFileSync(path.join(__dirname, '../navigation-probe.js'), 'utf8');
const sourceUrl = 'https://example.com/source';
const destination = 'https://example.com/destination';
const sender = { tab: { id: 10, index: 2, active: true, groupId: 7 }, frameId: 0,
  documentId: 'document', url: sourceUrl };
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

function harness({ saved, delayedRestore = false, replace = false, failRestore = false, entries = [], readEntry } = {}) {
  const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); } });
  const timers = new Map();
  const trace = [];
  const notices = [];
  const opened = [];
  const tab = { ...sender.tab, url: sourceUrl, entryKey: 'source-key' };
  let nextTimer = 0;
  const chrome = {
    runtime: { onMessage: event() },
    webNavigation: { onHistoryStateUpdated: event(), onReferenceFragmentUpdated: event(), onCommitted: event(), onErrorOccurred: event() },
    storage: { local: { get: async () => ({ [learning.STORAGE_KEY]: { version: 1, entries } }) } },
    tabs: {
      onRemoved: event(),
      async get() { return { ...tab }; },
      async update(id, properties) {
        trace.push('reload');
        if (failRestore) throw new Error('Cannot restore');
        tab.url = properties.url;
      },
      async sendMessage(id, message) {
        if (message.type === 'restoreConfirmedNavigationProbe') {
          trace.push('restore');
          if (!replace && !delayedRestore) { tab.url = sourceUrl; tab.entryKey = 'source-key'; }
          return { traversing: !replace };
        }
        if (message.type === 'readConfirmedNavigationEntry') return readEntry ? readEntry(tab) : { url: tab.url, entryKey: tab.entryKey };
        if (message.type === 'navigationProbeLearned') trace.push('cache');
        if (message.type === 'navigationProbeFeedback') notices.push(message.reason);
      },
    },
  };
  const context = vm.createContext({
    setTimeout(fn, delay) { const id = ++nextTimer; timers.set(id, { fn, delay }); return id; },
    clearTimeout(id) { timers.delete(id); },
  });
  vm.runInContext(source, context);
  const controller = context.MiddleClickProbe.install({ chrome, learning,
    save(transform) { trace.push('save'); transform(entries); return saved || Promise.resolve(true); },
    async open(url, original) { assert.equal(tab.url, sourceUrl); trace.push('open'); opened.push({ url, original }); },
    cancelPassive() { trace.push('cancel-passive'); },
  });
  function emit(event, ...args) { return event.listeners.map(fn => fn(...args)); }
  return { trace, notices, opened, tab, controller,
    async begin(overrides = {}, who = sender) {
      let response;
      emit(chrome.runtime.onMessage, { type: 'beginConfirmedNavigationProbe', confirmed: true,
        key: 'identity', entryKey: 'source-key', sourceUrl, ...overrides }, who, value => { response = value; });
      await flush();
      return response;
    },
    navigate(url = destination, details = {}, kind = 'onHistoryStateUpdated') {
      tab.url = url;
      tab.entryKey = details.entryKey ?? 'destination-key';
      emit(chrome.webNavigation[kind], { tabId: 10, frameId: 0, documentId: 'document', url, ...details });
    },
    cancel() { emit(chrome.runtime.onMessage, { type: 'cancelNavigationLearning' }, sender); },
    async fire(delay) {
      const next = [...timers.entries()].find(([, timer]) => timer.delay === delay);
      assert.ok(next, 'Expected timer with delay ' + delay);
      timers.delete(next[0]);
      next[1].fn();
      await flush();
    },
  };
}

test('opening waits for restoration but does not wait for the parallel durable save', async () => {
  let completeSave;
  const saved = new Promise(resolve => { completeSave = resolve; });
  const h = harness({ saved });
  assert.equal((await h.begin()).ok, true);
  h.navigate();
  await h.fire(300);
  assert.deepEqual(h.trace, ['cancel-passive', 'save', 'restore', 'cache', 'open']);
  assert.equal(h.opened[0].url, destination);
  assert.equal(h.opened[0].original.groupId, 7);
  completeSave(true);
  await flush();
  assert.deepEqual(h.notices, ['opened']);
});

test('no new tab is created until the source URL has actually returned', async () => {
  const h = harness({ delayedRestore: true });
  await h.begin(); h.navigate(); await h.fire(300);
  assert.equal(h.trace.includes('save'), true);
  assert.equal(h.opened.length, 0);
  h.tab.url = sourceUrl;
  h.tab.entryKey = 'source-key';
  await h.fire(100);
  assert.equal(h.opened.length, 1);
});

test('replacement navigation reloads the original URL before opening', async () => {
  const h = harness({ replace: true });
  await h.begin(); h.navigate(); await h.fire(300);
  assert.equal(h.trace.includes('reload'), true);
  assert.equal(h.opened.length, 1);
});

test('confirmation, eligible origin/frame and non-incognito context are mandatory', async () => {
  for (const [message, who] of [
    [{ confirmed: false }, sender], [{}, { ...sender, frameId: 1 }],
    [{}, { ...sender, tab: { id: 10, incognito: true } }],
    [{ sourceUrl: 'https://other.example/' }, sender],
  ]) {
    const h = harness();
    assert.equal((await h.begin(message, who)).ok, false);
    assert.equal(h.trace.length, 0);
  }
});

test('ambiguous identities cannot be rediscovered automatically after confirmation', async () => {
  const h = harness({ entries: [{ origin: 'https://example.com', key: 'identity', url: null,
    ambiguous: true, updatedAt: Date.now() }] });
  assert.equal((await h.begin()).reason, 'ambiguous');
  assert.equal(h.trace.length, 0);
});

test('timeout, cancellation and duplicate requests never create an extra tab', async () => {
  const h = harness();
  await h.begin();
  assert.equal((await h.begin()).reason, 'busy');
  await h.fire(10000);
  assert.deepEqual(h.notices, ['no-navigation']);
  assert.equal(h.opened.length, 0);
  await h.begin(); h.navigate(); h.cancel();
  await flush();
  assert.equal(h.opened.length, 0);
});

test('cross-origin/auth destinations restore the source without saving or opening', async () => {
  for (const url of ['https://other.example/destination', 'https://example.com/page?token=private']) {
    const h = harness();
    await h.begin(); h.navigate(url); await h.fire(300);
    assert.equal(h.tab.url, sourceUrl);
    assert.equal(h.trace.includes('save'), false);
    assert.equal(h.opened.length, 0);
    assert.deepEqual(h.notices, ['unsupported-destination']);
  }
});

test('failed restoration never opens a destination tab', async () => {
  const h = harness({ replace: true, failRestore: true });
  await h.begin(); h.navigate(); await h.fire(300);
  assert.equal(h.opened.length, 0);
  assert.deepEqual(h.notices, ['restore-failed']);
});

test('save failures are reported after opening and do not delay restoration', async () => {
  const h = harness({ saved: Promise.resolve(false) });
  await h.begin(); h.navigate(); await h.fire(300);
  assert.equal(h.opened.length, 1);
  assert.deepEqual(h.notices, ['opened', 'save-failed']);
});

test('same-URL history pushes learn and open after restoring the original entry', async () => {
  const h = harness();
  await h.begin();
  h.navigate(sourceUrl);
  await flush();
  await h.fire(300);
  assert.equal(h.opened.length, 1);
  assert.equal(h.opened[0].url, sourceUrl);
  assert.equal(h.tab.entryKey, 'source-key');
});

test('same URL alone is insufficient to declare history restoration complete', async () => {
  const h = harness({ delayedRestore: true });
  await h.begin(); h.navigate(sourceUrl); await flush(); await h.fire(300);
  assert.equal(h.tab.url, sourceUrl);
  assert.equal(h.opened.length, 0);
  h.tab.entryKey = 'source-key';
  await h.fire(100);
  assert.equal(h.opened.length, 1);
});

test('same-entry state updates never learn an unresolved control as the current page', async () => {
  const h = harness();
  await h.begin();
  h.navigate(sourceUrl, { entryKey: 'source-key' });
  await flush();
  await h.fire(10000);
  assert.equal(h.opened.length, 0);
  assert.equal(h.trace.includes('save'), false);
  assert.deepEqual(h.notices, ['no-navigation']);
});

test('late same-URL metadata cannot replace a newer observed destination', async () => {
  let release;
  let firstRead = true;
  const h = harness({ readEntry(tab) {
    if (firstRead) { firstRead = false; return new Promise(resolve => { release = resolve; }); }
    return { url: tab.url, entryKey: tab.entryKey };
  } });
  await h.begin();
  h.navigate(sourceUrl);
  h.navigate(destination);
  release({ url: sourceUrl, entryKey: 'old-destination-key' });
  await flush();
  await h.fire(300);
  assert.equal(h.opened[0].url, destination);
});
