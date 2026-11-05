const test = require('node:test');
const assert = require('node:assert/strict');
const { Registry, Resolver } = require('../event-analysis.js');
const baseUrl = 'https://example.test/current';
const resolve = (handler, extra = {}) => new Resolver({ baseUrl, ...extra }).resolve(handler);

test('literal and computed navigation expressions resolve without calling handlers', () => {
  const cases = [
    [() => location.assign('/settings'), '/settings'],
    [() => { window.location.href = '/report'; }, '/report'],
    [() => location.replace(`/items/${encodeURIComponent('a/b')}`), '/items/a%2Fb'],
    [() => { const prefix = '/items/'; location.assign(prefix + '42'); }, '/items/42'],
    [() => window.open('/window', '_blank'), '/window'],
    [() => history.pushState(null, '', '/history'), '/history'],
  ];
  for (const [handler, path] of cases) assert.equal(resolve(handler).url, 'https://example.test' + path);
});

test('unsupported expressions, unknown branches and required navigation state fail closed', () => {
  for (const handler of [
    () => { if (unavailableFlag) location.assign('/first'); else location.assign('/second'); },
    () => location.assign(fetch('/api').then(result => result.url)),
    () => { for (;;) location.assign('/loop'); },
    () => { location.assign('/one'); location.assign('/two'); },
    () => { location.assign('/same'); location.assign('/same'); },
    () => location.assign('javascript:alert(1)'),
    () => location.assign('https://other.test/path'),
    () => history.pushState({ mode: 'required' }, '', '/same-url-mode'),
  ]) assert.equal(resolve(handler).url, null, handler.toString());
  const navigate = () => { throw new Error('Must never execute'); };
  function Holder(props) { const { navigate: route } = props; return () => route('/new', { state: { productMode: 'work' } }); }
  const handler = Holder({ navigate });
  assert.equal(resolve(handler, { frames: [{ source: Holder.toString(), props: { navigate }, caches: [] }], navigationFunctions: [navigate] }).url, null);
});

test('props, defaults and wrapper forwarding are read, never invoked', () => {
  let calls = 0;
  const target = () => location.assign('/target');
  function Button(props) {
    const { onClick: callback, disabled: stopped = false } = props;
    return event => { if (!stopped) { event.stopPropagation(); callback(event); } };
  }
  const props = { onClick: target, get unrelated() { calls++; throw new Error('Getter executed'); } };
  const handler = Button(props);
  const result = resolve(handler, { frames: [{ source: Button.toString(), props, caches: [] }] });
  assert.equal(result.url, 'https://example.test/target');
  assert.equal(calls, 0);
  assert.equal(resolve(Button({ onClick: target, disabled: true }), { frames: [{ source: Button.toString(), props: { onClick: target, disabled: true }, caches: [] }] }).url, null);
});

test('renamed compiler variables and moved cache slots resolve module URL builders', () => {
  // The fixture is application code. The resolver must only read its source.
  const registry = new Registry();
  registry.addSource(`export const __webpack_modules__ = {
    component: function(box, output, load) {
      var urlFactory = load('builder');
      function Item(props) {
        const slots = memo(11);
        let owner = props.id, enabled = feature(), route = props.navigate;
        let action = () => enabled ? route(urlFactory.link(owner), {state: undefined}) : route('/', {state:{owner}});
        slots[7] = owner; slots[9] = enabled; slots[2] = route; slots[5] = action;
        return action;
      }
    },
    builder: function(box, output, load) {
      load.d(output, {}, {link: function(key) { return \`/resource/\${encodeURIComponent(key)}/compose\`; }});
    }
  };`, 'https://example.test/assets/app.js');
  const navigate = () => { throw new Error('Navigation must never run'); };
  const source = `function Item(props) {
        const slots = memo(11);
        let owner = props.id, enabled = feature(), route = props.navigate;
        let action = () => enabled ? route(urlFactory.link(owner), {state: undefined}) : route('/', {state:{owner}});
        slots[7] = owner; slots[9] = enabled; slots[2] = route; slots[5] = action;
        return action;
      }`;
  // Construct only the callback in the test harness, not in the shipped resolver.
  const handler = () => enabled ? route(urlFactory.link(owner), {state: undefined}) : route('/', {state:{owner}});
  const cache = new Array(11); cache[7] = 'alpha/beta'; cache[9] = true; cache[2] = navigate; cache[5] = handler;
  const result = resolve(handler, { registry, frames: [{ source, props: { id: 'alpha/beta', navigate }, caches: [cache] }], navigationFunctions: [navigate] });
  assert.equal(result.url, 'https://example.test/resource/alpha%2Fbeta/compose');
  cache[9] = false;
  assert.equal(resolve(handler, { registry, frames: [{ source, props: { id: 'alpha/beta', navigate }, caches: [cache] }], navigationFunctions: [navigate] }).url, null);
});

