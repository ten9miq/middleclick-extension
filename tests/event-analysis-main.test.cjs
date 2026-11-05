const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const analysis = require('../event-analysis.js');
const source = fs.readFileSync(path.join(__dirname, '../event-analysis-main.js'), 'utf8');

async function query({ oldHandler, currentHandler, alternateHandler, parentHandler }) {
  const listeners = new Map(), replies = [];
  class Element {
    constructor() { this.isConnected = true; this.tagName = 'BUTTON'; }
    matches() { return true; }
    closest() { return null; }
    getAttribute() { return null; }
    hasAttribute() { return false; }
    dispatchEvent(event) { replies.push(JSON.parse(event.detail)); }
  }
  const control = new Element();
  control.__reactProps$fixture = { onClick: currentHandler };
  control.__reactFiber$fixture = { type: 'button', memoizedProps: { onClick: oldHandler },
    alternate: alternateHandler ? { type: 'button', memoizedProps: { onClick: alternateHandler } } : null,
    return: parentHandler ? { type: 'button', memoizedProps: { onClick: parentHandler } } : null };
  const window = {};
  const context = { window, top: window, location: new URL('https://example.test/source'), MiddleClickEventAnalysis: analysis,
    Element, setTimeout() {}, clearTimeout() {},
    CustomEvent: class { constructor(type, values) { this.type = type; Object.assign(this, values); } },
    MutationObserver: class { observe() {} },
    document: { scripts: [], querySelector() { return null; }, querySelectorAll() { return []; }, addEventListener(type, fn) { listeners.set(type, fn); } },
    performance: { getEntriesByType() { return []; } },
  };
  vm.runInNewContext(source, context);
  await listeners.get('middleclick-plus:event-query:v1')({ target: control, detail: JSON.stringify({ id: 'request', sourceUrl: 'https://example.test/source' }) });
  return replies[0];
}

test('a React alternate is used only when it matches the current host event handler', async () => {
  const old = () => location.assign('/old'), current = () => location.assign('/new');
  assert.equal((await query({ oldHandler: old, currentHandler: current, alternateHandler: current })).url, 'https://example.test/new');
  assert.equal((await query({ oldHandler: old, currentHandler: current })).url, null);
});

test('a removed host handler and an ancestor control cannot supply a stale route', async () => {
  const old = () => location.assign('/old');
  assert.equal((await query({ oldHandler: old, currentHandler: undefined })).url, null);
  assert.equal((await query({ currentHandler: undefined, parentHandler: old })).url, null);
});
