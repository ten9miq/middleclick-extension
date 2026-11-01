const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const learning = require('../navigation-learning.js');

const source = fs.readFileSync(path.join(__dirname, '../content.js'), 'utf8');
const SVG = 'http://www.w3.org/2000/svg';
const sprite = '/cdn/assets/icons-c6b5375eadec3cee.svg#codex-icon-folder-light-20';
const flush = async () => { for (let i = 0; i < 35; i++) await Promise.resolve(); };

// Only the DOM surface used by the content script. Browser integration is
// checked separately; these events do not represent trusted mouse input.
class Element {
  constructor(tag, attrs = {}, children = [], namespace = 'http://www.w3.org/1999/xhtml') {
    this.nodeType = 1;
    this.tagName = tag;
    this.namespaceURI = namespace;
    this.attrs = attrs;
    this.children = children;
    for (const child of children) child.parentElement = this;
  }
  get attributes() { return Object.entries(this.attrs).map(([name, value]) => ({ name, value })); }
  get dataset() {
    return Object.fromEntries(Object.entries(this.attrs).filter(([name]) => name.startsWith('data-'))
      .map(([name, value]) => [name.slice(5).replace(/-([a-z])/g, (_, c) => c.toUpperCase()), value]));
  }
  get textContent() { return this.text || this.children.map(child => child.textContent).join(''); }
  getAttribute(name) { return this.attrs[name] ?? null; }
  hasAttribute(name) { return Object.hasOwn(this.attrs, name); }
  dispatchEvent(event) { (this.events ??= []).push(event); this.onDispatch?.(event); return true; }
  focus() { this.focused = true; }
  getBoundingClientRect() { return { x: 10, y: 10, width: 100, height: 30 }; }
  get isConnected() { return rootOf(this).tagName.toLowerCase() === 'html'; }
  matches(selector) {
    return selector.split(',').some(part => {
      const match = part.trim().match(/^(\w+)?(?:\[([\w-]+)(?:(\*=|=)["']?([^"'\]]+)["']?)?\])?$/);
      if (!match) return part.trim() === '.sidebar-item' && this.attrs.class === 'sidebar-item';
      const [, tag, attr, operator, value] = match;
      if (tag && tag.toLowerCase() !== this.tagName.toLowerCase()) return false;
      if (!attr) return true;
      const actual = this.getAttribute(attr);
      if (actual === null) return false;
      return !operator || (operator === '=' ? actual === value : actual.includes(value));
    });
  }
  closest(selector) {
    for (let el = this; el; el = el.parentElement) if (el.matches(selector)) return el;
    return null;
  }
  querySelectorAll(selector) {
    return this.children.flatMap(child => [
      ...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)
    ]);
  }
}

function harness(host = 'chatgpt.com', { entries = [], root = null, topFrame = false,
  confirm = () => false, acknowledge = () => Promise.resolve({ ok: true }), siteAllowed = false,
  savePermission = async () => ({ ok: true }), driveAcknowledge = async () => ({ ok: true }), loadEntries = null } = {}) {
  const listeners = new Map();
  const messages = [];
  const location = new URL(`https://${host}/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`);
  let time = 1000;
  let changed;
  const notices = [];
  const runtimeListeners = [];
  const window = { confirm };
  const document = {
    querySelector() { return null; },
    baseURI: location.href,
    addEventListener(type, callback) { listeners.set(type, callback); },
    querySelectorAll(selector) {
      if (selector === '[data-target="doc"][data-selectable][aria-selected="true"]') {
        return root ? root.querySelectorAll('[data-target="doc"]').filter(el =>
          el.hasAttribute('data-selectable') && el.getAttribute('aria-selected') === 'true') : [];
      }
      return root ? root.querySelectorAll(selector) : [];
    },
  };
  const saved = { [learning.STORAGE_KEY]: { version: 1, entries } };
  vm.runInNewContext(source, {
    setTimeout: callback => { queueMicrotask(callback); },
    MouseEvent: class { constructor(type, options) { this.type = type; Object.assign(this, options); } },
    PointerEvent: class { constructor(type, options) { this.type = type; Object.assign(this, options); } },
    KeyboardEvent: class { constructor(type, options) { this.type = type; Object.assign(this, options); } },
    Element, Node: { ELEMENT_NODE: 1 }, URL, URLSearchParams, location,
    FormData: class {
      constructor(form) { this.fields = form.fields || []; }
      entries() { return this.fields[Symbol.iterator](); }
    },
    document, MiddleClickLearning: learning,
    window, top: topFrame ? window : {},
    MiddleClickFeedback: { show(reason) { notices.push(reason); } },
    chrome: { runtime: { id: 'extension', onMessage: { addListener(fn) { runtimeListeners.push(fn); } },
      sendMessage(message) {
        messages.push(message);
        if (message.type === 'beginDriveDefaultOpen') return driveAcknowledge();
        if (message.type === 'getSiteLearningPermission') return Promise.resolve({ ok: true, allowed: siteAllowed });
        if (message.type === 'grantSiteLearningPermission') return savePermission().then(response => {
          if (response.ok) siteAllowed = true;
          return response;
        });
        return message.type === 'beginSiteNavigationProbe' ? acknowledge() : undefined;
      } }, storage: {
      local: { get: () => loadEntries ? loadEntries() : Promise.resolve(saved) }, onChanged: { addListener(callback) { changed = callback; } },
    } },
    performance: { now: () => time },
  });
  function dispatch(target, type = 'mousedown', options = {}) {
    const event = {
      target, button: 1, clientX: 800, ...options,
      composedPath() {
        const nodes = [];
        for (let el = target; el; el = el.parentElement) nodes.push(el);
        return nodes;
      },
      preventDefault() { this.defaultPrevented = true; },
      stopPropagation() {}, stopImmediatePropagation() {},
    };
    listeners.get(type)(event);
    return event;
  }
  return { messages, dispatch, location, document, notices, window, advance() { time += 200; },
    receive(message, respond = () => {}) { runtimeListeners.forEach(fn => fn(message, { id: 'extension' }, respond)); },
    change(entries) { changed({ [learning.STORAGE_KEY]: { newValue: { version: 1, entries } } }, 'local'); } };
}

function iconButton(attrs = {}) {
  const icon = new Element('use', { href: sprite }, [], SVG);
  const svg = new Element('svg', {}, [icon], SVG);
  const button = new Element('button', { type: 'button', ...attrs }, [svg]);
  const nav = new Element('nav', {}, [button]);
  new Element('html', { 'data-icon-sprite-url': sprite.split('#')[0] }, [new Element('body', {}, [nav])]);
  return { icon, svg, button };
}

test('only Codex retains a fixed ChatGPT destination; ordinary rail keys need learning', () => {
  const routes = { codex: '/#middleclick-plus-codex' };
  for (const [key, route] of Object.entries(routes)) {
    for (const target of Object.values(iconButton({ 'data-sidebar-destination': `builtin:${key}` }))) {
      const h = harness();
      const event = h.dispatch(target);
      assert.equal(event.defaultPrevented, true, `${key}: event handled`);
      assert.deepEqual(h.messages.map(message => message.url), [`https://chatgpt.com${route}`], key);
    }
  }
  for (const key of ['home', 'space', 'orbit', 'projects', 'automations']) {
    const h = harness();
    h.dispatch(iconButton({ 'data-sidebar-destination': `builtin:${key}` }).icon);
    assert.equal(h.messages.length, 0, key);
  }
});

