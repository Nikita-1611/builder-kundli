"""
Run stage-3 extraction (extract.py's own extract_one) over an explicit list
of PDFs, in the order given -- meant for the capped, per-respondent
selection from select_extraction_batch.py rather than orders/ directly.
Stops cleanly on extract.py's DailyQuotaExceeded (a 429 that looks like the
free tier's per-day cap, not a transient per-minute one) instead of
continuing to the next PDF.

Usage:
    python scripts/select_extraction_batch.py --json > /tmp/batch.json
    python scripts/extract_batch.py --from-selection /tmp/batch.json
"""

from __future__ import annotations

import argparse
import json
import logging
from pathlib import Path

from dotenv import load_dotenv
from google import genai

from extract import DailyQuotaExceeded, EXTRACTED_DIR, MODEL, ORDERS_DIR, extract_one, load_schema

ROOT = Path(__file__).resolve().parent.parent

logging.basicConfig(level=logging.INFO, format="%(asctime)s  %(levelname)-8s %(message)s", datefmt="%H:%M:%S")
log = logging.getLogger("extract_batch")


def load_pdf_list(selection_path: Path) -> list[Path]:
    """Flattens select_extraction_batch.py's --json output (per_builder ->
    remaining filenames) into one ordered PDF path list, builder by
    builder, in the same order that script printed them."""
    selection = json.loads(selection_path.read_text(encoding="utf-8"))
    paths = []
    for builder_id, info in selection["per_builder"].items():
        for filename in info["remaining"]:
            paths.append(ORDERS_DIR / filename)
    return paths


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--from-selection", type=Path, required=True, help="JSON from select_extraction_batch.py --json")
    parser.add_argument("--model", type=str, default=MODEL)
    args = parser.parse_args()

    load_dotenv(ROOT / ".env")
    schema = load_schema()
    EXTRACTED_DIR.mkdir(exist_ok=True)

    pdfs = [p for p in load_pdf_list(args.from_selection) if not (EXTRACTED_DIR / f"{p.stem}.json").exists()]
    log.info("Batch: %d PDFs to extract", len(pdfs))
    if not pdfs:
        log.info("Nothing to do.")
        return

    client = genai.Client()

    ok_count = 0
    low_confidence_count = 0
    failed: list[tuple[str, str]] = []
    stopped_early = False
    processed = 0

    for i, pdf_path in enumerate(pdfs, 1):
        log.info("[%d/%d] extracting %s", i, len(pdfs), pdf_path.name)
        try:
            data, status = extract_one(client, args.model, pdf_path, schema)
        except DailyQuotaExceeded:
            stopped_early = True
            break
        processed += 1

        if data is not None:
            out_path = EXTRACTED_DIR / f"{pdf_path.stem}.json"
            out_path.write_text(json.dumps(data, indent=2), encoding="utf-8")
            if status == "low_confidence":
                low_confidence_count += 1
                log.info("  -> saved, confidence=low")
            else:
                ok_count += 1
                log.info("  -> saved, confidence=%s", data.get("extraction_confidence"))
        else:
            failed.append((pdf_path.name, status))

    remaining_after = pdfs[processed:]

    log.info("=" * 60)
    log.info("Stopped early (daily quota): %s", stopped_early)
    log.info("Processed this run:          %d", processed)
    log.info("Extracted cleanly:            %d", ok_count)
    log.info("Low confidence:                %d", low_confidence_count)
    log.info("Failed (non-quota):            %d", len(failed))
    log.info("Remaining in this batch:      %d", len(remaining_after))
    for name, status in failed:
        log.info("  FAILED  %-70s %s", name, status)


if __name__ == "__main__":
    main()
