/* Tests for the Corner Shelf runtime.
 * Runs against the real published files over real HTTP: the main site on
 * 127.0.0.1:8001, the Northside peer on 127.0.0.1:8002 (a second origin),
 * and a scripted mock OpenAI-compatible router on 127.0.0.1:8003.
 * No test fakes the runtime — every assertion runs the same code the page
 * runs. Usage: node tests/run-tests.mjs
 */
import { createRequire } from 'module';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RT = require(path.join(ROOT, 'runtime.js'));
const ENG = require(path.join(ROOT, 'engines.js'));
const ACT = require(path.join(ROOT, 'site-actions.js'));

const MAIN_PORT = 8001, PEER_PORT = 8002, MOCK_PORT = 8003;
const results = [];
function check(name, cond, extra) {
  results.push({ name, ok: !!cond, extra: extra || '' });
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (cond || !extra ? '' : '  -> ' + extra));
}
function assertThrowsAsync(fn, re) {
  return fn().then(
    () => ({ threw: false }),
    (e) => ({ threw: true, msg: e.message, match: re ? re.test(e.message) : true }),
  );
}

// ---------- servers ----------
const mime = { '.json': 'application/json', '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' };
function staticServer(root, port, recorder) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      if (recorder) recorder(req);
      const urlPath = decodeURIComponent(req.url.split('?')[0]);
      let fp = path.join(root, urlPath === '/' ? 'index.html' : urlPath);
      if (!fp.startsWith(root)) { res.writeHead(403); return res.end(); }
      fs.readFile(fp, (err, data) => {
        if (err) { res.writeHead(404); return res.end('not found'); }
        res.writeHead(200, { 'Content-Type': mime[path.extname(fp)] || 'application/octet-stream', 'Access-Control-Allow-Origin': '*' });
        res.end(data);
      });
    });
    srv.listen(port, '127.0.0.1', () => resolve(srv));
  });
}

const peerRequests = [];
const mockCalls = [];
let mockScript = [];
function mockRouterServer(port) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => { body += c; });
      req.on('end', () => {
        mockCalls.push({ headers: req.headers, body });
        const next = mockScript.shift() || { choices: [{ message: { role: 'assistant', content: 'mock ran out of lines.' } }] };
        res.writeHead(200, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(JSON.stringify(next));
      });
    });
    srv.listen(port, '127.0.0.1', () => resolve(srv));
  });
}

// ---------- helpers ----------
function loadCatalog(rel) {
  return JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));
}
function freshRuntime(opts) {
  const catalog = loadCatalog('catalog.json');
  const actions = ACT.createCatalogActions(catalog, ACT.memStorage());
  const trace = [];
  const rt = new RT.AgenticRuntime(Object.assign({
    siteActions: actions,
    confirmWrite: async () => true,
    requestConsent: async () => true,
    onTrace: (e) => trace.push(e),
  }, opts || {}));
  rt.setEngine(new ENG.HouseEngine(), { engine: 'house/local', model: 'house/local', keyPresent: false });
  return { rt, trace, catalog };
}
const TITLES = loadCatalog('catalog.json').books.map((b) => b.title);