test('a full middle-button gesture sends one request and suppresses later handlers', () => {
  const h = harness();
  const { icon } = iconButton({ 'data-url': '/projects' });
  for (const type of ['pointerdown', 'mousedown', 'mouseup', 'auxclick']) {
    assert.equal(h.dispatch(icon, type).defaultPrevented, true);
  }
  assert.equal(h.messages.length, 1);
  h.advance();
  h.dispatch(icon);
  assert.equal(h.messages.length, 2);
});

test('SVG resources alone, unknown destinations, exploration and profile menus open no tab', () => {
  for (const attrs of [
    {},
    { 'data-sidebar-destination': 'builtin:unknown' },
    { 'aria-haspopup': 'dialog' }, { 'aria-haspopup': 'menu' },
  ]) {
    const h = harness();
    const { icon } = iconButton(attrs);
    assert.equal(h.dispatch(icon).defaultPrevented, undefined);
    assert.equal(h.messages.length, 0);
  }
});

test('generic pseudo-link resolves its parent URL instead of an SVG drawing resource', () => {
  const h = harness('example.com');
  const { icon } = iconButton({ 'data-url': '/destination' });
  h.dispatch(icon);
  assert.deepEqual(h.messages.map(message => message.url), ['https://example.com/destination']);
});

test('ordinary HTML and SVG anchors keep native middle-click handling, including SVG file links', () => {
  for (const namespace of [undefined, SVG]) {
    const h = harness('example.com');
    const { icon, svg } = iconButton();
    new Element('a', { href: '/diagram.svg' }, [svg], namespace);
    assert.equal(h.dispatch(icon).defaultPrevented, undefined);
    assert.equal(h.messages.length, 0);
  }
});

test('ChatGPT native sidebar link retains its href when the target is an SVG icon', () => {
  const h = harness();
  const { icon, svg } = iconButton();
  const anchor = new Element('a', { href: '/gpts' }, [svg]);
  new Element('nav', {}, [anchor]);
  h.dispatch(icon);
  assert.deepEqual(h.messages.map(message => message.url), ['https://chatgpt.com/gpts']);
});

test('resource hrefs on SVG image and gradient elements are ignored too', () => {
  for (const tag of ['use', 'image', 'linearGradient', 'feImage']) {
    const h = harness('example.com');
    h.dispatch(new Element(tag, { href: sprite }, [], SVG));
    assert.equal(h.messages.length, 0, tag);
  }
});

test('global HTML and body URL metadata is never a child control destination', () => {
  const h = harness();
  const button = new Element('button', { type: 'button' });
  const nav = new Element('nav', {}, [button]);
  new Element('html', { 'data-icon-sprite-url': sprite }, [
    new Element('body', { 'data-url': '/unrelated-global-metadata' }, [nav]),
  ]);
  assert.equal(h.dispatch(button).defaultPrevented, undefined);
  assert.equal(h.messages.length, 0);
});

test('left clicks and modified middle clicks are left alone', () => {
  for (const options of [{ button: 0 }, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }]) {
    const h = harness();
    const { icon } = iconButton({ 'data-sidebar-destination': 'builtin:projects' });
    assert.equal(h.dispatch(icon, 'mousedown', options).defaultPrevented, undefined);
    assert.equal(h.messages.length, 0);
  }
});

test('ChatGPT titles and project ids are no longer guessed as routes', () => {
  for (const attrs of [
    { 'data-project-id': 'g-p-abcdef123456' },
    { 'aria-label': '新しいチャット' }, { 'aria-label': 'スケジュール' },
  ]) {
    const h = harness();
    h.dispatch(iconButton(attrs).icon);
    assert.equal(h.messages.length, 0);
  }
});

function rootOf(element) {
  while (element.parentElement) element = element.parentElement;
  return element;
}

test('trusted normal clicks emit generic learning identities without activating handlers', () => {
  const { icon, button } = iconButton({ 'data-item-id': 'report-42', 'aria-label': 'Report' });
  let clicks = 0;
  button.click = () => clicks++;
  const h = harness('example.com', { root: rootOf(button) });
  h.dispatch(icon, 'click', { button: 0, isTrusted: false });
  assert.equal(h.messages.length, 0);
  h.dispatch(icon, 'click', { button: 0, isTrusted: true });
  assert.equal(h.messages[0].type, 'observeNavigationClick');
  assert.match(h.messages[0].key, /report-42/);
  assert.equal(clicks, 0);
});

test('stored generic destinations survive a new content-script instance and origin isolation', async () => {
  const make = () => iconButton({ 'data-item-id': 'report-42', 'aria-label': 'Report' });
  const first = make();
  const h = harness('example.com', { root: rootOf(first.button) });
  h.dispatch(first.icon, 'click', { button: 0, isTrusted: true });
  const entries = learning.remember([], 'https://example.com', h.messages[0].key, 'https://example.com/reports/42');
  for (const host of ['example.com', 'another.example']) {
    const next = make();
    const loaded = harness(host, { entries, root: rootOf(next.button) });
    await Promise.resolve();
    loaded.dispatch(next.icon);
    assert.equal(loaded.messages.length, host === 'example.com' ? 1 : 0);
    if (loaded.messages.length) assert.equal(loaded.messages[0].url, 'https://example.com/reports/42');
  }
});

test('storage changes invalidate a learned destination in already-open documents', async () => {
  const { icon, button } = iconButton({ 'data-item-id': 'report-42', 'aria-label': 'Report' });
  const h = harness('example.com', { root: rootOf(button) });
  h.dispatch(icon, 'click', { button: 0, isTrusted: true });
  const key = h.messages.pop().key;
  h.change(learning.remember([], h.location.origin, key, h.location.origin + '/report'));
  // A late initial storage read must not overwrite a newer change event.
  await Promise.resolve();
  h.dispatch(icon);
  assert.equal(h.messages.pop().url, 'https://example.com/report');
  h.change([]);
  h.advance();
  h.dispatch(icon);
  assert.equal(h.messages.length, 0);
});

test('explicitly labelled navigation reuses legacy mappings across paths and reloads without clicking', async () => {
  for (const labelAttr of ['aria-label', 'title']) {
    const first = iconButton({ [labelAttr]: 'Workspace B: new conversation' });
    const h = harness('example.com', { root: rootOf(first.button) });
    h.dispatch(first.icon, 'click', { button: 0, isTrusted: true });
    const key = h.messages.pop().key;
    const entries = learning.remember([], h.location.origin, key, h.location.origin + '/workspace-b/new');
    const next = iconButton({ [labelAttr]: 'Workspace B: new conversation' });
    let clicks = 0;
    next.button.click = () => clicks++;
    const loaded = harness('example.com', { entries, root: rootOf(next.button), topFrame: true, siteAllowed: true });
    loaded.location.pathname = '/workspace-c/conversations/another';
    loaded.location.search = '?view=compact';
    await flush();
    loaded.dispatch(next.icon);
    await flush();
    assert.equal(clicks, 0);
    assert.deepEqual(loaded.messages.map(message => message.type), ['maybeOpenOnMiddle']);
    assert.equal(loaded.messages[0].url, 'https://example.com/workspace-b/new');
    assert.equal(loaded.location.pathname, '/workspace-c/conversations/another');

    next.button.attrs[labelAttr] = 'Workspace D: new conversation';
    loaded.advance();
    loaded.dispatch(next.icon);
    await flush();
    assert.equal(clicks, 1);
    assert.equal(loaded.messages.at(-1).type, 'beginSiteNavigationProbe');
  }
});

