"""
Collect MahaRERA final-order PDFs for a set of respondents (stage 2 of the
pipeline — see ARCHITECTURE.md), via the "Orders & Judgements" search at
https://maharera.maharashtra.gov.in/orders-judgements

This is NOT captcha-gated and NOT blocked -- confirmed by hand before writing
this script. It's a plain Drupal POST form:

    order_complaint_type   = rulings_of_MahaRERA | judgements_by_adjudicating_officers | non_registration_rulings
    orders_judgements_type = 59 (Interim Order) | 60 (Final Order) | 0 (Non-Compliance Order)
    order_respondent_name  = free-text, partial match
    order_complaint_number = free-text, exact-ish match
    ruling_judgement_from / ruling_judgement_to = DD-MM-YYYY, both required
    form_build_id / form_id = read once from a fresh GET, reused across requests
    op = "Search"

Each result is a "card" (div.row.shadow...) holding, remarkably, the ENTIRE
order PDF as a base64 blob in the result link's `oj-data` attribute -- there
is no separate PDF download step. Pagination is `?page=N` (0-indexed)
appended to the same POST.

One order PDF is usually returned once PER complainant it covers (an 11-buyer
clubbed order shows up as 11 result cards, all carrying identical oj-data).
So this script searches by RESPONDENT NAME, not by complaint number one at a
time -- far fewer requests, and it means the complaint_no -> pdf mapping is
known from the search results themselves, before any PDF is even opened.
Duplicate PDFs (same order, multiple complainant rows) are deduplicated by
content hash, not by filename.

Usage:
    python scripts/collect_orders.py --respondents-file raw/top_respondents.json --top 10
    python scripts/collect_orders.py --respondents "Sumer Radius Realty,JVPD Properties Pvt Ltd"
"""

from __future__ import annotations

import argparse
import base64
import hashlib
import json
import logging
import re
import sys
import time
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

import requests
from bs4 import BeautifulSoup

# --- constants ---------------------------------------------------------------

BASE_URL = "https://maharera.maharashtra.gov.in/"
SEARCH_PATH = "orders-judgements"
SEARCH_URL = BASE_URL + SEARCH_PATH

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)
REQUEST_TIMEOUT_SECONDS = 30
MAX_RETRIES = 3
RETRY_BACKOFF_SECONDS = 5.0
DEFAULT_RATE_LIMIT_SECONDS = 2.0
RESULTS_PER_PAGE = 10  # observed, not configurable server-side

# Fixed search parameters -- "Final Order" under "Rulings of MahaRERA", per
# project-context.md's own warning: pick Final Order, not Interim.
COMPLAINT_TYPE = "rulings_of_MahaRERA"
JUDGEMENT_TYPE = "60"  # Final Order
DATE_FROM = "01-01-2015"  # wide enough to cover anything MahaRERA has issued
DATE_TO = datetime.now().strftime("%d-%m-%Y")

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_ORDERS_DIR = ROOT / "orders"
DEFAULT_RAW_HTML_DIR = ROOT / "raw_html" / "orders_search"
DEFAULT_INDEX_PATH = ROOT / "orders" / "order_index.json"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("collect_orders")


# --- data shapes ---------------------------------------------------------------

@dataclass
class OrderResult:
    complaint_no: str
    complainant_name: str
    respondent_name_raw: str
    project_reg_no: str | None
    project_name: str | None
    heard_by: str | None
    pdf_sha256: str


@dataclass
class RunStats:
    respondents_searched: int = 0
    total_result_cards: int = 0
    unique_pdfs_saved: int = 0
    unique_pdfs_already_present: int = 0
    respondents_with_zero_results: list[str] = field(default_factory=list)
    parse_failures: int = 0
    reused_complaint_numbers: int = 0


# --- HTTP helpers ---------------------------------------------------------------

def make_session() -> tuple[requests.Session, str]:
    """One session for the whole run; also returns a form_build_id read off
    a fresh page load (Drupal wants the field present, even if -- as tested --
    it doesn't seem to enforce it strictly for this particular form)."""
    session = requests.Session()
    session.headers.update({"User-Agent": USER_AGENT, "Referer": SEARCH_URL})
    resp = session.get(SEARCH_URL, timeout=REQUEST_TIMEOUT_SECONDS)
    resp.raise_for_status()
    match = re.search(r'name="form_build_id" value="([^"]*)"', resp.text)
    form_build_id = match.group(1) if match else ""
    return session, form_build_id


class EmptyShellResponse(Exception):
    """Raised when the server returns Drupal's BigPipe 'no-js' placeholder
    shell instead of real search results -- confirmed by hand to happen
    intermittently (same request, same session, ~1 in 3 attempts) on this
    site, unrelated to anything about the request itself. Treated as a
    retryable failure, same as a network error."""


