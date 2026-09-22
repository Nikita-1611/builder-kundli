# Architecture — Builder Kundli

Batch pipeline. Runs once on a laptop. No backend, no database, no login.
Output: one JSON file per builder (19 currently). Website only reads files.

---

## Current status (2026-09-19)

- **Scoring:** `score` is 0-10, one decimal, in `builders/*.json` (`scripts/build.py`) — raw points as the main driver, project count as a small log-scaled bonus (not a divisor), run through a saturating curve so scores spread out instead of clustering at a cap. See Stage 5 below for the constants and why an earlier divide-by-project-count version had the ranking backwards.
- **Website:** working. Vite + React, three screens (search, report, category detail) plus an empty state, reading only `builders/*.json`. Report leads with the score card, then project/warrant stat boxes, key flags, and a "what complaints were about" category breakdown that drills into per-buyer case detail (who won, what was ordered, why) at `/builder/:id/:category`.
- **Dataset:** 19 builders (see Stage 5's name-merge note on why not 20), and **all 19 currently show `adverse`** — expected, not a bug: the builder list is `raw/top_respondents.json`'s top 20 by warrant count, so by construction every builder in scope already has warrants. There is no `clean` example in the dataset yet because none was ever selected.
- **Next:** (1) add clean builders — pull in some builders with no adverse record so the site can actually show what "clean" looks like, not just varying degrees of "adverse"; (2) score labels — a human-readable band on top of the bare 0-10 number (e.g. low/moderate/high), not yet designed.
- **Extraction backlog (2026-09-22):** `extract.py`'s default scope was fixed — it used to walk `orders/*.pdf` alphabetically, ignoring the per-respondent cap; now it defaults to the same capped selection as `select_extraction_batch.py`. Ran the remaining capped PDFs for n-k-bhupesh-babu, skylink-hospitality-llp, darode-jog-homes-private-limited, karrm-infrastructure-pvt-ltd (16 PDFs): 2 extracted, then hit the Gemini free-tier daily quota (`gemini-2.5-flash`, 20 requests/day). **14 PDFs still remain** across those 4 builders. To finish: rerun `select_extraction_batch.py --json`, filter `per_builder` down to those 4 ids, and feed it to `extract_batch.py --from-selection` once the quota resets (resets daily, Pacific time).

---

## Pipeline stages

```
1. scrape     MahaRERA lists: warrants, revoked, abeyance, QPR defaulters      →  raw/*.json
2. collect    download order PDFs (warrant rows only)                          →  orders/*.pdf
3. extract    LLM reads each order PDF                                         →  extracted/*.json
4. score      plain Python, points table — warrants + orders                   →  scored/*.json
5. build      group by builder, resolve name variants, compute 0-10 score      →  builders/*.json   (website reads only this)
```

Each stage reads the previous stage's output and writes its own. No stage calls another stage's code directly — they're connected by files on disk, not function calls. Re-running a stage overwrites its output folder; earlier stages are untouched.

Only the warrant list has been built out end to end. Revoked, abeyance, and QPR defaulter lists were planned as structured rows that would skip collect/extract and feed scoring directly as registry signals — never built (see Stage 1), so stage 4 currently only ever scores warrants and orders.

One more wrinkle confirmed by reading real specimens: a single downloaded PDF can contain more than one dated proceeding for the same complaint — typically a final order, followed months or years later by a non-execution application when the promoter didn't comply. Extraction (stage 3) captures both from one file; it doesn't split them into separate PDFs or separate extracted files.

---

## Folder structure

```
builder-risk/
├── raw/
│   ├── warrants.json           # stage 1 — complaint-level, one row per warrant
│   ├── revoked.json            # stage 1 — project-level, registrations revoked
│   ├── abeyance.json           # stage 1 — project-level, projects in abeyance
│   └── qpr_defaulters.json     # stage 1 — project-level, QPR non-filers
├── raw_html/
│   └── warrants/
│       ├── _listing-page_{timestamp}.html   # the page itself, fetched once per run
│       └── {district}_{timestamp}.html      # one saved response per district, before parsing
├── orders/
│   └── {id}.pdf                # stage 2 output — downloaded PDFs, named by whatever opaque id the source assigns
├── extracted/
│   └── {id}.json                # stage 3 output — one file per PDF, same {id}. May hold one proceeding or several (final order + later non-execution application, etc.)
├── scored/
│   ├── warrant_{district}_{sr_no}.json   # stage 4 — points from a raw/warrants.json row
│   └── order_{order_id}.json             # stage 4 — points + full content from an extracted order
├── builders/
│   └── {builder_id}.json      # stage 5 output — final, one file per builder, 19 currently
├── scripts/
│   ├── scrape_warrants.py     # built — see Stage 1 below
│   ├── collect_orders.py      # built — see Stage 2 below
│   ├── extract.py             # built — see Stage 3 below
│   ├── score.py                # built — see Stage 4 below
│   └── build.py                # built — see Stage 5 below
└── website/                   # Vite + React, reads builders/*.json only (via public/builders/, synced by website/scripts/sync-builders.mjs)
```

The website never touches `raw/`, `raw_html/`, `orders/`, `extracted/`, or `scored/`. Those are working folders for the pipeline. Only `builders/*.json` ships.

---

## Stage 1 — Scrape → `raw/*.json`

Four separate lists, scraped as-is. No interpretation, no join yet.

**`raw/warrants.json`** is built. `scripts/scrape_warrants.py` (the only stage-1 script written so far) hits `https://maharera.maharashtra.gov.in/warrant-details`, which is not a plain HTML table you can just fetch — the page shows only a district-summary table by default, and the per-district row data loads via a client-side AJAX call fired when you click a district on the map, with no change to the URL. Reverse-engineered from the site's own `general.js`: a click builds `warrant-details/"<District>@undefined"` (the `@undefined` is real — the button markup has no `aria-controls` attribute, so the site's own jQuery reads JS `undefined` and sends it literally) and GETs that, no auth, no session, no pagination. The script replicates that exact request per district instead of using a browser. District names aren't hardcoded — they're read off the page's own `data-deatil` attributes, currently 14 of them, so a district MahaRERA adds later gets picked up automatically.