test('text-only and main-content controls keep path-local learning', async () => {
  for (const kind of ['text', 'main', 'main-navigation']) {
    const { icon, button } = iconButton(kind === 'text' ? {} : { 'aria-label': 'Open details' });
    button.text = 'Open details';
    if (kind !== 'text') {
      const nav = button.parentElement;
      const main = new Element('main', {}, kind === 'main' ? [button] : [nav]);
      new Element('html', {}, [new Element('body', {}, [main])]);
    }
    const h = harness('example.com', { root: rootOf(button) });
    h.dispatch(icon, 'click', { button: 0, isTrusted: true });
    const key = h.messages.pop().key;
    h.change(learning.remember([], h.location.origin, key, h.location.origin + '/details/old'));
    await flush();
    h.location.pathname = '/different-document';
    h.dispatch(icon);
    assert.equal(h.messages.some(message => message.type === 'maybeOpenOnMiddle'), false, kind);
  }
});

test('cross-path navigation keeps equal labels in separate sections distinct', async () => {
  const first = new Element('button', { 'aria-label': 'New conversation' });
  const second = new Element('button', { 'aria-label': 'New conversation' });
  const nav = new Element('nav', {}, [new Element('section', { 'aria-label': 'Workspace A' }, [first]),
    new Element('section', { 'aria-label': 'Workspace B' }, [second])]);
  const root = new Element('html', {}, [new Element('body', {}, [nav])]);
  const h = harness('example.com', { root });
  h.dispatch(first, 'click', { button: 0, isTrusted: true });
  h.dispatch(second, 'click', { button: 0, isTrusted: true });
  const keys = h.messages.splice(0).map(message => message.key);
  let entries = learning.remember([], h.location.origin, keys[0], h.location.origin + '/a/new');
  entries = learning.remember(entries, h.location.origin, keys[1], h.location.origin + '/b/new');
  h.change(entries);
  await flush();
  h.location.pathname = '/another-session';
  nav.children.reverse();
  h.dispatch(first);
  assert.equal(h.messages.pop().url, 'https://example.com/a/new');
  h.dispatch(second);
  assert.equal(h.messages.pop().url, 'https://example.com/b/new');
});

test('conflicting cross-path routes trigger local discovery while exact paths remain usable', async () => {
  const { icon, button } = iconButton({ 'aria-label': 'Open workspace' });
  let clicks = 0;
  button.click = () => clicks++;
  const h = harness('example.com', { root: rootOf(button), topFrame: true, siteAllowed: true });
  h.dispatch(icon, 'click', { button: 0, isTrusted: true });
  const keyA = h.messages.pop().key;
  h.location.pathname = '/workspace-b';
  h.dispatch(icon, 'click', { button: 0, isTrusted: true });
  const keyB = h.messages.pop().key;
  let entries = learning.remember([], h.location.origin, keyA, h.location.origin + '/a/new');
  entries = learning.remember(entries, h.location.origin, keyB, h.location.origin + '/b/new');
  h.change(entries);
  await flush();
  h.dispatch(icon);
  assert.equal(h.messages.pop().url, 'https://example.com/b/new');
  assert.equal(clicks, 0);
  h.location.pathname = '/unknown-workspace';
  h.advance();
  h.dispatch(icon);
  await flush();
  assert.equal(clicks, 1);
  assert.equal(h.messages.at(-1).type, 'beginSiteNavigationProbe');
});

test('duplicate controls and submit/menu/disabled controls are not learned', () => {
  for (const kind of ['duplicate', 'form', 'menu', 'disabled']) {
    const first = iconButton({ 'data-item-id': 'same', 'aria-label': 'Same' });
    const root = rootOf(first.button);
    if (kind === 'duplicate') {
      const second = iconButton({ 'data-item-id': 'same', 'aria-label': 'Same' });
      first.button.parentElement.children.push(second.button);
      second.button.parentElement = first.button.parentElement;
    }
    if (kind === 'form') first.button.form = {};
    if (kind === 'menu') first.button.attrs['aria-haspopup'] = 'menu';
    if (kind === 'disabled') first.button.attrs.disabled = '';
    const h = harness('example.com', { root });
    h.dispatch(first.icon, 'click', { button: 0, isTrusted: true });
    assert.equal(h.messages[0].type, 'cancelNavigationLearning', kind);
  }
});

test('equal navigation labels in different semantic sections get distinct stable identities', async () => {
  const top = new Element('button', { type: 'button' });
  const recent = new Element('button', { type: 'button', 'aria-label': '新しいチャット' });
  top.text = recent.text = '新しいチャット';
  const section = new Element('section', { 'data-navigation-section-heading': 'Recent' }, [recent]);
  const nav = new Element('nav', { 'aria-label': 'Home' }, [top, section]);
  const root = new Element('html', {}, [new Element('body', {}, [nav])]);
  let prompts = 0;
  const h = harness('example.com', { root, topFrame: true, confirm() { prompts++; return false; } });
  h.dispatch(top, 'click', { button: 0, isTrusted: true });
  h.dispatch(recent, 'click', { button: 0, isTrusted: true });
  const keys = h.messages.filter(message => message.type === 'observeNavigationClick').map(message => message.key);
  assert.equal(keys.length, 2);
  assert.notEqual(keys[0], keys[1]);
  assert.match(keys[1], /Recent/);
  h.messages.length = 0;
  // DOM order must not influence the learned control's identity.
  nav.children.reverse();
  h.dispatch(recent, 'click', { button: 0, isTrusted: true });
  assert.equal(h.messages.pop().key, keys[1]);
  h.dispatch(top);
  await flush();
  assert.equal(prompts, 1);
  assert.equal(h.notices.includes('ambiguous'), false);
  const entries = learning.remember([], h.location.origin, keys[1], h.location.origin + '/new-chat');
  h.change(entries);
  await Promise.resolve();
  h.dispatch(recent);
  assert.equal(h.messages.pop().url, 'https://example.com/new-chat');
});

test('equal labels in indistinguishable sections remain blocked', () => {
  const make = () => new Element('button', { type: 'button', 'aria-label': 'Same' });
  const first = make();
  const second = make();
  const nav = new Element('nav', {}, [new Element('section', {}, [first]), new Element('section', {}, [second])]);
  const root = new Element('html', {}, [new Element('body', {}, [nav])]);
  let prompts = 0;
  const h = harness('example.com', { root, topFrame: true, confirm() { prompts++; return true; } });
  h.dispatch(first);
  assert.equal(prompts, 0);
  assert.equal(h.messages.length, 0);
  assert.equal(h.notices[0], 'ambiguous');
});

