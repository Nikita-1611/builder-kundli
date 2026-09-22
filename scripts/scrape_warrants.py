"""
Scrape MahaRERA's Recovery Warrant list (stage 1 of the pipeline — see ARCHITECTURE.md).

Source page: https://maharera.maharashtra.gov.in/warrant-details

That page renders one static summary table (warrants/projects/amount per district)
plus a clickable map of Maharashtra. Clicking a district does NOT change the URL or
submit a form — it fires a jQuery AJAX GET built by the site's own
themes/maharera/js/general.js (~line 1400):

    var stringDetail = $(this).attr("data-deatil");     // e.g. "Mumbai city"
    var stringcity   = $(this).attr("aria-controls");   // not present in the HTML -> undefined
    var data = stringDetail + "@" + stringcity;          // "Mumbai city@undefined"
    var warrantUrl = baseUrl + "warrant-details/" + JSON.stringify(data);
    $.ajax({ url: warrantUrl, success: fn })             // GET, no body, no auth

Because the district buttons in the markup have no `aria-controls` attribute, the
site's own click handler always sends the literal string "<District>@undefined" —
this isn't a scraper hack, it's what a real click in a real browser sends. Confirmed
directly against the live site: a GET to

    https://maharera.maharashtra.gov.in/warrant-details/%22Mumbai%20city@undefined%22

returns a plain HTML table with all 65 Mumbai-city rows in one response (matches the
site's own summary count) — no auth, no CSRF token, no session cookie, no pagination.

So this script never needs a browser: it re-issues the same GET the map would.

Usage:
    python scripts/scrape_warrants.py
    python scripts/scrape_warrants.py --districts "Pune,Thane"   # just a couple, for a quick test
    python scripts/scrape_warrants.py --sleep 3.0                # slower, if the site pushes back
"""

from __future__ import annotations

import argparse
import json
import logging
import re
import sys
import time
from dataclasses import dataclass, asdict
from datetime import datetime, timezone
from decimal import Decimal, InvalidOperation
from pathlib import Path
from urllib.parse import quote

import requests
from bs4 import BeautifulSoup

# --- constants -----------------------------------------------------------

BASE_URL = "https://maharera.maharashtra.gov.in/"
LISTING_PATH = "warrant-details"
LISTING_URL = BASE_URL + LISTING_PATH

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"
)
REQUEST_TIMEOUT_SECONDS = 30
MAX_RETRIES = 3
RETRY_BACKOFF_SECONDS = 5.0
DEFAULT_RATE_LIMIT_SECONDS = 2.0

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_OUT = ROOT / "raw" / "warrants.json"
DEFAULT_RAW_HTML_DIR = ROOT / "raw_html" / "warrants"

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("scrape_warrants")


# --- data shape ------------------------------------------------------------

@dataclass
class WarrantRow:
    """One row of raw/warrants.json. Field names match ARCHITECTURE.md's Stage 1
    shape, plus `district` (needed once rows from 14 districts are combined) and
    `sr_no`/`amount_cr` (kept as scraped, alongside the derived `amount` in rupees,
    so nothing is thrown away between "what the site said" and "what we computed")."""

    district: str
    sr_no: int
    respondent_name: str
    project_no: str
    complaint_no: str
    date_of_dispatch: str  # ISO yyyy-mm-dd
    amount_cr: float       # as published, in crores
    amount: int | None     # rupees, derived from amount_cr; None if unparseable


# --- HTTP helpers ------------------------------------------------------------

def make_session() -> requests.Session:
    session = requests.Session()
    session.headers.update(
        {
            "User-Agent": USER_AGENT,
            "X-Requested-With": "XMLHttpRequest",
            "Referer": LISTING_URL,
        }
    )
    return session