def search_page(
    session: requests.Session, form_build_id: str, respondent_name: str, page: int
) -> str:
    """POST one page of search results for a respondent-name query."""
    data = {
        "order_complaint_type": COMPLAINT_TYPE,
        "orders_judgements_type": JUDGEMENT_TYPE,
        "order_coram_type": "",
        "order_state": "",
        "order_district": "0",
        "order_project_name": "",
        "order_complaint_number": "",
        "order_agent_registration_no": "",
        "order_complainant_name": "",
        "order_respondent_name": respondent_name,
        "ruling_judgement_from": DATE_FROM,
        "ruling_judgement_to": DATE_TO,
        "form_build_id": form_build_id,
        "form_id": "orders_judgements_form",
        "op": "Search",
    }
    url = f"{SEARCH_URL}?page={page}"

    last_exc: Exception | None = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            resp = session.post(url, data=data, timeout=REQUEST_TIMEOUT_SECONDS)
            resp.raise_for_status()
            if "Showing Final" not in resp.text and "big_pipe/no-js" in resp.text:
                raise EmptyShellResponse(
                    "server returned the BigPipe no-js placeholder instead of results"
                )
            return resp.text
        except (requests.RequestException, EmptyShellResponse) as exc:
            last_exc = exc
            log.warning("  request failed (attempt %d/%d): %s", attempt, MAX_RETRIES, exc)
            if attempt < MAX_RETRIES:
                time.sleep(RETRY_BACKOFF_SECONDS)
    assert last_exc is not None
    raise last_exc


# --- parsing ---------------------------------------------------------------

def parse_result_count(html: str) -> int:
    match = re.search(r"Showing Final\s*<span[^>]*>(\d+)</span>\s*Result", html)
    return int(match.group(1)) if match else 0


def _label_value(block, label_text: str) -> str | None:
    """Find a <label>whose text matches, then take the very next <p> after
    it -- the markup nests labels/values a few divs deep and inconsistently,
    so 'next <p> in document order' is more robust than assuming siblings."""
    label = block.find("label", string=lambda s: s and label_text in s)
    if label is None:
        return None
    p = label.find_next("p")
    return p.get_text(strip=True) if p else None


def parse_result_cards(html: str) -> list[dict]:
    """Each search result is one 'div.row.shadow...' card. Returns raw dicts
    (not yet deduplicated) -- one per complainant, per order."""
    soup = BeautifulSoup(html, "html.parser")
    cards = soup.find_all("div", class_=lambda c: c and "shadow" in c.split())

    rows = []
    for card in cards:
        link = card.find("a", attrs={"oj-data": True})
        if link is None:
            continue  # not a result card (e.g. a stray shadow div elsewhere on the page)

        project_reg_no = None
        p_tag = card.find("p", class_="p-0")
        if p_tag and p_tag.get_text(strip=True).startswith("#"):
            project_reg_no = p_tag.get_text(strip=True).lstrip("#")

        rows.append(
            {
                "complaint_no": _label_value(card, "Complainant No."),
                "complainant_name": _label_value(card, "Complainant Name"),
                "respondent_name_raw": _label_value(card, "Respondent Name"),
                "heard_by": _label_value(card, "Heard By"),
                "project_reg_no": project_reg_no,
                "project_name": link.get("oj-name"),
                "oj_data_b64": link.get("oj-data"),
            }
        )
    return rows


# --- raw HTML snapshots ---------------------------------------------------------

def save_raw_html(raw_dir: Path, respondent: str, page: int, html_text: str) -> None:
    raw_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    slug = re.sub(r"[^a-z0-9]+", "-", respondent.lower()).strip("-")
    path = raw_dir / f"{slug}_p{page}_{stamp}.html"
    path.write_text(html_text, encoding="utf-8")


# --- orchestration ---------------------------------------------------------------

