const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const learning = require('../navigation-learning.js');
const source = fs.readFileSync(path.join(__dirname, '../event-analysis-client.js'), 'utf8');

function setup() {
  const listeners = new Set(), timers = new Map(), queries = [];
  let timerId = 0;
  const window = {};
  const context = { window, top: window, location: new URL('https://example.test/source'),
    chrome: { extension: {} }, MiddleClickLearning: learning,
    CustomEvent: class { constructor(type, values) { this.type = type; Object.assign(this, values); } },
    setTimeout(fn) { timers.set(++timerId, fn); return timerId; }, clearTimeout(id) { timers.delete(id); },
    document: { addEventListener(type, fn) { listeners.add(fn); }, removeEventListener(type, fn) { listeners.delete(fn); } },
  };
  vm.runInNewContext(source, context);
  const control = { isConnected: true, dispatchEvent(event) { queries.push(JSON.parse(event.detail)); } };
  const respond = (query, values = {}, target = control) => {
    for (const fn of [...listeners]) fn({ target, detail: JSON.stringify({ ...query, url: 'https://example.test/destination', ...values }) });
  };
  return { context, listeners, timers, queries, control, respond, resolve: () => context.MiddleClickEventClient.resolve(control, context.location.href) };
}

test('the bridge accepts only the matching control, request and source, then disposes its listener', async () => {
  const h = setup(), pending = h.resolve(), query = h.queries[0];
  h.respond(query, {}, {});
  h.respond(query, { id: 'another-request' });
  h.respond(query, { sourceUrl: 'https://example.test/other' });
  assert.equal(h.listeners.size, 1);
  h.respond(query);
  assert.equal(await pending, 'https://example.test/destination');
  assert.equal(h.listeners.size, 0);
  assert.equal(h.timers.size, 0);
});

test('cross-origin, authentication, token and malformed destinations do not bypass learning', async () => {
  for (const url of ['https://other.test/path', 'https://example.test/oauth', 'https://example.test/path?token=secret', 'javascript:alert(1)', null]) {
    const h = setup(), pending = h.resolve();
    h.respond(h.queries[0], { url });
    assert.equal(await pending, null, String(url));
  }
});

test('timeout and a source change release listeners without accepting a late destination', async () => {
  const h = setup(), pending = h.resolve(), query = h.queries[0];
  h.context.location.pathname = '/changed';
  h.respond(query);
  assert.equal(h.listeners.size, 1);
  for (const fn of [...h.timers.values()]) fn();
  assert.equal(await pending, null);
  assert.equal(h.listeners.size, 0);
  h.respond(query);
});

test('incognito and child frames never query page event handlers', async () => {
  const h = setup();
  h.context.chrome.extension.inIncognitoContext = true;
  assert.equal(await h.resolve(), null);
  h.context.chrome.extension.inIncognitoContext = false;
  h.context.top = {};
  assert.equal(await h.resolve(), null);
  assert.equal(h.queries.length, 0);
});
