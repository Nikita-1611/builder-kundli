"""
Load stage 4's scored/*.json (score.py's output) into a SQLite database --
stage 4.5 of the pipeline, between score.py and build.py. See
ARCHITECTURE.md and queries/schema.sql for why this exists: every buyer
count the website shows (buyers won, warrants per builder, buyers per
category) becomes a SQL query against real rows instead of a hand-rolled
dedupe loop repeated -- and drifting -- in Python and JavaScript.

Builder-identity resolution (which raw respondent_name belongs to which
tracked builder) is NOT reimplemented here -- it imports build.py's own
normalize()/build_matcher()/CLEAN_BUILDERS/EXTRA_SCORED_BUILDERS, so a
name resolves to the same builder_id here as it does in build.py. Two
independent matchers would be exactly the kind of drift this stage exists
to eliminate.

Rerun any time scored/ changes -- this database is a derived, disposable
artifact (DROP + CREATE on every run, see queries/schema.sql), never a
source of truth. scripts/build.py calls load() itself; running this file
directly is only useful to inspect the .db by hand (e.g. with the sqlite3
CLI or DB Browser for SQLite).

Usage:
    python scripts/load_db.py
"""

from __future__ import annotations

import json
import sqlite3
from pathlib import Path

from build import (
    CLEAN_BUILDERS,
    EXTRA_SCORED_BUILDERS,
    build_matcher,
    load_canonical_names,
    slugify,
)

ROOT = Path(__file__).resolve().parent.parent
SCORED_DIR = ROOT / "scored"
RAW_WARRANTS_PATH = ROOT / "raw" / "warrants.json"
DB_PATH = ROOT / "builder_risk.db"
SCHEMA_PATH = ROOT / "queries" / "schema.sql"

# Mirrors website/src/lib/categories.js's CATEGORIES table exactly -- kept
# in sync by hand, same convention as website/src/lib/scoreFormula.js
# documents for the score constants it mirrors from build.py. Change one,
# change both.
CATEGORY_MAP: dict[str, tuple[str, str]] = {
    "delay_interest": ("late-possession", "Flat handed over late"),
    "possession_and_completion": ("late-possession", "Flat handed over late"),
    "refund_of_consideration": ("refund", "Money not returned"),
    "compensation": ("compensation", "Ordered to pay buyers"),
    "structural_defect_rectification": ("defects", "Building problems"),
    "agreement_for_sale_execution": ("paperwork", "Paperwork not done"),
    "cost": ("other", "Other"),
    "other": ("other", "Other"),
}


def category_for(relief_type: str) -> tuple[str, str]:
    return CATEGORY_MAP.get(relief_type, ("other", "Other"))