def fetch(session: requests.Session, url: str) -> str:
    """GET with a few retries. Raises on final failure — the caller decides
    whether one district's failure should stop the whole run."""
    last_exc: Exception | None = None
    for attempt in range(1, MAX_RETRIES + 1):
        try:
            resp = session.get(url, timeout=REQUEST_TIMEOUT_SECONDS)
            resp.raise_for_status()
            return resp.text
        except requests.RequestException as exc:
            last_exc = exc
            log.warning("  fetch failed (attempt %d/%d): %s", attempt, MAX_RETRIES, exc)
            if attempt < MAX_RETRIES:
                time.sleep(RETRY_BACKOFF_SECONDS)
    assert last_exc is not None
    raise last_exc


def build_district_url(district_label: str) -> str:
    """Reproduce exactly what general.js builds for a district-tab click.

    JSON.stringify("X@undefined") in JS is Python's json.dumps("X@undefined") —
    both wrap the string in double quotes. We then percent-encode everything
    except '@', because that's what actually happens when a browser turns this
    string into a request: quotes and spaces get escaped, '@' is left alone
    (it's a legal character in a URL path segment). This exact encoding was
    verified against the live site, not guessed.
    """
    token = json.dumps(f"{district_label}@undefined")
    return LISTING_URL + "/" + quote(token, safe="@")


# --- parsing -----------------------------------------------------------------

def discover_districts(listing_html: str) -> list[str]:
    """Read the district names straight off the map's tab buttons
    (`data-deatil="..."`), rather than hardcoding the 14 names. If MahaRERA
    adds or renames a district, this picks it up on the next run instead of
    silently missing it."""
    soup = BeautifulSoup(listing_html, "html.parser")
    districts = []
    seen = set()
    for button in soup.select("button[data-deatil]"):
        name = button["data-deatil"].strip()
        if name and name not in seen:
            seen.add(name)
            districts.append(name)
    return districts


def normalize_date(raw: str) -> str | None:
    """'22-10-2020' -> '2020-10-22'. Returns None (not a guess) if the format
    doesn't match what every row has shown so far."""
    raw = raw.strip()
    match = re.fullmatch(r"(\d{2})-(\d{2})-(\d{4})", raw)
    if not match:
        return None
    dd, mm, yyyy = match.groups()
    return f"{yyyy}-{mm}-{dd}"


def cr_to_rupees(raw: str) -> tuple[float, int | None]:
    """The site publishes amounts in crores (e.g. '1.36'). Keep that number as
    scraped (amount_cr) and also compute rupees (amount) for anything downstream
    that wants a plain figure. Decimal, not float, for the multiplication --
    this is money, and 0.6 * 1e7 in binary float can land on 5999999.999999999."""
    raw = raw.strip()
    try:
        cr = Decimal(raw)
    except InvalidOperation:
        return (float("nan"), None)
    rupees = int(cr * Decimal("10000000"))
    return (float(cr), rupees)


def parse_district_table(html: str, district_label: str) -> list[WarrantRow]:
    """Parse one district's response table into rows.

    The table always ends with a totals row (blank Sr.No, 'Total' text sitting
    in the Date-of-Dispatch cell, a grand total in the Amount cell) -- skipped
    by requiring the first cell to actually be an integer, not by assuming a
    fixed row count.
    """
    soup = BeautifulSoup(html, "html.parser")
    table = soup.find("table", class_="tableData")
    if table is None:
        log.warning("  no table found in response for %s", district_label)
        return []

    rows: list[WarrantRow] = []
    for tr in table.find_all("tr"):
        cells = [td.get_text(strip=True) for td in tr.find_all("td")]
        if len(cells) != 6:
            continue  # header row (th, not td) or a malformed row

        sr_no_raw, respondent_name, project_no, complaint_no, date_raw, amount_raw = cells

        if not sr_no_raw.isdigit():
            continue  # the totals row (and any other non-data row)

        date_iso = normalize_date(date_raw)
        if date_iso is None:
            log.warning(
                "  %s row %s: unrecognized date %r, leaving as-is",
                district_label, sr_no_raw, date_raw,
            )
            date_iso = date_raw

        amount_cr, amount_rupees = cr_to_rupees(amount_raw)
        if amount_rupees is None:
            log.warning(
                "  %s row %s: unparseable amount %r", district_label, sr_no_raw, amount_raw
            )

        rows.append(
            WarrantRow(
                district=district_label,
                sr_no=int(sr_no_raw),
                respondent_name=respondent_name,
                project_no=project_no,
                complaint_no=complaint_no,
                date_of_dispatch=date_iso,
                amount_cr=amount_cr,
                amount=amount_rupees,
            )
        )
    return rows


