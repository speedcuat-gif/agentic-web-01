/* Engines for the Corner Shelf runtime.
 * Two engines, one loop shape:
 *  - HouseEngine: a deterministic local engine. No key, no network, no LLM.
 *    It reads the visitor's words, matches them against the network's own
 *    published agent descriptions, and walks the graph step by step. It never
 *    invents a fact — every claim comes from a tool result.
 *  - ByokEngine: talks to a real OpenAI-compatible chat-completions endpoint
 *    the visitor configures (base URL + model + key). The key only ever goes
 *    to that router, never to a peer site, and never into the trace.
 * UMD: classic browser script or Node module.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ShelfEngines = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function lower(s) { return (s || '').toLowerCase(); }
  function hasWord(text, words) {
    var t = ' ' + lower(text) + ' ';
    return words.some(function (w) { return t.indexOf(' ' + w) !== -1 || t.indexOf(w) !== -1; });
  }
  function findTitle(text, titles) {
    var t = lower(text);
    var best = null;
    (titles || []).forEach(function (title) {
      if (title && t.indexOf(lower(title)) !== -1 && (!best || title.length > best.length)) best = title;
    });
    return best;
  }
  function guessTitle(text) {
    // Fallback when the title isn't in our known list: grab a quoted phrase,
    // or the words after got / borrow / return / for.
    var m = text.match(/["“]([^"”]+)["”]/);
    if (m) return m[1];
    var m2 = lower(text).match(/(?:got|borrow|return|check|find|for)\s+(?:a\s+|an\s+|the\s+)?([a-z][a-z0-9'&., -]{2,40})/);
    if (m2) return m2[1].replace(/\s+(\?|please|pls)\s*$/, '').trim();
    return null;
  }
  function classifyIntent(text) {
    if (hasWord(text, ['northside', 'other branch', 'anywhere else', 'another shelf', 'another branch', 'other side'])) return 'peer';
    if (hasWord(text, ['return', 'bring back', 'bringing back', 'drop off'])) return 'return';
    if (hasWord(text, ['borrow', 'check out', 'take', 'lend me', 'let me get', 'can i have', 'grab'])) return 'borrow';
    if (hasWord(text, ['hours', 'where are you', 'where is', 'how does', 'how this work', 'how do i', 'rules', 'rule'])) return 'info';
    return 'search';
  }
  function fmtBook(b) {
    return '"' + b.title + '" — ' + b.author + ' (' + b.year + ')' + (b.status === 'available' ? ' — here, ready to go' : ' — out right now, back ' + (b.due || 'soon'));
  }
  function fmtBooks(books) { return books.map(fmtBook).join('\n'); }

  /* ---------------- the house engine ---------------- */

  function HouseEngine() {}
  HouseEngine.prototype.nextStep = async function (runtime, ctx, current) {
    var req = ctx.request;
    var intent = classifyIntent(req);
    var title = findTitle(req, ctx.knownTitles) || guessTitle(req);
    var last = current.lastResult;
    var agent = current.agent;
    var net = current.network;

    // The front agent routes; the specialists do the work.
    if (agent === 'librarian' || agent === 'northside_librarian') {
      var selfDef = net.tools.filter(function (t) { return t.name === agent; })[0];
      var myTools = (selfDef && selfDef.tools) || [];
      // An answer came back from somewhere we asked — report it, don't re-ask.
      if (last && last.branch && typeof last.answer === 'string') {
        return { kind: 'answer', text: 'over at ' + last.branch + ': ' + last.answer };
      }
      if (last && last.ok === false && last.status === 'cancelled') {
        return { kind: 'answer', text: "alright, we'll keep it local. if you change your mind, just say the word." };
      }
      if (intent === 'peer' && myTools.indexOf('northside') !== -1) {
        // Only the main shelf has a peer link; the peer branch has none.
        return { kind: 'peer', network: 'northside', input: { request: req } };
      }
      if (intent === 'borrow' || intent === 'return') {
        var desk = net.tools.filter(function (t) { return t.name === 'borrow-desk'; })[0];
        if (desk) return { kind: 'delegate', agent: 'borrow-desk', input: { request: req } };
        return { kind: 'answer', text: "we don't lend books through the chat here — the shelf is right there, take what you need." };
      }
      var shelfAgent = net.tools.filter(function (t) { return t.name === 'shelf' || t.name === 'northside_shelf'; })[0];
      if (shelfAgent) return { kind: 'delegate', agent: shelfAgent.name, input: { request: req } };
      return { kind: 'answer', text: 'say that again? I want to help, I just didn\'t catch what you need.' };
    }

    if (agent === 'shelf' || agent === 'northside_shelf') {
      if (last) {
        if (last.books !== undefined) {
          if (last.books.length === 0) {
            var notHere = title ? 'nah, "' + title + '" ain\'t on this shelf right now.' : "didn't find anything matching that here.";
            if (current.networkName === 'corner-shelf' && intent !== 'peer') {
              return { kind: 'answer', text: notHere + ' want me to ask the Northside branch? they got their own shelf.' };
            }
            return { kind: 'answer', text: notHere };
          }
          return { kind: 'answer', text: 'yeah, we got it:\n' + fmtBooks(last.books) };
        }
        if (last.shelf) {
          return { kind: 'answer', text: last.shelf + ' — ' + last.where + ' ' + (last.hours || '') + ' ' + (last.rule || '') + ' ' + last.total + ' books on it right now.' };
        }
      }
      if (intent === 'info') return { kind: 'action', action: 'get_shelf_info', args: {} };
      return { kind: 'action', action: 'search_catalog', args: { query: title || req } };
    }

    if (agent === 'borrow-desk') {
      if (last) {
        if (last.ok === false && last.status === 'cancelled') return { kind: 'answer', text: 'no worries, nothing changed. it\'s still on the shelf.' };
        if (last.ok === false) {
          var msg = last.reason || "couldn't do that.";
          if (last.due) msg += ' back ' + last.due + '.';
          if (/ain't on this shelf/.test(msg)) msg += ' want me to check the Northside branch?';
          return { kind: 'answer', text: msg };
        }
        if (last.receipt) {
          var r = last.receipt;
          if (r.type === 'borrow') return { kind: 'answer', text: 'it\'s yours. "' + r.title + '" — bring it back by ' + r.due + ', no stress.' };
          if (r.type === 'return') return { kind: 'answer', text: 'got it, "' + r.title + '" is back on the shelf. thanks for bringing it home.' };
        }
        return { kind: 'answer', text: 'done.' };
      }
      if (intent === 'return') return { kind: 'action', action: 'return_book', args: { title: title || req } };
      var borrower = 'a neighbor';
      var m = req.match(/my name is\s+([A-Za-z][A-Za-z ]{1,30})/i) || req.match(/i'?m\s+([A-Za-z][A-Za-z ]{1,30})/i);
      if (m) borrower = m[1].trim();
      return { kind: 'action', action: 'borrow_book', args: { title: title || req, borrower: borrower } };
    }

    return { kind: 'answer', text: "I don't know how to do that one here." };
  };

  /* ---------------- the BYOK engine (real LLM) ---------------- */

  function ByokEngine(opts) {
    opts = opts || {};
    this.baseUrl = (opts.baseUrl || '').replace(/\/$/, '');
    this.model = opts.model || '';
    this.key = opts.key || '';
    this.fetchImpl = opts.fetchImpl || (typeof fetch !== 'undefined' ? fetch.bind(globalThis) : null);
    if (!this.fetchImpl) throw new Error('no fetch available for BYOK engine');
  }
  ByokEngine.prototype.toolSchemasFor = function (runtime, ctx, current) {
    var agent = current.network.tools.filter(function (t) { return t.name === current.agent; })[0];
    if (!agent) return [];
    var self = this;
    return agent.tools.map(function (ref) {
      // Internal agent?
      var inner = current.network.tools.filter(function (t) { return t.name === ref; })[0];
      if (inner) return { type: 'function', function: { name: 'call_agent_' + inner.name, description: inner.function.description, parameters: inner.function.parameters || { type: 'object', properties: { request: { type: 'string' } }, required: ['request'] } } };
      // Site action?
      var action = (current.scope && current.scope.actions ? current.scope.actions[ref] : runtime.siteActions[ref]);
      if (action) return { type: 'function', function: { name: 'action_' + action.name, description: action.purpose || action.name, parameters: action.inputSchema || { type: 'object', properties: {} } } };
      // Peer network (symbol or URL)?
      if (/^https?:\/\//.test(ref) || ref.indexOf('./') === 0 || /^[a-z][a-z0-9_-]*$/.test(ref)) {
        return { type: 'function', function: { name: 'ask_peer_' + ref.replace(/[^a-z0-9]/gi, '_'), description: 'Ask another branch site about this request. The visitor must agree first — the runtime handles that.', parameters: { type: 'object', properties: { request: { type: 'string' } }, required: ['request'] } } };
      }
      return null;
    }).filter(Boolean);
  };
  ByokEngine.prototype.nextStep = async function (runtime, ctx, current) {
    if (!this.key) throw new Error('BYOK needs a key — plug one in under settings, or switch back to the house engine.');
    if (!this.baseUrl || !this.model) throw new Error('BYOK needs a router URL and a model — set them under settings.');
    var agent = current.network.tools.filter(function (t) { return t.name === current.agent; })[0];
    var messages = [{ role: 'system', content: (agent ? agent.instructions : '') + '\nFacts come only from tool results. Never invent a book, a due date, or an availability. If a tool says no, say no plainly.' }];
    messages.push({ role: 'user', content: ctx.request });
    (ctx.history || []).forEach(function (h) {
      if (h.result !== undefined) messages.push({ role: 'user', content: 'Tool result: ' + JSON.stringify(h.result).slice(0, 2000) });
      else if (h.to) messages.push({ role: 'assistant', content: 'Delegating to ' + h.to + ': ' + JSON.stringify(h.input) });
    });
    var tools = this.toolSchemasFor(runtime, ctx, current);
    var res = await this.fetchImpl(this.baseUrl + '/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + this.key },
      body: JSON.stringify({ model: this.model, messages: messages, tools: tools.length ? tools : undefined, tool_choice: tools.length ? 'auto' : undefined }),
    });
    if (!res.ok) throw new Error('router said HTTP ' + res.status + ' — check the URL, model, and key under settings.');
    var data = await res.json();
    var choice = (data.choices || [])[0];
    if (!choice) throw new Error('router gave back nothing usable.');
    var msg = choice.message || {};
    var calls = msg.tool_calls || [];
    if (calls.length) {
      var call = calls[0];
      var fn = call.function || {};
      var args = {};
      try { args = JSON.parse(fn.name ? (fn.arguments || '{}') : '{}'); } catch (e) { args = {}; }
      if (fn.name.indexOf('call_agent_') === 0) return { kind: 'delegate', agent: fn.name.slice('call_agent_'.length), input: args };
      if (fn.name.indexOf('action_') === 0) return { kind: 'action', action: fn.name.slice('action_'.length), args: args };
      if (fn.name.indexOf('ask_peer_') === 0) {
        var agent2 = current.network.tools.filter(function (t) { return t.name === current.agent; })[0];
        var ref = (agent2.tools || []).filter(function (r) { return ('ask_peer_' + r.replace(/[^a-z0-9]/gi, '_')) === fn.name; })[0];
        return { kind: 'peer', network: ref, input: args };
      }
      throw new Error('router asked for a tool I do not have: ' + fn.name);
    }
    var text = (msg.content || '').trim();
    if (!text) throw new Error('router answered with nothing — try again, or switch to the house engine.');
    return { kind: 'answer', text: text };
  };

  return { HouseEngine: HouseEngine, ByokEngine: ByokEngine, classifyIntent: classifyIntent };
});