def load(conn: sqlite3.Connection) -> dict:
    """Populates conn's tables from scored/*.json. Returns the same
    match()/distinct_names pair build.py uses, so build.py's caller can
    reuse it for the narrative (non-SQL) parts of the JSON it writes,
    without resolving builder identity a second time."""
    conn.executescript(SCHEMA_PATH.read_text(encoding="utf-8"))

    canonical_names = load_canonical_names() + EXTRA_SCORED_BUILDERS
    match, distinct_names = build_matcher(canonical_names)

    builder_rows = [(slugify(name), name, 0) for name in distinct_names]
    builder_rows += [(slugify(name), name, 1) for name in CLEAN_BUILDERS]
    conn.executemany("INSERT INTO builders (builder_id, builder_name, is_clean) VALUES (?, ?, ?)", builder_rows)

    name_to_id = {name: slugify(name) for name in distinct_names}
    alias_rows: set[tuple[str, str]] = set()
    for name in distinct_names:
        alias_rows.add((name_to_id[name], name))
    for name, extra_variants in CLEAN_BUILDERS.items():
        builder_id = slugify(name)
        for variant in {name, *extra_variants}:
            alias_rows.add((builder_id, variant))

    # score.py's scored/warrant_*.json doesn't carry the rupee amount (it
    # only needs complaint_no/date/signal/points to score) -- pull it back
    # in from raw/warrants.json, keyed the same way score.py named its
    # output files: (slugified district, sr_no).
    raw_warrants = json.loads(RAW_WARRANTS_PATH.read_text(encoding="utf-8"))
    amount_by_key = {(slugify(r["district"]), r["sr_no"]): r["amount"] for r in raw_warrants}

    warrant_rows = []
    for path in sorted(SCORED_DIR.glob("warrant_*.json")):
        row = json.loads(path.read_text(encoding="utf-8"))
        canon = match(row["respondent_name"])
        builder_id = name_to_id.get(canon) if canon else None
        if canon:
            alias_rows.add((builder_id, row["respondent_name"]))
        # score.py's scored/warrant_*.json doesn't repeat district/sr_no
        # inside the file -- only in the filename it wrote them with
        # (warrant_{slugified-district}_{sr_no}.json). The district slug
        # itself only ever contains hyphens (see build.py's slugify), so
        # splitting the stem on "_" is safe.
        _, district_slug, sr_no = path.stem.split("_")
        sr_no = int(sr_no)
        warrant_rows.append(
            (
                path.stem.removeprefix("warrant_"),
                district_slug,
                sr_no,
                row["respondent_name"],
                builder_id,
                row["project_no"],
                row["complaint_no"],
                row["date_of_dispatch"],
                amount_by_key.get((district_slug, sr_no)),
                int(row["age_halved"]),
                row["final_points"],
            )
        )

    order_rows = []
    complaint_rows = []
    for path in sorted(SCORED_DIR.glob("order_*.json")):
        row = json.loads(path.read_text(encoding="utf-8"))
        canon = match(row["respondent_name"])
        builder_id = name_to_id.get(canon) if canon else None
        if canon:
            alias_rows.add((builder_id, row["respondent_name"]))

        order_rows.append(
            (
                row["order_id"],
                row["respondent_name"],
                builder_id,
                row["order_date"],
                row["project_name"],
                row["project_reg_no"],
                int(any(r["age_halved"] for r in row["relief_scores"]) if row["relief_scores"] else False),
                row["order_total_points"],
            )
        )

        for relief in row["relief_scores"]:
            category_id, category_label = category_for(relief["relief_type"])
            complaint_rows.append(
                (
                    relief["complaint_no"],
                    row["order_id"],
                    builder_id,
                    ", ".join(relief["complainant_names"] or []),
                    relief["relief_type"],
                    category_id,
                    category_label,
                    int(relief["granted"]),
                    int(relief["has_warrant"]),
                    (relief.get("amount") or {}).get("value"),
                    relief["final_points"],
                )
            )

    conn.executemany(
        """INSERT INTO warrants
           (warrant_id, district, sr_no, respondent_name, builder_id, project_no,
            complaint_no, date_of_dispatch, amount, age_halved, points)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        warrant_rows,
    )
    conn.executemany(
        """INSERT INTO orders
           (order_id, respondent_name, builder_id, order_date, project_name,
            project_reg_no, age_halved, order_total_points)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)""",
        order_rows,
    )
    conn.executemany(
        """INSERT INTO complaints
           (complaint_no, order_id, builder_id, complainant_names, relief_type,
            category_id, category_label, granted, has_warrant, amount_value, points)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
        complaint_rows,
    )
    conn.executemany(
        "INSERT OR IGNORE INTO builder_aliases (builder_id, alias) VALUES (?, ?)",
        sorted(alias_rows),
    )
    conn.commit()

    return {"match": match, "distinct_names": distinct_names}


def main() -> None:
    if DB_PATH.exists():
        DB_PATH.unlink()
    conn = sqlite3.connect(DB_PATH)
    load(conn)

    warrants = conn.execute("SELECT COUNT(*) FROM warrants").fetchone()[0]
    orders = conn.execute("SELECT COUNT(*) FROM orders").fetchone()[0]
    complaints = conn.execute("SELECT COUNT(*) FROM complaints").fetchone()[0]
    builders = conn.execute("SELECT COUNT(*) FROM builders").fetchone()[0]
    conn.close()

    print(f"Loaded {DB_PATH.name}: {builders} builders, {warrants} warrants, {orders} orders, {complaints} complaints (reliefs)")


if __name__ == "__main__":
    main()
