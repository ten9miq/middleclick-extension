const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sourceCode = fs.readFileSync(path.join(__dirname, '../background.js'), 'utf8');

function harness({ source, failCreate = false, failGroup = false, removeSource = false, groupAtFront = false, restoreMode = 'exact' } = {}) {
  const tabs = new Map();
  if (source) {
    tabs.set(source.id, { ...source });
    tabs.set(30, { id: 30, index: source.index + 1, windowId: source.windowId, groupId: source.groupId, active: false });
  }
  const calls = { create: [], group: [], move: [], update: [], warnings: [] };
  let nextId = 100;
  const noopEvent = { addListener() {} };
  const chrome = {
    contextMenus: { create() {}, removeAll() {}, onClicked: noopEvent },
    runtime: { onInstalled: noopEvent, onMessage: noopEvent },
    tabs: {
      onCreated: noopEvent,
      onRemoved: noopEvent,
      async sendMessage(id, message) {
        if (message.type === 'restoreConfirmedNavigationProbe') {
          if (restoreMode !== 'exact') return { traversing: false };
          Object.assign(tabs.get(id), { url: message.sourceUrl, entryKey: message.entryKey });
          return { traversing: true };
        }
        if (message.type === 'readConfirmedNavigationEntry') return { entryKey: tabs.get(id)?.entryKey };
      },
      async update(id, props) {
        calls.update.push({ id, ...props });
        if (props.active) for (const tab of tabs.values()) tab.active = tab.id === id;
        Object.assign(tabs.get(id), props);
      },
      async get(id) {
        if (removeSource || !tabs.has(id)) throw new Error('Tab closed');
        return { ...tabs.get(id) };
      },
      async create(properties) {
        calls.create.push({ ...properties });
        if (failCreate && calls.create.length === 1) throw new Error('Invalid opener');
        const index = properties.index ?? tabs.size;
        for (const tab of tabs.values()) if (tab.index >= index) tab.index++;
        const tab = { ...properties, id: nextId++, index, groupId: -1 };
        tabs.set(tab.id, tab);
        return { ...tab };
      },
      async group(properties) {
        calls.group.push({ ...properties });
        if (failGroup) throw new Error('Group removed');
        const tab = tabs.get(properties.tabIds);
        tab.groupId = properties.groupId;
        // Chrome may reposition a newly grouped tab; exercise adjacency repair.
        await chrome.tabs.move(tab.id, { index: groupAtFront ? 0 : tabs.size - 1 });
        return properties.groupId;
      },
      async move(id, { index }) {
        calls.move.push({ id, index });
        const ordered = [...tabs.values()].sort((a, b) => a.index - b.index).filter(tab => tab.id !== id);
        ordered.splice(index, 0, tabs.get(id));
        ordered.forEach((tab, tabIndex) => { tab.index = tabIndex; });
        return { ...tabs.get(id) };
      }
    }
  };
  chrome.webNavigation = { onHistoryStateUpdated: noopEvent, onReferenceFragmentUpdated: noopEvent,
    onCommitted: noopEvent, onErrorOccurred: noopEvent };
  const context = vm.createContext({ chrome, URL, setTimeout, clearTimeout, console: { warn(...args) { calls.warnings.push(args); } } });
  context.importScripts = file => vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context);
  vm.runInContext(sourceCode, context);
  return { calls, tabs, open: snapshot => context.createBackgroundTabNextToSource('https://chatgpt.com/', snapshot),
    adopt: (tab, record) => context.adoptDriveTab(tab, record),
    reopen: (record, url, current = () => true) => context.reopenDriveNavigation(record, url, current) };
}

const source = { id: 10, index: 0, windowId: 1, groupId: 0, active: true };

test('grouped source: inherit group id zero, stay adjacent and in background', async () => {
  const h = harness({ source });
  const created = await h.open(source);
  const actual = h.tabs.get(created.id);
  assert.equal(h.calls.create.length, 1);
  assert.equal(actual.groupId, 0);
  assert.equal(actual.index, h.tabs.get(source.id).index + 1);
  assert.equal(actual.active, false);
  assert.equal(h.tabs.get(source.id).active, true);
  assert.equal(actual.openerTabId, source.id);
});

test('use current source group instead of a stale sender snapshot', async () => {
  const h = harness({ source: { ...source, groupId: 42 } });
  const created = await h.open({ ...source, groupId: 7 });
  assert.equal(h.tabs.get(created.id).groupId, 42);
});

test('ungrouped source does not create or join a group', async () => {
  const h = harness({ source: { ...source, groupId: -1 } });
  const created = await h.open({ ...source, groupId: 7 });
  assert.equal(h.calls.group.length, 0);
  assert.equal(h.tabs.get(created.id).groupId, -1);
  assert.equal(h.tabs.get(created.id).index, 1);
});