test('cache conflicts, missing closure values and unknown module exports never guess', () => {
  const handler = () => location.assign('/' + key);
  function Card(props) { const values = memo(3); let key = source(); values[0] = key; values[1] = key; return () => location.assign('/' + key); }
  assert.equal(resolve(handler, { frames: [{ source: Card.toString(), props: {}, caches: [['one', 'two', null]] }] }).url, null);
  assert.equal(resolve(() => location.assign('/' + missingClosureValue)).url, null);
  const registry = new Registry(); registry.addSource('export const __webpack_modules__={ bad: function(a,b,c){c.d(b,{}, {url: object.constructor});} };');
  assert.equal(resolve(() => absent.url('/'), { registry }).url, null);
});

test('getters, prototypes, coercion hooks and page functions are never executed', () => {
  let calls = 0;
  const dangerous = { get id() { calls++; return 'secret'; }, toString() { calls++; return '/wrong'; } };
  function Card(props) { const { item } = props; return () => location.assign('/item/' + item.id); }
  assert.equal(resolve(Card({ item: dangerous }), { frames: [{ source: Card.toString(), props: { item: dangerous }, caches: [] }] }).url, null);
  function StringCard(props) { const { item } = props; return () => location.assign('/item/' + item); }
  assert.equal(resolve(StringCard({ item: dangerous }), { frames: [{ source: StringCard.toString(), props: { item: dangerous }, caches: [] }] }).url, null);
  assert.equal(resolve(() => location.constructor('/evil')).url, null);
  assert.equal(calls, 0);
});

test('only known router hook forwarders count as navigation sinks', () => {
  const forward = async (target, config = {}) => { check(mounted.current); mounted.current && await router.navigate(target, { fromRouteId: routeId, ...config }); };
  function Control(props) { const { route } = props; return () => route('/compose', { state: undefined }); }
  const handler = Control({ route: forward });
  const frames = [{ source: Control.toString(), props: { route: forward }, caches: [] }];
  assert.equal(resolve(handler, { frames, forwardingFunctions: [forward] }).url, 'https://example.test/compose');
  assert.equal(resolve(handler, { frames }).url, null);
  const conditional = target => featureEnabled ? router.navigate(target) : undefined;
  const conditionalHandler = Control({ route: conditional });
  assert.equal(resolve(conditionalHandler, { frames: [{ source: Control.toString(), props: { route: conditional }, caches: [] }], forwardingFunctions: [conditional] }).url, null);
});

test('input objects read after an unknown effect are not treated as immutable route evidence', () => {
  function Control(props) { const { item } = props; return () => { effect(); location.assign('/' + item.id); }; }
  assert.equal(resolve(Control({ item: { id: 'before' } }), { frames: [{ source: Control.toString(), props: { item: { id: 'before' } }, caches: [] }] }).url, null);
});

test('unknown hook destructuring does not overwrite a current cached undefined state', () => {
  function Item(props) {
    const slots = memo(5), { state } = readContext();
    const route = props.route;
    const action = () => route('/new', { state });
    slots[1] = state; slots[3] = route; slots[4] = action;
    return action;
  }
  const route = () => { throw new Error('Must not execute'); };
  const handler = () => route('/new', { state });
  const slots = new Array(5); slots[1] = undefined; slots[3] = route; slots[4] = handler;
  assert.equal(resolve(handler, { frames: [{ source: Item.toString(), props: { route }, caches: [slots] }], navigationFunctions: [route] }).url, 'https://example.test/new');
});

test('mutations and unknown local effects before a navigation are not silently ignored', () => {
  function Control(props) { let { id } = props; return () => { id++; location.assign('/' + id); }; }
  assert.equal(resolve(Control({ id: 1 }), { frames: [{ source: Control.toString(), props: { id: 1 }, caches: [] }] }).url, null);
  function Other(props) { const { id, effect } = props; return () => { effect(); location.assign('/' + id); }; }
  const effect = () => { external = 'different'; };
  assert.equal(resolve(Other({ id: 'before', effect }), { frames: [{ source: Other.toString(), props: { id: 'before', effect }, caches: [] }] }).url, null);
});

test('a nested factory closure cannot borrow similarly named outer component props', () => {
  function Outer(props) {
    function factory(props) { return () => location.assign(props.url); }
    return factory({ url: '/actual-inner-route' });
  }
  assert.equal(resolve(Outer({ url: '/wrong-outer-route' }), { frames: [{ source: Outer.toString(), props: { url: '/wrong-outer-route' }, caches: [] }] }).url, null);
});
