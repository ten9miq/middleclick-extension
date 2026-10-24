const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const learning = require('../navigation-learning.js');

const source = fs.readFileSync(path.join(__dirname, '../content.js'), 'utf8');
const SVG = 'http://www.w3.org/2000/svg';
const sprite = '/cdn/assets/icons-c6b5375eadec3cee.svg#codex-icon-folder-light-20';

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

function harness(host = 'chatgpt.com', { entries = [], root = null } = {}) {
  const listeners = new Map();
  const messages = [];
  const location = new URL(`https://${host}/c/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`);
  let time = 1000;
  let changed;
  const document = {
    baseURI: location.href,
    addEventListener(type, callback) { listeners.set(type, callback); },
    querySelectorAll(selector) {
      return root ? root.querySelectorAll(selector) : [];
    },
  };
  const saved = { [learning.STORAGE_KEY]: { version: 1, entries } };
  vm.runInNewContext(source, {
    Element, Node: { ELEMENT_NODE: 1 }, URL, URLSearchParams, location,
    FormData: class {
      constructor(form) { this.fields = form.fields || []; }
      entries() { return this.fields[Symbol.iterator](); }
    },
    document, MiddleClickLearning: learning,
    window: {}, top: {}, // Subframe avoids unrelated sidebar-learning observers.
    chrome: { runtime: { sendMessage(message) { messages.push(message); } }, storage: {
      local: { get: async () => saved }, onChanged: { addListener(callback) { changed = callback; } },
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
  return { messages, dispatch, location, document, advance() { time += 200; },
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

test('stable data identifiers are not interpreted as relative navigation URLs', () => {
  const h = harness('example.com');
  h.dispatch(iconButton({ 'data-route-id': 'opaque-id' }).icon);
  assert.equal(h.messages.length, 0);
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
    chrome: { storage: { local: { get: async () => ({}) }, onChanged: { addListener() {} } } },
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
