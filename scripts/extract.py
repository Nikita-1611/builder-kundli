"""
Extract structured JSON from MahaRERA order PDFs (stage 3 of the pipeline --
see ARCHITECTURE.md). The only AI step: everything before this is a scrape,
everything after is plain code.

For each PDF in orders/, uploads it to the Gemini Files API and sends it to
the model alongside schema.json embedded in the prompt as the extraction
contract. The response is parsed as JSON and validated against schema.json
with the `jsonschema` library -- not Gemini's own response_schema
enforcement, because schema.json's `deadline` definition is self-referential
(`earlier_of` nests other deadlines) and Google's docs warn that "very large
or deeply nested schemas may be rejected" under response_schema. We still set
response_mime_type="application/json" to bias the model toward clean JSON.

With no --pdf given, defaults to the same capped, per-respondent selection
as select_extraction_batch.py/extract_batch.py (5 PDFs per respondent by
default) -- not every PDF in orders/ alphabetically.

Usage:
    python scripts/extract.py --limit 20
    python scripts/extract.py --pdf orders/0051555....pdf
    python scripts/extract.py --limit 20 --overwrite
"""

from __future__ import annotations

import argparse
import json
import logging
import time
from pathlib import Path

import httpx
import jsonschema
from dotenv import load_dotenv
from google import genai
from google.genai import types
from google.genai.errors import ClientError, ServerError

from select_extraction_batch import DEFAULT_CAP, build_selection

ROOT = Path(__file__).resolve().parent.parent
ORDERS_DIR = ROOT / "orders"
EXTRACTED_DIR = ROOT / "extracted"
SCHEMA_PATH = ROOT / "schema.json"

MODEL = "gemini-2.5-flash"  # has a usable free tier; override with --model
MAX_ATTEMPTS = 3  # per PDF, on invalid JSON or schema-validation failure
RATE_LIMIT_SECONDS = 4.0  # fixed gap between requests -- free tier is RPM-capped

# Substrings Gemini's 429 puts in the quotaId/message for a per-DAY limit
# ("GenerateRequestsPerDayPerProjectPerModel-FreeTier" etc.), as opposed to
# a per-minute one -- the latter is exactly what the retry-with-backoff
# below is for; the former won't recover by waiting 30 seconds, so it's
# treated as a hard stop instead of another retry.
DAILY_QUOTA_MARKERS = ("perday", "per day", "daily")


class DailyQuotaExceeded(Exception):
    """Raised out of extract_one (skipping its own retry loop) when a 429
    looks like the free tier's daily cap, not a transient per-minute one."""


def _is_daily_quota_error(exc: "ClientError") -> bool:
    text = f"{getattr(exc, 'details', '')} {getattr(exc, 'message', '')}".lower()
    return any(marker in text for marker in DAILY_QUOTA_MARKERS)

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-8s %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("extract")

PROMPT_TEMPLATE = """You are extracting structured data from a MahaRERA (Maharashtra Real Estate Regulatory Authority) order PDF for a builder-risk pipeline.

Fill exactly this JSON schema. Follow every field description -- they encode real decisions from reading prior orders (e.g. why `value` is nullable, why `reliefs` is a list, why `supplementary_proceedings` is a list not a flag).

SCHEMA:
{schema}

Rules:
- Only the FINAL ORDER section is scored (via `reliefs` / `order_level_penalty`). Everything above it (hearing history, submissions, roznama) belongs only in `reasoning` fields, as short paraphrase -- never verbatim.
- `order_id` must be exactly: {order_id}
- If this PDF contains more than one dated proceeding for the same complaint (e.g. a final order, then a later non-execution application), capture the later one(s) in `supplementary_proceedings` -- do not merge or drop them.
- `extraction_confidence` is `low` only for genuine ambiguity in what the order says. A degraded OCR layer over an otherwise legible scan is `medium`, not `low`.
- Do not guess a numeric amount that the order does not state (e.g. a combined multi-unit figure). Leave `value` null and explain in `extraction_notes`.
- Output ONLY the JSON object. No markdown fences, no commentary before or after.
"""


def load_schema() -> dict:
    return json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))


def extract_json(text: str) -> dict:
    """Pull the JSON object out of a response that should be pure JSON but
    may still be wrapped in a markdown fence."""
    text = text.strip()
    if text.startswith("```"):
        text = text.split("```")[1]
        if text.startswith("json"):
            text = text[4:]
        text = text.strip()
    start = text.find("{")
    end = text.rfind("}")
    if start == -1 or end == -1:
        raise ValueError("no JSON object found in response")
    return json.loads(text[start : end + 1])


def upload_pdf(client: genai.Client, pdf_path: Path):
    """Upload a PDF to the Files API and wait until it's ACTIVE."""
    uploaded = client.files.upload(
        file=str(pdf_path),
        config=types.UploadFileConfig(mime_type="application/pdf"),
    )
    while uploaded.state == "PROCESSING":
        time.sleep(2)
        uploaded = client.files.get(name=uploaded.name)
    if uploaded.state != "ACTIVE":
        raise RuntimeError(f"file upload ended in state {uploaded.state}")
    return uploaded


