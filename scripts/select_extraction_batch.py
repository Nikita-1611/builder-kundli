"""
Select which collected order PDFs (orders/*.pdf) to extract next, capped at
5 per respondent -- read-only, no API calls. Written to answer "how much
extraction work is actually left" before running extract.py against it.

Why a cap: orders/ already holds 383 downloaded PDFs across ~19 respondents
(order_index.json), wildly uneven per respondent (JVPD alone accounts for
well over half), and only 29 are extracted so far. Extracting everything
would spend the Gemini free tier's daily quota almost entirely on whichever
respondent happens to have the most PDFs. Capping each respondent at 5 keeps
coverage spread across builders instead.

"Newest first": order_index.json (built by collect_orders.py) carries no
order date -- the search results it's built from don't include one. The
only ordering signal available before a PDF is actually read is the order
respondent search results were encountered in (page 0 before page 1, row
before row), which MahaRERA's own listing appears to return newest-first by
default (common for this kind of registry, not independently confirmed
here) -- so that encounter order, preserved by order_index.json's own key
order, is used as the "newest first" proxy. Once extraction reads
`order_date` out of a PDF, a later pass could re-sort by the real date;
this script doesn't do that.

Respondent matching: order_index.json's respondent_name_raw is messy free
text as MahaRERA's own site prints it (e.g. "Mr. Dipesh/Mukesh Bhagtani
JVPD Properties Pvt Ltd" -- a person's name prefixed onto the company).
build.py's exact-normalize matcher (for scoring) would miss most of these,
so this script instead checks whether a known builder's normalized name is
a *substring* of the normalized raw respondent text, which catches prefixed
variants like the one above. This is a looser matcher deliberately scoped
to this selection step -- it does not feed scoring or builders/*.json.

Usage:
    python scripts/select_extraction_batch.py
    python scripts/select_extraction_batch.py --cap 5 --json > batch.json
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ORDER_INDEX_PATH = ROOT / "orders" / "order_index.json"
ORDERS_DIR = ROOT / "orders"
EXTRACTED_DIR = ROOT / "extracted"
BUILDER_INDEX_PATH = ROOT / "website" / "public" / "builders" / "index.json"

DEFAULT_CAP = 5


def normalize(name: str) -> str:
    s = name.lower()
    s = re.sub(r"[.,]", "", s)
    s = re.sub(r"[^a-z0-9&/ ]", " ", s)
    return re.sub(r"\s+", " ", s).strip()


def load_builder_names() -> list[dict]:
    """id + every normalized name/alias, from the already-resolved builder
    index (website/public/builders/index.json) -- reuses stage 5's own
    name-variant resolution instead of re-deriving it."""
    rows = json.loads(BUILDER_INDEX_PATH.read_text(encoding="utf-8"))
    out = []
    for row in rows:
        names = {normalize(row["name"])} | {normalize(a) for a in row.get("aliases", [])}
        out.append({"id": row["id"], "name": row["name"], "normalized_names": names})
    return out


def match_respondent(raw_name: str, builders: list[dict]) -> dict | None:
    norm_raw = normalize(raw_name or "")
    if not norm_raw:
        return None
    # Prefer the longest matching name (avoids a short/generic alias
    # matching inside an unrelated longer string).
    best = None
    for builder in builders:
        for name in builder["normalized_names"]:
            if name and name in norm_raw:
                if best is None or len(name) > len(best[1]):
                    best = (builder, name)
    return best[0] if best else None


def build_selection(cap: int) -> dict:
    order_index: dict[str, list[dict]] = json.loads(ORDER_INDEX_PATH.read_text(encoding="utf-8"))
    builders = load_builder_names()
    existing_pdfs = {p.name for p in ORDERS_DIR.glob("*.pdf")}
    extracted_ids = {p.stem for p in EXTRACTED_DIR.glob("*.json")}

    # pdf_filename -> first-encountered respondent_name_raw, in
    # order_index.json's own key order (see module docstring on "newest
    # first"). One PDF can appear under several complaint_no keys
    # (multi-complainant order) -- keep only its first sighting.
    pdf_first_seen: dict[str, str] = {}
    for occurrences in order_index.values():
        for occ in occurrences:
            filename = occ.get("pdf_filename")
            if filename and filename not in pdf_first_seen:
                pdf_first_seen[filename] = occ.get("respondent_name_raw", "")

    by_builder: dict[str, list[str]] = {}
    unmatched: list[str] = []
    missing_on_disk: list[str] = []

    for filename, raw_name in pdf_first_seen.items():
        if filename not in existing_pdfs:
            missing_on_disk.append(filename)
            continue
        match = match_respondent(raw_name, builders)
        if match is None:
            unmatched.append(filename)
            continue
        by_builder.setdefault(match["id"], []).append(filename)

    result = {}
    for builder_id, filenames in by_builder.items():
        capped = filenames[:cap]
        remaining = [f for f in capped if f.replace(".pdf", "") not in extracted_ids]
        already_done = [f for f in capped if f.replace(".pdf", "") in extracted_ids]
        result[builder_id] = {
            "total_collected": len(filenames),
            "capped_at": len(capped),
            "already_extracted": already_done,
            "remaining": remaining,
        }

    return {
        "per_builder": result,
        "unmatched_pdfs": unmatched,
        "missing_on_disk": missing_on_disk,
    }


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--cap", type=int, default=DEFAULT_CAP)
    parser.add_argument("--json", action="store_true", help="print the full selection as JSON instead of a summary")
    args = parser.parse_args()

    selection = build_selection(args.cap)

    if args.json:
        print(json.dumps(selection, indent=2))
        return

    total_remaining = sum(len(v["remaining"]) for v in selection["per_builder"].values())
    total_capped = sum(v["capped_at"] for v in selection["per_builder"].values())
    total_done = sum(len(v["already_extracted"]) for v in selection["per_builder"].values())

    print(f"Builders with collected PDFs: {len(selection['per_builder'])}")
    print(f"Cap: {args.cap} per builder -> {total_capped} PDFs in scope")
    print(f"Already extracted (within cap): {total_done}")
    print(f"Remaining to extract: {total_remaining}")
    if selection["unmatched_pdfs"]:
        print(f"PDFs that couldn't be matched to a known builder: {len(selection['unmatched_pdfs'])}")
    if selection["missing_on_disk"]:
        print(f"Indexed PDFs missing from orders/: {len(selection['missing_on_disk'])}")
    print()
    for builder_id, info in sorted(selection["per_builder"].items(), key=lambda kv: -len(kv[1]["remaining"])):
        print(
            f"  {builder_id:45s} collected={info['total_collected']:<4d} "
            f"capped={info['capped_at']:<3d} done={len(info['already_extracted']):<3d} "
            f"remaining={len(info['remaining']):<3d}"
        )


if __name__ == "__main__":
    main()
