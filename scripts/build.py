"""
Build per-builder JSON files for the website (stage 5 -- see
ARCHITECTURE.md). Plain Python: groups every scored/*.json record by
builder identity and writes one builders/{builder_id}.json per builder --
the only thing the website reads at runtime.

Canonical builder list: raw/top_respondents.json's top 20 rows (this
product ships exactly 20 builder pages -- see project-context.md). Any
scored record whose respondent name doesn't resolve to one of those 20 is
out of this product's scope and left out, not an error.

Name-variant merging: MahaRERA's data has no stable builder ID. The same
real entity shows up under differently-cased, differently-punctuated,
differently-abbreviated strings in both raw/warrants.json (registry text)
and extracted/*.json's LLM-read promoter names (which flow into
scored/order_*.json). Two mechanisms, in order:

  1. normalize() -- lowercase, drop periods/commas, unify pvt/private and
     ltd/limited, strip a leading "M/s" honorific -- then match exactly
     against a normalized canonical name. Catches the bulk of it: e.g.
     "JVPD PROPERTIES PRIVATE LIMITED", "JVPD Properties Pvt. Ltd." and
     "JVPD Properties Pvt Ltd" all normalize to the same string. This step
     alone also caught something worth knowing: two of top_respondents.json's
     own top-20 rows ("JVPD Properties Pvt Ltd" and "JVPD Properties Pvt.
     Ltd.") normalize to the same builder -- they were never actually 20
     distinct entities, see the run's printed summary.
  2. MANUAL_ALIASES below -- an explicit, human-curated table for anything
     normalize() can't safely resolve: typos ("Vidhi Relators" for "Vidhi
     Realtors"), truncated names ("M/s. Om Sai Group" for "Om Sai Infra &
     Om Sai Group"), shortened forms ("Nirmal Lifestyle Kalyan" without
     "Pvt Ltd"). Deliberately NOT fuzzy/edit-distance matching: two real
     top-20 entries differ by exactly one word ("Nirmal Lifestyle Ltd" vs
     "Nirmal Lifestyle Kalyan Pvt Ltd"), and most canonical names are just
     one distinctive word plus a generic noun ("Nirmal Developers", "Vidhi
     Realtors", "Shadow Builders") -- a "matches all but one word" fuzzy
     rule was tried here and immediately matched hundreds of unrelated
     companies to "Nirmal Developers" on the strength of the word
     "Developers" alone. A wrong auto-merge silently attributes one
     builder's bad record to a different one, which is worse than leaving a
     name unmatched -- so every alias here is a human decision, made after
     looking at the raw name, never a guess. The script instead prints the
     unmatched names ranked by how many scored records reference them, so a
     human can see which ones are worth the five minutes to check.

Scoring: the display-facing `score` is 0-10, one decimal. raw_points
(warrant_points + order_points) is the main driver; project_count is a
small log-scaled bonus, not a divisor -- dividing by project count was
tried first and got the ranking backwards (a builder with warrants spread
over 18 projects scored *lower* than one with fewer warrants on a single
project, because "total harm" was being read as "concentration"). The
whole thing runs through a saturating curve rather than a hard cap, so
scores actually spread out instead of clustering at the top -- see the
comment above the calculation below for the exact formula and why those
constants. raw_points itself is kept in the output too, unnormalized,
unrounded, uncapped.

Counting (stage 4.5, added after report and category pages were once found
to show different numbers for the same builder -- see conversation): every
COUNT in this file -- buyers won, warrants per builder, buyers per
category -- comes from a SQL query in queries/*.sql, run against
builder_risk.db (scripts/load_db.py, rebuilt fresh on every run from
scored/*.json). This script still does its own pass over scored/*.json
below, but only to assemble the narrative content the website displays
(order dates, reasoning text, PDF ids, per-project warrant lists) -- never
to count anything. See queries/schema.sql for why that split matters: a
buyer count computed two different ways, once here and once in the
browser, is exactly how the original bug happened.

Deliberately not done here (still open, see ARCHITECTURE.md):
  - No adverse/clean/no_record state -- that needs each builder's *total*
    registered-project count (every project they've ever registered, not
    just the ones with a warrant against them), which none of the scraped
    lists provide yet. `project_count` above is a real count, just of the
    wrong, smaller population -- it answers "how many projects does this
    builder have warrants on," not "how many projects does this builder
    have," so it's fine as a size-normalizer but not as evidence for a
    "too new/small to say anything" state.
  - The top-level `projects` list is still warrant-rows-only (project_no +
    warrant_count). Each order in `orders` now carries its own project_name
    /project_reg_no (score.py passes it through from extracted/*.json), but
    those aren't merged into `projects` -- a project can appear in both
    lists under the same project_reg_no without this script reconciling
    them into one entry.

Usage:
    python scripts/build.py
"""

