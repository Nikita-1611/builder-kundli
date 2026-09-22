# Builder Kundli

Not stars. MahaRERA records.

**Live:** [paste your Vercel URL]

## What it solves

Other builder-check tools just count complaints filed against a real estate developer. Builder Kundli reads the actual MahaRERA order PDFs — what a buyer complained about, what the authority ordered, and whether the builder actually paid — so a buyer can see the real outcome, not just a raw complaint tally. Maharashtra (MahaRERA) only, for now.

## How it works

A batch pipeline, run ahead of time, not live:

1. **Scrape** — MahaRERA's recovery warrant registry → `raw/warrants.json`
2. **Collect** — download the underlying order PDFs → `orders/`
3. **Extract** — Gemini reads each order PDF into structured JSON (who asked, what was granted/denied, why) → `extracted/`
4. **Score** — plain Python, no AI: points from warrants and orders → `scored/`
5. **Load** — `scored/*.json` into a SQLite database (`builder_risk.db`); every buyer/warrant count the site shows comes from a SQL query here, not a hand-rolled recount in the app
6. **Build** — resolve builder name variants, compute the 0–10 score, write one JSON per builder → `builders/`, synced into the website

The website (`website/`) only ever reads those per-builder JSON files — no backend, no live scraping.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the full pipeline, schema, and design decisions.

## Tech

Python · Gemini · SQLite · React · Vite · Vercel