# --- raw HTML snapshots ------------------------------------------------------

def save_raw_html(raw_dir: Path, label: str, html_text: str) -> Path:
    """Save the untouched response before any parsing happens. If the parser
    is wrong or the site changes its markup, this is what lets you re-parse
    without re-hitting the site."""
    raw_dir.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    slug = re.sub(r"[^a-z0-9]+", "-", label.lower()).strip("-")
    path = raw_dir / f"{slug}_{stamp}.html"
    path.write_text(html_text, encoding="utf-8")
    return path


# --- orchestration ------------------------------------------------------------

def run(out_path: Path, raw_dir: Path, rate_limit: float, only_districts: list[str] | None) -> int:
    session = make_session()

    log.info("Fetching listing page: %s", LISTING_URL)
    listing_html = fetch(session, LISTING_URL)
    save_raw_html(raw_dir, "_listing-page", listing_html)

    districts = discover_districts(listing_html)
    if not districts:
        log.error("Found 0 districts on the listing page — site markup may have changed.")
        return 1
    log.info("Discovered %d districts: %s", len(districts), ", ".join(districts))

    if only_districts:
        wanted = {d.strip() for d in only_districts}
        districts = [d for d in districts if d in wanted]
        missing = wanted - set(districts)
        if missing:
            log.warning("Requested districts not found on the page: %s", ", ".join(missing))

    all_rows: list[WarrantRow] = []
    failed_districts: list[str] = []

    for i, district in enumerate(districts):
        time.sleep(rate_limit)  # rate limit before every district request, including the first

        url = build_district_url(district)
        log.info("[%d/%d] %s -> %s", i + 1, len(districts), district, url)
        try:
            html = fetch(session, url)
        except requests.RequestException as exc:
            log.error("  giving up on %s after %d attempts: %s", district, MAX_RETRIES, exc)
            failed_districts.append(district)
            continue

        save_raw_html(raw_dir, district, html)

        rows = parse_district_table(html, district)
        log.info("  parsed %d rows", len(rows))
        all_rows.extend(rows)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("w", encoding="utf-8") as f:
        json.dump([asdict(r) for r in all_rows], f, indent=2, ensure_ascii=False)

    log.info("Wrote %d rows across %d districts to %s", len(all_rows), len(districts) - len(failed_districts), out_path)

    if failed_districts:
        log.error(
            "%d district(s) failed and are NOT in the output: %s",
            len(failed_districts), ", ".join(failed_districts),
        )
        return 1
    return 0


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", type=Path, default=DEFAULT_OUT, help="Output path for raw/warrants.json")
    parser.add_argument("--raw-dir", type=Path, default=DEFAULT_RAW_HTML_DIR, help="Where to save raw HTML snapshots")
    parser.add_argument("--sleep", type=float, default=DEFAULT_RATE_LIMIT_SECONDS, help="Seconds to wait before each district request (default 2.0 -- don't lower this for a real run)")
    parser.add_argument("--districts", type=str, default=None, help="Comma-separated district names to scrape, e.g. 'Pune,Thane' -- for quick testing, not for the real run")
    args = parser.parse_args()

    only = [d for d in args.districts.split(",")] if args.districts else None
    exit_code = run(out_path=args.out, raw_dir=args.raw_dir, rate_limit=args.sleep, only_districts=only)
    sys.exit(exit_code)


if __name__ == "__main__":
    main()