def run(
    respondents: list[str],
    orders_dir: Path,
    raw_dir: Path,
    index_path: Path,
    rate_limit: float,
) -> RunStats:
    session, form_build_id = make_session()
    orders_dir.mkdir(parents=True, exist_ok=True)

    # index: complaint_no -> LIST of occurrences (usually length 1). A list,
    # not a single dict, because complaint numbers turned out not to be a
    # reliable unique key -- the same complaint_no has been observed
    # pointing at two genuinely different PDFs (confirmed by hash) more than
    # once in a real run. Filenames are content hashes, never complaint_no,
    # so two different documents can never overwrite each other on disk no
    # matter what complaint_no either of them claims.
    index: dict[str, list[dict]] = json.loads(index_path.read_text(encoding="utf-8")) if index_path.exists() else {}
    seen_hashes: set[str] = {occ["pdf_sha256"] for occs in index.values() for occ in occs}

    stats = RunStats()

    for respondent in respondents:
        stats.respondents_searched += 1
        log.info("Searching: %r", respondent)

        time.sleep(rate_limit)
        try:
            first_html = search_page(session, form_build_id, respondent, page=0)
        except (requests.RequestException, EmptyShellResponse) as exc:
            log.error("  giving up on %r (page 0) after %d attempts: %s", respondent, MAX_RETRIES, exc)
            stats.respondents_with_zero_results.append(respondent)
            continue
        save_raw_html(raw_dir, respondent, 0, first_html)

        total = parse_result_count(first_html)
        if total == 0:
            log.warning("  0 results for %r", respondent)
            stats.respondents_with_zero_results.append(respondent)
            continue

        pages = (total + RESULTS_PER_PAGE - 1) // RESULTS_PER_PAGE
        log.info("  %d result(s) across %d page(s)", total, pages)

        all_rows = parse_result_cards(first_html)
        for page in range(1, pages):
            time.sleep(rate_limit)
            try:
                html = search_page(session, form_build_id, respondent, page=page)
            except (requests.RequestException, EmptyShellResponse) as exc:
                log.error(
                    "  giving up on %r page %d after %d attempts: %s -- results from this page are missing",
                    respondent, page, MAX_RETRIES, exc,
                )
                continue
            save_raw_html(raw_dir, respondent, page, html)
            all_rows.extend(parse_result_cards(html))

        stats.total_result_cards += len(all_rows)

        for row in all_rows:
            b64 = row.pop("oj_data_b64", None)
            complaint_no = row.get("complaint_no")
            if not b64 or not complaint_no:
                log.warning("  card missing oj-data or complaint number, skipping: %s", row)
                stats.parse_failures += 1
                continue

            try:
                pdf_bytes = base64.b64decode(b64)
            except Exception as exc:  # noqa: BLE001 -- log and move on, don't crash the batch
                log.warning("  base64 decode failed for %s: %s", complaint_no, exc)
                stats.parse_failures += 1
                continue

            sha256 = hashlib.sha256(pdf_bytes).hexdigest()
            row["pdf_sha256"] = sha256
            filename = f"{sha256}.pdf"  # content-addressed -- can never collide with a different document

            if sha256 in seen_hashes:
                stats.unique_pdfs_already_present += 1
            else:
                (orders_dir / filename).write_bytes(pdf_bytes)
                seen_hashes.add(sha256)
                stats.unique_pdfs_saved += 1
                log.info("  saved %s (%s, %d bytes)", filename, row.get("project_name"), len(pdf_bytes))

            row["pdf_filename"] = filename
            existing = index.setdefault(complaint_no, [])
            if sha256 not in {occ["pdf_sha256"] for occ in existing}:
                if existing:
                    log.warning(
                        "  complaint_no %s already points to a different document (%s) -- "
                        "keeping both, not overwriting",
                        complaint_no, ", ".join(o["pdf_filename"] for o in existing),
                    )
                    stats.reused_complaint_numbers += 1
                existing.append(row)

    index_path.parent.mkdir(parents=True, exist_ok=True)
    index_path.write_text(json.dumps(index, indent=2, ensure_ascii=False), encoding="utf-8")

    return stats


def load_top_respondents(path: Path, top_n: int) -> list[str]:
    data = json.loads(path.read_text(encoding="utf-8"))
    return [d["respondent_name"] for d in data[:top_n]]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--respondents", type=str, default=None, help="Comma-separated respondent names to search")
    parser.add_argument("--respondents-file", type=Path, default=None, help="JSON file like raw/top_respondents.json")
    parser.add_argument("--top", type=int, default=10, help="How many to take from --respondents-file, in file order")
    parser.add_argument("--orders-dir", type=Path, default=DEFAULT_ORDERS_DIR)
    parser.add_argument("--raw-dir", type=Path, default=DEFAULT_RAW_HTML_DIR)
    parser.add_argument("--index", type=Path, default=DEFAULT_INDEX_PATH)
    parser.add_argument("--sleep", type=float, default=DEFAULT_RATE_LIMIT_SECONDS)
    args = parser.parse_args()

    if args.respondents:
        respondents = [r.strip() for r in args.respondents.split(",")]
    elif args.respondents_file:
        respondents = load_top_respondents(args.respondents_file, args.top)
    else:
        parser.error("pass --respondents or --respondents-file")
        return

    stats = run(
        respondents=respondents,
        orders_dir=args.orders_dir,
        raw_dir=args.raw_dir,
        index_path=args.index,
        rate_limit=args.sleep,
    )

    log.info("=" * 60)
    log.info("Respondents searched:        %d", stats.respondents_searched)
    log.info("Result cards seen:            %d", stats.total_result_cards)
    log.info("Unique PDFs newly saved:      %d", stats.unique_pdfs_saved)
    log.info("Unique PDFs already present:  %d", stats.unique_pdfs_already_present)
    log.info("Parse failures:                %d", stats.parse_failures)
    log.info("Reused complaint numbers:     %d  (same complaint_no, different document -- see warnings above)", stats.reused_complaint_numbers)
    if stats.respondents_with_zero_results:
        log.warning("Zero results for: %s", ", ".join(stats.respondents_with_zero_results))
    sys.exit(0)


if __name__ == "__main__":
    main()
