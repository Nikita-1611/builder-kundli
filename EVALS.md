# Evaluation suite

Three checks against the stage-3 (Gemini) extraction and the shipped site, run 2026-09-23. Read-only throughout — nothing in `extracted/`, `scored/`, `builders/`, or `website/public/` was changed to produce these numbers. Re-run any of them with the commands under each section.

---

## 1. Grounding check

**Script:** `evals/grounding_check.py` (needs `pdfplumber`: `pip install pdfplumber`)
**Full detail:** `evals/grounding_report.txt` (433 ungrounded values, one per line)

For every `extracted/{id}.json`, pulls the plain text out of the matching `orders/{id}.pdf` and checks whether every complaint number, date, and rupee amount the model wrote down actually appears somewhere in that text (as one of several textual spellings — see the script's `date_variants`/`amount_variants`). This is **not** an accuracy check: it can't tell you whether a relief was correctly summarized, only whether the concrete, checkable atoms are traceable to the source document rather than invented.

```
Orders checked: 93 (missing PDF: 3, no text layer: 11)
Orders with a usable text layer (>= 200 chars): 82

  complaint_no     288/502  grounded (57.4%)
  date             103/261  grounded (39.5%)
  amount           295/356  grounded (82.9%)
```

**Read this carefully before trusting the percentages above.** Three things pull them down that are not extraction errors:

1. **11 PDFs have no usable text layer at all** (under 200 extracted characters — scanned images with no embedded text, would need OCR this checker doesn't do). These are excluded from the percentages above, not counted as failures, and listed separately in the report.
2. **Heavy OCR corruption in several of the remaining 82.** Spot-checked directly: one PDF's own printed date "15th June 2023" extracts as `"Date: l.5th ]une 2023."` — lowercase `l` for `1`, `]` for `J`. Another shows `"ir lflt.r,i'",] ll 'fulv 20ll"` where a year and month clearly once were. A literal substring match against a clean ISO date has no chance against text like that, independent of whether the model read the PDF correctly.
3. **The matcher only tries specific spellings** (documented in the script). A date or amount phrased in a form not generated there shows as ungrounded even if a human would recognize it as correct.

So this run is a **lower bound**, not a verdict. The honest way to use it: `evals/grounding_report.txt` is a prioritized worklist of exactly which (order, field, value) triples to spot-check — most will turn out to be OCR noise on a real value, but some might not be, and the only way to tell them apart is opening the PDF. That's what part 2 is for.

**What's worth actually checking:** `complaint_no` is a fixed alphanumeric code (`CC006000000141110`) with no reformatting to account for — its ungrounded cases are the most likely to be genuine (either a real extraction slip, or the same OCR corruption problem hitting a digit string). Its 57.4% is the number I'd start with if I only had time to check one thing.

---

## 2. Human review sample

**Script:** `evals/sample_for_human_review.py`
**Output:** `evals/human_review_sample.csv` (15 rows, empty `human_correct_yn` / `human_notes` columns to fill in)

One row per order — the AI's category, relief type, granted/denied, amount, and a short reasoning paraphrase — spread across **15 distinct builders** (not 15 distinct spellings of fewer builders; see finding below), deterministically selected so a rerun reproduces the same sample. Open each `pdf_file` path alongside the row and mark it.

Two things worth knowing about how the sample was built:

- **Builder identity for sampling is resolved by substring match** (`select_extraction_batch.py`'s existing matcher, not a new one), specifically so "Mr. Dipesh/Mukesh Bhagtani, JVPD Properties Pvt Ltd" — a director's name listed ahead of the company — collapses to JVPD instead of inflating the sample with near-duplicate rows. Building this surfaced a real gap, below.
- One order can have many complaints/reliefs (one had 35). Each row shows only the first; `other_reliefs_note` says how many more exist in that same order, so a reviewer isn't misled into thinking that's the whole order.

---

## 3. Site invariants

**Script:** `website/scripts/check-invariants.mjs` — now wired into `npm run build` and `npm run vercel-build`, alongside the existing `check-consistency.mjs`.

Three checks, read-only against `public/builders/*.json` and `public/districts.json`:

1. **Buyers won, amount shows as ₹0.00.** Not a data check (the underlying data shape — many unstated amounts plus one real tiny one — is normal and already handled). It's a *source guard*: confirms at least one builder's data currently exercises that shape, then asserts `ReportScreen.jsx` still contains the fallback that shows "Amount not stated in the orders we read" instead of a bare figure. Removing that fallback later would fail this.
2. **District project counts vs. the builder's total.** No single district's project count may exceed the builder's own `project_count`, and the distinct projects across all of a builder's districts must equal it exactly. (A union, not a sum: the register can list one project under two benches.)
3. **Warrant counts agree everywhere they're shown.** Sum of a builder's warrant count across every district in `districts.json` must equal `builder.warrant_count`.

**Current result: passes.**

The first run failed on `nirmal-lifestyle-ltd` (district project counts summed to 7 vs. a total of 6). The data was correct: project `P51800004719` has warrants in both the Mumbai Suburban and Thane registers, so summing per-district counts counted it twice. Invariant 2 now compares the *distinct* set of projects across districts (`project_nos`, written by `sync-builders.mjs`) against `project_count`, and requires an exact match. Fixed 2026-10-02.

---

## Findings beyond the three checks

Two issues turned up while building this suite that aren't fixed here (out of scope: "don't change any data, just measure"), the second still open.

**1. ~~Name-matcher disagreement~~ — wrong diagnosis, retracted.** This was blamed for the `nirmal-lifestyle-ltd` failure. Checked on 2026-10-02: both scripts match all 13 of that builder's warrants. The real cause was one project appearing in two districts (see section 3).

**2. `score.py`/`build.py` pick "the first respondent listed with role=promoter", and that's sometimes a person, not the company.** Found via the human-review sample: 4 real "Bhagtani Serenity" orders list a director (e.g. "Mr. Dipesh/Mukesh Bhagtani") as `role: "promoter"` *ahead of* "JVPD Properties..." — also `role: "promoter"` — in the same `respondents` array. `score.py`'s and `build.py`'s matching takes whichever is first; for 3 of these 4 orders that's the director, who matches nothing, so those 3 orders silently fall into `build.py`'s unmatched bucket instead of counting toward JVPD's `order_count`/score. Confirmed directly: `build.py`'s own matcher returns `None` for `"Mr. Dipesh/Mukesh Bhagtani"`, `"Dilpesh Bhagtani"`, and `"Diipesh Bhagtani"`. This likely isn't unique to JVPD — any builder whose orders list a director ahead of the company name in `extracted/*.json`'s `respondents` array would lose those orders the same way.

---

## How to re-run everything

```bash
# 1. Grounding check (needs pdfplumber)
pip install pdfplumber
python evals/grounding_check.py                       # summary
python evals/grounding_check.py --json > evals/grounding_report.json   # full machine-readable

# 2. Human review sample
python evals/sample_for_human_review.py                # writes evals/human_review_sample.csv
python evals/sample_for_human_review.py --count 20 --out evals/my_sample.csv

# 3. Site invariants (also runs automatically in npm run build)
cd website
npm run check-invariants
```
