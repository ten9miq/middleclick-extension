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

const ownedKey = (path, { owner = 'workspace-alpha', account = 'account-acme', item = 'record-42', label = 'Open details' } = {}) =>
  JSON.stringify(['owned-v1', JSON.stringify(['v1', 'button', '', [['data-record-id', item]], label, [], path]),
    [[['data-workspace-id', owner]], [['data-account-id', account]]]]);

test('owned destinations need two agreeing source pages before reuse on an unseen page', () => {
  const first = learning.remember([], origin, ownedKey('/first'), origin + '/records/42', now);
  assert.equal(learning.lookupOwned(first, origin, ownedKey('/first'), now), origin + '/records/42');
  assert.equal(learning.lookupOwned(first, origin, ownedKey('/second'), now), null);
  const both = learning.remember(first, origin, ownedKey('/second'), origin + '/records/42', now + 1);
  assert.equal(learning.lookupOwned(both, origin, ownedKey('/third'), now + 1), origin + '/records/42');
});

test('owned destinations retain every owner, item, action label and origin boundary', () => {
  let entries = learning.remember([], origin, ownedKey('/first'), origin + '/records/42', now);
  entries = learning.remember(entries, origin, ownedKey('/second'), origin + '/records/42', now);
  for (const options of [{ owner: 'workspace-beta' }, { account: 'account-other' }, { item: 'record-43' }, { label: 'Download' }]) {
    assert.equal(learning.lookupOwned(entries, origin, ownedKey('/third', options), now), null);
  }
  assert.equal(learning.lookupOwned(entries, 'https://other.example', ownedKey('/third'), now), null);
});

test('owned destinations retain exact query and hash context instead of guessing equivalence', () => {
  let entries = learning.remember([], origin, ownedKey('/first?filter=one#selected'), origin + '/records/42', now);
  entries = learning.remember(entries, origin, ownedKey('/second?filter=one#selected'), origin + '/records/42', now);
  assert.equal(learning.lookupOwned(entries, origin, ownedKey('/third?filter=one#selected'), now), origin + '/records/42');
  for (const path of ['/third?filter=two#selected', '/third?filter=one#other', '/third#selected', '/third?filter=one']) {
    assert.equal(learning.lookupOwned(entries, origin, ownedKey(path), now), null, path);
  }
});

test('owned conflicts, duplicate observations and ambiguous keys block cross-page reuse', () => {
  const first = learning.remember([], origin, ownedKey('/first'), origin + '/records/42', now);
  const agreeing = learning.remember(first, origin, ownedKey('/second'), origin + '/records/42', now);
  const conflict = learning.remember(first, origin, ownedKey('/second'), origin + '/different', now);
  const ambiguous = learning.remember(agreeing, origin, ownedKey('/first'), origin + '/different', now + 1);
  for (const entries of [[...first, ...first], [...agreeing, ...first], conflict, ambiguous]) {
    assert.equal(learning.lookupOwned(entries, origin, ownedKey('/third'), now + 1), null);
  }
  assert.equal(learning.lookupOwned(conflict, origin, ownedKey('/first'), now), origin + '/records/42');
  assert.equal(learning.lookupOwned(ambiguous, origin, ownedKey('/first'), now + 1), null);
});

test('owned evidence expires and old owner-free keys do not count as proof', () => {
  const old = learning.remember([], origin, navigationKey('/first'), origin + '/records/42', now);
  const first = learning.remember(old, origin, ownedKey('/first'), origin + '/records/42', now);
  assert.equal(learning.lookupOwned(first, origin, ownedKey('/third'), now), null);
  const entries = learning.remember(first, origin, ownedKey('/second'), origin + '/records/42', now + 100);
  assert.equal(learning.lookupOwned(entries, origin, ownedKey('/third'), now + learning.MAX_AGE_MS + 1), null);
  assert.equal(learning.lookupOwned(entries, origin, ownedKey('/second'), now + learning.MAX_AGE_MS + 1), origin + '/records/42');
});

test('owned keys reject missing identity, malformed ownership and numeric/generated IDs', () => {
  const valid = ownedKey('/first');
  const altered = mutate => { const key = JSON.parse(valid); mutate(key); return JSON.stringify(key); };
  for (const key of ['not-json', navigationKey('/first'),
    altered(key => { key[2] = []; }),
    altered(key => { key[2] = [[['data-record-id', 'record-42']]]; }),
    altered(key => { key[2] = [[['id', 'workspace-alpha']]]; }),
    altered(key => { key[2] = [[['data-workspace-id', true]]]; }),
    altered(key => { key[2] = [[['data-workspace-id', '123']]]; }),
    altered(key => { key[2] = [[['data-workspace-id', 'radix-generated']]]; }),
    altered(key => { const base = JSON.parse(key[1]); base[3] = [['data-testid', 'open']]; key[1] = JSON.stringify(base); }),
    altered(key => { const base = JSON.parse(key[1]); base[6] = '//other.example/path'; key[1] = JSON.stringify(base); }),
  ]) assert.equal(learning.lookupOwned([], origin, key, now), null);
  for (const value of ['0', '42', 'row-4', 'item_2', 'index3', 'react-control', 'unknown', 'bad value', true]) {
    assert.equal(learning.entityIds([{ name: 'data-record-id', value }]), null, String(value));
  }
  assert.deepEqual(learning.entityIds([{ name: 'id', value: 'record-42' }]), []);
  assert.deepEqual(learning.entityIds([{ name: 'data-testid', value: 'record-42' }]), []);
});

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

