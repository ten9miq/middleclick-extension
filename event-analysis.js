(function (root) {
  'use strict';
  const commonJS = typeof window === 'undefined' && typeof module === 'object' && module.exports;
  const parser = commonJS ? require('./vendor/acorn/acorn.js') : root.MiddleClickAcorn;
  const UNKNOWN = Symbol('unknown');
  const TAG = Symbol('analysis-reference');
  const blocked = new Set(['__proto__', 'prototype', 'constructor', 'caller', 'callee', 'arguments']);
  const options = { ecmaVersion: 'latest', sourceType: 'module', allowAwaitOutsideFunction: true };
  const ref = (kind, data = {}) => ({ [TAG]: kind, ...data });
  const scalar = value => value === null || ['undefined', 'string', 'number', 'boolean'].includes(typeof value);
  function own(object, key) {
    if (object === UNKNOWN || object == null || typeof key !== 'string' || blocked.has(key)) return UNKNOWN;
    try {
      const descriptor = Object.getOwnPropertyDescriptor(object, key);
      return descriptor && 'value' in descriptor ? descriptor.value : descriptor ? UNKNOWN : undefined;
    } catch { return UNKNOWN; }
  }
  function functionSource(fn) {
    try { return typeof fn === 'function' ? Function.prototype.toString.call(fn) : ''; } catch { return ''; }
  }
  function walk(node, visit, descendFunctions = true) {
    const stack = [node];
    let count = 0;
    while (stack.length) {
      const current = stack.pop();
      if (!current || typeof current.type !== 'string') continue;
      if (++count > 350000) throw new Error('AST limit');
      visit(current);
      if (!descendFunctions && current !== node && /^(?:Function|ArrowFunction)/.test(current.type)) continue;
      for (const key of Object.keys(current)) {
        const value = current[key];
        if (Array.isArray(value)) {
          for (let i = value.length - 1; i >= 0; i--) if (value[i]?.type) stack.push(value[i]);
        } else if (value?.type) stack.push(value);
      }
    }
  }
  const tail = node => node?.type === 'SequenceExpression' ? tail(node.expressions.at(-1)) : node?.type === 'ChainExpression' ? tail(node.expression) : node;
  const keyOf = node => node?.computed ? node.property?.type === 'Literal' ? String(node.property.value) : null : node?.property?.name;
  const literalKey = property => property.computed ? property.key.type === 'Literal' ? String(property.key.value) : null : property.key.name ?? String(property.key.value);

  class Registry {
    constructor() { this.files = []; this.modules = new Map(); this.failures = new Set(); }
    addSource(source, url = '') {
      if (typeof source !== 'string' || source.length > 2500000 || this.files.length >= 64) return false;
      if (this.files.some(file => file.url === url && url)) return true;
      this.files.push({ source, url, parsed: false });
      return true;
    }
    parseFile(file) {
      if (file.parsed) return;
      file.parsed = true;
      try {
        const ast = parser.parse(file.source, options);
        const accept = object => {
          if (object?.type !== 'ObjectExpression') return;
          for (const property of object.properties) {
            if (property.type !== 'Property' || property.kind !== 'init' || !/FunctionExpression|ArrowFunctionExpression/.test(property.value.type)) continue;
            const id = literalKey(property);
            if (id == null || blocked.has(id)) continue;
            const definition = { id, node: property.value, source: file.source, file };
            const previous = this.modules.get(id);
            if (previous && previous.source.slice(previous.node.start, previous.node.end) !== file.source.slice(property.value.start, property.value.end)) {
              this.modules.set(id, null); this.failures.add(id);
            } else if (!this.failures.has(id)) this.modules.set(id, definition);
          }
        };
        walk(ast, node => {
          if (node.type === 'VariableDeclarator' && /^__(?:webpack|rspack)_modules__$/.test(node.id?.name || '')) accept(node.init);
          if (node.type === 'CallExpression' && keyOf(tail(node.callee)) === 'push' && node.arguments[0]?.type === 'ArrayExpression') accept(node.arguments[0].elements[1]);
        });
      } catch { /* Unsupported source is data, never executable fallback. */ }
    }
    forComponent(source) {
      for (const file of this.files) if (file.source.includes(source)) this.parseFile(file);
      const matches = [...this.modules.values()].filter(item => item && item.source.slice(item.node.start, item.node.end).includes(source));
      return matches.length === 1 ? matches[0] : null;
    }
    get(id) {
      for (const file of this.files) if (file.source.includes(id + ':') || file.source.includes(JSON.stringify(id) + ':')) this.parseFile(file);
      return this.failures.has(id) ? null : this.modules.get(id);
    }
  }

  class Env {
    constructor(parent = null) { this.values = new Map(); this.parent = parent; }
    get(name) { return this.values.has(name) ? this.values.get(name) : this.parent ? this.parent.get(name) : UNKNOWN; }
    has(name) { return this.values.has(name) || Boolean(this.parent?.has(name)); }
    set(name, value) { this.values.set(name, value); }
  }

  class Resolver {
    constructor({ frames = [], registry = new Registry(), navigationFunctions = [], forwardingFunctions = [], baseUrl = 'https://example.invalid/' } = {}) {
      this.frames = frames;
      this.registry = registry;
      this.navigationFunctions = new Set(navigationFunctions);
      this.forwardingFunctions = new Set(forwardingFunctions);
      this.baseUrl = baseUrl;
      this.functions = new Map(); this.contexts = new Map(); this.modules = new Map();
      this.steps = 0; this.depth = 0;
    }
    tick() { if (++this.steps > 18000 || this.depth > 18 || (this.deadline && Date.now() > this.deadline)) throw new Error('Evaluation limit'); }
    parseFunction(fn) {
      const source = typeof fn === 'string' ? fn : functionSource(fn);
      if (!source || source.length > 180000 || source.includes('[native code]')) return null;
      if (this.functions.has(source)) return this.functions.get(source);
      let result = null;
      try {
        const wrapped = '(' + source + ')';
        const program = parser.parse(wrapped, options);
        const node = program.body.length === 1 ? program.body[0].expression : null;
        if (node && /^(FunctionExpression|ArrowFunctionExpression)$/.test(node.type)) result = { node, source: wrapped };
      } catch { /* Method syntax and unknown syntax fail closed. */ }
      this.functions.set(source, result);
      return result;
    }
    global(name) {
      if (['encodeURIComponent', 'encodeURI', 'String'].includes(name)) return ref('builtin', { name });
      if (name === 'undefined') return undefined;
      if (['window', 'self', 'globalThis'].includes(name)) return ref('window');
      if (name === 'location') return ref('location');
      if (name === 'history') return ref('history');
      return UNKNOWN;
    }
    bind(pattern, value, env, state) {
      if (!pattern) return;
      if (pattern.type === 'Identifier') {
        // An unreadable hook initializer must not erase a current value
        // independently evidenced by the compiler's dependency cache.
        if (!(state.binding && value === UNKNOWN && env.values.has(pattern.name) && env.values.get(pattern.name) !== UNKNOWN)) env.set(pattern.name, value);
      }
      else if (pattern.type === 'AssignmentPattern') this.bind(pattern.left, value === undefined ? this.value(pattern.right, env, state, true) : value, env, state);
      else if (pattern.type === 'ObjectPattern') {
        for (const property of pattern.properties) {
          if (property.type === 'RestElement') { this.bind(property.argument, UNKNOWN, env, state); continue; }
          const key = literalKey(property);
          this.bind(property.value, key == null ? UNKNOWN : this.member(value, key, state), env, state);
        }
      } else if (pattern.type === 'ArrayPattern') {
        pattern.elements.forEach((element, index) => this.bind(element, this.member(value, String(index), state), env, state));
      }
    }
    bindings(node, source, env, state, frame = null, module = null) {
      const declarations = [], assignments = [], functions = [];
      walk(node.body || node, current => {
        if (current.type === 'VariableDeclarator') declarations.push(current);
        if (current.type === 'AssignmentExpression') assignments.push(current);
        if (current.type === 'FunctionDeclaration') functions.push(current);
      }, false);
      if (frame) {
        const caches = frame.caches || [];
        const cacheNames = new Map();
        for (const declaration of declarations) {
          const init = declaration.init;
          if (declaration.id.type !== 'Identifier' || init?.type !== 'CallExpression' || init.arguments.length !== 1 || init.arguments[0].type !== 'Literal') continue;
          const matching = caches.filter(cache => Array.isArray(cache) && cache.length === init.arguments[0].value);
          if (matching.length === 1) { cacheNames.set(declaration.id.name, matching[0]); env.set(declaration.id.name, matching[0]); }
        }
        const values = new Map();
        for (const assignment of assignments) {
          const left = assignment.left;
          if (assignment.operator !== '=' || left.type !== 'MemberExpression' || assignment.right.type !== 'Identifier' || !cacheNames.has(left.object?.name)) continue;
          const key = keyOf(left);
          if (key == null || !/^\d+$/.test(key)) continue;
          const value = own(cacheNames.get(left.object.name), key);
          if (value === UNKNOWN || typeof value === 'symbol') continue;
          const name = assignment.right.name;
          if (values.has(name) && values.get(name) !== value) values.set(name, UNKNOWN);
          else if (!values.has(name)) values.set(name, value);
        }
        for (const [name, value] of values) env.set(name, value);
      }
      for (const fn of functions) if (fn.id) env.set(fn.id.name, ref('function', { node: fn, source, env }));
      for (let pass = 0; pass < 4; pass++) {
        for (const declaration of declarations) {
          if (declaration.id.type === 'Identifier' && env.values.has(declaration.id.name) && env.values.get(declaration.id.name) !== UNKNOWN) continue;
          let value = UNKNOWN;
          const init = declaration.init;
          if (module && init?.type === 'CallExpression' && init.callee.type === 'Identifier' && init.callee.name === module.node.params[2]?.name && init.arguments[0]?.type === 'Literal') {
            value = ref('module', { id: String(init.arguments[0].value) });
          } else if (init) value = this.value(init, env, state, true);
          this.bind(declaration.id, value, env, state);
        }
      }
    }
    moduleEnv(definition) {
      if (this.modules.has(definition.id)) return this.modules.get(definition.id);
      const env = new Env();
      this.modules.set(definition.id, env);
      this.bindings(definition.node, definition.source, env, { binding: true }, null, definition);
      return env;
    }
    exported(id, name) {
      if (blocked.has(name)) return UNKNOWN;
      const definition = this.registry.get(id);
      if (!definition) return UNKNOWN;
      const env = this.moduleEnv(definition);
      let result = UNKNOWN;
      walk(definition.node.body, node => {
        if (node.type !== 'CallExpression' || keyOf(tail(node.callee)) !== 'd') return;
        const callee = tail(node.callee);
        if (callee.object?.name !== definition.node.params[2]?.name || node.arguments[0]?.name !== definition.node.params[1]?.name) return;
        for (let index = 1; index <= 2; index++) {
          const object = node.arguments[index];
          if (object?.type !== 'ObjectExpression') continue;
          for (const property of object.properties) {
            if (property.type !== 'Property' || property.kind !== 'init' || property.method || literalKey(property) !== name) continue;
            if (index === 1 && /Function|ArrowFunction/.test(property.value.type)) {
              const fn = property.value;
              const expression = fn.body.type === 'BlockStatement' && fn.body.body.length === 1 && fn.body.body[0].type === 'ReturnStatement' ? fn.body.body[0].argument : fn.body.type !== 'BlockStatement' ? fn.body : null;
              if (expression) result = this.value(expression, env, { binding: true }, true);
            } else result = this.value(property.value, env, { binding: true }, true);
          }
        }
      }, false);
      return result;
    }
    contextFor(fn) {
      if (this.contexts.has(fn)) return this.contexts.get(fn);
      const source = functionSource(fn);
      const env = new Env();
      this.contexts.set(fn, env);
      let frame, component;
      for (const candidate of this.frames) {
        if (candidate.source.length <= source.length || !candidate.source.includes(source)) continue;
        const parsed = this.parseFunction(candidate.source);
        if (!parsed) continue;
        let direct = false;
        walk(parsed.node.body, node => {
          if (/^(?:Function|ArrowFunction)/.test(node.type) && parsed.source.slice(node.start, node.end) === source) direct = true;
        }, false);
        // A text match inside an inner factory is not evidence that its free
        // variables belong to this component's props or compiler cache.
        if (direct) { frame = candidate; component = parsed; break; }
      }
      if (!frame) return env;
      const factory = this.registry.forComponent(frame.source);
      if (factory) env.parent = this.moduleEnv(factory);
      this.bind(component.node.params[0], frame.props, env, { binding: true });
      this.bindings(component.node, component.source, env, { binding: true }, frame);
      return env;
    }
    member(object, key, state) {
      if (typeof key !== 'string' || blocked.has(key) || object === UNKNOWN || object == null) return UNKNOWN;
      const kind = object[TAG];
      if (kind === 'module') return this.exported(object.id, key);
      if (kind === 'event') return own({ button: 1, ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, defaultPrevented: false }, key) ?? (['preventDefault', 'stopPropagation', 'stopImmediatePropagation'].includes(key) ? ref('noop') : undefined);
      if (kind === 'window') return ['location', 'history'].includes(key) ? ref(key) : key === 'open' ? ref('navigation', { ignoreOptions: true }) : UNKNOWN;
      if (kind === 'location') return ['assign', 'replace'].includes(key) ? ref('navigation', { ignoreOptions: true }) : key === 'href' ? this.baseUrl : UNKNOWN;
      if (kind === 'history') return ['pushState', 'replaceState'].includes(key) ? ref('navigation', { argument: 2 }) : UNKNOWN;
      if (kind === 'record') return own(object.fields, key);
      if (typeof object === 'string' && key === 'length') return object.length;
      if (state?.dirty && !state.binding) return UNKNOWN;
      return own(object, key);
    }
    forwarder(fn, parsed) {
      if (!this.forwardingFunctions.has(fn) || parsed.node.params[0]?.type !== 'Identifier') return false;
      const parameter = parsed.node.params[0].name;
      let count = 0, bad = false;
      const guard = node => {
        if (!node) return false;
        if (node.type === 'Literal') return true;
        if (node.type === 'MemberExpression') return keyOf(node) === 'current' && node.object.type === 'Identifier';
        if (node.type === 'UnaryExpression') return node.operator === 'typeof' && node.argument.name === parameter || node.operator === '!' && guard(node.argument);
        if (node.type === 'BinaryExpression' || node.type === 'LogicalExpression') return guard(node.left) && guard(node.right);
        return false;
      };
      walk(parsed.node.body, node => {
        if (node.type === 'CallExpression' && keyOf(tail(node.callee)) === 'navigate') {
          count++; if (node.arguments[0]?.type !== 'Identifier' || node.arguments[0].name !== parameter) bad = true;
        }
        if (node.type === 'ConditionalExpression' || node.type === 'IfStatement') { if (!guard(node.test)) bad = true; }
        if (node.type === 'LogicalExpression' && !guard(node.left)) bad = true;
      }, false);
      return count > 0 && !bad;
    }
    navigation(args, index, state, ignoreOptions = false) {
      const url = args[index];
      if (typeof url !== 'string' || !/^(?:https?:\/\/|\/)/i.test(url) || url.length > 4096) throw new Error('Unresolved destination');
      const config = args[index + 1];
      if (index === 2 && args[0] != null && !(args[0]?.[TAG] === 'record' && Object.keys(args[0].fields).length === 0)) throw new Error('Navigation state required');
      if (!ignoreOptions && index === 0 && config !== undefined && config !== null) {
        if (config === UNKNOWN) throw new Error('Unknown navigation options');
        const data = this.member(config, 'state', state);
        if (data === UNKNOWN || (data != null && !(data[TAG] === 'record' && Object.keys(data.fields).length === 0))) throw new Error('Navigation state required');
      }
      state.urls.push(new URL(url, this.baseUrl).href);
      return undefined;
    }
    call(callee, args, state, demanded) {
      this.tick();
      const kind = callee?.[TAG];
      if (kind === 'noop') return undefined;
      if (kind === 'builtin') {
        if (args.some(value => value === UNKNOWN || !scalar(value))) return UNKNOWN;
        try { return ({ encodeURIComponent, encodeURI, String })[callee.name](...args); } catch { return UNKNOWN; }
      }
      if (kind === 'navigation') return this.navigation(args, callee.argument || 0, state, callee.ignoreOptions);
      if (typeof callee !== 'function' && kind !== 'function') { if (!state.binding) throw new Error('Unknown call'); return UNKNOWN; }
      if (state.binding) return UNKNOWN;
      if (this.navigationFunctions.has(callee)) return this.navigation(args, 0, state);
      const parsed = kind === 'function' ? callee : this.parseFunction(callee);
      if (!parsed) throw new Error('Unknown function');
      if (typeof callee === 'function' && this.forwarder(callee, parsed)) return this.navigation(args, 0, state);
      const env = new Env(kind === 'function' ? callee.env : this.contextFor(callee));
      parsed.node.params.forEach((parameter, index) => this.bind(parameter, index < args.length ? args[index] : undefined, env, state));
      const nested = { urls: [], dirty: state.dirty };
      this.depth++;
      try {
        const result = parsed.node.body.type === 'BlockStatement' ? this.statements(parsed.node.body.body, env, nested) : { returned: true, value: this.value(parsed.node.body, env, nested, true) };
        state.urls.push(...nested.urls); state.dirty = nested.dirty;
        return result?.returned ? result.value : undefined;
      } finally { this.depth--; }
    }
    value(node, env, state, demanded = true) {
      this.tick();
      if (!node) return undefined;
      switch (node.type) {
        case 'Literal': return scalar(node.value) ? node.value : UNKNOWN;
        case 'Identifier': return env.has(node.name) ? env.get(node.name) : this.global(node.name);
        case 'ChainExpression': return this.value(node.expression, env, state, demanded);
        case 'FunctionExpression': case 'ArrowFunctionExpression': return ref('function', { node, source: '', env });
        case 'MemberExpression': {
          const object = this.value(node.object, env, state, true);
          if (node.optional && object == null) return undefined;
          const key = node.computed ? this.value(node.property, env, state, true) : node.property.name;
          return scalar(key) && key !== UNKNOWN ? this.member(object, String(key), state) : UNKNOWN;
        }
        case 'TemplateLiteral': {
          let result = node.quasis[0].value.cooked;
          for (let i = 0; i < node.expressions.length; i++) {
            const value = this.value(node.expressions[i], env, state, true);
            if (value === UNKNOWN || !scalar(value)) return UNKNOWN;
            result += String(value) + node.quasis[i + 1].value.cooked;
          }
          return result.length <= 4096 ? result : UNKNOWN;
        }
        case 'UnaryExpression': {
          const value = this.value(node.argument, env, state, node.operator !== 'void');
          if (node.operator === 'void') return undefined;
          if (value === UNKNOWN) return UNKNOWN;
          if (node.operator === '!') return !value;
          if (node.operator === 'typeof') return typeof value;
          if (node.operator === '-' && typeof value === 'number') return -value;
          return UNKNOWN;
        }
        case 'LogicalExpression': {
          const left = this.value(node.left, env, state, true);
          if (left === UNKNOWN) { if (!state.binding) throw new Error('Unknown condition'); return UNKNOWN; }
          if (node.operator === '&&') return left ? this.value(node.right, env, state, demanded) : left;
          if (node.operator === '||') return left ? left : this.value(node.right, env, state, demanded);
          return left == null ? this.value(node.right, env, state, demanded) : left;
        }
        case 'ConditionalExpression': {
          const condition = this.value(node.test, env, state, true);
          if (condition === UNKNOWN) { if (!state.binding) throw new Error('Unknown condition'); return UNKNOWN; }
          return this.value(condition ? node.consequent : node.alternate, env, state, demanded);
        }
        case 'BinaryExpression': {
          const left = this.value(node.left, env, state, true), right = this.value(node.right, env, state, true);
          if (left === UNKNOWN || right === UNKNOWN || !scalar(left) || !scalar(right)) return UNKNOWN;
          switch (node.operator) {
            case '+': return typeof left === 'string' || typeof right === 'string' ? String(left) + String(right) : Number(left) + Number(right);
            case '===': return left === right; case '!==': return left !== right;
            case '==': return left == right; case '!=': return left != right; // primitives only
            case '<': return left < right; case '>': return left > right;
            default: return UNKNOWN;
          }
        }
        case 'SequenceExpression': {
          let result;
          node.expressions.forEach((expression, index) => { result = this.value(expression, env, state, index === node.expressions.length - 1 ? demanded : false); });
          return result;
        }
        case 'ObjectExpression': {
          const fields = Object.create(null);
          for (const property of node.properties) {
            if (property.type === 'SpreadElement') {
              const spread = this.value(property.argument, env, state, true);
              if (spread == null) continue;
              if (spread?.[TAG] !== 'record') return UNKNOWN;
              Object.assign(fields, spread.fields);
            } else {
              const key = literalKey(property);
              if (property.kind !== 'init' || key == null || blocked.has(key)) return UNKNOWN;
              fields[key] = this.value(property.value, env, state, true);
            }
          }
          return ref('record', { fields });
        }
        case 'ArrayExpression': return node.elements.map(element => this.value(element, env, state, true));
        case 'CallExpression': {
          const target = tail(node.callee);
          // Component/module initialization is not a program to run. In
          // particular do not expand imported hooks merely to discover that
          // their result is unknown. Current compiler values come from caches.
          if (state.binding && !(target.type === 'Identifier' && !env.has(target.name) && ['encodeURIComponent', 'encodeURI', 'String'].includes(target.name))) return UNKNOWN;
          // Discarded imported effects are not needed to calculate a URL from
          // captured primitives. Never descend into a store/network action.
          if (!demanded && target.type === 'MemberExpression' && target.object.type === 'Identifier' && env.get(target.object.name)?.[TAG] === 'module') {
            state.dirty = true; return UNKNOWN;
          }
          const callee = this.value(tail(node.callee), env, state, true);
          if (node.optional && callee == null) return undefined;
          if (node.arguments.some(argument => argument.type === 'SpreadElement')) return UNKNOWN;
          return this.call(callee, node.arguments.map(argument => this.value(argument, env, state, true)), state, demanded);
        }
        case 'AwaitExpression': return this.value(node.argument, env, state, demanded);
        case 'AssignmentExpression': {
          if (state.binding) return UNKNOWN;
          const value = this.value(node.right, env, state, true);
          if (node.operator === '=' && node.left.type === 'Identifier' && env.values.has(node.left.name)) { env.set(node.left.name, value); return value; }
          if (node.operator === '=' && node.left.type === 'MemberExpression' && keyOf(node.left) === 'href' && this.value(node.left.object, env, state, true)?.[TAG] === 'location') return this.navigation([value], 0, state);
          throw new Error('Unsupported assignment');
        }
        default: if (!state.binding) throw new Error('Unsupported expression'); return UNKNOWN;
      }
    }
    statements(body, env, state) {
      for (const node of body) {
        this.tick();
        if (node.type === 'ExpressionStatement') this.value(node.expression, env, state, false);
        else if (node.type === 'ReturnStatement') return { returned: true, value: this.value(node.argument, env, state, true) };
        else if (node.type === 'VariableDeclaration') for (const declaration of node.declarations) this.bind(declaration.id, this.value(declaration.init, env, state, true), env, state);
        else if (node.type === 'BlockStatement') { const result = this.statements(node.body, new Env(env), state); if (result?.returned) return result; }
        else if (node.type === 'IfStatement') {
          const condition = this.value(node.test, env, state, true);
          if (condition === UNKNOWN) throw new Error('Unknown condition');
          const branch = condition ? node.consequent : node.alternate;
          if (branch) { const result = this.statements(branch.type === 'BlockStatement' ? branch.body : [branch], new Env(env), state); if (result?.returned) return result; }
        } else if (node.type === 'FunctionDeclaration') env.set(node.id.name, ref('function', { node, source: '', env }));
        else if (node.type !== 'EmptyStatement') throw new Error('Unsupported statement');
      }
      return { returned: false };
    }
    resolve(handler) {
      this.steps = 0;
      this.deadline = Date.now() + 300;
      const state = { urls: [], dirty: false };
      try {
        this.call(handler, [ref('event')], state, true);
        const urls = [...new Set(state.urls)];
        if (urls.length !== 1 || state.urls.length !== 1) return { url: null, reason: 'no-unique-navigation' };
        const url = new URL(urls[0], this.baseUrl), source = new URL(this.baseUrl);
        if (!/^https?:$/.test(url.protocol) || url.origin !== source.origin || url.username || url.password || url.href.length > 4096) return { url: null, reason: 'unsupported-url' };
        return { url: url.href, reason: 'resolved' };
      } catch (error) { this.lastError = error.message; return { url: null, reason: 'unsupported-handler' }; }
    }
  }
  const api = Object.freeze({ Registry, Resolver, own, functionSource });
  if (commonJS) module.exports = api;
  else Object.defineProperty(root, 'MiddleClickEventAnalysis', { value: api, configurable: true });
})(globalThis);