test('stable data identifiers are not interpreted as relative navigation URLs', () => {
  const h = harness('example.com');
  h.dispatch(iconButton({ 'data-route-id': 'opaque-id' }).icon);
  assert.equal(h.messages.length, 0);
});

function ownedControl({ owner = 'workspace-alpha', account = 'account-acme', item = 'record-42' } = {}) {
  const control = iconButton({ 'data-record-id': item, 'aria-label': 'Open details' });
  const workspace = new Element('section', { 'data-workspace-id': owner }, [control.button]);
  const main = new Element('main', {}, [workspace]);
  const root = new Element('html', {}, [new Element('body', { 'data-account-id': account }, [main])]);
  return { ...control, workspace, main, root };
}

function observeOwned(h, target, path) {
  h.location.pathname = path;
  h.dispatch(target, 'click', { button: 0, isTrusted: true });
  return h.messages.pop().key;
}

test('generic owned items require two matching pages, then open from a third without discovery', async () => {
  const item = ownedControl();
  const h = harness('example.com', { root: item.root, topFrame: true });
  const first = observeOwned(h, item.icon, '/first');
  assert.equal(JSON.parse(first)[0], 'owned-v1');
  let entries = learning.remember([], h.location.origin, first, h.location.origin + '/records/42');
  h.change(entries); await flush();
  h.location.pathname = '/second';
  h.dispatch(item.icon); await flush();
  assert.equal(h.messages.some(m => m.type === 'maybeOpenOnMiddle'), false);
  const second = observeOwned(h, item.icon, '/second');
  entries = learning.remember(entries, h.location.origin, second, h.location.origin + '/records/42');
  h.change(entries); await flush(); h.messages.length = 0;
  h.location.pathname = '/third'; h.advance();
  item.button.click = () => assert.fail('must not rediscover the item');
  for (const event of ['pointerdown', 'mousedown', 'mouseup', 'auxclick']) assert.equal(h.dispatch(item.icon, event).defaultPrevented, true);
  assert.deepEqual(h.messages.map(m => [m.type, m.url]), [['maybeOpenOnMiddle', h.location.origin + '/records/42']]);
});

test('generic owned items survive reordering and regenerated DOM while keeping same-name owners separate', async () => {
  const item = ownedControl();
  const h = harness('example.com', { root: item.root });
  const first = observeOwned(h, item.icon, '/first');
  const second = observeOwned(h, item.icon, '/second');
  let entries = learning.remember([], h.location.origin, first, h.location.origin + '/records/42');
  entries = learning.remember(entries, h.location.origin, second, h.location.origin + '/records/42');
  const next = ownedControl();
  next.workspace.attrs.id = 'new-dom-wrapper';
  next.workspace.attrs['aria-label'] = 'Renamed section';
  const other = ownedControl({ owner: 'workspace-beta' });
  next.main.children.unshift(other.workspace); other.workspace.parentElement = next.main;
  const loaded = harness('example.com', { root: next.root, entries, topFrame: true });
  loaded.location.pathname = '/third'; await flush();
  loaded.dispatch(next.icon);
  assert.equal(loaded.messages.at(-1).url, h.location.origin + '/records/42');
  loaded.advance(); loaded.dispatch(other.icon); await flush();
  assert.equal(loaded.messages.filter(m => m.type === 'maybeOpenOnMiddle').length, 1);
  const otherKey = observeOwned(loaded, other.icon, '/third');
  assert.equal(JSON.parse(otherKey)[0], 'owned-v1');
  assert.notDeepEqual(JSON.parse(otherKey)[2], JSON.parse(first)[2]);
});

test('generic ownership stores all ancestor IDs and retains query/hash instead of falling back to legacy keys', async () => {
  const item = ownedControl(); const h = harness('example.com', { root: item.root, topFrame: true });
  h.location.search = '?selection=one'; h.location.hash = '#panel';
  const first = observeOwned(h, item.icon, '/first'), second = observeOwned(h, item.icon, '/second');
  assert.deepEqual(JSON.parse(first)[2], [[['data-workspace-id', 'workspace-alpha']], [['data-account-id', 'account-acme']]]);
  assert.equal(JSON.parse(JSON.parse(first)[1])[6], '/first?selection=one#panel');
  let entries = learning.remember([], h.location.origin, first, h.location.origin + '/records/42');
  entries = learning.remember(entries, h.location.origin, second, h.location.origin + '/records/42');
  const old = JSON.parse(JSON.parse(first)[1]); old[6] = '*';
  entries = learning.remember(entries, h.location.origin, JSON.stringify(old), h.location.origin + '/unsafe-legacy');
  h.change(entries); await flush(); h.location.pathname = '/third'; h.location.search = '?selection=two';
  h.dispatch(item.icon); await flush();
  assert.equal(h.messages.some(m => m.type === 'maybeOpenOnMiddle'), false);
  assert.equal(h.messages.some(m => m.url?.includes('unsafe-legacy')), false);
});

test('generic ownership does not promote label-only controls, testing IDs, missing owners or generated IDs', () => {
  for (const kind of ['label', 'testing', 'missing-owner', 'numeric-owner', 'generated-item', 'repeated-item']) {
    const item = ownedControl();
    if (kind === 'label' || kind === 'testing') delete item.button.attrs['data-record-id'];
    if (kind === 'testing') item.button.attrs['data-testid'] = 'open-record';
    if (kind === 'missing-owner') { delete item.workspace.attrs['data-workspace-id']; delete item.root.children[0].attrs['data-account-id']; }
    if (kind === 'numeric-owner') item.workspace.attrs['data-workspace-id'] = '0';
    if (kind === 'generated-item') item.button.attrs['data-record-id'] = 'react-generated';
    if (kind === 'repeated-item') { item.workspace.attrs['data-workspace-id'] = 'record-42'; delete item.root.children[0].attrs['data-account-id']; }
    const h = harness('example.com', { root: item.root });
    const key = observeOwned(h, item.icon, '/first');
    assert.equal(JSON.parse(key)[0], 'v1', kind);
  }
});

test('duplicate item IDs within the same owner remain ambiguous, even in differently labelled wrappers', () => {
  const item = ownedControl(), duplicate = ownedControl();
  const section = new Element('section', { 'aria-label': 'Another view' }, [duplicate.button]);
  item.workspace.children.push(section); section.parentElement = item.workspace;
  const h = harness('example.com', { root: item.root, topFrame: true });
  h.dispatch(item.icon);
  assert.equal(h.messages.length, 0);
  assert.ok(h.notices.includes('ambiguous'));
});

const CHAT_PROJECT_A = 'g-p-' + 'a'.repeat(32);
const CHAT_PROJECT_B = 'g-p-' + 'b'.repeat(32);
function chatProject(id = CHAT_PROJECT_A, name = 'Same') {
  const item = iconButton({ 'aria-label': name + ' で新しいチャット' });
  const row = new Element('div', { role: 'button', 'data-app-action-sidebar-project-id': id,
    'data-app-action-sidebar-project-row': '' }, [item.button]);
  const section = new Element('section', { id: 'volatile-section', 'aria-label': 'Projects' }, [row]);
  const nav = new Element('nav', { 'aria-label': 'ホーム' }, [section]);
  const root = new Element('html', {}, [new Element('body', {}, [nav])]);
  return { ...item, row, section, nav, root };
}

