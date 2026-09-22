"""
Score MahaRERA signals into points (stage 4 of the pipeline -- see
ARCHITECTURE.md). Plain Python, no AI: the same input always produces the
same output, and every point traces back to one line of code below.

Two independent inputs, kept separate -- no merging across a builder's name
variants here, that's stage 5 (build.py, not written yet)'s job:

    raw/warrants.json    one row per recovery warrant already issued
    extracted/*.json     one file per order PDF, LLM-read in stage 3

Points table (given, not derived):
    recovery warrant issued        30
    adverse order, no warrant      10
Anything dated more than 3 years before today is halved.

A complaint scores once. If raw/warrants.json shows a warrant against a
complaint_no, that's the 30-point signal for it and the matching relief(s)
in extracted/ contribute 0 more -- otherwise every granted relief on that
complaint scores the flat 10-point "adverse order" signal. This avoids
double-counting the same underlying dispute as both a warrant and an order.

No delay-length bands (there used to be a 15/24mo and 8/12mo split here).
Dropped because delay length isn't reliably extractable -- see
ARCHITECTURE.md, stage 3: orders almost always state it in prose ("possession
was due in 2018, still not handed over") rather than as a clean field, so
`schema.json`'s `deadline.from_date` is null on all but a handful of the
delay_interest reliefs seen so far. Banding on a field that's usually empty
would silently misclassify almost everything as the lowest band instead of
"unknown" -- flat 10 points is the honest answer until extraction can
actually get the date out.

One output file per input row/order, same granularity as the inputs --
scored/warrant_{district}_{sr_no}.json and scored/order_{order_id}.json.
Cross-record aggregation (grouping by builder, summing) is deliberately not
done here; that needs name-variant resolution, which belongs to stage 5.

The product's point is showing what happened, not counting warrants --
points are secondary. So alongside the scoring fields, each relief in
scored/order_*.json also carries the descriptive content straight through
from extracted/*.json unchanged: who asked (complainant_names), what they
asked for and got (relief_type, granted, amount), and why (reasoning).
score.py is the only place that reads extracted/*.json, and build.py
(stage 5) only reads scored/*.json -- so if this content isn't copied
through here, it's gone before it ever reaches builders/*.json and the
website. Nothing here is scored *from* this content; it rides along.

Usage:
    python scripts/score.py
"""

from __future__ import annotations

import json
import re
from datetime import date, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
WARRANTS_PATH = ROOT / "raw" / "warrants.json"
EXTRACTED_DIR = ROOT / "extracted"
SCORED_DIR = ROOT / "scored"

POINTS_RECOVERY_WARRANT = 30
POINTS_ADVERSE_ORDER_NO_WARRANT = 10
HALF_LIFE_YEARS = 3


def parse_date(iso_str: str | None) -> date | None:
    if not iso_str:
        return None
    try:
        return datetime.strptime(iso_str, "%Y-%m-%d").date()
    except ValueError:
        return None  # e.g. the known "01-01-1970" placeholder, already ISO-ified upstream but still not a real date


def is_older_than_3_years(event_date: date | None, today: date) -> bool:
    if event_date is None:
        return False  # unknown date can't be judged old -- treat as recent rather than guess
    return (today - event_date).days > HALF_LIFE_YEARS * 365


def slugify(text: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")


def score_warrants(warrants: list[dict], today: date) -> int:
    count = 0
    for row in warrants:
        event_date = parse_date(row["date_of_dispatch"])
        halved = is_older_than_3_years(event_date, today)
        final_points = POINTS_RECOVERY_WARRANT / 2 if halved else POINTS_RECOVERY_WARRANT
        out = {
            "complaint_no": row["complaint_no"],
            "respondent_name": row["respondent_name"],
            "project_no": row["project_no"],
            "date_of_dispatch": row["date_of_dispatch"],
            "signal": "recovery_warrant",
            "base_points": POINTS_RECOVERY_WARRANT,
            "age_halved": halved,
            "final_points": final_points,
        }
        filename = f"warrant_{slugify(row['district'])}_{row['sr_no']}.json"
        (SCORED_DIR / filename).write_text(json.dumps(out, indent=2), encoding="utf-8")
        count += 1
    return count


def score_orders(extracted_files: list[Path], warrant_complaint_nos: set[str], today: date) -> tuple[int, int]:
    orders_scored = 0
    reliefs_scored = 0

    for path in extracted_files:
        data = json.loads(path.read_text(encoding="utf-8"))
        order_id = data["order_id"]
        order_date = parse_date(data["primary_order"]["order_date"])
        halved = is_older_than_3_years(order_date, today)

        promoter = next(
            (r["name"] for r in data["respondents"] if r["role"] == "promoter"),
            data["respondents"][0]["name"],
        )

        relief_scores = []
        for complaint in data["primary_order"]["complaints"]:
            cno = complaint["complaint_no"]
            has_warrant = cno in warrant_complaint_nos

            for relief in complaint["reliefs"]:
                signal = None
                base_points = 0

                if not relief["granted"]:
                    signal = None  # a denied relief is not an adverse signal
                elif has_warrant:
                    signal = "covered_by_warrant"  # already scored as a warrant above, don't double-count
                else:
                    signal, base_points = "adverse_order_no_warrant", POINTS_ADVERSE_ORDER_NO_WARRANT

                final_points = base_points / 2 if halved else base_points
                relief_scores.append(
                    {
                        # descriptive content, carried through unchanged from
                        # extracted/*.json -- see module docstring
                        "complaint_no": cno,
                        "complainant_names": complaint["complainant_names"],
                        "relief_type": relief["relief_type"],
                        "granted": relief["granted"],
                        "amount": relief["amount"],
                        "reasoning": relief["reasoning"],
                        # scoring fields
                        "has_warrant": has_warrant,
                        "signal": signal,
                        "base_points": base_points,
                        "age_halved": halved,
                        "final_points": final_points,
                    }
                )
                reliefs_scored += 1

        out = {
            "order_id": order_id,
            "respondent_name": promoter,
            "order_date": data["primary_order"]["order_date"],
            "project_name": data["project"]["project_name"],
            "project_reg_no": data["project"]["project_reg_no"],
            "relief_scores": relief_scores,
            "order_total_points": sum(r["final_points"] for r in relief_scores),
        }
        (SCORED_DIR / f"order_{order_id}.json").write_text(json.dumps(out, indent=2), encoding="utf-8")
        orders_scored += 1

    return orders_scored, reliefs_scored


def main() -> None:
    SCORED_DIR.mkdir(exist_ok=True)
    today = date.today()

    warrants = json.loads(WARRANTS_PATH.read_text(encoding="utf-8"))
    warrant_complaint_nos = {row["complaint_no"] for row in warrants}
    extracted_files = sorted(EXTRACTED_DIR.glob("*.json"))

    warrants_scored = score_warrants(warrants, today)
    orders_scored, reliefs_scored = score_orders(extracted_files, warrant_complaint_nos, today)

    print(f"Warrants scored:  {warrants_scored}  -> scored/warrant_*.json")
    print(f"Orders scored:    {orders_scored}  -> scored/order_*.json  ({reliefs_scored} reliefs)")


if __name__ == "__main__":
    main()
