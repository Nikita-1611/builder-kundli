"""
Builds a human-review sample: 15 orders spread across as many distinct
builders as possible, with the AI's outcome/amount/category for each,
plus empty columns for a person to mark correct or wrong against the
source PDF. Read-only -- doesn't touch extracted/ or scored/, just reads
them.

Builder identity is resolved the same way scripts/build.py does (imported
directly, not reimplemented) so "different builders" means different real
entities, not different spellings of the same one -- extracted/*.json has
61 distinct raw respondent strings, but many are the same builder under a
different capitalisation/punctuation (e.g. "JVPD Properties Pvt. Ltd."
and "JVPD Properties Private Limited").

One row per order, keyed on that order's first complaint's first relief --
an order with several complaints/reliefs still gets one row, with a note
on how many more reliefs it has, so a human reviewer opens each PDF once
rather than once per relief.

Usage:
    python evals/sample_for_human_review.py
    python evals/sample_for_human_review.py --count 20 --out evals/my_sample.csv
"""

from __future__ import annotations

import argparse
import csv
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
EXTRACTED_DIR = ROOT / "extracted"
ORDERS_DIR = ROOT / "orders"
DEFAULT_OUT = ROOT / "evals" / "human_review_sample.csv"

sys.path.insert(0, str(ROOT / "scripts"))
from build import normalize  # noqa: E402
from load_db import CATEGORY_MAP  # noqa: E402
from select_extraction_batch import load_builder_names, match_respondent  # noqa: E402


def category_for(relief_type: str) -> str:
    return CATEGORY_MAP.get(relief_type, ("other", "Other"))[1]


def resolve_builder(promoter_name: str, builders: list[dict]) -> str:
    """Tracked builder_id if the raw promoter text matches one, by
    substring -- not exact-normalize -- so "Mr. Dipesh/Mukesh Bhagtani
    JVPD Properties Pvt Ltd" (a director's name prefixed onto the
    company, a real pattern in this data -- see
    select_extraction_batch.py) still resolves to JVPD instead of
    becoming its own one-off bucket and inflating "distinct builders"
    with what's actually the same entity three different ways.
    Falls back to the promoter's own normalized name for genuinely
    untracked respondents, still a stable per-entity grouping key."""
    match = match_respondent(promoter_name, builders)
    if match:
        return match["id"]
    # One more, looser try: strip ALL punctuation/spacing (not just
    # periods/commas) before the substring check. Real gap found building
    # this sample -- "JVPD Properties Pvt.Ltd." (no space before "Ltd.")
    # normalizes to "...pvtltd" as one glued token under both this
    # project's matchers, which then can't match the canonical alias's
    # "...pvt ltd" (with a space). Collapsing punctuation entirely on both
    # sides fixes that specific case. This is deliberately NOT applied to
    # the real pipeline (build.py's own docstring explains why: fuzzy
    # matching on short/generic tokens wrongly merged unrelated
    # companies) -- it's fine here only because a human is about to look
    # at every row anyway, so a wrong dedupe just costs one sample slot,
    # not a builder's public score.
    loose_raw = re.sub(r"[^a-z0-9]", "", promoter_name.lower())
    for builder in builders:
        for alias in builder["normalized_names"]:
            loose_alias = re.sub(r"[^a-z0-9]", "", alias)
            if loose_alias and loose_alias in loose_raw:
                return builder["id"]
    return normalize(promoter_name)