test('ChatGPT project action keys survive reordering, renaming, source changes and reloads', async () => {
  const first = chatProject();
  const h = harness('chatgpt.com', { root: first.root });
  h.dispatch(first.icon, 'click', { button: 0, isTrusted: true });
  const key = h.messages.pop().key;
  assert.deepEqual(JSON.parse(key), ['chatgpt-nav-v1', 'new-chat', CHAT_PROJECT_A]);
  const entries = learning.remember([], h.location.origin, key, h.location.origin + '/g/' + CHAT_PROJECT_A + '/project');
  const next = chatProject(CHAT_PROJECT_A, 'Renamed');
  next.section.attrs.id = 'different-section-after-reorder';
  next.section.attrs['aria-label'] = 'Pinned';
  next.nav.attrs['aria-label'] = 'Project';
  const loaded = harness('chatgpt.com', { root: next.root, entries, topFrame: true, siteAllowed: true });
  loaded.location.pathname = '/c/different';
  next.button.click = () => assert.fail('must reuse the stored destination');
  await flush(); loaded.dispatch(next.icon); await flush();
  assert.deepEqual(loaded.messages.map(m => m.type), ['maybeOpenOnMiddle']);
  assert.equal(loaded.messages[0].url, h.location.origin + '/g/' + CHAT_PROJECT_A + '/project');
  loaded.dispatch(next.icon, 'click', { button: 0, isTrusted: true });
  assert.equal(loaded.messages.at(-1).key, key);
});

test('ChatGPT same-name projects retain different action keys and keep action menus separate', () => {
  const a = chatProject(CHAT_PROJECT_A), b = chatProject(CHAT_PROJECT_B);
  a.nav.children.push(b.section); b.section.parentElement = a.nav;
  const h = harness('chatgpt.com', { root: a.root });
  h.dispatch(a.icon, 'click', { button: 0, isTrusted: true });
  h.dispatch(b.icon, 'click', { button: 0, isTrusted: true });
  assert.notEqual(h.messages[0].key, h.messages[1].key);
  h.dispatch(a.row, 'click', { button: 0, isTrusted: true });
  assert.deepEqual(JSON.parse(h.messages.at(-1).key), ['chatgpt-nav-v1', 'project', CHAT_PROJECT_A]);
  const menu = new Element('button', { 'aria-label': 'Same のプロジェクトアクション', 'aria-haspopup': 'menu' });
  a.row.children.push(menu); menu.parentElement = a.row;
  h.dispatch(menu, 'click', { button: 0, isTrusted: true });
  assert.equal(h.messages.at(-1).type, 'cancelNavigationLearning');
});

test('ChatGPT global text-only and labelled New chat share existing legacy mappings across pages', async () => {
  const top = new Element('button'); top.text = '新しいチャット';
  const recent = new Element('button', { 'aria-label': '新しいチャット' });
  const nav = new Element('nav', { 'aria-label': 'ホーム' }, [top, new Element('section', { 'aria-label': 'Recent' }, [recent])]);
  const root = new Element('html', {}, [new Element('body', {}, [nav])]);
  const old = JSON.stringify(['v1', 'button', '', [], '新しいチャット', ['nav', 'ホーム', ''], '/old-page']);
  const entries = learning.remember([], 'https://chatgpt.com', JSON.stringify(['section-v1', old, 'old-context']), 'https://chatgpt.com/', Date.now() - 7 * 86400000);
  const h = harness('chatgpt.com', { root, entries, topFrame: true });
  h.location.pathname = '/c/unseen-page';
  top.click = recent.click = () => assert.fail('must not rediscover');
  await flush();
  for (const target of [top, recent]) { h.advance(); h.dispatch(target); }
  assert.deepEqual(h.messages.map(m => [m.type, m.url]), [
    ['maybeOpenOnMiddle', 'https://chatgpt.com/'], ['maybeOpenOnMiddle', 'https://chatgpt.com/'],
  ]);
});

test('ChatGPT project New chat reuses old page-specific records without migrating storage', async () => {
  const item = chatProject();
  const old = JSON.stringify(['v1', 'button', '', [], 'Same で新しいチャット', ['nav', 'ホーム', ''], '/old-session']);
  const url = 'https://chatgpt.com/g/' + CHAT_PROJECT_A + '/project';
  const entries = learning.remember([], 'https://chatgpt.com', old, url);
  const h = harness('chatgpt.com', { root: item.root, entries });
  item.button.click = () => assert.fail('must reuse legacy record');
  await flush(); h.dispatch(item.icon);
  assert.deepEqual(h.messages.map(m => [m.type, m.url]), [['maybeOpenOnMiddle', url]]);
});

test('ChatGPT action specialization excludes other hosts, main content and invalid project IDs', () => {
  for (const kind of ['host', 'main', 'id']) {
    const item = chatProject(kind === 'id' ? 'not-a-project' : CHAT_PROJECT_A);
    if (kind === 'main') { const main = new Element('main', {}, [item.nav]); new Element('html', {}, [new Element('body', {}, [main])]); }
    const h = harness(kind === 'host' ? 'example.com' : 'chatgpt.com', { root: rootOf(item.button) });
    h.dispatch(item.icon, 'click', { button: 0, isTrusted: true });
    assert.equal(JSON.parse(h.messages.at(-1).key)[0], 'v1', kind);
  }
});

test('an early middle click waits for saved destinations before prompting or discovering', async () => {
  for (const kind of ['loaded', 'cancelled', 'navigated']) {
    let finish, prompts = 0, clicks = 0;
    const item = chatProject(); item.button.click = () => clicks++;
    const h = harness('chatgpt.com', { root: item.root, topFrame: true, confirm() { prompts++; return true; },
      loadEntries: () => new Promise(resolve => { finish = resolve; }) });
    h.dispatch(item.icon, 'pointerdown'); h.dispatch(item.icon, 'mousedown');
    await flush();
    assert.equal(h.messages.length, 0);
    if (kind === 'cancelled') h.dispatch(item.icon, 'keydown', { isTrusted: true });
    if (kind === 'navigated') h.location.pathname = '/c/changed';
    const key = JSON.stringify(['chatgpt-nav-v1', 'new-chat', CHAT_PROJECT_A]);
    const entries = learning.remember([], h.location.origin, key, h.location.origin + '/g/' + CHAT_PROJECT_A + '/project');
    finish({ [learning.STORAGE_KEY]: { version: 1, entries } }); await flush();
    assert.equal(prompts, 0); assert.equal(clicks, 0);
    assert.equal(h.messages.filter(m => m.type === 'maybeOpenOnMiddle').length, kind === 'loaded' ? 1 : 0);
    assert.equal(h.messages.some(m => m.type === 'beginSiteNavigationProbe'), false);
  }
});