def extract_one(client: genai.Client, model: str, pdf_path: Path, schema: dict) -> tuple[dict | None, str]:
    """Returns (extracted_json_or_None, status), status is one of
    'ok', 'low_confidence', 'invalid_json', 'schema_invalid', 'api_error'."""
    order_id = pdf_path.stem
    prompt = PROMPT_TEMPLATE.format(schema=json.dumps(schema, indent=2), order_id=order_id)

    uploaded_file = upload_pdf(client, pdf_path)
    try:
        last_error = None
        for attempt in range(1, MAX_ATTEMPTS + 1):
            time.sleep(RATE_LIMIT_SECONDS)
            try:
                response = client.models.generate_content(
                    model=model,
                    contents=[uploaded_file, prompt],
                    config=types.GenerateContentConfig(response_mime_type="application/json"),
                )
            except ClientError as e:
                if e.code == 429 and _is_daily_quota_error(e):
                    log.error("daily quota reached on %s: %s", order_id, e)
                    raise DailyQuotaExceeded(str(e)) from e
                if e.code == 429:
                    wait = 30
                    log.warning("rate limited on %s (attempt %d/%d): waiting %ds", order_id, attempt, MAX_ATTEMPTS, wait)
                    time.sleep(wait)
                else:
                    log.warning("API error on %s (attempt %d/%d): %s", order_id, attempt, MAX_ATTEMPTS, e)
                    time.sleep(5)
                last_error = e
                continue
            except ServerError as e:
                log.warning("server error on %s (attempt %d/%d): %s", order_id, attempt, MAX_ATTEMPTS, e)
                time.sleep(15)
                last_error = e
                continue
            except httpx.HTTPError as e:
                log.warning("network error on %s (attempt %d/%d): %s", order_id, attempt, MAX_ATTEMPTS, e)
                time.sleep(10)
                last_error = e
                continue

            text = response.text or ""
            try:
                data = extract_json(text)
            except (ValueError, json.JSONDecodeError) as e:
                log.warning("invalid JSON from %s (attempt %d/%d): %s", order_id, attempt, MAX_ATTEMPTS, e)
                last_error = e
                continue

            try:
                jsonschema.validate(data, schema)
            except jsonschema.ValidationError as e:
                log.warning("schema validation failed for %s (attempt %d/%d): %s", order_id, attempt, MAX_ATTEMPTS, e.message)
                last_error = e
                continue

            status = "low_confidence" if data.get("extraction_confidence") == "low" else "ok"
            return data, status

        log.error("giving up on %s after %d attempts: %s", order_id, MAX_ATTEMPTS, last_error)
        if isinstance(last_error, (ValueError, json.JSONDecodeError)):
            return None, "invalid_json"
        if isinstance(last_error, jsonschema.ValidationError):
            return None, "schema_invalid"
        return None, "api_error"
    finally:
        try:
            client.files.delete(name=uploaded_file.name)
        except ClientError:
            pass  # best-effort cleanup; free-tier files auto-expire anyway


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--limit", type=int, default=None, help="only process the first N PDFs (by filename)")
    parser.add_argument("--pdf", type=str, default=None, help="process a single PDF by path")
    parser.add_argument("--model", type=str, default=MODEL, help="Gemini model id")
    parser.add_argument("--overwrite", action="store_true", help="re-extract PDFs that already have an extracted/{id}.json")
    parser.add_argument(
        "--cap",
        type=int,
        default=DEFAULT_CAP,
        help="per-respondent cap used to build the default PDF list (see select_extraction_batch.py)",
    )
    args = parser.parse_args()

    load_dotenv(ROOT / ".env")

    schema = load_schema()
    EXTRACTED_DIR.mkdir(exist_ok=True)

    if args.pdf:
        pdfs = [Path(args.pdf)]
    else:
        # Default scope is the same capped, per-respondent selection
        # select_extraction_batch.py/extract_batch.py use -- NOT every PDF in
        # orders/ alphabetically, which would burn the daily quota on
        # whichever respondent happens to have the most collected PDFs (see
        # select_extraction_batch.py's module docstring).
        selection = build_selection(args.cap)
        pdfs = []
        for info in selection["per_builder"].values():
            filenames = info["remaining"] + info["already_extracted"] if args.overwrite else info["remaining"]
            pdfs.extend(ORDERS_DIR / filename for filename in filenames)
        if not args.overwrite:
            pdfs = [p for p in pdfs if not (EXTRACTED_DIR / f"{p.stem}.json").exists()]
        if args.limit:
            pdfs = pdfs[: args.limit]

    if not pdfs:
        log.info("nothing to do (all PDFs already extracted -- use --overwrite to re-run)")
        return

    client = genai.Client()

    ok_count = 0
    low_confidence_count = 0
    failed = []
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

    remaining = pdfs[processed:]

    log.info("=" * 60)
    log.info("Stopped early (daily quota): %s", stopped_early)
    log.info("PDFs processed:        %d", processed)
    log.info("Extracted cleanly:     %d", ok_count)
    log.info("Low confidence:        %d", low_confidence_count)
    log.info("Failed:                %d", len(failed))
    log.info("Remaining:             %d", len(remaining))
    for name, status in failed:
        log.info("  FAILED  %-70s %s", name, status)


if __name__ == "__main__":
    main()
