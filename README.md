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

## Limitations

- **Maharashtra only.** Each state's RERA publishes data differently.
- **Order coverage per builder is uneven, not capped.** New extraction runs are limited to 5 orders per builder to stay within free API limits, but several builders already have more from before that cap existed (up to 21 for one builder) — so counts vary widely, not a fixed 5.
- **10 of the 26 tracked builders have warrants but no readable orders yet.** For 3 of them, MahaRERA's own site actively blocks PDF retrieval (see `ARCHITECTURE.md`, Stage 2). The other 7 are just waiting on the next extraction run — limited by the free Gemini tier's daily quota, not blocked.
- **Warrant execution isn't published.** MahaRERA shows that a warrant was issued, not whether the money was later recovered.
- **Clean builders were added by hand**, after confirming they have no recovery warrants on record.

## Run it locally

```bash
# Pipeline (needs GEMINI_API_KEY in .env)
python scripts/scrape_warrants.py
python scripts/collect_orders.py
python scripts/extract.py       # defaults to a capped, per-builder selection
python scripts/score.py
python scripts/build.py

# Website
cd website
npm install
npm run dev
```

## Stack

Python · Gemini API · SQLite · React · Vite · Vercel

## Disclaimer

Builder Kundli shows what MahaRERA's own public records say. It is not legal or financial advice, and it doesn't tell anyone whether to buy. Every finding links to its source so it can be checked independently.