function driveItem(role = 'row', id = 'folder_abcdefgh1234', type = '') {
  const title = new Element('title', {}, [], SVG);
  title.text = type;
  const icon = new Element('svg', {}, [title, new Element('path', {}, [], SVG)], SVG);
  const label = new Element('span', { 'data-id': id }, [icon]);
  const item = new Element('div', { role, 'data-id': id, 'data-target': 'doc',
    'data-selectable': '', tabindex: '-1' }, [label]);
  return { item, label, icon };
}

function driveHarness(role = 'row', options = {}) {
  const item = driveItem(role);
  item.label.attrs['data-tooltip'] = 'name';
  const root = new Element('html', {}, [new Element('body', {}, [item.item])]);
  const h = harness('drive.google.com', { root, topFrame: true, ...options });
  h.location.pathname = '/drive/u/2/my-drive';
  item.label.onDispatch = event => { if (event.type === 'mousedown') item.item.attrs['aria-selected'] = 'true'; };
  return { ...h, ...item, root };
}

test('Drive list/grid delegate one complete middle gesture to the default-open shortcut', async () => {
  for (const role of ['row', 'gridcell']) {
    const h = driveHarness(role);
    for (const type of ['pointerdown', 'mousedown', 'mouseup', 'auxclick']) assert.equal(h.dispatch(h.icon, type).defaultPrevented, true);
    await flush();
    assert.deepEqual(h.messages.map(m => m.type), ['beginDriveDefaultOpen']);
    assert.equal(h.messages[0].itemId, 'folder_abcdefgh1234');
    assert.equal(h.messages[0].sourceUrl, h.location.href);
    assert.equal(h.messages[0].url, undefined);
    assert.deepEqual(h.label.events.map(e => e.type), ['pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']);
    assert.equal(h.item.events.length, 1);
    assert.equal(h.item.events[0].key, 'Enter');
    assert.equal(Boolean(h.item.events[0].ctrlKey), false);
    assert.equal(h.item.events[0].keyCode, 13);
    assert.equal(h.item.focused, true);
    h.receive({ type: 'driveOpenFeedback', requestId: h.messages[0].requestId, reason: 'drive-opened' });
    h.advance(); h.dispatch(h.icon); await flush();
    assert.equal(h.item.events.length, 2);
  }
});

test('Drive uses current account and default app without filename, type or URL guesses', async () => {
  for (const [path, search] of [['/drive/u/0/my-drive', '?authuser=3'], ['/drive/my-drive', '?authuser=person%40example.com'], ['/drive/folders/parent_1234567890', '']]) {
    const h = driveHarness(); h.location.pathname = path; h.location.search = search; h.label.text = 'notes.md';
    h.dispatch(h.icon); await flush();
    assert.equal(h.messages[0].sourceUrl, h.location.href);
    assert.equal(h.messages[0].url, undefined);
    assert.equal(Boolean(h.item.events[0].ctrlKey), false);
  }
});

test('Drive nested controls, ordinary left clicks and modified middle clicks retain their behavior', () => {
  const h = driveHarness();
  const owner = new Element('div', { role: 'button', tabindex: '-1' });
  const menu = new Element('button', { 'aria-haspopup': 'menu' });
  h.item.children.push(owner, menu); owner.parentElement = menu.parentElement = h.item;
  h.dispatch(owner); h.dispatch(menu); h.dispatch(h.icon, 'mousedown', { ctrlKey: true });
  assert.equal(h.messages.some(m => m.type === 'beginDriveDefaultOpen'), false);
  h.messages.length = 0;
  assert.equal(h.dispatch(h.icon, 'click', { button: 0, isTrusted: true }).defaultPrevented, undefined);
  assert.deepEqual(h.messages.map(m => m.type), ['cancelNavigationLearning']);
  assert.equal(h.item.events, undefined);
});

test('Drive detection is restricted to top-level HTTPS selectable item controls', () => {
  for (const kind of ['host', 'subdomain', 'http', 'path', 'role', 'target', 'selectable', 'id', 'form', 'disabled', 'frame', 'editable']) {
    const h = driveHarness('row', { topFrame: kind !== 'frame' });
    if (kind === 'host') h.location.hostname = 'example.com';
    if (kind === 'subdomain') h.location.hostname = 'drive.google.com.example.com';
    if (kind === 'http') h.location.protocol = 'http:';
    if (kind === 'path') h.location.pathname = '/file/d/abcdefgh1234/view';
    if (kind === 'role') h.item.attrs.role = 'button';
    if (kind === 'target') h.item.attrs['data-target'] = 'node';
    if (kind === 'selectable') delete h.item.attrs['data-selectable'];
    if (kind === 'id') h.item.attrs['data-id'] = '../not-an-id?';
    if (kind === 'form') new Element('form', {}, [h.item]);
    if (kind === 'disabled') h.item.attrs['aria-disabled'] = 'true';
    if (kind === 'editable') h.label.attrs.contenteditable = 'true';
    h.dispatch(h.icon);
    assert.equal(h.messages.some(m => m.type === 'beginDriveDefaultOpen'), false, kind);
  }
});

test('Drive denied acknowledgements, stale source/item and user cancellation never execute', async () => {
  for (const kind of ['denied', 'rejected', 'source', 'id', 'cancel']) {
    let finish;
    const h = driveHarness('row', { driveAcknowledge: () => kind === 'rejected' ? Promise.reject(new Error()) : new Promise(resolve => { finish = resolve; }) });
    h.dispatch(h.icon);
    if (kind === 'source') h.location.pathname = '/drive/home';
    if (kind === 'id') h.item.attrs['data-id'] = 'different_1234567890';
    if (kind === 'cancel') h.dispatch(h.icon, 'keydown', { isTrusted: true });
    finish?.({ ok: kind !== 'denied' }); await flush();
    assert.equal(h.label.events, undefined, kind);
    assert.equal(h.item.events, undefined, kind);
  }
});

test('Drive selection failure, multi-selection and missing labels never open a guessed fallback', async () => {
  for (const kind of ['selection', 'multiple', 'label']) {
    const h = driveHarness();
    if (kind === 'selection') h.label.onDispatch = () => {};
    if (kind === 'multiple') {
      const other = driveItem(); other.item.attrs['aria-selected'] = 'true';
      h.item.parentElement.children.push(other.item); other.item.parentElement = h.item.parentElement;
    }
    if (kind === 'label') delete h.label.attrs['data-tooltip'];
    h.dispatch(h.icon); await flush();
    assert.equal(h.item.events, undefined, kind);
    assert.ok(h.messages.some(m => m.type === 'cancelDriveDefaultOpen'));
    assert.ok(h.notices.includes('drive-open-failed'));
    assert.equal(h.messages.some(m => m.type === 'maybeOpenOnMiddle'), false);
  }
});

