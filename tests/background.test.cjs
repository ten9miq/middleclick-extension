const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sourceCode = fs.readFileSync(path.join(__dirname, '../background.js'), 'utf8');

function harness({ source, failCreate = false, failGroup = false, removeSource = false, groupAtFront = false } = {}) {
  const tabs = new Map();
  if (source) {
    tabs.set(source.id, { ...source });
    tabs.set(30, { id: 30, index: source.index + 1, windowId: source.windowId, groupId: source.groupId, active: false });
  }
  const calls = { create: [], group: [], move: [], warnings: [] };
  let nextId = 100;
  const noopEvent = { addListener() {} };
  const chrome = {
    contextMenus: { create() {}, removeAll() {}, onClicked: noopEvent },
    runtime: { onInstalled: noopEvent, onMessage: noopEvent },
    tabs: {
      onCreated: noopEvent,
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
  const context = vm.createContext({ chrome, URL, setTimeout, clearTimeout, console: { warn(...args) { calls.warnings.push(args); } } });
  vm.runInContext(sourceCode, context);
  return { calls, tabs, open: snapshot => context.createBackgroundTabNextToSource('https://chatgpt.com/', snapshot) };
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
