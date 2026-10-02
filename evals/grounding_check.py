"""
Grounding check for stage 3 extraction (see ARCHITECTURE.md). Read-only --
never writes to extracted/, orders/, or anything the pipeline produces.

For every extracted/{id}.json, pulls the plain text out of the matching
orders/{id}.pdf (pdfplumber, page by page) and checks that every complaint
number, date, and rupee amount the model claimed is actually present
somewhere in that text. This is NOT an accuracy check -- it can't tell you
whether the model correctly read what a relief was granted for, only
whether the concrete, checkable atoms it wrote down (numbers, dates, case
IDs) actually appear in the source document rather than being invented.
That's a real, if narrow, signal: a hallucinated complaint number or a
transposed amount would show up here as ungrounded.

Matching is substring-based against generated textual variants, not exact
equality, because a PDF states "15th January, 2018" or "Rs.10,00,000/-"
while the JSON stores "2018-01-15" / 1000000 -- see date_variants() and
amount_variants() for exactly which spellings are tried. This is a
deliberate, documented limitation: a date or amount phrased in a form not
generated here will show as ungrounded even if a human would recognise it
as correct. Complaint numbers are checked as a plain substring (they're a
fixed alphanumeric code, e.g. "CC006000000141110" -- no reformatting to
account for).

Usage:
    python evals/grounding_check.py
    python evals/grounding_check.py --json > evals/grounding_report.json
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path

import pdfplumber

ROOT = Path(__file__).resolve().parent.parent
EXTRACTED_DIR = ROOT / "extracted"
ORDERS_DIR = ROOT / "orders"

MONTHS = [
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
]


def ordinal(n: int) -> str:
    if 11 <= n % 100 <= 13:
        suffix = "th"
    else:
        suffix = {1: "st", 2: "nd", 3: "rd"}.get(n % 10, "th")
    return f"{n}{suffix}"


def date_variants(iso: str) -> list[str]:
    """Every textual form of an ISO date (YYYY-MM-DD) commonly seen in a
    MahaRERA order -- numeric with /, -, . separators (zero-padded and
    not), and the written-out day-month-year form with and without an
    ordinal suffix."""
    m = re.match(r"^(\d{4})-(\d{2})-(\d{2})$", iso or "")
    if not m:
        return []
    y, mo, d = m.group(1), int(m.group(2)), int(m.group(3))
    mo_name = MONTHS[mo - 1]
    variants = set()
    for sep in ("/", "-", "."):
        variants.add(f"{d:02d}{sep}{mo:02d}{sep}{y}")
        variants.add(f"{d}{sep}{mo}{sep}{y}")
    variants.add(f"{d} {mo_name} {y}")
    variants.add(f"{d:02d} {mo_name} {y}")
    variants.add(f"{ordinal(d)} {mo_name}, {y}")
    variants.add(f"{ordinal(d)} {mo_name} {y}")
    variants.add(f"{mo_name} {d}, {y}")
    variants.add(f"{mo_name} {d}, {y}".replace(", ", " "))
    return sorted(variants)


def indian_grouped(n: int) -> str:
    """1000000 -> '10,00,000' -- the digit grouping MahaRERA orders use,
    not the western 3-digit grouping."""
    s = str(n)
    if len(s) <= 3:
        return s
    last3, rest = s[-3:], s[:-3]
    parts = []
    while len(rest) > 2:
        parts.insert(0, rest[-2:])
        rest = rest[:-2]
    if rest:
        parts.insert(0, rest)
    return ",".join(parts) + "," + last3


def amount_variants(value: float) -> list[str]:
    """Every rupee-figure spelling worth checking for -- plain digits,
    western and Indian comma grouping, with a trailing '.00' or '/-' the
    way an order often writes a settled figure, and with a Rs./₹ prefix."""
    if value is None:
        return []
    n = int(value) if float(value).is_integer() else value
    plain = str(n)
    western = f"{int(value):,}"
    indian = indian_grouped(int(value))
    bases = {plain, western, indian}
    variants = set()
    for b in bases:
        variants.add(b)
        variants.add(b + ".00")
        variants.add(b + "/-")
        variants.add("Rs." + b)
        variants.add("Rs. " + b)
        variants.add("₹" + b)
    return sorted(variants)


def extract_pdf_text(pdf_path: Path) -> str:
    with pdfplumber.open(pdf_path) as pdf:
        return "\n".join(page.extract_text() or "" for page in pdf.pages)


def collect_checkable_values(data: dict) -> list[tuple[str, str, object]]:
    """Returns (field_type, json_path, value) for every complaint_no, date,
    and non-null amount in one extracted/{id}.json. field_type is one of
    'complaint_no', 'date', 'amount'."""
    out: list[tuple[str, str, object]] = []

    po = data.get("primary_order") or {}
    if po.get("order_date"):
        out.append(("date", "primary_order.order_date", po["order_date"]))

    oc = (data.get("project") or {}).get("oc_status") or {}
    if oc.get("date"):
        out.append(("date", "project.oc_status.date", oc["date"]))

    def walk_deadline(deadline: dict | None, path: str):
        if not deadline:
            return
        if deadline.get("date"):
            out.append(("date", f"{path}.date", deadline["date"]))
        if deadline.get("from_date"):
            out.append(("date", f"{path}.from_date", deadline["from_date"]))
        for i, opt in enumerate(deadline.get("options") or []):
            walk_deadline(opt, f"{path}.options[{i}]")

    def walk_amount(amount: dict | None, path: str):
        if amount and amount.get("value") is not None:
            out.append(("amount", f"{path}.value", amount["value"]))

    for ci, complaint in enumerate(po.get("complaints") or []):
        if complaint.get("complaint_no"):
            out.append(("complaint_no", f"primary_order.complaints[{ci}].complaint_no", complaint["complaint_no"]))
        for ri, relief in enumerate(complaint.get("reliefs") or []):
            base = f"primary_order.complaints[{ci}].reliefs[{ri}]"
            walk_amount(relief.get("amount"), f"{base}.amount")
            walk_deadline(relief.get("deadline"), f"{base}.deadline")

    penalty = po.get("order_level_penalty")
    if penalty:
        walk_amount(penalty.get("amount"), "primary_order.order_level_penalty.amount")
        walk_deadline(penalty.get("deadline"), "primary_order.order_level_penalty.deadline")

    for si, supp in enumerate(data.get("supplementary_proceedings") or []):
        if supp.get("date"):
            out.append(("date", f"supplementary_proceedings[{si}].date", supp["date"]))
        if supp.get("complaint_no"):
            out.append(("complaint_no", f"supplementary_proceedings[{si}].complaint_no", supp["complaint_no"]))

    return out


def is_grounded(field_type: str, value, text: str) -> bool:
    if field_type == "complaint_no":
        return str(value) in text
    if field_type == "date":
        variants = date_variants(str(value))
        return any(v in text for v in variants)
    if field_type == "amount":
        variants = amount_variants(value)
        return any(v in text for v in variants)
    return False


# Below this many extracted characters, pdfplumber essentially found no
# text layer -- almost certainly a scanned image page with no embedded
# text (would need OCR, which this script deliberately doesn't do -- see
# module docstring). Calibrated against this dataset: the degenerate cases
# measured 0/10/13 chars, the smallest genuine one measured 744. Orders
# below this line are reported separately and excluded from the grounded
# percentages -- scoring them as "ungrounded" would blame the model for a
# PDF-rendering gap in this checker, not an extraction error.
NO_TEXT_LAYER_THRESHOLD = 200


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--json", action="store_true", help="print the full machine-readable report instead of a summary")
    args = parser.parse_args()

    files = sorted(EXTRACTED_DIR.glob("*.json"))
    totals: dict[str, int] = {"complaint_no": 0, "date": 0, "amount": 0}
    grounded: dict[str, int] = {"complaint_no": 0, "date": 0, "amount": 0}
    ungrounded: list[dict] = []
    missing_pdfs: list[str] = []
    no_text_layer: list[str] = []
    checked_orders = 0
    usable_orders = 0

    for path in files:
        data = json.loads(path.read_text(encoding="utf-8"))
        order_id = data.get("order_id", path.stem)
        pdf_path = ORDERS_DIR / f"{order_id}.pdf"
        if not pdf_path.exists():
            missing_pdfs.append(order_id)
            continue

        text = extract_pdf_text(pdf_path)
        checked_orders += 1
        if len(text) < NO_TEXT_LAYER_THRESHOLD:
            no_text_layer.append(order_id)
            continue
        usable_orders += 1

        for field_type, json_path, value in collect_checkable_values(data):
            totals[field_type] += 1
            if is_grounded(field_type, value, text):
                grounded[field_type] += 1
            else:
                ungrounded.append(
                    {"order_id": order_id, "field_type": field_type, "json_path": json_path, "value": value}
                )

    report = {
        "orders_checked": checked_orders,
        "orders_usable": usable_orders,
        "orders_no_text_layer": no_text_layer,
        "orders_missing_pdf": missing_pdfs,
        "totals": totals,
        "grounded": grounded,
        "percent_grounded": {
            k: round(100 * grounded[k] / totals[k], 1) if totals[k] else None for k in totals
        },
        "ungrounded": ungrounded,
    }

    if args.json:
        print(json.dumps(report, indent=2, default=str))
        return

    print(f"Orders checked: {checked_orders} (missing PDF: {len(missing_pdfs)}, no text layer: {len(no_text_layer)})")
    print(f"Orders with a usable text layer (>= {NO_TEXT_LAYER_THRESHOLD} chars): {usable_orders}")
    for field_type in ("complaint_no", "date", "amount"):
        t, g = totals[field_type], grounded[field_type]
        pct = report["percent_grounded"][field_type]
        print(f"  {field_type:15s} {g:4d}/{t:<4d} grounded ({pct}%)" if t else f"  {field_type:15s} 0 found")
    if missing_pdfs:
        print(f"Missing PDFs (skipped): {', '.join(missing_pdfs)}")
    if no_text_layer:
        print(f"No text layer, excluded from percentages ({len(no_text_layer)}): {', '.join(no_text_layer)}")
    print(f"\n{len(ungrounded)} ungrounded value(s) among usable orders:")
    for item in ungrounded:
        print(f"  [{item['field_type']:12s}] {item['order_id']}  {item['json_path']} = {item['value']!r}")


if __name__ == "__main__":
    main()
