# Builder Kundli

**Not stars. MahaRERA records.**

Check a Maharashtra builder's track record before you book a flat.

**Live:** https://builder-kundli.vercel.app/



https://github.com/user-attachments/assets/baac7e7b-a457-499d-b279-f176d36d589c



---

## The problem

Buying an under-construction flat means paying lakhs to a builder years before you get the keys. The one thing you can't easily check is whether that builder has let buyers down before.

MahaRERA publishes the records, but only as counts. A builder page might say "9 complaints, 7 disposed." That number hides the answer that matters. Nine small issues that were fixed and nine buyers who won their case and never got paid look exactly the same.

And "disposed" doesn't mean paid. MahaRERA marks a case closed when it passes an order, not when the buyer gets their money. When a builder ignores an order, MahaRERA issues a recovery warrant. Only around a third of those warrants have actually been executed.

## What Builder Kundli does

It reads the actual MahaRERA orders instead of counting them, and shows a buyer:

- **What buyers complained about**, in plain language
- **What MahaRERA ordered**, and who it ruled for
- **Whether the builder paid**, or whether MahaRERA had to issue a recovery warrant
- **A 0 to 10 concern score**, with the full working shown
- **A link to the source order** for every finding, so anyone can verify it

MahaRERA's statewide warrant registry has 1,607 recovery warrants in total. Of the 26 builders tracked so far, 477 of those warrants and 73 fully-read orders belong to them.

## How it works

A batch pipeline that runs ahead of time. Nothing is scraped or generated when a visitor uses the site.

| Stage | What it does | Output |
|---|---|---|
| 1. Scrape | Pulls MahaRERA's recovery warrant registry | `raw/warrants.json` |
| 2. Collect | Downloads the order PDFs behind each warrant | `orders/` |
| 3. Extract | Gemini reads each order into a fixed JSON schema | `extracted/` |
| 4. Score | Plain Python assigns points to warrants and orders | `scored/` |
| 5. Load | Everything goes into SQLite; all counts come from SQL | `builder_risk.db` |
| 6. Build | Resolves builder name variants, computes scores, writes one file per builder | `builders/` |

The website in `website/` only reads the per-builder JSON files. There is no backend and no API key on the live site.

Full details are in [ARCHITECTURE.md](ARCHITECTURE.md).

## Key decisions

**AI is used in one place only.** Gemini extracts facts from legal PDFs. Scoring and counting are plain code, so the same data always produces the same score, and every point can be explained.

**Schema-validated extraction.** Every extracted order is checked against `schema.json`. Output that doesn't fit is rejected rather than guessed at.

**Buyers are counted once.** One buyer can win several things in a single order. All buyer counts use `COUNT(DISTINCT complaint_no)` in SQL, so the report and category pages always agree.

**No fuzzy name matching.** Builders appear under many spellings. Fuzzy matching wrongly attached other companies' records to the wrong builder, so name variants are matched by normalisation and a reviewed alias list instead.

**"Not decided" is not "builder won".** Many dismissed complaints were never ruled on: filed too early, paused by insolvency proceedings, or settled. These are labelled separately from cases MahaRERA actually decided for the builder.

**No hand-typed numbers on the site.** Homepage stats (warrants, projects, amount) are computed from `raw/warrants.json` at build time into `public/stats.json`, the same source this README cites. When orders don't state an amount, the report says "Amount not stated in the orders we read" instead of showing a misleading ₹0.00.

## How it's checked

Full results and method are in [EVALS.md](EVALS.md).

| Check | What it tests | Result |
|---|---|---|
| Grounding (`evals/grounding_check.py`) | Does every complaint number, date and amount Gemini extracted appear in the source PDF text? | Amounts 82.9%, complaint numbers 57.4%, dates 39.5% traceable. A lower bound: 11 PDFs are scans with no text layer, and many others have heavy OCR noise. |
| Human review (`evals/sample_for_human_review.py`) | 15 orders across 15 builders, to check by hand against the PDF | Sample ready in `evals/human_review_sample.csv` |
| Site invariants (`website/scripts/check-invariants.mjs`) | Counts agree across pages; district totals never exceed builder totals; the ₹0.00 guard is still in place | Runs on every build. Passing. |

## Limitations

- **Maharashtra only.** Each state's RERA publishes data differently.
- **Order coverage per builder is uneven, not capped.** New extraction runs are limited to 5 orders per builder to stay within free API limits, but several builders already have more from before that cap existed (up to 21 for one builder) — so counts vary widely, not a fixed 5.
- **10 of the 26 tracked builders have warrants but no readable orders yet.** For 3 of them, MahaRERA's own site actively blocks PDF retrieval (see `ARCHITECTURE.md`, Stage 2). The other 7 are just waiting on the next extraction run — limited by the free Gemini tier's daily quota, not blocked.
- **Warrant execution isn't published.** MahaRERA shows that a warrant was issued, not whether the money was later recovered.
- **Clean builders were added by hand**, after confirming they have no recovery warrants on record.
- **Director-named orders can go uncounted.** When an order lists a director ahead of the company, it isn't matched to the builder (3 JVPD orders confirmed). Found by the evals, not yet fixed.

## Go-to-market

**For:** families buying under-construction flats in Mumbai and Pune — ₹50L–3Cr, usually on a home loan.

**How they'd find it:** each builder has its own URL, so pages can be indexed for searches like "is [builder] safe" (needs server rendering, not built yet); a WhatsApp share card, because property decisions here are family decisions; homebuyer groups on Reddit and WhatsApp.

**Pricing:** free for buyers. A paid API for portals and lenders later.

**North star:** source-backed reads — one visit where someone found their builder, read the report, and opened the original order. Supporting: search success rate, scroll depth, shares, source-order CTR. Counter-metric: disputed findings, since this publishes adverse things about named companies.

## Roadmap

**Now** — read the orders still pending; fix the open bug where a director's name is read as the builder.

**Next** — every Maharashtra builder, auto-updated, with alerts when a record changes.

**Later** — paid partner API, then other states.

## Run it locally

```bash
# Pipeline (needs GEMINI_API_KEY in .env)
python scripts/scrape_warrants.py
python scripts/collect_orders.py
python scripts/extract.py       # defaults to a capped, per-builder selection
python scripts/score.py
python scripts/build.py

# Evals (needs: pip install pdfplumber)
python evals/grounding_check.py
python evals/sample_for_human_review.py

# Website
cd website
npm install
npm run dev
npm run check-invariants   # also runs inside npm run build
```

## Stack

Python · Gemini API · SQLite · React · Vite · Vercel

## Disclaimer

Builder Kundli shows what MahaRERA's own public records say. It is not legal or financial advice, and it doesn't tell anyone whether to buy. Every finding links to its source so it can be checked independently.