test('Drive busy gestures and stale feedback cannot open a second tab', async () => {
  const h = driveHarness(); h.dispatch(h.icon); await flush();
  h.advance(); h.dispatch(h.icon); await flush();
  assert.equal(h.item.events.length, 1);
  assert.ok(h.notices.includes('busy'));
  const first = h.messages[0].requestId;
  h.receive({ type: 'driveOpenFeedback', requestId: first, reason: 'drive-opened' });
  h.advance(); h.dispatch(h.icon); await flush();
  h.receive({ type: 'driveOpenFeedback', requestId: first, reason: 'drive-open-failed' });
  h.advance(); h.dispatch(h.icon); await flush();
  assert.equal(h.item.events.length, 2);
});

test('Drive only reopens in preview mode after the normal action shows a visible preview', async () => {
  const h = driveHarness();
  let visible = false, closed = 0;
  const frame = new Element('iframe');
  frame.src = 'https://drive.google.com/viewer/main?source=10';
  frame.checkVisibility = () => visible;
  const close = new Element('button'); close.checkVisibility = () => true;
  close.onDispatch = e => { if (e.type === 'click') { visible = false; closed++; } };
  frame.contentDocument = { querySelector: () => close };
  h.root.children[0].children.push(frame); frame.parentElement = h.root.children[0];
  h.item.onDispatch = e => { if (!e.ctrlKey) visible = true; };
  h.dispatch(h.icon); await flush();
  assert.equal(h.item.events.length, 2);
  assert.equal(Boolean(h.item.events[0].ctrlKey), false);
  assert.equal(h.item.events[1].ctrlKey, true);
  assert.equal(closed, 1);
  assert.equal(visible, false);
});

test('Drive leaves an already-open preview alone instead of replaying a hidden item', () => {
  const h = driveHarness();
  const frame = new Element('iframe'); frame.src = 'https://drive.google.com/viewer/main';
  frame.checkVisibility = () => true;
  h.root.children[0].children.push(frame); frame.parentElement = h.root.children[0];
  h.dispatch(h.icon);
  assert.equal(h.messages.length, 0);
  assert.ok(h.notices.includes('drive-open-failed'));
});

test('Drive uses the parent close control when the preview toolbar is in an iframe', async () => {
  const h = driveHarness(); let visible = false;
  const frame = new Element('iframe'); frame.src = 'https://drive.google.com/viewer/main';
  frame.checkVisibility = () => visible;
  frame.contentDocument = null;
  h.root.children[0].children.push(frame); frame.parentElement = h.root.children[0];
  const close = { click() { visible = false; } };
  h.document.querySelector = () => close;
  h.item.onDispatch = e => { if (!e.ctrlKey) visible = true; };
  h.dispatch(h.icon); await flush();
  assert.equal(h.item.events.length, 2);
  assert.equal(h.item.events[1].ctrlKey, true);
  assert.equal(visible, false);
});
test('a control cannot borrow another navigation item URL from a broad ancestor', () => {
  const unknown = iconButton();
  unknown.button.parentElement.children.push(new Element('a', { href: '/unrelated' }));
  const h = harness();
  h.dispatch(unknown.icon);
  assert.equal(h.messages.length, 0);
});

test('GET form buttons and submit inputs still resolve without submitting; POST forms do not', () => {
  for (const tag of ['button', 'input']) {
    for (const method of ['get', 'post']) {
      const submitter = new Element(tag, { type: 'submit' });
      const form = new Element('form', { method, action: '/search' }, [submitter]);
      form.fields = [['q', 'hello world']];
      const h = harness('example.com');
      h.dispatch(submitter);
      if (method === 'get') assert.equal(h.messages[0].url, 'https://example.com/search?q=hello+world');
      else assert.equal(h.messages.length, 0);
    }
  }
});

test('cancelling initial site consent never grants permission, registers a probe or clicks', async () => {
  const { icon, button } = iconButton({ 'data-item-id': 'initial', 'aria-label': 'Initial navigation' });
  let prompts = 0;
  let clicks = 0;
  button.click = () => clicks++;
  const h = harness('example.com', { root: rootOf(button), topFrame: true,
    confirm(text) { prompts++; assert.match(text, /https:\/\/example.com/); assert.match(text, /未学習/); return false; } });
  h.dispatch(icon, 'pointerdown');
  h.dispatch(icon, 'mousedown');
  await flush();
  assert.equal(prompts, 1);
  assert.equal(clicks, 0);
  assert.deepEqual(h.messages.map(message => message.type), ['getSiteLearningPermission']);
});

test('initial site consent is saved before registration and discovery clicks only after acknowledgement', async () => {
  const { icon, button } = iconButton({ 'data-item-id': 'initial', 'aria-label': 'Initial navigation' });
  let acknowledge;
  let clicks = 0;
  button.click = () => clicks++;
  const response = new Promise(resolve => { acknowledge = resolve; });
  const h = harness('example.com', { root: rootOf(button), topFrame: true, confirm: () => true,
    acknowledge: () => response });
  h.dispatch(icon, 'pointerdown');
  h.dispatch(icon, 'mousedown');
  await flush();
  assert.equal(clicks, 0);
  assert.deepEqual(h.messages.map(message => message.type), [
    'getSiteLearningPermission', 'grantSiteLearningPermission', 'beginSiteNavigationProbe',
  ]);
  assert.equal(h.messages[1].confirmed, true);
  assert.equal(h.messages[1].origin, 'https://example.com');
  acknowledge({ ok: true });
  await flush();
  assert.equal(clicks, 1);
});

test('one site consent covers a different previously unlearned control on that site', async () => {
  const first = iconButton({ 'data-item-id': 'first', 'aria-label': 'First' });
  const second = iconButton({ 'data-item-id': 'second', 'aria-label': 'Second' });
  first.button.parentElement.children.push(second.button);
  second.button.parentElement = first.button.parentElement;
  let prompts = 0;
  const clicked = [];
  first.button.click = () => clicked.push('first');
  second.button.click = () => clicked.push('second');
  const h = harness('example.com', { root: rootOf(first.button), topFrame: true,
    confirm() { prompts++; return true; } });
  h.dispatch(first.icon); await flush();
  h.receive({ type: 'navigationProbeFeedback', reason: 'opened' });
  h.dispatch(second.icon); await flush();
  assert.equal(prompts, 1);
  assert.deepEqual(clicked, ['first', 'second']);
  assert.equal(h.messages.filter(message => message.type === 'grantSiteLearningPermission').length, 1);
  assert.equal(h.messages.filter(message => message.type === 'beginSiteNavigationProbe').length, 2);
});

test('a persisted site grant skips confirmation in a fresh document with an unknown control', async () => {
  const { icon, button } = iconButton({ 'data-item-id': 'never-learned' });
  let clicks = 0;
  let prompts = 0;
  button.click = () => clicks++;
  const h = harness('example.com', { root: rootOf(button), topFrame: true, siteAllowed: true,
    confirm() { prompts++; return false; } });
  h.dispatch(icon); await flush();
  assert.equal(prompts, 0);
  assert.equal(clicks, 1);
  assert.deepEqual(h.messages.map(message => message.type), ['getSiteLearningPermission', 'beginSiteNavigationProbe']);
});

