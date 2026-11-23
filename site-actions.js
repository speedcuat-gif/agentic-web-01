/* Site actions for the Corner Shelf (and, with different data, Northside).
 * Four actions, registered with the runtime:
 *   search_catalog / get_shelf_info — reads, no confirmation needed.
 *   borrow_book / return_book      — writes, the runtime makes the visitor
 *   confirm before either one runs, and hands back a receipt.
 * State lives in the catalog data plus a small loans record in storage
 * (localStorage in the browser, an in-memory stub in tests). Nothing here
 * talks to the network. UMD: classic browser script or Node module.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.ShelfActions = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function memStorage() {
    var store = {};
    return {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null; },
      setItem: function (k, v) { store[k] = String(v); },
      removeItem: function (k) { delete store[k]; },
    };
  }

  function dueDate(days) {
    var d = new Date();
    d.setDate(d.getDate() + days);
    return d.toISOString().slice(0, 10);
  }

  function findBook(books, query) {
    var q = (query || '').toLowerCase().trim();
    if (!q) return null;
    var exact = null, partial = null;
    books.forEach(function (b) {
      var t = b.title.toLowerCase();
      if (t === q) exact = b;
      else if (!partial && t.indexOf(q) !== -1) partial = b;
    });
    return exact || partial;
  }

  function searchBooks(books, query) {
    var q = (query || '').toLowerCase().trim();
    if (!q) return books.slice();
    return books.filter(function (b) {
      return (b.title + ' ' + b.author + ' ' + b.genre).toLowerCase().indexOf(q) !== -1;
    });
  }

  function createCatalogActions(catalog, storage, loanDays) {
    storage = storage || memStorage();
    loanDays = loanDays || 14;
    var books = catalog.books || [];
    var key = 'shelf:loans:' + (catalog.shelf || 'shelf').replace(/\W+/g, '-').toLowerCase();
    var loans = {};
    try { loans = JSON.parse(storage.getItem(key) || '{}'); } catch (e) { loans = {}; }
    function save() { try { storage.setItem(key, JSON.stringify(loans)); } catch (e) { /* storage full or blocked — loans still hold in memory */ } }
    function statusOf(b) {
      if (loans[b.id]) return { status: 'borrowed', due: loans[b.id].due, borrower: loans[b.id].borrower };
      return { status: b.status, due: b.due || null };
    }
    function publicBook(b) {
      var s = statusOf(b);
      return { id: b.id, title: b.title, author: b.author, year: b.year, genre: b.genre, status: s.status, due: s.due || undefined };
    }

    return [
      {
        name: 'search_catalog', purpose: 'Look up books on this shelf by title, author, or genre.',
        effect: 'read',
        inputSchema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
        handler: async function (args) {
          var hits = searchBooks(books, args.query).map(publicBook);
          return { ok: true, books: hits };
        },
      },
      {
        name: 'get_shelf_info', purpose: 'Where this shelf is, when it is open, and the house rule.',
        effect: 'read',
        inputSchema: { type: 'object', properties: {} },
        handler: async function () {
          var available = books.filter(function (b) { return statusOf(b).status === 'available'; }).length;
          return { ok: true, shelf: catalog.shelf, where: catalog.where, hours: catalog.hours, rule: catalog.rule, total: books.length, available: available };
        },
      },
      {
        name: 'borrow_book', purpose: 'Borrow a book for 14 days. A write — the visitor confirms first.',
        effect: 'write',
        inputSchema: { type: 'object', properties: { title: { type: 'string' }, borrower: { type: 'string' } }, required: ['title'] },
        handler: async function (args) {
          var b = findBook(books, args.title);
          if (!b) return { ok: false, reason: '"' + args.title + '" ain\'t on this shelf.' };
          var s = statusOf(b);
          if (s.status !== 'available') return { ok: false, reason: '"' + b.title + '" is out right now.', due: s.due };
          var due = dueDate(loanDays);
          loans[b.id] = { borrower: args.borrower || 'a neighbor', due: due, at: new Date().toISOString() };
          save();
          var receipt = { type: 'borrow', id: 'loan-' + b.id + '-' + Date.now(), title: b.title, borrower: loans[b.id].borrower, due: due };
          return { ok: true, receipt: receipt };
        },
      },
      {
        name: 'return_book', purpose: 'Bring a borrowed book back to the shelf. A write — the visitor confirms first.',
        effect: 'write',
        inputSchema: { type: 'object', properties: { title: { type: 'string' } }, required: ['title'] },
        handler: async function (args) {
          var b = findBook(books, args.title);
          if (!b) return { ok: false, reason: '"' + args.title + '" ain\'t from this shelf.' };
          var s = statusOf(b);
          if (s.status === 'available') return { ok: false, reason: '"' + b.title + '" is already here on the shelf.' };
          delete loans[b.id];
          save();
          var receipt = { type: 'return', id: 'return-' + b.id + '-' + Date.now(), title: b.title };
          return { ok: true, receipt: receipt };
        },
      },
    ];
  }

  return { createCatalogActions: createCatalogActions, memStorage: memStorage, findBook: findBook, searchBooks: searchBooks };
});