from __future__ import annotations

import json
import math
import re
import sqlite3
from collections import defaultdict
from datetime import date
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCORED_DIR = ROOT / "scored"
TOP_RESPONDENTS_PATH = ROOT / "raw" / "top_respondents.json"
BUILDERS_DIR = ROOT / "builders"
QUERIES_DIR = ROOT / "queries"
DB_PATH = ROOT / "builder_risk.db"
TOP_N = 20  # this product ships exactly 20 builder pages

# Score curve constants -- tuned by hand against the actual 19-builder
# dataset (see conversation), not derived from a formula. PROJECT_COUNT_LOG_WEIGHT
# is deliberately small: log(1)=0, so the common single-project builder gets
# no bonus at all, and it grows slowly from there. SCORE_SCALE=600 was picked
# so the single most extreme outlier (JVPD, 127 warrants) lands at ~9.7/10
# and most builders land in 3-8, leaving 10 for something even worse than
# anything seen yet.
PROJECT_COUNT_LOG_WEIGHT = 0.08
SCORE_SCALE = 600

# Raw respondent name (exactly as it appears in a scored/*.json file) ->
# canonical top-20 respondent_name. Add an entry here when the "possible
# alias" hints printed at the end of a run confirm a real variant -- never
# add one you haven't checked by eye.
MANUAL_ALIASES: dict[str, str] = {
    "Vidhi Relators": "Vidhi Realtors",
    "D. S. Kulkarni Developers Limited": "D.S Kulkarni Developers Limited",
    "N. K. Bhupeshbabu": "N.K.Bhupesh Babu",
    "M/S SHADOW BUILDERS AND DEVELOPERS PVT LTD": "Shadow Builders",
}

# Builders with a page even though they didn't rank in top_respondents.json's
# top TOP_N by warrant count. Two different reasons a builder ends up here,
# handled differently below:
#
#   CLEAN_BUILDERS -- well-known builders checked by hand against
#   raw/warrants.json and confirmed to have zero warrant rows under their
#   legal name (see conversation, 2026-09-22). Always written with score 0
#   and empty records -- there's nothing in scored/ to sum for them, so they
#   skip the matching loop below entirely. Maps the legal name used on
#   MahaRERA to the brand name(s) people actually search for.
#
#   EXTRA_SCORED_BUILDERS -- the opposite case: real signal already exists
#   in scored/*.json, the builder just isn't in top_respondents.json's top
#   TOP_N by warrant count. Added to the normal canonical-name universe so
#   the matching loop below picks up its existing scored records and scores
#   it the same way as any top-20 builder -- not hardcoded to 0.
CLEAN_BUILDERS: dict[str, list[str]] = {
    "Hiranandani Constructions Pvt Ltd": ["Hiranandani", "House of Hiranandani"],
    "Oberoi Realty Limited": ["Oberoi Realty", "Oberoi Constructions"],
    "Kalpataru Limited": ["Kalpataru", "Kalpataru Group"],
    "Keystone Realtors Limited": ["Rustomjee"],
    "Macrotech Developers Limited": ["Lodha", "Lodha Group"],
    "Piramal Realty Private Limited": ["Piramal Realty"],
}

EXTRA_SCORED_BUILDERS: list[str] = [
    # Has 1 warrant (scored/warrant_mumbai-city_9.json, Rs 1 Cr, Mumbai
    # City) under this exact respondent name -- a related entity to Godrej
    # Properties Limited, not a typo/variant of it. Scored normally through
    # the matching loop below, not marked clean.
    "Godrej Projects Development Pvt. Ltd",
]

SUFFIX_MAP = {"private": "pvt", "limited": "ltd"}
DROP_PREFIXES = {"m/s", "ms", "mr", "mrs"}


def normalize(name: str) -> str:
    s = name.lower()
    s = re.sub(r"[.,]", "", s)
    s = re.sub(r"[^a-z0-9&/ ]", " ", s)
    tokens = s.split()
    while tokens and tokens[0] in DROP_PREFIXES:
        tokens.pop(0)
    tokens = [SUFFIX_MAP.get(t, t) for t in tokens]
    return " ".join(tokens)


