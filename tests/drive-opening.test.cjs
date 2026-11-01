const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '../drive-opening.js'), 'utf8');
const url = 'https://drive.google.com/drive/u/2/my-drive';
const sender = { url, frameId: 0, tab: { id: 10, windowId: 1, active: true } };
const request = { type: 'beginDriveDefaultOpen', requestId: 'request-1', itemId: 'abcdefgh123456', sourceUrl: url };
const flush = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };

function harness({ fail = false } = {}) {
  const event = () => ({ listeners: [], addListener(fn) { this.listeners.push(fn); } });
  const chrome = { webNavigation: { onCommitted: event(), onHistoryStateUpdated: event() },
    runtime: { onMessage: event() }, tabs: { onCreated: event(), onRemoved: event(),
    async sendMessage(id, msg) { feedback.push({ id, ...msg }); } } };
  const timers = new Map(); let nextTimer = 0;
  const adopted = [], feedback = [], navigated = [];
  const context = vm.createContext({ chrome, URL,
    setTimeout(fn, delay) { timers.set(++nextTimer, { fn, delay }); return nextTimer; },
    clearTimeout(id) { timers.delete(id); } });
  vm.runInContext(source, context);
  context.MiddleClickDrive.install({ chrome, async navigate(record, destination, stillCurrent) {
    navigated.push({ destination, current: stillCurrent() });
    if (fail) throw new Error('Cannot restore');
  }, async adopt(tab, record) {
    adopted.push({ tab, record }); if (fail) throw new Error('Cannot adopt');
  } });
  return { adopted, feedback, navigated,
    request(message = request, who = sender) {
      let result;
      chrome.runtime.onMessage.listeners.forEach(fn => fn(message, who, value => { result = value; }));
      return result;
    },
    created(detail = {}) { chrome.tabs.onCreated.listeners.forEach(fn => fn({ id: 20, openerTabId: 10, windowId: 1, ...detail })); },
    close(id) { chrome.tabs.onRemoved.listeners.forEach(fn => fn(id)); },
    expire(ms = 10000) { for (const [id, timer] of [...timers]) if (timer.delay <= ms) { timers.delete(id); timer.fn(); } },
    navigate(detail = {}) { chrome.webNavigation.onHistoryStateUpdated.listeners.forEach(fn =>
      fn({ tabId: 10, frameId: 0, url: 'https://drive.google.com/drive/folders/abcdefgh123456', ...detail })); },
  };
}

test('Drive adopts only one tab from the registered opener/window and does not restrict default-app origins', async () => {
  const h = harness(); assert.equal(h.request().ok, true);
  h.created({ openerTabId: 11 }); h.created({ windowId: 2 });
  assert.equal(h.adopted.length, 0);
  h.created({ url: 'https://custom-editor.example/open/file' }); h.created({ id: 21 });
  await flush();
  assert.equal(h.adopted.length, 1);
  assert.equal(h.feedback[0].reason, 'drive-opened');
  assert.equal(h.feedback[0].requestId, request.requestId);
});

test('Drive rejects forged sources, frames, malformed IDs and concurrent registrations', () => {
  for (const kind of ['host', 'http', 'path', 'frame', 'tab', 'url', 'id', 'token']) {
    const h = harness(); const who = structuredClone(sender), msg = { ...request };
    if (kind === 'host') who.url = 'https://drive.google.com.example.com/drive/my-drive';
    if (kind === 'http') who.url = url.replace('https:', 'http:');
    if (kind === 'path') who.url = 'https://drive.google.com/file/d/abcdefgh123456/view';
    if (kind === 'frame') who.frameId = 1;
    if (kind === 'tab') who.tab = undefined;
    if (kind === 'url') msg.sourceUrl = 'https://drive.google.com/drive/home';
    if (kind === 'id') msg.itemId = '../file';
    if (kind === 'token') msg.requestId = '';
    assert.equal(h.request(msg, who).ok, false, kind);
  }
  const h = harness(); assert.equal(h.request().ok, true); assert.equal(h.request().ok, false);
});

test('Drive cancellation and tab closure disarm adoption; stale cancellations do not cancel new requests', async () => {
  for (const kind of ['cancel', 'close']) {
    const h = harness(); h.request();
    if (kind === 'cancel') h.request({ type: 'cancelDriveDefaultOpen', requestId: request.requestId });
    else h.close(10);
    h.created(); await flush(); assert.equal(h.adopted.length, 0);
  }
  const h = harness(); h.request();
  h.request({ type: 'cancelDriveDefaultOpen', requestId: 'old-request' });
  h.created(); await flush(); assert.equal(h.adopted.length, 1);
});

test('Drive timeout and adoption failure report failure without creating a fallback tab', async () => {
  const expired = harness(); expired.request(); expired.expire(); expired.created(); await flush();
  assert.equal(expired.adopted.length, 0); assert.equal(expired.feedback[0].reason, 'drive-open-failed');
  const failed = harness({ fail: true }); failed.request(); failed.created(); await flush();
  assert.equal(failed.adopted.length, 1); assert.equal(failed.feedback[0].reason, 'drive-open-failed');
});

test('Drive same-tab navigation waits for restoration and uses the observed destination', async () => {
  for (const fail of [false, true]) {
    const h = harness({ fail }); h.request();
    h.navigate({ frameId: 1 }); h.expire(300); await flush();
    assert.equal(h.navigated.length, 0);
    h.navigate(); h.navigate({ url: 'https://drive.google.com/drive/u/2/folders/abcdefgh123456' });
    h.expire(300); await flush();
    assert.equal(h.navigated.length, 1);
    assert.equal(h.navigated[0].destination, 'https://drive.google.com/drive/u/2/folders/abcdefgh123456');
    assert.equal(h.navigated[0].current, true);
    assert.equal(h.feedback[0].reason, fail ? 'drive-open-failed' : 'drive-opened');
    assert.equal(h.adopted.length, 0);
  }
});

test('Drive user cancellation prevents a scheduled route restoration or tab adoption', async () => {
  const h = harness(); h.request(); h.navigate();
  h.request({ type: 'cancelDriveDefaultOpen', requestId: request.requestId });
  h.expire(); h.created(); await flush();
  assert.equal(h.navigated.length, 0); assert.equal(h.adopted.length, 0);
});