test('failure to persist site consent never starts discovery or clicks a target', async () => {
  const { icon, button } = iconButton({ 'data-item-id': 'first' });
  let clicks = 0;
  button.click = () => clicks++;
  const h = harness('example.com', { root: rootOf(button), topFrame: true, confirm: () => true,
    savePermission: async () => ({ ok: false }) });
  h.dispatch(icon); await flush();
  assert.equal(clicks, 0);
  assert.equal(h.messages.some(message => message.type === 'beginSiteNavigationProbe'), false);
  assert.equal(h.notices.at(-1), 'permission-save-failed');
});

test('another user action while consent is being registered cancels the original discovery', async () => {
  const { icon, button } = iconButton({ 'data-item-id': 'first' });
  let acknowledge;
  let clicks = 0;
  button.click = () => clicks++;
  const response = new Promise(resolve => { acknowledge = resolve; });
  const h = harness('example.com', { root: rootOf(button), topFrame: true, siteAllowed: true,
    acknowledge: () => response });
  h.dispatch(icon); await flush();
  h.dispatch(icon, 'keydown', { isTrusted: true });
  acknowledge({ ok: true }); await flush();
  assert.equal(clicks, 0);
});

test('a late failed grant from a cancelled attempt does not clear a newer active discovery', async () => {
  const items = ['first', 'second', 'third'].map(id => iconButton({ 'data-item-id': id }));
  const nav = items[0].button.parentElement;
  for (const item of items.slice(1)) { nav.children.push(item.button); item.button.parentElement = nav; }
  const clicked = [];
  items.forEach((item, index) => { item.button.click = () => clicked.push(index); });
  let finishFirst;
  let grants = 0;
  const firstGrant = new Promise(resolve => { finishFirst = resolve; });
  const h = harness('example.com', { root: rootOf(items[0].button), topFrame: true, confirm: () => true,
    savePermission: () => ++grants === 1 ? firstGrant : Promise.resolve({ ok: true }) });
  h.dispatch(items[0].icon); await flush();
  h.dispatch(items[0].icon, 'keydown', { isTrusted: true });
  h.dispatch(items[1].icon); await flush();
  finishFirst({ ok: false }); await flush();
  h.dispatch(items[2].icon); await flush();
  assert.deepEqual(clicked, [1]);
  assert.equal(h.notices.at(-1), 'busy');
});

test('rejected acknowledgements or changed source pages never execute the confirmed control', async () => {
  for (const changed of [false, true]) {
    const { icon, button } = iconButton({ 'data-item-id': 'initial' });
    let clicks = 0;
    button.click = () => clicks++;
    const h = harness('example.com', { root: rootOf(button), topFrame: true, confirm: () => true,
      acknowledge: async () => ({ ok: changed }) });
    h.dispatch(icon);
    if (changed) h.location.pathname = '/another-page';
    for (let i = 0; i < 8; i++) await Promise.resolve();
    assert.equal(clicks, 0);
  }
});

test('immediate learned feedback avoids a second prompt while local persistence finishes', async () => {
  const { icon, button } = iconButton({ 'data-item-id': 'initial' });
  let prompts = 0;
  const h = harness('example.com', { root: rootOf(button), topFrame: true,
    confirm() { prompts++; return false; } });
  h.dispatch(icon, 'click', { button: 0, isTrusted: true });
  const key = h.messages.pop().key;
  h.receive({ type: 'navigationProbeLearned', key, destination: 'https://example.com/destination' });
  // The late initial storage read must not erase the freshly learned in-memory
  // mapping while the background's durable write is still in flight.
  await Promise.resolve();
  h.dispatch(icon);
  assert.equal(prompts, 0);
  assert.equal(h.messages[0].url, 'https://example.com/destination');
});

test('history restoration uses the exact original entry, and refuses replaced or foreign entries', () => {
  const h = harness('example.com');
  const traversed = [];
  const source = h.location.href;
  h.window.navigation = { currentEntry: { key: 'destination' }, entries: () => [
    { key: 'source', url: source }, { key: 'replaced', url: 'https://example.com/replaced' },
  ], traverseTo(key) { traversed.push(key); return { committed: Promise.resolve() }; } };
  for (const [entryKey, sourceUrl, expected] of [
    ['source', source, true], ['replaced', source, false], ['source', 'https://other.example/', false],
  ]) {
    let response;
    h.receive({ type: 'restoreConfirmedNavigationProbe', entryKey, sourceUrl }, value => { response = value; });
    assert.equal(response.traversing, expected);
  }
  assert.deepEqual(traversed, ['source']);
});

function modeHarness({ url = 'https://chatgpt.com/#middleclick-plus-codex', ready = 'complete', selectAfter = 1 } = {}) {
  const location = new URL(url);
  const timers = [];
  const warnings = [];
  let clicks = 0;
  let selected = false;
  const history = {
    state: { usr: { sidebarProductMode: 'work' } },
    replaceState(state, title, url) { location.href = new URL(url, location).href; this.state = state; },
  };
  const button = {
    hasAttribute: () => selected,
    click() {
      if (++clicks >= selectAfter) {
        selected = true;
        history.state.usr.sidebarProductMode = 'codex';
      }
    },
  };
  const document = {
    readyState: ready, addEventListener() {},
    querySelector(selector) {
      assert.equal(selector, 'button[data-sidebar-destination="builtin:codex"]');
      return button;
    },
  };
  const window = { addEventListener() {}, postMessage() {} };
  vm.runInNewContext(source, {
    location, history, document, window, top: window, MiddleClickLearning: learning,
    chrome: { runtime: { onMessage: { addListener() {} } }, storage: { local: { get: async () => ({}) }, onChanged: { addListener() {} } } },
    setTimeout(fn) { timers.push(fn); },
    console: { warn(message) { warnings.push(message); } },
  });
  return { location, history, timers, warnings, document, get clicks() { return clicks; } };
}

test('Codex marker selects the known mode after hydration and removes the marker', () => {
  const h = modeHarness({ selectAfter: 2 });
  while (h.timers.length) h.timers.shift()();
  assert.equal(h.clicks, 2);
  assert.equal(h.history.state.usr.sidebarProductMode, 'codex');
  assert.equal(h.location.href, 'https://chatgpt.com/');
  assert.equal(h.warnings.length, 0);
});

test('Codex mode selection waits for the new document to finish loading', () => {
  const h = modeHarness({ ready: 'loading' });
  assert.equal(h.clicks, 0);
  h.document.readyState = 'complete';
  while (h.timers.length) h.timers.shift()();
  assert.equal(h.clicks, 1);
  assert.equal(h.location.hash, '');
});

test('ordinary URLs, other hosts and other paths never activate a mode control', () => {
  for (const url of [
    'https://chatgpt.com/', 'https://chatgpt.com/#another-fragment',
    'https://example.com/#middleclick-plus-codex',
    'https://chatgpt.com/c/example#middleclick-plus-codex',
  ]) {
    const h = modeHarness({ url });
    assert.equal(h.clicks, 0);
    assert.equal(h.timers.length, 0);
    assert.equal(h.location.href, url);
  }
});

test('Codex mode initialization stops if the site never attaches the navigation handler', () => {
  const h = modeHarness({ selectAfter: Infinity });
  while (h.timers.length) h.timers.shift()();
  assert.equal(h.clicks, 150);
  assert.equal(h.warnings.length, 1);
});
