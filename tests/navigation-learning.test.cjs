const test = require('node:test');
const assert = require('node:assert/strict');
const learning = require('../navigation-learning.js');
const origin = 'https://example.com';
const now = 1_000_000_000;

test('learned routes serialize, reload, expire after 90 days and stay origin scoped', () => {
  const entries = learning.remember([], origin, 'report', origin + '/report', now);
  const saved = JSON.parse(JSON.stringify({ version: 1, entries }));
  const loaded = learning.clean(saved, now + 1);
  assert.equal(learning.lookup(loaded, origin, 'report', now + 1), origin + '/report');
  assert.equal(learning.lookup(loaded, 'https://other.example', 'report', now + 1), null);
  assert.equal(learning.lookup(loaded, origin, 'report', now + learning.MAX_AGE_MS + 1), null);
});

test('different destinations for one identity remain blocked until reset or expiry', () => {
  let entries = learning.remember([], origin, 'report', origin + '/one', now);
  entries = learning.remember(entries, origin, 'report', origin + '/two', now + 1);
  entries = learning.remember(entries, origin, 'report', origin + '/one', now + 2);
  assert.equal(learning.lookup(entries, origin, 'report', now + 3), null);
  assert.equal(entries[0].ambiguous, true);
  assert.equal(entries[0].url, null);
  entries = learning.remember(entries, origin, 'report', origin + '/new', now + learning.MAX_AGE_MS + 3);
  assert.equal(learning.lookup(entries, origin, 'report', now + learning.MAX_AGE_MS + 3), origin + '/new');
});

test('unsafe, cross-origin, authentication and sensitive-query destinations are rejected', () => {
  for (const url of ['javascript:alert(1)', 'data:text/html,test', 'file:///test', 'https://other.example/page',
    'https://user:password@example.com/', origin + '/oauth/callback', origin + '/logout',
    origin + '/page?access_token=secret', origin + '/page?session_id=private']) {
    assert.equal(learning.remember([], origin, 'key', url, now).length, 0, url);
  }
});

test('storage is bounded and malformed or duplicate records cannot resolve', () => {
  let entries = [];
  for (let index = 0; index <= learning.MAX_ENTRIES; index++) {
    entries = learning.remember(entries, origin, String(index), origin + '/' + index, now + index);
  }
  assert.equal(entries.length, learning.MAX_ENTRIES);
  assert.equal(entries.some(entry => entry.key === '0'), false);
  const record = entries[0];
  assert.equal(learning.lookup([record, record], origin, record.key, now + learning.MAX_ENTRIES), null);
  assert.deepEqual(learning.clean({ version: 2, entries }, now), []);
  assert.deepEqual(learning.clean({ version: 1, entries: [null, { key: 'bad' }] }, now), []);
});

test('site consent persists independently and matches exact origins without subdomain or port inheritance', () => {
  const granted = learning.setSiteAllowed(null, origin, true);
  const reloaded = JSON.parse(JSON.stringify(granted));
  assert.equal(learning.siteAllowed(reloaded, origin), true);
  for (const other of ['http://example.com', 'https://sub.example.com', 'https://example.com:8443', 'https://other.example']) {
    assert.equal(learning.siteAllowed(reloaded, other), false, other);
  }
  assert.equal(learning.siteAllowed(learning.setSiteAllowed(reloaded, origin, false), origin), false);
  assert.equal(learning.siteAllowed({ version: 2, origins: [origin] }, origin), false);
  assert.deepEqual(learning.siteOrigins({ version: 1, origins: [null, 'javascript:test', origin, origin, origin + '/path'] }), [origin]);
});

const navigationKey = (path, label = 'Workspace B: new conversation') =>
  JSON.stringify(['v1', 'button', '', [], label, ['nav', 'Sidebar', ''], path]);

test('cross-path lookup reuses agreeing legacy records but retains origin and expiry boundaries', () => {
  let entries = learning.remember([], origin, navigationKey('/a?view=one'), origin + '/b/new', now);
  entries = learning.remember(entries, origin, navigationKey('/c'), origin + '/b/new', now);
  const key = navigationKey('/unseen');
  assert.equal(learning.lookupAcrossPaths(entries, origin, key, now), origin + '/b/new');
  assert.equal(learning.lookupAcrossPaths(entries, 'https://other.example', key, now), null);
  assert.equal(learning.lookupAcrossPaths(entries, origin, key, now + learning.MAX_AGE_MS + 1), null);
  assert.equal(learning.lookupAcrossPaths(entries, origin, navigationKey('/unseen', 'Workspace D'), now), null);
  assert.equal(learning.lookupAcrossPaths(entries, origin, 'not-json', now), null);
  assert.equal(learning.lookupAcrossPaths(entries, origin, JSON.stringify(['v1']), now), null);
});

test('cross-path conflicts, ambiguous records and duplicate stored keys prevent reuse', () => {
  const first = learning.remember([], origin, navigationKey('/a'), origin + '/b/new', now);
  let conflict = learning.remember(first, origin, navigationKey('/c'), origin + '/c/new', now);
  assert.equal(learning.lookupAcrossPaths(conflict, origin, navigationKey('/unseen'), now), null);
  conflict = learning.remember(first, origin, navigationKey('/a'), origin + '/changed', now);
  conflict = learning.remember(conflict, origin, navigationKey('/c'), origin + '/b/new', now);
  assert.equal(learning.lookupAcrossPaths(conflict, origin, navigationKey('/unseen'), now), null);
  assert.equal(learning.lookupAcrossPaths([...first, ...first], origin, navigationKey('/unseen'), now), null);
});
