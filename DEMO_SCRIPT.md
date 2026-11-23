# Demo script — The Corner Shelf (~90 seconds)

Silent captioned walkthrough, recorded from the real site running in the browser. No voiceover, no fake screens — every frame is the actual page doing the actual thing.

## The flow

**0:00 — The shelf.** The Corner Shelf homepage. A grid of real books, green means it's here, amber means somebody's got it. "Books from the block, for the block."

**0:08 — "y'all got Dune?"** Type it in the chat. The librarian checks the shelf and answers: yeah, Dune's here — Frank Herbert, 1965, ready to go. The receipts panel shows the steps: house engine, librarian → shelf → search_catalog.

**0:22 — "let me borrow Beloved."** The librarian asks you to confirm — borrowing changes something, so the runtime makes you say yes first. Tap "yeah, do it." Receipt: it's yours, bring it back by the due date. The shelf grid updates — Beloved flips to amber.

**0:40 — "check Northside for Piranesi."** We don't have Piranesi. The librarian asks: mind if I ask the other branch? The consent card names the site. Tap "yeah, ask 'em." The peer's manifest and network load, their librarian checks their shelf — Piranesi's there, Susanna Clarke, 2020. Two independent sites, one question, no middleman.

**1:05 — The receipts.** Open the trace. Every step is there: which engine ran, who got called, who got asked, what got confirmed. No secrets in it, ever.

**1:15 — Bring your own brain.** The settings panel. Out the box the librarian runs on the house engine — local, free, no key. Got your own router + key? Plug it in and she'll use a real LLM instead. The key only ever goes to your router.

## Narration (for the final cut, ~2 min, casual voice)

> "Yo — so this is the Corner Shelf. Just a little book swap on the block. Take one, leave one, that's the whole deal.
>
> But look — you can talk to it. 'Y'all got Dune?' And the librarian — she checks the shelf, for real, and tells you straight.
>
> Now watch this: 'let me borrow Beloved.' She don't just do it — she asks first, 'cause borrowing changes something. You say yeah, it's yours. Fourteen days. The shelf updates right there.
>
> Here's the part I'm proud of. 'Check Northside for Piranesi.' We ain't got it. So she asks — can I hit up the other branch? That's a whole different site, with its own librarian and its own books. You say yeah, she asks them, and boom — Piranesi's over there. Two sites talking, no middleman, no central anything. Just public files and your browser.
>
> And everything she did? It's right here in the receipts. Every step, every call, every yes. No secrets, no magic.
>
> Oh — and if you got your own key, plug it in. She'll use a real model instead of the little local engine. Your key never leaves your browser except to your router.
>
> That's it. A shelf that talks to other shelves. Go build one."
