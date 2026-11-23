# The Corner Shelf

Books from the block, for the block. Take one, leave one.

This is a little neighborhood book swap — and it's also a real agentic website, built for the [Open Agentic Web Challenge](https://cognizant-agenticweb.devpost.com/). The whole thing runs in your browser: a librarian you can talk to, a shelf you can borrow from, and a sister branch across town it can ask when we ain't got what you need. No server, no account, no key required.

## How it works

- **`agent-manifest.json`** — the public index. Says what networks this site publishes, who the front agent is, where the network file lives, which peers are allowed, and how the LLM router works.
- **`corner-shelf.network.json`** — the agent network itself, in the Neuro SAN shape the spec asks for: three agents (`librarian`, `shelf`, `borrow-desk`), their descriptions, instructions, and what each one is allowed to call. The `librarian` can also call the `northside` peer network.
- **`links.json`** — maps the name `northside` to the peer's network URL.
- **`runtime.js`** — the browser runtime. Loads the manifest, validates it, validates the network, then runs the graph. It owns consent, budgets, cycle checks, and private-context rules. It never trusts the model to enforce any of that.
- **`engines.js`** — two engines, same loop:
  - **House engine (default):** a little local engine. No key, no cloud, no cost. It reads your words, matches them against the agents' own published descriptions, and walks the graph. Every fact it tells you comes from a tool result.
  - **BYOK engine:** plug in your own OpenAI-compatible router + model + key under "bring your own brain" and the librarian talks to a real LLM instead. Your key stays in your browser and only ever goes to your router — never to another site, never into the trace.
- **`site-actions.js`** — the shelf's real capabilities: `search_catalog`, `get_shelf_info` (reads), `borrow_book`, `return_book` (writes — the runtime makes you confirm before either one runs, and hands back a receipt).
- **`peer/`** — the Northside Shelf, a whole second branch: its own manifest, network, and catalog. The main site loads it over plain fetch after you say it's cool — manifest first, exact name match, then the network file. Its agents run right here in your browser, on your router, under your budgets. It never sees your key.

## Run it

No build step. It's static files.

```bash
# quickest: any static server. this one adds CORS headers so other
# agent sites can fetch our public files:
python3 serve.py
# main site: http://127.0.0.1:8001/   peer: http://127.0.0.1:8002/
```

Or just open `index.html` straight from disk — the page works from `file://` too.

## Try it

- "y'all got Dune?" — the librarian checks the shelf.
- "let me borrow Beloved" — she asks you to confirm, then it's yours for 14 days.
- "i'm bringing back Kindred" — back on the shelf.
- "check Northside for Piranesi" — she asks if she can hit up the other branch, then asks their librarian. That's two independent agent sites talking, no middleman.
- "how this work?" — the house rules.

Open "the receipts" at the bottom of the page and you'll see every step: which engine ran, who got called, who got asked, what got confirmed. No secrets in there, ever.

## Tests

```bash
node tests/run-tests.mjs
```

39 checks, all against the real files over real HTTP: manifest + network validation (good and bad), search / borrow / return / info flows, borrow declined (nothing changes), cross-origin peer load with consent, consent denied (peer never fetched), denied origin refused, unknown peer name refused, private context blocked by default and allowed by name only, the BYOK path against a mock router (key goes to the router, never to the peer, never into the trace), cycle stopped, step + tool-call budgets enforced.

```
39/39 tests passed
```

## What's what

| file | what it is |
| --- | --- |
| `index.html` / `styles.css` / `app.js` | the site + chat + settings + the receipts |
| `agent-manifest.json` | public index of this site's networks |
| `corner-shelf.network.json` | the agent network (Neuro SAN shape, JSON) |
| `links.json` | peer link map (`northside` → the peer) |
| `catalog.json` | the books on this shelf |
| `runtime.js` | the runtime: load, validate, run, consent, budgets |
| `engines.js` | house engine + BYOK engine |
| `site-actions.js` | search / info / borrow / return |
| `peer/` | the Northside branch (own manifest, network, catalog) |
| `serve.py` | static server with CORS for both sites |
| `tests/run-tests.mjs` | the test suite |
| `web/demo.mp4` | the demo video (silent, captioned) |
| `DEMO_SCRIPT.md` | what the video walks through |

## Why a book swap?

Because interop is easiest to see when two places have to work together for a real person. One question — "y'all got Piranesi?" — crosses from one independent site to another, with your permission, on your machine, and the answer comes back with receipts. No central registry, no special integration, just public files and a browser. That's the whole idea.