async function main() {
  const mainSrv = await staticServer(ROOT, MAIN_PORT);
  const peerSrv = await staticServer(path.join(ROOT, 'peer'), PEER_PORT, (req) => peerRequests.push({ url: req.url, auth: req.headers.authorization || null }));
  const mockSrv = await mockRouterServer(MOCK_PORT);
  const MAIN = 'http://127.0.0.1:' + MAIN_PORT + '/';

  // ---------- validation ----------
  const goodManifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'agent-manifest.json'), 'utf8'));
  check('manifest validates', RT.validateManifest(goodManifest).ok);
  check('manifest rejects empty networks', !RT.validateManifest({ networks: [] }).ok);
  check('manifest rejects missing front_man', !RT.validateManifest({ networks: [{ name: 'x', hocon: './x.json' }] }).ok);
  check('manifest rejects duplicate network names', !RT.validateManifest({ networks: [{ name: 'x', front_man: 'a', hocon: './x.json' }, { name: 'x', front_man: 'a', hocon: './x.json' }] }).ok);

  const goodNet = JSON.parse(fs.readFileSync(path.join(ROOT, 'corner-shelf.network.json'), 'utf8'));
  const vNet = RT.validateNetwork(goodNet, { frontMan: 'librarian', actions: ['search_catalog', 'get_shelf_info', 'borrow_book', 'return_book'], links: { northside: './peer/northside-shelf' } });
  check('network validates', vNet.ok, vNet.errors.join('; '));
  const badFront = JSON.parse(JSON.stringify(goodNet)); badFront.tools = badFront.tools.filter((t) => t.name !== 'librarian');
  check('network rejects missing front agent', !RT.validateNetwork(badFront, { frontMan: 'librarian' }).ok);
  const dup = JSON.parse(JSON.stringify(goodNet)); dup.tools.push(JSON.parse(JSON.stringify(dup.tools[0])));
  check('network rejects duplicate agent names', !RT.validateNetwork(dup, { frontMan: 'librarian' }).ok);
  const dangling = JSON.parse(JSON.stringify(goodNet)); dangling.tools[0].tools.push('nope_nothing');
  check('network rejects dangling tool reference', !RT.validateNetwork(dangling, { frontMan: 'librarian', actions: ['search_catalog', 'get_shelf_info', 'borrow_book', 'return_book'], links: { northside: './peer/northside-shelf' } }).ok);
  const badSteps = JSON.parse(JSON.stringify(goodNet)); badSteps.max_steps = 0;
  check('network rejects max_steps 0', !RT.validateNetwork(badSteps, { frontMan: 'librarian' }).ok);

  // ---------- local flows (house engine, no key) ----------
  {
    const { rt } = freshRuntime();
    await rt.loadSite(MAIN + 'agent-manifest.json');
    await rt.loadNetworkByName('corner-shelf');
    const r1 = await rt.run("y'all got Dune?", { knownTitles: TITLES });
    check('search finds Dune, available', /Dune/.test(r1.answer) && /ready to go/.test(r1.answer), r1.answer);
    const r2 = await rt.run("y'all got Piranesi?", { knownTitles: TITLES });
    check('search says plainly when a book ain\'t here + offers Northside', /ain't on this shelf/.test(r2.answer) && /Northside/.test(r2.answer), r2.answer);
    const r3 = await rt.run('how this work?', { knownTitles: TITLES });
    check('info answers from the shelf (where + rule)', /5th/.test(r3.answer) && /take a book/.test(r3.answer), r3.answer);
  }
  {
    const { rt } = freshRuntime();
    await rt.loadSite(MAIN + 'agent-manifest.json');
    await rt.loadNetworkByName('corner-shelf');
    const r = await rt.run('let me borrow Beloved', { knownTitles: TITLES });
    check('borrow works + receipt + due date', /bring it back by/.test(r.answer) && r.receipts.length === 1 && r.receipts[0].type === 'borrow', JSON.stringify(r.receipts));
    const r2 = await rt.run('let me borrow Beloved', { knownTitles: TITLES });
    check('second borrow of the same book is refused with a due date', /out right now/.test(r2.answer) && /back /.test(r2.answer), r2.answer);
    const r3 = await rt.run("i'm bringing back Beloved", { knownTitles: TITLES });
    check('return works + receipt', /back on the shelf/.test(r3.answer) && r3.receipts.length === 1 && r3.receipts[0].type === 'return', r3.answer);
    const r4 = await rt.run('let me borrow Beloved', { knownTitles: TITLES });
    check('borrow works again after return', /bring it back by/.test(r4.answer), r4.answer);
  }
  {
    // Write declined: nothing changes.
    const { rt } = freshRuntime({ confirmWrite: async () => false });
    await rt.loadSite(MAIN + 'agent-manifest.json');
    await rt.loadNetworkByName('corner-shelf');
    const r = await rt.run('let me borrow Beloved', { knownTitles: TITLES });
    check('declined borrow changes nothing', /no worries, nothing changed/.test(r.answer) && r.receipts.length === 0, r.answer);
    const r2 = await rt.run("y'all got Beloved?", { knownTitles: TITLES });
    check('book still available after declined borrow', /ready to go/.test(r2.answer), r2.answer);
  }

  // ---------- peer flows (second origin, real HTTP) ----------
  {
    peerRequests.length = 0;
    const { rt, trace } = freshRuntime({
      linkOverrides: { 'corner-shelf': { northside: 'http://127.0.0.1:' + PEER_PORT + '/northside-shelf' } },
    });
    await rt.loadSite(MAIN + 'agent-manifest.json');
    await rt.loadNetworkByName('corner-shelf');
    const r = await rt.run('check Northside for Piranesi', { knownTitles: TITLES });
    check('peer finds Piranesi at Northside', /Piranesi/.test(r.answer) && /Northside Shelf/.test(r.answer), r.answer);
    check('peer manifest + network + catalog were fetched', peerRequests.some((x) => x.url === '/agent-manifest.json') && peerRequests.some((x) => x.url === '/northside-shelf.network.json') && peerRequests.some((x) => x.url === '/catalog.json'), JSON.stringify(peerRequests.map((x) => x.url)));
    check('consent was asked before contacting the peer', trace.some((e) => e.kind === 'consent' && /said yes/.test(e.label)), '');
    check('peer fetches carried no auth header', peerRequests.every((x) => x.auth === null), JSON.stringify(peerRequests));
  }
  {
    // Same-origin peer via the shipped links.json (./peer/northside-shelf).
    const { rt } = freshRuntime();
    await rt.loadSite(MAIN + 'agent-manifest.json');
    await rt.loadNetworkByName('corner-shelf');
    const r = await rt.run('check Northside for Piranesi', { knownTitles: TITLES });
    check('same-origin peer link from links.json also works', /Piranesi/.test(r.answer), r.answer);
  }
  {
    // Consent denied: the peer is never contacted.
    peerRequests.length = 0;
    const { rt } = freshRuntime({
      requestConsent: async () => false,
      linkOverrides: { 'corner-shelf': { northside: 'http://127.0.0.1:' + PEER_PORT + '/northside-shelf' } },
    });
    await rt.loadSite(MAIN + 'agent-manifest.json');
    await rt.loadNetworkByName('corner-shelf');
    const r = await rt.run('check Northside for Piranesi', { knownTitles: TITLES });
    check('consent denied -> peer never fetched + honest answer', peerRequests.length === 0 && /keep it local/.test(r.answer), r.answer + ' | fetches: ' + peerRequests.length);
  }
  {
    // Denied origin: peer URL not on the allowed list.
    const { rt } = freshRuntime({
      linkOverrides: { 'corner-shelf': { northside: 'http://127.0.0.1:8009/evil-shelf' } },
    });
    await rt.loadSite(MAIN + 'agent-manifest.json');
    await rt.loadNetworkByName('corner-shelf');
    const res = await assertThrowsAsync(() => rt.run('check Northside for Piranesi', { knownTitles: TITLES }), /not on the allowed list/);
    check('denied origin is refused, fail closed', res.threw && res.match, res.msg || 'did not throw');
  }
  {
    // Unknown peer name: the manifest has no such network.
    const { rt } = freshRuntime({
      linkOverrides: { 'corner-shelf': { northside: 'http://127.0.0.1:' + PEER_PORT + '/no-such-network' } },
    });
    await rt.loadSite(MAIN + 'agent-manifest.json');
    await rt.loadNetworkByName('corner-shelf');
    const res = await assertThrowsAsync(() => rt.run('check Northside for Piranesi', { knownTitles: TITLES }), /no network named/);
    check('peer without that exact name is refused (no silent fallback)', res.threw && res.match, res.msg || 'did not throw');
  }
  {
    // Private context: deny by default; allow-list forwards only named fields.
    const { rt } = freshRuntime({
      linkOverrides: { 'corner-shelf': { northside: 'http://127.0.0.1:' + PEER_PORT + '/northside-shelf' } },
    });
    await rt.loadSite(MAIN + 'agent-manifest.json');
    await rt.loadNetworkByName('corner-shelf');
    const r = await rt.run('check Northside for Piranesi', { knownTitles: TITLES, sly_data: { member_id: 'M-123', nickname: 'jay' } });
    const peerEntry = r.history.find((h) => h.peer);
    check('sly_data: peer sees nothing by default', peerEntry && JSON.stringify(peerEntry.result.slyDataSeen) === '{}', JSON.stringify(peerEntry && peerEntry.result.slyDataSeen));
    // Same run, but the network explicitly allows "nickname".
    const net2 = JSON.parse(JSON.stringify(goodNet));
    net2.sly_data = { allow: ['nickname'] };
    const { rt: rt2 } = freshRuntime({
      linkOverrides: { 'corner-shelf': { northside: 'http://127.0.0.1:' + PEER_PORT + '/northside-shelf' } },
    });
    await rt2.loadSite(MAIN + 'agent-manifest.json');
    rt2.network = net2; rt2.networkName = 'corner-shelf';
    const r2 = await rt2.run('check Northside for Piranesi', { knownTitles: TITLES, sly_data: { member_id: 'M-123', nickname: 'jay' } });
    const peerEntry2 = r2.history.find((h) => h.peer);
    check('sly_data: allow-list forwards only the named field', peerEntry2 && JSON.stringify(peerEntry2.result.slyDataSeen) === '{"nickname":"jay"}', JSON.stringify(peerEntry2 && peerEntry2.result.slyDataSeen));
  }

  // ---------- BYOK engine (mock router) ----------
  {
    mockCalls.length = 0;
    mockScript = [
      { choices: [{ message: { role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'action_search_catalog', arguments: '{"query":"Dune"}' } }] } }] },
      { choices: [{ message: { role: 'assistant', content: "yeah, Dune's right here — Frank Herbert, 1965. want me to hold it for you?" } }] },
    ];
    const KEY = 'sk-test-KEY-DO-NOT-LOG-12345';
    const { rt, trace } = freshRuntime();
    await rt.loadSite(MAIN + 'agent-manifest.json');
    await rt.loadNetworkByName('corner-shelf');
    rt.setEngine(new ENG.ByokEngine({ baseUrl: 'http://127.0.0.1:' + MOCK_PORT, model: 'mock-model', key: KEY, fetchImpl: fetch }), { engine: 'byok', model: 'mock-model', keyPresent: true });
    const r = await rt.run("y'all got Dune?", { knownTitles: TITLES });
    check('BYOK: tool call dispatched + final answer returned', /Dune's right here/.test(r.answer), r.answer);
    check('BYOK: key went to the router as a Bearer header', mockCalls.length >= 1 && mockCalls[0].headers.authorization === 'Bearer ' + KEY, JSON.stringify(mockCalls.map((c) => c.headers.authorization)));
    check('BYOK: key never appears in the trace', !JSON.stringify(trace).includes(KEY), '');
  }
  {
    // BYOK peer run: the key must not reach the peer site either.
    peerRequests.length = 0; mockCalls.length = 0;
    const KEY2 = 'sk-test-KEY-PEER-CHECK-67890';
    mockScript = [
      { choices: [{ message: { role: 'assistant', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'ask_peer_northside', arguments: '{"request":"check Northside for Piranesi"}' } }] } }] },
      { choices: [{ message: { role: 'assistant', tool_calls: [{ id: 'c2', type: 'function', function: { name: 'call_agent_northside_shelf', arguments: '{"request":"check Northside for Piranesi"}' } }] } }] },
      { choices: [{ message: { role: 'assistant', tool_calls: [{ id: 'c3', type: 'function', function: { name: 'action_search_catalog', arguments: '{"query":"Piranesi"}' } }] } }] },
      { choices: [{ message: { role: 'assistant', content: "yeah, Piranesi's here at Northside — Susanna Clarke, 2020, ready to go." } }] },
      { choices: [{ message: { role: 'assistant', content: "Northside's got it — Piranesi, Susanna Clarke, 2020, ready to go." } }] },
    ];
    const { rt, trace } = freshRuntime({
      linkOverrides: { 'corner-shelf': { northside: 'http://127.0.0.1:' + PEER_PORT + '/northside-shelf' } },
    });
    await rt.loadSite(MAIN + 'agent-manifest.json');
    await rt.loadNetworkByName('corner-shelf');
    rt.setEngine(new ENG.ByokEngine({ baseUrl: 'http://127.0.0.1:' + MOCK_PORT, model: 'mock-model', key: KEY2, fetchImpl: fetch }), { engine: 'byok', model: 'mock-model', keyPresent: true });
    const r = await rt.run('check Northside for Piranesi', { knownTitles: TITLES });
    check('BYOK peer: answer comes back through the caller', /Northside's got it/.test(r.answer), r.answer);
    check('BYOK peer: peer fetches carried no auth header', peerRequests.every((x) => x.auth === null) && peerRequests.length > 0, JSON.stringify(peerRequests));
    check('BYOK peer: key never appears in the trace', !JSON.stringify(trace).includes(KEY2), '');
  }
  {
    const { rt } = freshRuntime();
    await rt.loadSite(MAIN + 'agent-manifest.json');
    await rt.loadNetworkByName('corner-shelf');
    rt.setEngine(new ENG.ByokEngine({ baseUrl: 'http://127.0.0.1:' + MOCK_PORT, model: 'mock-model', key: '', fetchImpl: fetch }), { engine: 'byok', model: 'mock-model', keyPresent: false });
    const res = await assertThrowsAsync(() => rt.run("y'all got Dune?", { knownTitles: TITLES }), /needs a key/);
    check('BYOK without a key stops with a clear error', res.threw && res.match, res.msg || 'did not throw');
  }

  // ---------- budgets, cycles, invalid networks ----------
  {
    const { rt } = freshRuntime();
    await rt.loadSite(MAIN + 'agent-manifest.json');
    // Network whose front agent doesn't exist: rejected at load.
    const bad = JSON.parse(JSON.stringify(goodNet));
    bad.tools = bad.tools.filter((t) => t.name !== 'librarian');
    rt.network = bad; rt.networkName = 'corner-shelf';
    const v = RT.validateNetwork(bad, { frontMan: 'librarian' });
    check('invalid network (front agent gone) fails validation', !v.ok && v.errors.some((e) => /front agent/.test(e)), v.errors.join('; '));
  }
  {
    // Cycle: an engine that always delegates to the same agent, same input.
    const { rt } = freshRuntime();
    await rt.loadSite(MAIN + 'agent-manifest.json');
    await rt.loadNetworkByName('corner-shelf');
    rt.setEngine({ nextStep: async () => ({ kind: 'delegate', agent: 'shelf', input: { request: 'loop' } }) }, { engine: 'stub', model: 'stub' });
    const res = await assertThrowsAsync(() => rt.run('loop test', { knownTitles: TITLES }), /loop caught/);
    check('composition cycle is stopped with a visible error', res.threw && res.match, res.msg || 'did not throw');
  }
  {
    // Step budget: an engine that keeps delegating to fresh agents.
    const { rt } = freshRuntime({ budgets: { maxSteps: 3 } });
    await rt.loadSite(MAIN + 'agent-manifest.json');
    await rt.loadNetworkByName('corner-shelf');
    let n = 0;
    rt.setEngine({ nextStep: async () => ({ kind: 'delegate', agent: n++ % 2 === 0 ? 'shelf' : 'borrow-desk', input: { request: 'x' + n } }) }, { engine: 'stub', model: 'stub' });
    const res = await assertThrowsAsync(() => rt.run('budget test', { knownTitles: TITLES }), /step budget hit/);
    check('over-budget run is stopped with a visible error', res.threw && res.match, res.msg || 'did not throw');
  }
  {
    // Tool-call budget.
    const { rt } = freshRuntime({ budgets: { maxToolCalls: 2 } });
    await rt.loadSite(MAIN + 'agent-manifest.json');
    await rt.loadNetworkByName('corner-shelf');
    rt.setEngine({ nextStep: async (runtime, ctx, current) => {
      if (current.agent === 'librarian') return { kind: 'delegate', agent: 'shelf', input: { request: 'x' } };
      return { kind: 'action', action: 'search_catalog', args: { query: 'Dune' } };
    } }, { engine: 'stub', model: 'stub' });
    const res = await assertThrowsAsync(() => rt.run('tool budget test', { knownTitles: TITLES }), /tool-call budget hit/);
    check('tool-call budget is enforced', res.threw && res.match, res.msg || 'did not throw');
  }

  mainSrv.close(); peerSrv.close(); mockSrv.close();
  const passed = results.filter((r) => r.ok).length;
  console.log('\n' + passed + '/' + results.length + ' tests passed');
  if (passed !== results.length) {
    console.log('FAILED:');
    results.filter((r) => !r.ok).forEach((r) => console.log(' - ' + r.name + (r.extra ? ' -> ' + r.extra : '')));
    process.exitCode = 1;
  }
}

main().catch((e) => { console.error('TEST RUNNER CRASHED:', e); process.exitCode = 1; });