test('group failure preserves the created tab without a duplicate retry', async () => {
  const h = harness({ source, failGroup: true });
  const created = await h.open(source);
  assert.equal(h.calls.create.length, 1);
  assert.equal(h.calls.group.length, 1);
  assert.ok(h.tabs.has(created.id));
  assert.equal(h.calls.warnings.length, 1);
});

test('creation fallback still inherits an existing source group', async () => {
  const h = harness({ source, failCreate: true });
  const created = await h.open(source);
  assert.equal(h.calls.create.length, 2);
  assert.equal(h.calls.create[1].openerTabId, undefined);
  assert.equal(h.tabs.get(created.id).groupId, 0);
  assert.equal(h.tabs.get(created.id).index, h.tabs.get(source.id).index + 1);
});

test('closed source: preserve fallback tab without guessing its former group', async () => {
  const h = harness({ source, failCreate: true, removeSource: true });
  const created = await h.open(source);
  assert.equal(h.calls.create.length, 2);
  assert.equal(h.calls.group.length, 0);
  assert.ok(h.tabs.has(created.id));
});

test('repair adjacency when grouping places the new tab before the source', async () => {
  const h = harness({ source, groupAtFront: true });
  const created = await h.open(source);
  assert.equal(h.tabs.get(created.id).index, h.tabs.get(source.id).index + 1);
});

test('missing source creates one ungrouped background tab', async () => {
  const h = harness();
  const created = await h.open(null);
  assert.equal(h.calls.create.length, 1);
  assert.equal(h.calls.group.length, 0);
  assert.equal(created.active, false);
});

test('Drive keeps the actual app tab, restores stolen focus and inherits adjacency/group', async () => {
  const drive = { ...source, url: 'https://drive.google.com/drive/u/2/my-drive', active: false };
  const h = harness({ source: drive, groupAtFront: true });
  h.tabs.set(40, { id: 40, url: 'https://custom-editor.example/file', active: true, windowId: 1, index: 2, groupId: -1 });
  await h.adopt(h.tabs.get(40), { sourceTab: { ...drive, active: true }, sourceUrl: drive.url });
  assert.equal(h.calls.create.length, 0);
  assert.equal(h.tabs.get(40).url, 'https://custom-editor.example/file');
  assert.equal(h.tabs.get(40).active, false);
  assert.equal(h.tabs.get(10).active, true);
  assert.equal(h.tabs.get(40).index, h.tabs.get(10).index + 1);
  assert.equal(h.tabs.get(40).groupId, 0);
});

test('Drive adoption respects another active tab and refuses a changed source', async () => {
  const drive = { ...source, url: 'https://drive.google.com/drive/my-drive', active: false };
  for (const changed of [false, true]) {
    const h = harness({ source: drive });
    h.tabs.get(30).active = true;
    h.tabs.set(40, { id: 40, windowId: 1, index: 2, groupId: -1, active: false });
    const operation = h.adopt(h.tabs.get(40), { sourceTab: { ...drive, active: true }, sourceUrl: changed ? drive.url + '?other' : drive.url });
    if (changed) await assert.rejects(operation);
    else await operation;
    assert.equal(h.calls.update.length, 0);
    assert.equal(h.tabs.get(30).active, true);
    assert.equal(h.calls.create.length, 0);
  }
});

test('Drive source restoration precedes opening the observed route; exact entry and reload fallback work', async () => {
  for (const restoreMode of ['exact', 'reload']) {
    const drive = { ...source, url: 'https://drive.google.com/drive/folders/child_1234567890' };
    const sourceUrl = 'https://drive.google.com/drive/u/2/my-drive';
    const h = harness({ source: drive, restoreMode });
    await h.reopen({ sourceTab: drive, sourceUrl, entryKey: 'original' }, drive.url);
    assert.equal(h.tabs.get(10).url, sourceUrl);
    assert.equal(h.calls.create.length, 1);
    assert.equal(h.calls.create[0].url, drive.url);
    assert.equal(h.calls.create[0].active, false);
    if (restoreMode === 'exact') assert.equal(h.calls.update.length, 0);
    else assert.equal(h.calls.update[0].url, sourceUrl);
  }
});

test('Drive cancellation or missing source prevents restoration from opening a tab', async () => {
  const h = harness({ source });
  await h.reopen({ sourceTab: source, sourceUrl: 'https://drive.google.com/drive/my-drive' }, 'https://example.com/destination', () => false);
  assert.equal(h.calls.create.length, 0); assert.equal(h.calls.update.length, 0);
  const closed = harness({ source, removeSource: true });
  await assert.rejects(closed.reopen({ sourceTab: source, sourceUrl: 'https://drive.google.com/drive/my-drive' }, 'https://example.com/destination'));
  assert.equal(closed.calls.create.length, 0);
});
