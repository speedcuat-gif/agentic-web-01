/* The Corner Shelf — page wiring.
 * Loads the published agent files, starts the runtime, renders the shelf,
 * and runs the chat. Classic script (file:// friendly — no modules).
 * A tiny demo hook lives on window.__shelf so the demo video can drive the
 * page: { send(text), runtime, state }. That hook is documented, not hidden.
 */
(function () {
  'use strict';

  var logEl = document.getElementById('log');
  var traceEl = document.getElementById('trace');
  var askEl = document.getElementById('ask');
  var sendBtn = document.getElementById('send');
  var gridEl = document.getElementById('shelf-grid');
  var chipsEl = document.getElementById('chips');

  var traceLines = [];
  var runtime = null;
  var catalog = null;
  var actions = null;
  var consentGiven = {}; // origin -> true, this session only

  function say(text, who) {
    var div = document.createElement('div');
    div.className = 'msg ' + (who || 'agent');
    div.textContent = text;
    logEl.appendChild(div);
    logEl.scrollTop = logEl.scrollHeight;
    return div;
  }

  function trace(entry) {
    var line = '#' + entry.seq + ' [' + entry.kind + '] ' + entry.label;
    traceLines.push(line);
    if (traceLines.length > 200) traceLines.shift();
    traceEl.textContent = traceLines.join('\n');
  }

  function renderShelf() {
    if (!catalog) return;
    gridEl.innerHTML = '';
    catalog.books.forEach(function (b) {
      var div = document.createElement('div');
      var out = b.status !== 'available';
      div.className = 'book' + (out ? ' out' : '');
      var t = document.createElement('div'); t.className = 't'; t.textContent = b.title;
      var a = document.createElement('div'); a.className = 'a'; a.textContent = b.author + ' · ' + b.year + ' · ' + b.genre;
      var s = document.createElement('div'); s.className = 's ' + (out ? 'out' : 'avail');
      s.textContent = out ? 'out — back ' + (b.due || 'soon') : 'here, ready to go';
      div.appendChild(t); div.appendChild(a); div.appendChild(s);
      gridEl.appendChild(div);
    });
  }

  function refreshShelfFromLoans() {
    // Re-read the catalog + loan state so the grid matches what the actions see.
    fetch('catalog.json').then(function (r) { return r.json(); }).then(function (c) {
      catalog = c;
      try {
        var loans = JSON.parse(localStorage.getItem('shelf:loans:the-corner-shelf') || '{}');
        catalog.books.forEach(function (b) {
          if (loans[b.id]) { b.status = 'borrowed'; b.due = loans[b.id].due; }
          else if (b.status === 'borrowed' && !b.due) { b.status = 'available'; }
        });
      } catch (e) { /* no storage — grid shows the published catalog */ }
      renderShelf();
    }).catch(function () { /* keep the last good render */ });
  }

  /* ---- the two modals the runtime owns: consent + write confirmation ---- */

  function askConsent(origin, purpose) {
    return new Promise(function (resolve) {
      if (consentGiven[origin]) { trace({ seq: 0, kind: 'consent', label: 'already said yes to ' + origin + ' this session' }); return resolve(true); }
      var back = document.getElementById('consent-modal');
      document.getElementById('consent-origin').textContent = origin;
      document.getElementById('consent-text').textContent = purpose || 'mind if I ask the other branch?';
      back.classList.add('open');
      var done = function (yes) {
        back.classList.remove('open');
        document.getElementById('consent-yes').onclick = null;
        document.getElementById('consent-no').onclick = null;
        if (yes) consentGiven[origin] = true;
        resolve(yes);
      };
      document.getElementById('consent-yes').onclick = function () { done(true); };
      document.getElementById('consent-no').onclick = function () { done(false); };
    });
  }

  function confirmWrite(actionName, args) {
    return new Promise(function (resolve) {
      var back = document.getElementById('confirm-modal');
      var what = actionName === 'borrow_book'
        ? 'borrow "' + (args.title || '') + '"' + (args.borrower && args.borrower !== 'a neighbor' ? ' for ' + args.borrower : '') + '? 14 days, then it comes back so somebody else can have a turn.'
        : actionName === 'return_book'
          ? 'bring "' + (args.title || '') + '" back to the shelf?'
          : 'run ' + actionName + ' with ' + JSON.stringify(args) + '?';
      document.getElementById('confirm-text').textContent = what;
      back.classList.add('open');
      var done = function (yes) {
        back.classList.remove('open');
        document.getElementById('confirm-yes').onclick = null;
        document.getElementById('confirm-no').onclick = null;
        resolve(yes);
      };
      document.getElementById('confirm-yes').onclick = function () { done(true); };
      document.getElementById('confirm-no').onclick = function () { done(false); };
    });
  }

  /* ---- engine selection (house default, BYOK optional) ---- */

  function savedByok() {
    try { return JSON.parse(localStorage.getItem('corner-shelf:byok') || 'null'); } catch (e) { return null; }
  }

  function applyEngine() {
    var byok = savedByok();
    var wantByok = document.querySelector('input[name="engine"]:checked').value === 'byok';
    if (wantByok && byok && byok.key && byok.baseUrl && byok.model) {
      runtime.setEngine(new ShelfEngines.ByokEngine({ baseUrl: byok.baseUrl, model: byok.model, key: byok.key }), { engine: 'byok', model: byok.model, keyPresent: true });
      document.getElementById('settings-state').textContent = 'using your router — ' + byok.model;
    } else {
      runtime.setEngine(new ShelfEngines.HouseEngine(), { engine: 'house/local', model: 'house/local', keyPresent: false });
      if (wantByok) document.getElementById('settings-state').textContent = 'fill in the router + model + key first, or stay on the house engine.';
      else document.getElementById('settings-state').textContent = 'house engine — local, free, no key.';
    }
  }

  /* ---- chat ---- */

  var busy = false;
  async function send(text) {
    var q = (text || '').trim();
    if (!q || busy || !runtime) return null;
    busy = true; sendBtn.disabled = true;
    say(q, 'user');
    askEl.value = '';
    var thinking = say('…', 'agent');
    try {
      var knownTitles = (catalog.books || []).map(function (b) { return b.title; });
      var res = await runtime.run(q, { knownTitles: knownTitles });
      thinking.remove();
      say(res.answer, 'agent');
      refreshShelfFromLoans();
      return res;
    } catch (e) {
      thinking.remove();
      say("couldn't do that one — " + e.message, 'agent');
      return { answer: '', error: e.message };
    } finally {
      busy = false; sendBtn.disabled = false;
      askEl.focus();
    }
  }

  /* ---- boot ---- */

  async function boot() {
    try {
      catalog = await fetch('catalog.json').then(function (r) { return r.json(); });
      document.getElementById('shelf-meta').textContent = catalog.where + ' — ' + catalog.hours;
      renderShelf();
    } catch (e) { gridEl.innerHTML = '<p class="sub">couldn\'t load the shelf. is catalog.json next to this page?</p>'; }

    actions = ShelfActions.createCatalogActions(catalog, (typeof localStorage !== 'undefined' ? localStorage : ShelfActions.memStorage()));
    runtime = new ShelfRuntime.AgenticRuntime({
      siteActions: actions,
      confirmWrite: confirmWrite,
      requestConsent: function (origin, purpose) { return askConsent(origin, purpose); },
      onTrace: trace,
    });
    runtime.setEngine(new ShelfEngines.HouseEngine(), { engine: 'house/local', model: 'house/local', keyPresent: false });
    try {
      await runtime.loadSite('agent-manifest.json');
      await runtime.loadNetworkByName('corner-shelf');
    } catch (e) {
      say("the shelf's agent files didn't load — " + e.message, 'sys');
      return;
    }
    var samples = (runtime.network.metadata.sample_queries || []);
    samples.forEach(function (q) {
      var chip = document.createElement('button');
      chip.className = 'chip'; chip.type = 'button'; chip.textContent = q;
      chip.onclick = function () { send(q); };
      chipsEl.appendChild(chip);
    });

    // Settings wiring.
    var byok = savedByok();
    if (byok) {
      document.getElementById('router-url').value = byok.baseUrl || '';
      document.getElementById('router-model').value = byok.model || '';
      document.getElementById('router-key').value = byok.key || '';
      if (byok.engine === 'byok') document.querySelector('input[name="engine"][value="byok"]').checked = true;
    }
    var toggleFields = function () {
      document.getElementById('byok-fields').style.display = document.querySelector('input[name="engine"]:checked').value === 'byok' ? 'block' : 'none';
    };
    document.querySelectorAll('input[name="engine"]').forEach(function (r) { r.addEventListener('change', function () { toggleFields(); applyEngine(); }); });
    document.getElementById('save-settings').onclick = function () {
      var v = {
        engine: document.querySelector('input[name="engine"]:checked').value,
        baseUrl: document.getElementById('router-url').value.trim(),
        model: document.getElementById('router-model').value.trim(),
        key: document.getElementById('router-key').value,
      };
      try { localStorage.setItem('corner-shelf:byok', JSON.stringify(v)); } catch (e) { /* storage blocked */ }
      applyEngine();
    };
    document.getElementById('forget-settings').onclick = function () {
      try { localStorage.removeItem('corner-shelf:byok'); } catch (e) { /* ignore */ }
      document.getElementById('router-url').value = '';
      document.getElementById('router-model').value = '';
      document.getElementById('router-key').value = '';
      document.querySelector('input[name="engine"][value="house"]').checked = true;
      toggleFields(); applyEngine();
      document.getElementById('settings-state').textContent = 'forgotten. house engine it is.';
    };
    toggleFields(); applyEngine();

    sendBtn.onclick = function () { send(askEl.value); };
    askEl.addEventListener('keydown', function (e) { if (e.key === 'Enter') send(askEl.value); });

    // Demo/test hook (documented): drive the page from the console or CDP.
    window.__shelf = { send: send, runtime: runtime, state: function () { return { catalog: catalog, consentGiven: consentGiven }; } };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