const chatOrigin = 'https://chatgpt.com';
const projectA = 'g-p-' + 'a'.repeat(32);
const projectB = 'g-p-' + 'b'.repeat(32);
const chatKey = (action = 'new-chat', id = '') => JSON.stringify(['chatgpt-nav-v1', action, id]);
const oldChatKey = (label, path = '/c/old', attrs = []) =>
  JSON.stringify(['v1', 'button', '', attrs, label, ['nav', 'ホーム', ''], path]);

test('ChatGPT global New chat reuses legacy text/section keys across paths without migration', () => {
  const base = oldChatKey('新しいチャット');
  const refined = JSON.stringify(['section-v1', oldChatKey('New chat', '/'), 'old-section']);
  let entries = learning.remember([], chatOrigin, base, chatOrigin + '/', now);
  entries = learning.remember(entries, chatOrigin, refined, chatOrigin + '/', now);
  assert.equal(learning.lookupChatGPT(entries, chatOrigin, chatKey(), 'New chat', now), chatOrigin + '/');
  assert.equal(learning.lookupChatGPT(entries, origin, chatKey(), 'New chat', now), null);
  assert.equal(learning.lookupChatGPT(entries, chatOrigin, chatKey(), 'New chat', now + learning.MAX_AGE_MS + 1), null);
});

test('ChatGPT project aliases require the actual project ID, even for identical project names', () => {
  let entries = learning.remember([], chatOrigin, oldChatKey('Same で新しいチャット', '/one'), chatOrigin + '/g/' + projectA + '/project', now);
  entries = learning.remember(entries, chatOrigin, oldChatKey('Same で新しいチャット', '/two'), chatOrigin + '/g/' + projectB + '-same/project', now);
  assert.equal(learning.lookupChatGPT(entries, chatOrigin, chatKey('new-chat', projectA), 'Same で新しいチャット', now), chatOrigin + '/g/' + projectA + '/project');
  assert.equal(learning.lookupChatGPT(entries, chatOrigin, chatKey('new-chat', projectB), 'Same で新しいチャット', now), chatOrigin + '/g/' + projectB + '-same/project');
  assert.equal(learning.lookupChatGPT(entries, chatOrigin, chatKey('new-chat', projectA), 'Renamed で新しいチャット', now), null);
  const key = oldChatKey('Old name', '/', [['data-app-action-sidebar-project-id', projectA]]);
  entries = learning.remember(entries, chatOrigin, key, chatOrigin + '/g/' + projectA + '/project', now);
  assert.equal(learning.lookupChatGPT(entries, chatOrigin, chatKey('project', projectA), 'Renamed', now), chatOrigin + '/g/' + projectA + '/project');
});

test('ChatGPT canonical keys survive label changes and their conflicts block older aliases', () => {
  const key = chatKey('new-chat', projectA);
  let entries = learning.remember([], chatOrigin, oldChatKey('Same で新しいチャット'), chatOrigin + '/g/' + projectA + '/project', now);
  entries = learning.remember(entries, chatOrigin, key, chatOrigin + '/g/' + projectA + '/project', now);
  assert.equal(learning.lookupChatGPT(entries, chatOrigin, key, 'Renamed で新しいチャット', now), chatOrigin + '/g/' + projectA + '/project');
  entries = learning.remember(entries, chatOrigin, key, chatOrigin + '/different', now + 1);
  assert.equal(learning.lookupChatGPT(entries, chatOrigin, key, 'Same で新しいチャット', now + 1), null);
});

test('ChatGPT malformed, conflicting, ambiguous and duplicate legacy mappings cannot be reused', () => {
  const key = oldChatKey('New chat');
  const first = learning.remember([], chatOrigin, key, chatOrigin + '/', now);
  assert.equal(learning.lookupChatGPT([...first, ...first], chatOrigin, chatKey(), 'New chat', now), null);
  const conflict = learning.remember(first, chatOrigin, oldChatKey('New chat', '/other'), chatOrigin + '/?mode=other', now);
  assert.equal(learning.lookupChatGPT(conflict, chatOrigin, chatKey(), 'New chat', now), null);
  const otherRoute = learning.remember(first, chatOrigin, oldChatKey('New chat', '/other'), chatOrigin + '/different', now);
  assert.equal(learning.lookupChatGPT(otherRoute, chatOrigin, chatKey(), 'New chat', now), null);
  const ambiguous = learning.remember(first, chatOrigin, key, chatOrigin + '/different', now + 1);
  assert.equal(learning.lookupChatGPT(ambiguous, chatOrigin, chatKey(), 'New chat', now + 1), null);
  for (const bad of ['not-json', JSON.stringify(['chatgpt-nav-v1', 'project', 'bad-id']), JSON.stringify(['v1'])]) {
    assert.equal(learning.lookupChatGPT(first, chatOrigin, bad, 'New chat', now), null);
  }
  const main = JSON.stringify(['v1', 'button', '', [], 'New chat', [], '/']);
  assert.equal(learning.lookupChatGPT(learning.remember([], chatOrigin, main, chatOrigin + '/', now), chatOrigin, chatKey(), 'New chat', now), null);
});