def slugify(name: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")


def load_canonical_names() -> list[str]:
    rows = json.loads(TOP_RESPONDENTS_PATH.read_text(encoding="utf-8"))
    return [row["respondent_name"] for row in rows[:TOP_N]]


def build_matcher(canonical_names: list[str]) -> tuple[callable, list[str]]:
    by_normalized: dict[str, str] = {}
    for name in canonical_names:
        by_normalized[normalize(name)] = name  # last one wins on a collision -- see module docstring
    distinct_names = sorted(set(by_normalized.values()))

    def match(raw_name: str) -> str | None:
        if raw_name in MANUAL_ALIASES:
            return MANUAL_ALIASES[raw_name]
        return by_normalized.get(normalize(raw_name))

    return match, distinct_names




def load_query(name: str) -> str:
    return (QUERIES_DIR / f"{name}.sql").read_text(encoding="utf-8")


def main() -> None:
    BUILDERS_DIR.mkdir(exist_ok=True)

    # Stage 4.5: (re)build builder_risk.db from scored/*.json and reuse its
    # match()/distinct_names -- the loop below still walks scored/*.json
    # itself, but only to assemble narrative content (order dates,
    # reasoning, PDF ids), never to count anything. See load_db.py and
    # queries/schema.sql.
    from load_db import load as load_db_into  # local import: load_db imports from this module

    if DB_PATH.exists():
        DB_PATH.unlink()
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    loaded = load_db_into(conn)
    match, distinct_names = loaded["match"], loaded["distinct_names"]

    canonical_names = load_canonical_names() + EXTRA_SCORED_BUILDERS
    if len(distinct_names) < len(canonical_names):
        print(
            f"Note: top_respondents.json's top {len(canonical_names)} rows normalize to only "
            f"{len(distinct_names)} distinct builders (some rows are the same entity under a "
            f"different string -- see module docstring)."
        )

    builders = {
        name: {"builder_name": name, "name_variants": set(), "warrant_records": [], "order_records": []}
        for name in distinct_names
    }
    unmatched_counts: dict[str, int] = defaultdict(int)

    for path in sorted(SCORED_DIR.glob("warrant_*.json")):
        row = json.loads(path.read_text(encoding="utf-8"))
        canon = match(row["respondent_name"])
        if canon is None:
            unmatched_counts[row["respondent_name"]] += 1
            continue
        b = builders[canon]
        b["name_variants"].add(row["respondent_name"])
        b["warrant_records"].append(row)

    for path in sorted(SCORED_DIR.glob("order_*.json")):
        row = json.loads(path.read_text(encoding="utf-8"))
        canon = match(row["respondent_name"])
        if canon is None:
            unmatched_counts[row["respondent_name"]] += 1
            continue
        b = builders[canon]
        b["name_variants"].add(row["respondent_name"])
        b["order_records"].append(row)

    query_buyers = load_query("buyers_won_per_builder")
    query_warrants = load_query("warrants_per_builder")
    query_categories = load_query("complaints_per_category")

    built = 0
    for name, b in builders.items():
        builder_id = slugify(name)

        # Every count below is a SQL query result (queries/*.sql), keyed by
        # builder_id -- not a Python sum/len over b["warrant_records"] or
        # b["order_records"]. Those two lists still exist above, but only
        # to supply the narrative `orders`/`projects` content further down
        # (dates, reasoning, PDF ids) -- see the module docstring.
        buyer_row = conn.execute(query_buyers, {"builder_id": builder_id}).fetchone()
        warrant_row = conn.execute(query_warrants, {"builder_id": builder_id}).fetchone()
        category_rows = conn.execute(query_categories, {"builder_id": builder_id}).fetchall()

        relief_count = buyer_row["relief_count"] if buyer_row else 0
        total_buyers = buyer_row["total_buyers"] if buyer_row else 0
        buyers_won = buyer_row["buyers_won"] if buyer_row else 0
        warranted_buyers = buyer_row["warranted_buyers"] if buyer_row else 0
        buyers_won_no_warrant = buyer_row["buyers_won_no_warrant"] if buyer_row else 0
        adverse_no_warrant_relief_count = buyer_row["adverse_no_warrant_relief_count"] if buyer_row else 0
        order_points = buyer_row["order_points"] if buyer_row else 0.0

        warrant_count = warrant_row["warrant_count"] if warrant_row else 0
        warrant_points = warrant_row["warrant_points"] if warrant_row else 0.0
        warrants_recent_count = warrant_row["warrants_recent_count"] if warrant_row else 0
        warrants_recent_points = warrant_row["warrants_recent_points"] if warrant_row else 0.0
        warrants_older_count = warrant_row["warrants_older_count"] if warrant_row else 0
        warrants_older_points = warrant_row["warrants_older_points"] if warrant_row else 0.0
        project_count = warrant_row["project_count"] if warrant_row else 0

        categories = [
            {
                "id": row["category_id"],
                "label": row["category_label"],
                "buyers": row["buyers"],
                "buyers_won": row["buyers_won"],
                "warranted_buyers": row["warranted_buyers"],
                "project_count": row["project_count"],
            }
            for row in category_rows
        ]

        project_warrant_counts: dict[str, int] = defaultdict(int)
        for r in b["warrant_records"]:
            project_warrant_counts[r["project_no"]] += 1

        # raw_points is the main driver of `score` -- total harm, not
        # concentration. project_count only adjusts it a little, and only
        # upward: warrants spread across more projects is a broader pattern,
        # not a mitigating one, so this is a small log-scaled bonus rather
        # than the divisor an earlier version of this used (which had the
        # ranking backwards -- see module docstring). project_count is the
        # number of distinct project_no's seen on this builder's warrant
        # rows -- the same known-incomplete count used in `projects` below
        # (order records don't carry project_no), not the builder's true
        # total registered-project count.
        #
        # The result is run through a saturating curve (1 - e^-x) instead of
        # a hard cap, scaled to 0-10 with one decimal, so a builder doesn't
        # have to be anywhere near the worst on record to still be clearly
        # below the ones who are.
        raw_points = warrant_points + order_points
        adjusted_points = raw_points * (1 + PROJECT_COUNT_LOG_WEIGHT * math.log(project_count)) if project_count else raw_points
        score = round(10 * (1 - math.exp(-adjusted_points / SCORE_SCALE)), 1)

        out = {
            "builder_id": builder_id,
            "builder_name": name,
            "name_variants": sorted(b["name_variants"]),
            "score": score,
            "raw_points": raw_points,
            "project_count": project_count,
            "warrant_count": warrant_count,
            "warrant_points": warrant_points,
            "warrants_recent_count": warrants_recent_count,
            "warrants_recent_points": warrants_recent_points,
            "warrants_older_count": warrants_older_count,
            "warrants_older_points": warrants_older_points,
            "order_count": len(b["order_records"]),
            "relief_count": relief_count,
            "order_points": order_points,
            "total_buyers": total_buyers,
            "buyers_won": buyers_won,
            "warranted_buyers": warranted_buyers,
            "buyers_won_no_warrant": buyers_won_no_warrant,
            "adverse_no_warrant_relief_count": adverse_no_warrant_relief_count,
            "categories": categories,
            "projects": [
                {"project_no": project_no, "warrant_count": count}
                for project_no, count in sorted(project_warrant_counts.items())
            ],
            "orders": [
                {
                    "order_id": r["order_id"],
                    "order_date": r["order_date"],
                    "project_name": r["project_name"],
                    "project_reg_no": r["project_reg_no"],
                    "order_total_points": r["order_total_points"],
                    # what happened, not just the score -- see score.py's module
                    # docstring. Carried straight through unchanged.
                    "reliefs": r["relief_scores"],
                }
                for r in b["order_records"]
            ],
            "last_built": date.today().isoformat(),
        }
        (BUILDERS_DIR / f"{out['builder_id']}.json").write_text(json.dumps(out, indent=2), encoding="utf-8")
        built += 1

    for name, extra_variants in CLEAN_BUILDERS.items():
        out = {
            "builder_id": slugify(name),
            "builder_name": name,
            "name_variants": sorted({name, *extra_variants}),
            "score": 0.0,
            "raw_points": 0.0,
            "project_count": 0,
            "warrant_count": 0,
            "warrant_points": 0.0,
            "warrants_recent_count": 0,
            "warrants_recent_points": 0.0,
            "warrants_older_count": 0,
            "warrants_older_points": 0.0,
            "order_count": 0,
            "relief_count": 0,
            "order_points": 0.0,
            "total_buyers": 0,
            "buyers_won": 0,
            "warranted_buyers": 0,
            "buyers_won_no_warrant": 0,
            "adverse_no_warrant_relief_count": 0,
            "categories": [],
            "projects": [],
            "orders": [],
            "last_built": date.today().isoformat(),
        }
        (BUILDERS_DIR / f"{out['builder_id']}.json").write_text(json.dumps(out, indent=2), encoding="utf-8")
        built += 1

    conn.close()

    print(f"Builders written: {built} -> builders/*.json ({len(CLEAN_BUILDERS)} clean, hardcoded score 0)")
    print(
        f"Unmatched respondent names (out of the top-{TOP_N} scope, or a variant needing a "
        f"MANUAL_ALIASES entry): {len(unmatched_counts)} distinct names, {sum(unmatched_counts.values())} records"
    )
    if unmatched_counts:
        print("Top unmatched names by record count -- worth a look, not a claim that they belong to a top-20 builder:")
        for name, count in sorted(unmatched_counts.items(), key=lambda kv: -kv[1])[:15]:
            print(f"  {count:4d}  {name!r}")


if __name__ == "__main__":
    main()