def build_rows() -> list[dict]:
    builders = load_builder_names()

    orders = []
    for path in sorted(EXTRACTED_DIR.glob("*.json")):
        data = json.loads(path.read_text(encoding="utf-8"))
        order_id = data["order_id"]
        if not (ORDERS_DIR / f"{order_id}.pdf").exists():
            continue  # can't ask a human to check a PDF that isn't on disk
        promoter = next((r["name"] for r in data["respondents"] if r["role"] == "promoter"), data["respondents"][0]["name"])

        # score.py/build.py take *this* order's respondents[0]-with-role-
        # promoter as THE respondent name for matching -- which breaks when
        # a person is listed as a second "promoter" entry ahead of the
        # actual company (real case found while building this sample: 4
        # "Bhagtani Serenity" orders list a director as role=promoter
        # alongside "JVPD Properties..." also role=promoter, and whichever
        # extraction happened to list first is what the real pipeline
        # tries to match -- three of the four times that's the person, who
        # matches nothing, so those orders silently fall into build.py's
        # unmatched bucket instead of JVPD's. See EVALS.md's findings
        # section -- not fixed here, this task is measurement only.
        # For sampling diversity we try every listed respondent, not just
        # the first, so this known gap doesn't also fragment the human
        # review sample into near-duplicate "different builders".
        tracked_ids = {b["id"] for b in builders}
        builder_key = None
        for respondent in data["respondents"]:
            key = resolve_builder(respondent["name"], builders)
            if key in tracked_ids:
                builder_key = key
                break
        if builder_key is None:
            builder_key = resolve_builder(promoter, builders)

        complaints = data["primary_order"]["complaints"]
        first_complaint = complaints[0]
        first_relief = first_complaint["reliefs"][0]
        total_reliefs = sum(len(c["reliefs"]) for c in complaints)

        orders.append(
            {
                "builder_key": builder_key,
                "order_id": data["order_id"],
                "pdf_file": f"orders/{data['order_id']}.pdf",
                "builder_name": promoter,
                "order_date": data["primary_order"]["order_date"],
                "complaint_no": first_complaint["complaint_no"],
                "complainant_names": "; ".join(first_complaint["complainant_names"]),
                "category": category_for(first_relief["relief_type"]),
                "relief_type": first_relief["relief_type"],
                "granted": "yes" if first_relief["granted"] else "no",
                "amount_value": first_relief["amount"]["value"] if first_relief["amount"] else "",
                "amount_type": first_relief["amount"]["type"] if first_relief["amount"] else "",
                "reasoning": first_relief["reasoning"],
                "extraction_confidence": data["extraction_confidence"],
                "total_complaints_in_order": len(complaints),
                "total_reliefs_in_order": total_reliefs,
                "other_reliefs_note": (
                    f"+{total_reliefs - 1} more relief(s) in this order, not shown" if total_reliefs > 1 else ""
                ),
            }
        )
    return orders


def sample_diverse(orders: list[dict], count: int) -> list[dict]:
    """Round-robin across distinct builder_key so the sample spreads
    across as many real builders as possible before repeating one --
    deterministic (first-encountered order per builder, in filename
    order), not random, so a rerun reproduces the same sample."""
    by_builder: dict[str, list[dict]] = {}
    for order in orders:
        by_builder.setdefault(order["builder_key"], []).append(order)

    selected: list[dict] = []
    round_index = 0
    builder_keys = sorted(by_builder.keys())
    while len(selected) < count and any(by_builder.values()):
        for key in builder_keys:
            if len(selected) >= count:
                break
            bucket = by_builder[key]
            if round_index < len(bucket):
                selected.append(bucket[round_index])
        round_index += 1
        if round_index > max((len(v) for v in by_builder.values()), default=0):
            break
    return selected


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--count", type=int, default=15)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT)
    args = parser.parse_args()

    orders = build_rows()
    sample = sample_diverse(orders, args.count)

    fieldnames = [
        "order_id",
        "pdf_file",
        "builder_name",
        "order_date",
        "complaint_no",
        "complainant_names",
        "category",
        "relief_type",
        "granted",
        "amount_value",
        "amount_type",
        "reasoning",
        "extraction_confidence",
        "other_reliefs_note",
        "human_correct_yn",
        "human_notes",
    ]
    with open(args.out, "w", newline="", encoding="utf-8") as f:
        writer = csv.DictWriter(f, fieldnames=fieldnames, extrasaction="ignore")
        writer.writeheader()
        for row in sample:
            row["human_correct_yn"] = ""
            row["human_notes"] = ""
            writer.writerow(row)

    distinct_builders = len({row["builder_key"] for row in sample})
    print(f"Wrote {len(sample)} rows ({distinct_builders} distinct builders) -> {args.out}")


if __name__ == "__main__":
    main()