Before any parsing, the listing page and every district's raw response are saved to `raw_html/warrants/`, each named with a timestamp. Only after that does the script parse the table into `raw/warrants.json` — columns as the site publishes them, plus `district` (needed once 14 districts' rows are combined into one file) and `sr_no` (the site's own per-district row number, kept for traceability back to a specific row in the saved raw HTML):

```json
[
  {
    "district": "Pune",
    "sr_no": 1,
    "respondent_name": "ABC Developers Pvt Ltd",
    "project_no": "P51700012345",
    "complaint_no": "CC00600001234",
    "date_of_dispatch": "2023-11-20",
    "amount_cr": 0.73,
    "amount": 7300000
  }
]
```

Amount is kept two ways: `amount_cr` exactly as the site publishes it (amounts are listed in crores), and `amount` in rupees, computed with `Decimal` rather than `float` — multiplying a crore figure by 10,000,000 in binary float can land a cent off. Dates are normalized from the site's `DD-MM-YYYY` to ISO (`date_of_dispatch`), but not otherwise corrected: one real row reads `01-01-1970`, MahaRERA's own placeholder for a missing date, and the scraper keeps it as-is rather than guessing or dropping it — Stage 1's job is a straight dump, not cleanup. A full run was checked against the site's own published total (1,607 rows, ₹1,163.48 Cr) and matched exactly.

**`raw/revoked.json`**, **`raw/abeyance.json`**, **`raw/qpr_defaulters.json`** — not yet built. Project-level, one row per project on that list:

```json
[
  {
    "respondent_name": "ABC Developers Pvt Ltd",
    "project_no": "P51700012345",
    "list_date": "2024-02-01"
  }
]
```

None of these tables has a PDF reference column — there is nothing in `raw/` that names a file. Order PDFs are collected separately (stage 2) and matched back to `warrants.json` by `complaint_no`, which only becomes readable once a PDF is actually opened (stage 3). `respondent_name` is raw text — not yet deduplicated against name variants (that happens in stage 5).

---

## Stage 2 — Collect → `orders/{id}.pdf`

No JSON. Just PDFs, downloaded by looping the sequential source URL pattern (`.../final_order_document/{id}.pdf`) — not by looking anything up in `raw/warrants.json`, since that table has no PDF reference. `{id}` here (e.g. `9`, `31`) is just the source site's own file number; it carries no meaning beyond "which file this is" and is not a join key to anything.

The real link between a downloaded PDF and a warrant row is made in stage 3: extraction reads `complaint_no` out of the PDF text itself, and that value — not the filename — is what joins back to `raw/warrants.json`.

**Known gap, not debugged further:** three respondents return zero results on every run — "Unity Land Consultancy/ Pramod Pisal", "Sumer Radius Realty Pvt.Ltd", "D.S Kulkarni Developers Limited" — always failing with "server returned the BigPipe no-js placeholder instead of results" (see `collect_orders_log.txt` through `_log4.txt`). Their order PDFs, if any exist, are simply not in `orders/`. Accepted as a known hole in coverage rather than a blocker.

---

## Stage 3 — Extract → `extracted/{id}.json`

The hard step. LLM reads one PDF, fills a fixed schema (`schema.json`, at the project root). This is the only AI step — everything after is plain code.

This schema went through one real correction: the first three specimen PDFs turned out to be a different order type entirely (suo-motu advertisement enforcement — MahaRERA vs. a promoter for an ad missing a registration number, no buyer involved at all). That schema was discarded once real buyer-complaint orders were read. The schema below is built from those — three real orders, 1 to 11 complainants each, one of them containing two separate dated proceedings in a single PDF.

Key decisions baked into the schema, from reading those orders:
- One order can cover 1 to 11+ buyers, clubbed together → `primary_order.complaints` is a list, and each complaint's `complainant_names` is itself a list (joint filings, e.g. spouses).
- **A relief, not a complaint, is the atomic scored unit.** The same complainant can have one relief granted and another denied in the same order (a Meridia complainant got structural-defect relief granted but their delay-interest claim denied in the same paragraph) — so each complaint has a `reliefs` array, not one `outcome` field.
- `amount` carries a `type` (`refund_principal` / `penalty` / `compensation` / `cost`) and a `recipient` (`buyer` / `government`), and an `interest_rate_description` for when the order gives a rate or formula instead of a settled figure. `value` is nullable on purpose — one complainant's two-flat payment wasn't summed anywhere in the order itself, so it isn't summed here either. Guessing a total would look precise and be wrong.
- `deadline` is a recursive typed union (`fixed_date` / `days_from_order` / `days_from_notice` / `ongoing_until_event` / `earlier_of`), not a date field. Real orders needed all of these: interest accruing with no end date until possession happens; a 30-day clock that only starts once a defect notice is served; and a refund payable on "OC received, or a fixed date, whichever is earlier," then in 3 monthly instalments — `earlier_of` nests two other deadlines to express that.
- `validity_window` is separate from `deadline`, for obligations bounded by a duration rather than a single trigger — e.g. a 5-year defect-liability period, inside which the 30-day notice-response deadline applies.
- `order_level_penalty` sits outside any complainant's `reliefs`. Both multi-complainant samples fined the promoter for something no individual buyer claimed (a lapsed registration, accepting money without an agreement for sale) — attaching that penalty to one buyer's relief list would misattribute it.
- `supplementary_proceedings` holds a later dated proceeding on the same complaint found in the same PDF (a non-execution application, in the one sample that had one) — required as an array, `[]` when empty, so "nothing further happened" is a stated fact, not an omission.
- Only the `FINAL ORDER` section is scored, via `reliefs`/`order_level_penalty`. Everything above (hearing history, submissions, roznama) is kept only inside `reasoning` fields, as paraphrase, never verbatim.
- `complaint_no` is the join key back to `raw/warrants.json` — the PDF filename is not, and doesn't need to be.
- `extraction_confidence` and `extraction_notes` apply to the whole order, not per-relief. An OCR-garbled PDF whose scanned image was still legible is `medium`, not `low` — `low` is reserved for genuine ambiguity in what the order says.

A trimmed real example (single complainant; the full multi-complainant shape just repeats `complaints` and `reliefs`):

```json
{
  "order_id": "b299fbe7-3af5-4126-9597-1d62ca61e668",
  "bench": "Mumbai",
  "case_type": "single_complainant",
  "complainant_count": 1,
  "respondents": [{ "name": "Taksha Spaces Pvt. Ltd.", "role": "promoter" }],
  "project": { "project_name": "Goverdhangiri CHS Ltd (Redevelopment)", "project_reg_no": "P51800002450", "location": "Kandivli, Mumbai", "oc_status": { "received": false, "date": null, "issuing_authority": null, "note": null } },
  "primary_order": {
    "order_date": "2019-10-03",
    "complaints": [
      {
        "complaint_no": "CC006000000055701",
        "complainant_names": ["Anita Modi"],
        "reliefs": [
          {
            "relief_type": "delay_interest",
            "granted": true,
            "amount": { "value": null, "type": "refund_principal", "recipient": "buyer", "interest_rate_description": "MCLR of SBI plus 2% per annum" },
            "deadline": { "type": "ongoing_until_event", "event": "date of possession", "from_date": "2018-01-15", "date": null, "days": null, "options": null, "installments": null },
            "validity_window": null,
            "reasoning": "Respondent admittedly failed to hand over possession by the agreed date; MahaRERA held complainant is an allottee entitled to interest under Section 18(1).",
            "source_page": 4
          }
        ]
      }
    ],
    "order_level_penalty": null,
    "source_page": 4
  },
  "supplementary_proceedings": [
    {
      "proceeding_type": "non_execution_application",
      "date": "2022-06-20",
      "complaint_no": "CC006000000055701",
      "outcome": "dismissed_want_of_prosecution",
      "reasoning": "Both parties absent despite notice; dismissed for want of prosecution.",
      "source_page": 6
    }
  ],
  "extraction_confidence": "medium",
  "extraction_notes": "Pages 1-4 have a heavily degraded OCR layer; the scanned image was legible and used instead."
}
```

`relief_type` is a controlled vocabulary (`delay_interest`, `refund_of_consideration`, `structural_defect_rectification`, `agreement_for_sale_execution`, `compensation`, `possession_and_completion`, `cost`, `other`). This vocabulary, plus `granted: true/false`, is the entire contract between extraction and scoring — scoring never re-reads PDF text or `reasoning`, only these typed fields.

---

## Stage 4 — Score → `scored/warrant_{district}_{sr_no}.json` and `scored/order_{order_id}.json`

Plain Python, no AI: same input always gives the same output. Built in `scripts/score.py`. Two inputs, kept separate — no name-variant merging here, that's stage 5:

- `raw/warrants.json` — one row per recovery warrant already issued.
- `extracted/*.json` — one file per order PDF, LLM-read in stage 3.

There is no registry-based scoring. `raw/revoked.json`, `raw/abeyance.json`, `raw/qpr_defaulters.json` were planned in Stage 1 but never built (see Stage 1 above), so there is nothing for a registry-based scorer to read — an earlier version of this document described one anyway. Dropped rather than left half-documented.

**Points table** (given, not derived): recovery warrant issued = 30. Adverse order, no warrant = 10, per *granted relief* (not per complaint — a denied relief scores differently than a granted one, and one complaint can have both). Anything dated more than 3 years before the run date is halved (`age_halved: true`, `final_points` = `base_points / 2`).

A complaint scores once: if `raw/warrants.json` shows a warrant against a `complaint_no`, that's the 30-point signal for it (`signal: "recovery_warrant"` on the warrant-side file) and every matching relief in `extracted/` gets `signal: "covered_by_warrant"`, `base_points: 0` — not double-counted as an order too. Otherwise, every granted relief on that complaint scores the flat 10 (`signal: "adverse_order_no_warrant"`). A denied relief always scores 0 with `signal: null`.

**No delay-length bands.** An earlier version of this table split "adverse order" into 15 points for delay over 24 months and 8 for 12–24 months, using `schema.json`'s `relief.deadline.from_date` to compute the delay. Dropped: real orders almost always state the delay in prose ("possession was due in 2018, still not handed over") rather than as a clean date field, so `from_date` came back null on all but a handful of the `delay_interest` reliefs extracted so far. Banding on a field that's usually empty would silently misclassify nearly everything into the lowest band instead of flagging it as unknown — the flat 10-point signal is the honest answer until extraction can reliably pull that date out of the prose (a stage 3 problem, not a scoring one, if it's revisited).

**Content, not just points.** The product's point is showing what happened, not counting warrants — points are secondary. So each relief in `scored/order_*.json` also carries descriptive content straight through from `extracted/*.json`, unchanged: who asked (`complainant_names`), what they asked for and got (`relief_type`, `granted`, `amount`), and why (`reasoning`) — plus `project_name`/`project_reg_no` at the order level. `score.py` is the only stage that reads `extracted/*.json`, and stage 5 only reads `scored/*.json`, so if this content weren't copied through here, it would be gone before it ever reached `builders/*.json` and the website. None of it is scored *from* — it just rides along.

A real warrant-based file (`scored/warrant_alibaug_1.json`):

```json
{
  "complaint_no": "CC006000000194778",
  "respondent_name": "Xrbia Builders Limited",
  "project_no": "P52000007138",
  "date_of_dispatch": "2024-06-10",
  "signal": "recovery_warrant",
  "base_points": 30,
  "age_halved": false,
  "final_points": 30
}
```

A real order-based file, trimmed to one relief (`scored/order_755d6dfd....json`):

```json
{
  "order_id": "755d6dfd822efe17c7cea3dca98dcf08aaea4237f1f8efe54320fcdde3c0f07c",
  "respondent_name": "JVPD PROPERTIES PRIVATE LIMITED",
  "order_date": "2025-01-09",
  "project_name": "SERENITY- BLDG 1",
  "project_reg_no": "P51800011181",
  "relief_scores": [
    {
      "complaint_no": "CC006000000193702",
      "complainant_names": ["GAUTAM THAKKAR"],
      "relief_type": "refund_of_consideration",
      "granted": false,
      "amount": null,
      "reasoning": "Complaint is not maintainable as it is premature, given the proposed date of completion is 30.07.2025.",
      "has_warrant": false,
      "signal": null,
      "base_points": 0,
      "age_halved": false,
      "final_points": 0
    }
  ],
  "order_total_points": 30
}
```

One file in, one file out per input row/order — no cross-record math here. Cross-record aggregation (grouping by builder, summing, scoring) happens in stage 5, because it needs everything for a builder at once, and can't happen until name variants are resolved.

---

## Stage 4.5 — Load → `builder_risk.db` (added 2026-09-22)

Added after the report page and a category detail page were once found showing different numbers for the same builder (56 vs 152 buyers won, 162 vs 157 complaints — see conversation). Root cause: buyer counts were computed three separate ways in three places (a relief count here, an order count there, a JS dedupe loop with a scoping bug somewhere else), so they could — and did — disagree.

`scripts/load_db.py` loads `scored/*.json` (stage 4's output) into a SQLite database (`builder_risk.db`, rebuilt fresh on every run — a derived artifact, never hand-edited) with four tables: `builders`, `warrants`, `orders`, `complaints`. `complaints` is the key design decision: **one row per relief, not one row per buyer** — `complaint_no` (the buyer/case id) is deliberately repeated across rows, so "how many buyers" is always `COUNT(DISTINCT complaint_no)`, never `COUNT(*)`. See `queries/schema.sql` for the full column list and why.

Builder-identity resolution (which raw name belongs to which tracked builder) is *not* reimplemented in `load_db.py` — it imports `build.py`'s own `normalize()`/`build_matcher()`/`CLEAN_BUILDERS`/`EXTRA_SCORED_BUILDERS`, so a name resolves to the same `builder_id` in the database as it does in the JSON output.

Three named queries in `queries/*.sql` (`buyers_won_per_builder.sql`, `warrants_per_builder.sql`, `complaints_per_category.sql`) do every count the website shows. `scripts/build.py` runs them once per builder and bakes the results straight into `builders/{id}.json` (`total_buyers`, `buyers_won`, `warranted_buyers`, `buyers_won_no_warrant`, `adverse_no_warrant_relief_count`, `warrant_count` and its recent/older split, and a new `categories: [{id, label, buyers, buyers_won, warranted_buyers, project_count}]` array). `build.py` still walks `scored/*.json` itself for the narrative content (`orders[]`, `projects[]` — dates, reasoning, PDF ids) since that's presentation, not counting.

The website changed to match: `lib/categories.js`'s `summarizeCategories` and `lib/categoryGrouping.js`'s `categoryFacts`/`builderBuyerStats` now read `builder.categories`/`builder.total_buyers`/etc. directly instead of recomputing from `builder.orders`. The report page's category bars, the category-switch tabs, and a category page's header are now reading one shared, precomputed number — not three independent calculations that need to happen to agree. `website/scripts/check-consistency.mjs` still runs at build time, but now does something more useful than comparing two functions that trivially read the same field: it independently recounts buyers from the raw `orders`/`reliefs` JSON (the same data still embedded for narrative display) and asserts it matches what the SQL query baked in — the one place a second, deliberately separate count still exists, specifically to catch the SQL pipeline and the raw data drifting apart.

Narrative grouping (which rulings look the same, what a denial's reasoning says, PDF links) stays in JavaScript, unmoved — `lib/categoryGrouping.js`'s `buildCases`/`groupCategoryCases`/`summarizeRuling` still operate on the raw relief data for the category detail page's per-ruling display. That's presentation, not counting, and was never the source of the bug.

---

## Stage 5 — Build → `builders/{builder_id}.json`

Built in `scripts/build.py`. Groups every `scored/*.json` record by resolved builder identity and writes one `builders/{builder_id}.json` per builder — the only thing the website reads at runtime.

**Canonical builder list:** `raw/top_respondents.json`'s top 20 rows (this product ships exactly 20 builder pages — see `project-context.md`). Any scored record whose respondent name doesn't resolve to one of those 20 is out of scope and left out, not an error — the script prints the unmatched names ranked by how many scored records reference them, so a human can spot-check whether any deserve a `MANUAL_ALIASES` entry.

**Name-variant merging.** MahaRERA's data has no stable builder ID — the same real entity shows up under differently-cased, differently-punctuated, differently-abbreviated strings in both `raw/warrants.json` and `extracted/*.json`'s LLM-read promoter names. Two mechanisms, in order:

1. `normalize()` — lowercase, drop periods/commas, unify pvt/private and ltd/limited, strip a leading "M/s" honorific — then match exactly against a normalized canonical name. Catches the bulk of it: "JVPD PROPERTIES PRIVATE LIMITED", "JVPD Properties Pvt. Ltd." and "JVPD Properties Pvt Ltd" all normalize to the same string. This step alone also caught something worth knowing: two of `top_respondents.json`'s own top-20 rows ("JVPD Properties Pvt Ltd" and "JVPD Properties Pvt. Ltd.") normalize to the same builder — they were never actually 20 distinct entities, which is why the dataset has 19 builders, not 20.
2. `MANUAL_ALIASES` — an explicit, human-curated table for anything `normalize()` can't safely resolve: typos ("Vidhi Relators" for "Vidhi Realtors"), spacing variants ("D. S. Kulkarni Developers Limited" for "D.S Kulkarni Developers Limited"), condensed forms ("N. K. Bhupeshbabu" for "N.K.Bhupesh Babu"). Deliberately **not** fuzzy/edit-distance matching: two real top-20 entries differ by exactly one word ("Nirmal Lifestyle Ltd" vs "Nirmal Lifestyle Kalyan Pvt Ltd"), and most canonical names are just one distinctive word plus a generic noun ("Nirmal Developers", "Vidhi Realtors", "Shadow Builders") — a "matches all but one word" fuzzy rule was tried here and immediately matched hundreds of unrelated companies to "Nirmal Developers" on the strength of the word "Developers" alone. A wrong auto-merge silently attributes one builder's bad record to a different one, which is worse than leaving a name unmatched — so every alias is a human decision, made after looking at the raw name, never a guess.

**Scoring.** `score` is 0-10, one decimal — the only number the website shows as "the score." It's derived, per builder, from:

- `raw_points` = `warrant_points` + `order_points` (the sum of every `final_points` from stage 4's warrant and order files that resolved to this builder). This is the main driver — total harm, not concentration.
- `project_count` = the number of distinct `project_no`'s seen on this builder's *warrant* rows. A real count, just of the wrong, smaller population — it answers "how many projects does this builder have warrants on," not "how many projects does this builder have" (order records don't carry `project_no`, so they can't widen this count either). It's a small log-scaled bonus, not a divisor: `adjusted_points = raw_points × (1 + 0.08 × ln(project_count))`. Dividing by project count was tried first and got the ranking backwards — a builder with warrants spread over 18 projects scored *lower* than one with fewer warrants on a single project, because "total harm" was being read as "concentration." `ln(1) = 0`, so the common single-project builder gets no bonus at all.
- `score = round(10 × (1 − e^(−adjusted_points / 600)), 1)` — a saturating curve instead of a hard cap, so scores spread out instead of clustering at the top. The constant 600 was picked by hand against the actual 19-builder dataset so the single most extreme outlier (JVPD, 127 warrants) lands at ~9.7/10 and most builders land in 3-8, leaving room above for something worse than anything seen yet.

`raw_points` is kept in the output too, unrounded and uncapped, alongside `warrant_points`/`order_points` as its two components.

A real builder file, trimmed to one project and one order (`builders/vidhi-realtors.json`):

```json
{
  "builder_id": "vidhi-realtors",
  "builder_name": "Vidhi Realtors",
  "name_variants": ["VIDHI REALTORS", "Vidhi Realtors", "Vidhi Relators"],
  "score": 5.4,
  "raw_points": 460.0,
  "project_count": 1,
  "warrant_count": 27,
  "warrant_points": 450.0,
  "order_count": 4,
  "relief_count": 5,
  "order_points": 10.0,
  "signal_counts": {
    "recovery_warrant": 27,
    "adverse_order_no_warrant": 2,
    "covered_by_warrant": 2,
    "denied": 1
  },
  "projects": [{ "project_no": "P51800007949", "warrant_count": 27 }],
  "orders": [
    {
      "order_id": "0051555ab80becbc083b88b79040f7b894a4110d83cbd412f3b89c006a267078",
      "order_date": "2019-01-17",
      "project_name": "Gaurav Discovery",
      "project_reg_no": "P51800007949",
      "order_total_points": 10.0,
      "reliefs": [
        {
          "complaint_no": "CC006000000056781",
          "complainant_names": ["MRS ANUJA GUPTA", "MRS SEJAL A. PODAR"],
          "relief_type": "delay_interest",
          "granted": true,
          "amount": { "value": null, "type": "compensation", "recipient": "buyer", "interest_rate_description": "9% p.a." },
          "reasoning": "Complaint settled amicably via consent terms; however, non-compliance with these terms, which included delayed possession interest, led to subsequent enforcement actions.",
          "has_warrant": false,
          "signal": "adverse_order_no_warrant",
          "base_points": 10,
          "age_halved": true,
          "final_points": 5.0
        }
      ]
    }
  ],
  "last_built": "2026-09-19"
}
```

This file is self-contained: the website's search screen, report screen, and category-detail screen each read only from this one JSON per builder (plus `builders/index.json`, a small manifest of name/score/order-count the website's own sync step derives from these files for the search screen — see `website/scripts/sync-builders.mjs`). No stage 1-4 data is fetched at runtime.

**Not built yet, deliberately:**
- No `adverse`/`clean`/`no_record` three-state field. The website currently infers a two-way state client-side, purely from whether `raw_points > 0` — every one of the current 19 builders is `adverse` by that test, because the builder list is `top_respondents.json`'s top 20 *by warrant count*, so by construction none of them could come back clean. A real `no_record` state needs each builder's *total* registered-project count (every project ever registered, not just ones with a warrant), which none of the scraped lists provide — a fifth data source, not scoped yet.
- The top-level `projects` list is still warrant-rows-only (`project_no` + `warrant_count`). Each order in `orders` carries its own `project_name`/`project_reg_no` (passed through from `extracted/*.json` by `score.py`), but those aren't reconciled into `projects` — the same `project_reg_no` can appear in both places without this script merging them into one entry.

---

## Why this shape

- **File boundary = trust boundary.** Everything before `builders/*.json` can be messy, re-run, or wrong without touching the live site. Only stage 5's output is "published."
- **AI is contained to one stage.** Extraction is the only place an LLM touches the data. Scoring and aggregation are deterministic, so a re-run never silently changes a builder's number.
- **Per-order granularity survives to the top.** The `orders` array in the final builder file keeps individual outcomes — and now full relief-level content — visible instead of collapsing straight to a score, matching the product decision to show *why*, not just a number.

---

**Open gap, flagging rather than deciding:** the `no_record` state needs "total projects for this builder" and "years of history," but none of the scraped lists give a builder's *full* project count — only `raw/warrants.json` exists, and it only lists projects with a warrant. Confirming a builder has "fewer than 3 projects" needs a fifth source: the full registered-project directory per builder. Not scoped here. Related: the current 19-builder dataset can't demonstrate a `clean` builder even once this is built, since it was selected by warrant count — showing what "clean" looks like needs deliberately adding some builders with no adverse record, not just refining the rule.
