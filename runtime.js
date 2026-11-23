/* The Corner Shelf — agent runtime.
 * A small, honest browser runtime for the Open Agentic Web MVP profile (0.3).
 * It loads a published agent-manifest.json + a resolved network JSON, validates
 * both before anything runs, then runs the network's front agent through an
 * engine (the built-in house engine, or a visitor's own OpenAI-compatible
 * router via BYOK). Peers load over plain fetch: manifest first, exact name
 * match, then the network file. Consent, budgets, cycle checks and private
 * context rules are enforced here, in the runtime — never by the model.
 * No dependencies. Works as a classic browser script or a Node module (UMD).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ShelfRuntime = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var DEFAULT_BUDGETS = { maxSteps: 12, maxPeerHops: 2, maxToolCalls: 20, maxElapsedMs: 30000 };

  function isObj(x) { return x !== null && typeof x === 'object' && !Array.isArray(x); }
  function isNonEmptyStr(x) { return typeof x === 'string' && x.trim().length > 0; }
  function hashInput(x) {
    var s = typeof x === 'string' ? x : JSON.stringify(x || {});
    var h = 0;
    for (var i = 0; i < s.length; i++) { h = ((h << 5) - h + s.charCodeAt(i)) | 0; }
    return String(h);
  }
  function redact(obj) {
    // Never let a secret into the trace. Keys are stripped by field name.
    if (typeof obj === 'string') return obj;
    if (!isObj(obj) && !Array.isArray(obj)) return obj;
    var out = Array.isArray(obj) ? [] : {};
    Object.keys(obj).forEach(function (k) {
      if (/key|secret|token|password|auth/i.test(k)) out[k] = '[redacted]';
      else out[k] = redact(obj[k]);
    });
    return out;
  }

  /* ---------------- validation ---------------- */

  function validateManifest(m) {
    var errors = [];
    if (!isObj(m)) return { ok: false, errors: ['manifest is not a JSON object'] };
    if (!Array.isArray(m.networks) || m.networks.length === 0) errors.push('manifest.networks is empty');
    else {
      var seen = {};
      m.networks.forEach(function (n, i) {
        if (!isObj(n)) { errors.push('networks[' + i + '] is not an object'); return; }
        if (!isNonEmptyStr(n.name)) errors.push('networks[' + i + '].name missing');
        else if (seen[n.name]) errors.push('duplicate network name: ' + n.name);
        else seen[n.name] = true;
        if (!isNonEmptyStr(n.front_man) && !isNonEmptyStr(n.front_agent)) errors.push('networks[' + i + '] has no front_man');
        if (!isNonEmptyStr(n.hocon)) errors.push('networks[' + i + '].hocon missing');
      });
    }
    if (m.allowed_peers !== undefined && !Array.isArray(m.allowed_peers)) errors.push('allowed_peers must be an array');
    if (m.peer_policy !== undefined && !isObj(m.peer_policy)) errors.push('peer_policy must be an object');
    return { ok: errors.length === 0, errors: errors };
  }

  function validateNetwork(def, opts) {
    opts = opts || {};
    var errors = [];
    if (!isObj(def)) return { ok: false, errors: ['network is not a JSON object'] };
    if (!isObj(def.metadata) || !isNonEmptyStr(def.metadata.description)) errors.push('metadata.description missing');
    if (!Array.isArray(def.tools) || def.tools.length === 0) { errors.push('tools is empty'); return { ok: false, errors: errors }; }
    var names = {};
    def.tools.forEach(function (t, i) {
      if (!isObj(t)) { errors.push('tools[' + i + '] is not an object'); return; }
      if (!isNonEmptyStr(t.name)) errors.push('tools[' + i + '].name missing');
      else if (names[t.name]) errors.push('duplicate agent name: ' + t.name);
      else names[t.name] = true;
      if (!isObj(t.function) || !isNonEmptyStr(t.function.description)) errors.push('tools[' + i + '].function.description missing');
      if (t.function && t.function.parameters !== undefined && (!isObj(t.function.parameters) || t.function.parameters.type !== 'object')) errors.push('tools[' + i + '].function.parameters must be a JSON Schema object');
      if (typeof t.instructions !== 'string') errors.push('tools[' + i + '].instructions missing');
      if (!Array.isArray(t.tools)) errors.push('tools[' + i + '].tools must be an array');
    });
    var front = opts.frontMan;
    if (isNonEmptyStr(front) && !names[front]) errors.push('front agent "' + front + '" is not in tools');
    if (def.max_steps !== undefined && (!Number.isInteger(def.max_steps) || def.max_steps < 1 || def.max_steps > 50)) errors.push('max_steps must be an integer 1..50');
    if (def.sly_data !== undefined) {
      if (!isObj(def.sly_data) || !Array.isArray(def.sly_data.allow) || def.sly_data.allow.some(function (f) { return typeof f !== 'string'; })) errors.push('sly_data.allow must be an array of strings');
    }
    // Every callable reference must resolve: agent name, site action, link symbol, or peer URL.
    var actions = opts.actions || [];
    var links = opts.links || {};
    def.tools.forEach(function (t) {
      if (!Array.isArray(t.tools)) return;
      t.tools.forEach(function (ref) {
        if (typeof ref !== 'string' || ref.length === 0) { errors.push('agent ' + t.name + ' has an empty tool reference'); return; }
        if (names[ref] || actions.indexOf(ref) !== -1 || Object.prototype.hasOwnProperty.call(links, ref)) return;
        if (/^https?:\/\//.test(ref) || ref.indexOf('./') === 0 || ref.indexOf('/') === 0) return; // peer URL or relative peer path
        errors.push('agent ' + t.name + ' references unknown tool "' + ref + '"');
      });
    });
    return { ok: errors.length === 0, errors: errors };
  }

  /* ---------------- the runtime ---------------- */

  function AgenticRuntime(opts) {
    opts = opts || {};
    this.fetchImpl = opts.fetchImpl || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
    if (!this.fetchImpl) throw new Error('no fetch available');
    this.siteActions = {}; // name -> {purpose, inputSchema, effect, handler}
    (opts.siteActions || []).forEach(function (a) { this.siteActions[a.name] = a; }.bind(this));
    this.confirmWrite = opts.confirmWrite || (function () { return Promise.resolve(false); });
    this.requestConsent = opts.requestConsent || (function () { return Promise.resolve(false); });
    this.onTrace = opts.onTrace || function () {};
    this.engine = opts.engine || null; // set later via setEngine
    this.linkOverrides = opts.linkOverrides || {}; // caller-owned bindings: { networkName: { symbol: url } }
    this.budgets = Object.assign({}, DEFAULT_BUDGETS, opts.budgets || {});
    this.baseUrl = opts.baseUrl || (typeof location !== 'undefined' ? location.href : 'http://localhost/');
    this.seq = 0;
    this.manifest = null;
    this.manifestUrl = null;
    this.siteBase = null;
    this.network = null;
    this.networkName = null;
    this.links = {};
    this.routerInfo = { engine: 'house/local', model: 'house/local', keyPresent: false };
  }

  AgenticRuntime.prototype.trace = function (kind, label, detail) {
    var entry = { seq: ++this.seq, at: new Date().toISOString(), kind: kind, label: label, detail: redact(detail === undefined ? null : detail) };
    this.onTrace(entry);
    return entry;
  };

  AgenticRuntime.prototype.setEngine = function (engine, info) {
    this.engine = engine;
    if (info) this.routerInfo = info;
    this.trace('router', 'engine: ' + (info && info.engine ? info.engine : 'house/local'), { model: info && info.model, keyPresent: !!(info && info.keyPresent) });
  };

  AgenticRuntime.prototype.resolveUrl = function (base, rel) {
    try { return new URL(rel, base).toString(); } catch (e) { return rel; }
  };

  AgenticRuntime.prototype.siteBaseOf = function (url) {
    // A peer-network URL's final path part is the network name; the rest is
    // the site base. Relative URLs resolve against the page that loaded us.
    var abs;
    try { abs = new URL(url, this.baseUrl).toString(); } catch (e) { abs = url; }
    if (abs.indexOf('file:') === 0) return abs.slice(0, abs.lastIndexOf('/') + 1);
    var u = new URL(abs);
    var parts = u.pathname.split('/').filter(Boolean);
    parts.pop();
    return u.protocol + '//' + u.host + (parts.length ? '/' + parts.join('/') + '/' : '/');
  };

  AgenticRuntime.prototype.fetchJson = async function (url) {
    var res = await this.fetchImpl(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) throw new Error('fetch ' + url + ' -> HTTP ' + res.status);
    return res.json();
  };

  AgenticRuntime.prototype.loadSite = async function (manifestUrl) {
    manifestUrl = this.resolveUrl(this.baseUrl, manifestUrl);
    this.manifestUrl = manifestUrl;
    this.siteBase = this.siteBaseOf(manifestUrl);
    this.trace('manifest', 'loading ' + manifestUrl, null);
    var m = await this.fetchJson(manifestUrl);
    var v = validateManifest(m);
    if (!v.ok) {
      this.trace('error', 'manifest rejected', { errors: v.errors });
      throw new Error('manifest rejected: ' + v.errors.join('; '));
    }
    this.manifest = m;
    this.trace('manifest', 'loaded ' + (m.brand || 'site') + ', ' + m.networks.length + ' network(s)', { networks: m.networks.map(function (n) { return n.name; }) });
    // links.json sits next to the manifest
    try {
      var links = await this.fetchJson(this.resolveUrl(manifestUrl, './links.json'));
      this.links = (links && links.networks) || {};
    } catch (e) { this.links = {}; }
    return m;
  };

  AgenticRuntime.prototype.loadNetworkByName = async function (name, slyData) {
    if (!this.manifest) throw new Error('load a manifest first');
    var entry = null;
    this.manifest.networks.forEach(function (n) { if (n.name === name) entry = n; });
    if (!entry) throw new Error('no network named "' + name + '" in this manifest');
    var url = this.resolveUrl(this.manifestUrl, entry.hocon);
    var def = await this.fetchJson(url);
    var v = validateNetwork(def, { frontMan: entry.front_man || entry.front_agent, actions: Object.keys(this.siteActions), links: (this.links[name] || {}) });
    if (!v.ok) {
      this.trace('error', 'network rejected', { network: name, errors: v.errors });
      throw new Error('network "' + name + '" rejected: ' + v.errors.join('; '));
    }
    this.network = def;
    this.networkName = name;
    this.trace('network', 'loaded ' + name + ', front agent ' + (entry.front_man || entry.front_agent), { agents: def.tools.map(function (t) { return t.name; }) });
    return def;
  };

  AgenticRuntime.prototype.peerAllowed = function (peerUrl) {
    // Closed policy: the peer must be the caller's own origin, or be listed
    // in the manifest's allowed_peers. Same-origin peers are not a third
    // party, so they are allowed (consent still applies). On file:// the
    // origins are opaque, so a listed relative peer path matches by prefix.
    var allowed = (this.manifest && this.manifest.allowed_peers) || [];
    var peer, self;
    try { peer = new URL(peerUrl, this.siteBase); } catch (e) { return false; }
    try { self = new URL(this.siteBase); } catch (e) { self = null; }
    if (self && peer.origin !== 'null' && peer.origin === self.origin) return true;
    if (peer.protocol === 'file:') {
      return allowed.some(function (a) {
        if (a === './peer/') return peerUrl.indexOf('/peer/') !== -1;
        return peerUrl.indexOf(a.replace(/^\.\//, '')) !== -1;
      });
    }
    if (allowed.indexOf(peer.origin) !== -1) return true;
    return allowed.some(function (a) { return peerUrl.indexOf(a) === 0; });
  };

  AgenticRuntime.prototype.loadPeerNetwork = async function (peerUrl, ctx) {
    // peerUrl: .../<network-name>. The site base is everything before it.
    var name = peerUrl.split('/').filter(Boolean).pop();
    var base = this.siteBaseOf(peerUrl);
    this.trace('peer', 'contacting ' + base + ' for network "' + name + '"', null);
    var manifestUrl = base + 'agent-manifest.json';
    var m = await this.fetchJson(manifestUrl);
    var v = validateManifest(m);
    if (!v.ok) throw new Error('peer manifest rejected: ' + v.errors.join('; '));
    var entry = null;
    m.networks.forEach(function (n) { if (n.name === name) entry = n; });
    if (!entry) throw new Error('peer has no network named "' + name + '" — refusing to pick another one');
    var def = await this.fetchJson(this.resolveUrl(manifestUrl, entry.hocon));
    // Peer tools resolve against the PEER's own action set + its own agents.
    var peerActions = ((m.actions && m.actions.agentTools) || []);
    var v2 = validateNetwork(def, { frontMan: entry.front_man || entry.front_agent, actions: peerActions, links: {} });
    if (!v2.ok) throw new Error('peer network "' + name + '" rejected: ' + v2.errors.join('; '));
    // The peer's catalog data rides with the peer: fetch its public catalog
    // so its search action runs against the peer's own books, not ours.
    var peerCatalog = null;
    try { peerCatalog = await this.fetchJson(base + 'catalog.json'); } catch (e) { peerCatalog = null; }
    this.trace('peer', 'loaded ' + name + ' from ' + base, { agents: def.tools.map(function (t) { return t.name; }), catalog: !!peerCatalog });
    return { manifest: m, entry: entry, def: def, catalog: peerCatalog, base: base, name: name };
  };

  AgenticRuntime.prototype.filterSlyData = function (slyData, allowList) {
    var out = {};
    (allowList || []).forEach(function (f) {
      if (slyData && Object.prototype.hasOwnProperty.call(slyData, f)) out[f] = slyData[f];
    });
    return out;
  };

  AgenticRuntime.prototype.callSiteAction = async function (actionName, args, ctx, scope) {
    var action = scope && scope.actions ? scope.actions[actionName] : this.siteActions[actionName];
    if (!action) throw new Error('unknown site action "' + actionName + '"');
    // Validate args against the action's input schema (required + types).
    var schema = action.inputSchema || {};
    var errs = [];
    (schema.required || []).forEach(function (k) {
      if (args === undefined || args[k] === undefined || args[k] === '') errs.push('missing required field "' + k + '"');
    });
    if (errs.length) throw new Error('bad args for ' + actionName + ': ' + errs.join('; '));
    if (action.effect === 'write') {
      this.trace('action', 'write needs your say-so: ' + actionName, { args: redact(args) });
      var ok = await this.confirmWrite(actionName, args);
      if (!ok) {
        this.trace('action', 'visitor said no to ' + actionName, null);
        return { ok: false, status: 'cancelled', reason: 'visitor declined' };
      }
    }
    this.trace('action', 'calling ' + actionName, { args: redact(args), effect: action.effect });
    var result = await action.handler(args, ctx);
    if (result && result.receipt) ctx.receipts.push(result.receipt);
    this.trace('action', actionName + ' -> ' + (result && result.ok === false ? 'refused: ' + (result.reason || '') : 'done'), { ok: !(result && result.ok === false) });
    return result;
  };

  AgenticRuntime.prototype.run = async function (requestText, opts) {
    opts = opts || {};
    if (!this.network) throw new Error('load a network first');
    if (!this.engine) throw new Error('no engine set');
    var ctx = {
      request: requestText,
      slyData: opts.sly_data || {},
      steps: 0, toolCalls: 0, peerHops: 0,
      deadline: Date.now() + this.budgets.maxElapsedMs,
      stack: [], receipts: [], history: [],
      knownTitles: opts.knownTitles || [],
    };
    var front = (this.manifest.networks.filter(function (n) { return n.name === this.networkName; }.bind(this))[0] || {}).front_man || 'librarian';
    this.trace('run', 'front agent ' + front + ' takes: "' + requestText.slice(0, 140) + '"', null);
    var current = { network: this.network, networkName: this.networkName, agent: front, scope: null, base: this.siteBase };
    var answer = null;
    var guard = 0;
    while (guard++ < this.budgets.maxSteps) {
      if (Date.now() > ctx.deadline) throw new Error('ran out of time (' + this.budgets.maxElapsedMs + 'ms) — stopped, nothing half-done');
      if (ctx.steps >= this.budgets.maxSteps) throw new Error('step budget hit (' + this.budgets.maxSteps + ') — stopped');
      var step = await this.engine.nextStep(this, ctx, current);
      if (!step || step.kind === 'answer') { answer = step ? step.text : ''; break; }
      ctx.steps++;
      if (step.kind === 'delegate') {
        var target = current.network.tools.filter(function (t) { return t.name === step.agent; })[0];
        if (!target) throw new Error('front agent tried to call "' + step.agent + '", which is not in this network');
        var key = current.networkName + '|' + step.agent + '|' + hashInput(step.input);
        if (ctx.stack.indexOf(key) !== -1) throw new Error('loop caught: ' + step.agent + ' calling itself with the same ask — stopped');
        ctx.stack.push(key);
        var prevAgent = current.agent;
        this.trace('agent', current.agent + ' -> ' + step.agent, { input: redact(step.input) });
        current = Object.assign({}, current, { agent: step.agent });
        ctx.history.push({ from: prevAgent, to: step.agent, input: step.input });
      } else if (step.kind === 'action') {
        ctx.toolCalls++;
        if (ctx.toolCalls > this.budgets.maxToolCalls) throw new Error('tool-call budget hit — stopped');
        var res = await this.callSiteAction(step.action, step.args, ctx, current.scope);
        ctx.history.push({ action: step.action, args: redact(step.args), result: res });
        current = Object.assign({}, current, { lastResult: res });
      } else if (step.kind === 'peer') {
        ctx.peerHops++;
        if (ctx.peerHops > this.budgets.maxPeerHops) throw new Error('peer-hop budget hit — stopped');
        var peerUrl = this.resolvePeerUrl(step.network, current.networkName);
        if (!this.peerAllowed(peerUrl)) {
          this.trace('error', 'peer not allowed: ' + peerUrl, null);
          throw new Error('that peer is not on the allowed list — stopped');
        }
        var allowedSly = this.filterSlyData(ctx.slyData, (this.network.sly_data && this.network.sly_data.allow) || []);
        var consent = await this.requestConsent(peerUrl, 'ask the other branch about: ' + requestText.slice(0, 140), requestText.slice(0, 140));
        if (!consent) {
          this.trace('consent', 'visitor said no to ' + peerUrl, null);
          ctx.history.push({ peer: step.network, result: { ok: false, status: 'cancelled', reason: 'visitor declined the peer check' } });
          current = Object.assign({}, current, { lastResult: { ok: false, status: 'cancelled', reason: 'visitor declined the peer check' } });
          continue;
        }
        this.trace('consent', 'visitor said yes to ' + peerUrl, null);
        var peer = await this.loadPeerNetwork(peerUrl, ctx);
        var peerScope = peer.catalog ? this.makePeerScope(peer) : null;
        var peerAnswer = await this.runPeer(peer, requestText, allowedSly, ctx, peerScope);
        ctx.history.push({ peer: step.network, result: peerAnswer });
        current = Object.assign({}, current, { lastResult: peerAnswer });
      } else {
        throw new Error('engine gave a step I do not understand: ' + JSON.stringify(Object.keys(step || {})));
      }
    }
    if (answer === null) throw new Error('step budget hit (' + this.budgets.maxSteps + ') — stopped');
    this.trace('run', 'done in ' + ctx.steps + ' step(s)', { receipts: ctx.receipts.length });
    return { answer: answer, receipts: ctx.receipts, history: ctx.history, steps: ctx.steps };
  };

  AgenticRuntime.prototype.resolvePeerUrl = function (symbol, networkName) {
    var override = (this.linkOverrides[networkName] || {})[symbol];
    if (override) return override;
    var links = (this.links[networkName] || {});
    if (links[symbol]) return this.resolveUrl(this.manifestUrl, links[symbol]);
    if (/^https?:\/\//.test(symbol) || symbol.indexOf('./') === 0) return this.resolveUrl(this.manifestUrl, symbol);
    throw new Error('no link for peer "' + symbol + '" — the site has to publish one in links.json');
  };

  AgenticRuntime.prototype.makePeerScope = function (peer) {
    // The peer's search actions run against the peer's own public catalog.
    // Same action code, the peer's data. No writes: the peer only shares reads.
    var catalog = peer.catalog;
    var actions = {};
    actions.search_catalog = {
      name: 'search_catalog', purpose: 'search the peer branch catalog', effect: 'read',
      inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
      handler: async function (args) {
        var q = (args.query || '').toLowerCase();
        var hits = (catalog.books || []).filter(function (b) {
          return (b.title + ' ' + b.author + ' ' + b.genre).toLowerCase().indexOf(q) !== -1;
        });
        return { ok: true, branch: catalog.shelf, books: hits };
      },
    };
    actions.get_shelf_info = {
      name: 'get_shelf_info', purpose: 'info about the peer branch', effect: 'read',
      inputSchema: { type: 'object', properties: {} },
      handler: async function () {
        return { ok: true, shelf: catalog.shelf, where: catalog.where, hours: catalog.hours, rule: catalog.rule, total: (catalog.books || []).length };
      },
    };
    return { actions: actions };
  };

  AgenticRuntime.prototype.runPeer = async function (peer, requestText, allowedSly, ctx, peerScope) {
    // The peer runs INSIDE the caller's runtime, with the caller's router and
    // budgets. The peer never sees the visitor's key and never gets private
    // context beyond the fields the caller network explicitly allows.
    var front = peer.entry.front_man || peer.entry.front_agent;
    var peerCtx = {
      request: requestText, slyData: allowedSly,
      steps: ctx.steps, toolCalls: ctx.toolCalls, peerHops: ctx.peerHops,
      deadline: ctx.deadline, stack: ctx.stack.slice(), receipts: ctx.receipts, history: [],
      knownTitles: (peer.catalog.books || []).map(function (b) { return b.title; }),
    };
    var current = { network: peer.def, networkName: peer.name, agent: front, scope: peerScope, base: peer.base };
    var guard = 0;
    while (guard++ < this.budgets.maxSteps) {
      if (Date.now() > peerCtx.deadline) throw new Error('peer ran out of time — stopped');
      var step = await this.engine.nextStep(this, peerCtx, current);
      if (!step || step.kind === 'answer') {
        return { ok: true, branch: peer.catalog ? peer.catalog.shelf : peer.name, answer: step ? step.text : '', slyDataSeen: allowedSly };
      }
      peerCtx.steps++;
      if (step.kind === 'delegate') {
        var target = current.network.tools.filter(function (t) { return t.name === step.agent; })[0];
        if (!target) throw new Error('peer agent tried to call "' + step.agent + '", which is not in its network');
        var key = peer.name + '|' + step.agent + '|' + hashInput(step.input);
        if (peerCtx.stack.indexOf(key) !== -1) throw new Error('loop caught in peer network — stopped');
        peerCtx.stack.push(key);
        var prevPeerAgent = current.agent;
        this.trace('agent', '(peer) ' + current.agent + ' -> ' + step.agent, { input: redact(step.input) });
        current = Object.assign({}, current, { agent: step.agent });
        peerCtx.history.push({ from: prevPeerAgent, to: step.agent, input: step.input });
      } else if (step.kind === 'action') {
        peerCtx.toolCalls++;
        var res = await this.callSiteAction(step.action, step.args, peerCtx, current.scope);
        peerCtx.history.push({ action: step.action, args: redact(step.args), result: res });
        current = Object.assign({}, current, { lastResult: res });
      } else if (step.kind === 'peer') {
        // One hop is enough for this demo: the peer asking a third site is
        // allowed by the protocol, but this build stops the chain here and
        // says so plainly instead of silently chaining.
        throw new Error('peer tried to call a third site — this build only does one hop');
      } else {
        throw new Error('peer engine gave a step I do not understand');
      }
    }
    throw new Error('peer step budget hit — stopped');
  };

  return { AgenticRuntime: AgenticRuntime, validateManifest: validateManifest, validateNetwork: validateNetwork, DEFAULT_BUDGETS: DEFAULT_BUDGETS };
});
