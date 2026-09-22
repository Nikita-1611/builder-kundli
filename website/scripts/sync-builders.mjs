// Copies ../../builders/*.json (stage 5 output, see ARCHITECTURE.md) into
// public/builders/ so Vite ships them as static files, and writes an
// index.json alongside them -- the one thing the search and landing screens
// need that no single builder file has: the full list of who's in the
// dataset, plus warrant_count so the landing page can count "has a warrant
// but no readable order" builders without fetching all 25 detail files.
//
// Also copies the underlying order PDFs (../../orders/{order_id}.pdf, from
// scripts/collect_orders.py) into public/orders/ -- but only the ones a
// builder file actually references, not the full orders/ directory (~193MB,
// almost all of it respondents outside this product's top-20 scope). MahaRERA
// itself has no direct PDF URL to link to -- collect_orders.py's docstring
// confirms the search UI embeds each order as a base64 blob in the results
// page, no separate download step -- so "link straight to the PDF" means our
// own hosted copy, filename-matched to order_id by content hash, not a
// MahaRERA URL.
//
// Run manually after re-running scripts/build.py:
//   npm run sync-data

import { readdirSync, readFileSync, writeFileSync, copyFileSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SOURCE_DIR = join(__dirname, "..", "..", "builders");
const DEST_DIR = join(__dirname, "..", "public", "builders");
const ORDERS_SOURCE_DIR = join(__dirname, "..", "..", "orders");
const ORDERS_DEST_DIR = join(__dirname, "..", "public", "orders");
const WARRANTS_SOURCE = join(__dirname, "..", "..", "raw", "warrants.json");
const DEST_DISTRICTS = join(__dirname, "..", "public", "districts.json");

rmSync(DEST_DIR, { recursive: true, force: true });
mkdirSync(DEST_DIR, { recursive: true });
rmSync(ORDERS_DEST_DIR, { recursive: true, force: true });
mkdirSync(ORDERS_DEST_DIR, { recursive: true });

const files = readdirSync(SOURCE_DIR).filter((f) => f.endsWith(".json"));

const referencedOrderIds = new Set();

const index = files.map((filename) => {
  const raw = readFileSync(join(SOURCE_DIR, filename), "utf-8");
  writeFileSync(join(DEST_DIR, filename), raw);
  const data = JSON.parse(raw);
  for (const order of data.orders || []) {
    referencedOrderIds.add(order.order_id);
  }
  return {
    id: data.builder_id,
    name: data.builder_name,
    aliases: data.name_variants,
    score: data.score,
    order_count: data.order_count,
    warrant_count: data.warrant_count,
  };
});

index.sort((a, b) => a.name.localeCompare(b.name));
writeFileSync(join(DEST_DIR, "index.json"), JSON.stringify(index, null, 2));

let pdfsCopied = 0;
for (const orderId of referencedOrderIds) {
  const src = join(ORDERS_SOURCE_DIR, `${orderId}.pdf`);
  if (!existsSync(src)) {
    console.warn(`  warning: no PDF on disk for order_id ${orderId} (looked in orders/)`);
    continue;
  }
  copyFileSync(src, join(ORDERS_DEST_DIR, `${orderId}.pdf`));
  pdfsCopied++;
}

console.log(`Copied ${files.length} builder files + index.json -> public/builders/`);
console.log(`Copied ${pdfsCopied}/${referencedOrderIds.size} referenced order PDFs -> public/orders/`);

// Per-district warrant totals + top respondents, for the landing page map.
// Built from raw/warrants.json (stage 1 output, one row per warrant) rather
// than anything district-shaped stage 5 produces, since no later stage
// keeps the district field. Respondent names are matched back to a
// builder_id via the same name_variants used for search, so the map's
// side panel can link to a report where one exists -- most respondents in
// the raw register aren't one of the ~25 builders this product profiled,
// and stay unlinked names.
function normalizeName(name) {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

// MahaRERA's warrant register groups rows by regional bench, not exactly
// by the state's 35 revenue districts this map draws -- "Alibaug" is a
// bench inside Raigad district with no polygon of its own here, and
// Mumbai City/Suburban are one district on this map (see landing page
// instructions). "Ratanagiri" is just the register's spelling of Ratnagiri.
const DISTRICT_ALIASES = {
  alibaug: "Raigad",
  "mumbai city": "Mumbai",
  "mumbai suburban": "Mumbai",
  ratanagiri: "Ratnagiri",
};

function canonicalDistrict(rawDistrict) {
  const key = normalizeName(rawDistrict);
  if (DISTRICT_ALIASES[key]) return DISTRICT_ALIASES[key];
  return rawDistrict.trim().replace(/\b\w/g, (c) => c.toUpperCase());
}

const nameToBuilderId = new Map();
const builderIdToName = new Map();
for (const entry of index) {
  builderIdToName.set(entry.id, entry.name);
  for (const name of [entry.name, ...(entry.aliases || [])]) {
    nameToBuilderId.set(normalizeName(name), entry.id);
  }
}

const warrants = JSON.parse(readFileSync(WARRANTS_SOURCE, "utf-8"));
const districts = new Map();

for (const warrant of warrants) {
  const district = canonicalDistrict(warrant.district);
  if (!districts.has(district)) {
    districts.set(district, { count: 0, amount: 0, respondents: new Map() });
  }
  const entry = districts.get(district);
  entry.count += 1;
  entry.amount += warrant.amount;

  // The register spells the same builder several ways (periods, spacing,
  // case) -- group by builder_id when this respondent matches one of our
  // 25 tracked builders, so their variants don't show up as separate rows
  // in the same district's list. Unmatched respondents fall back to their
  // own normalized name, same as before.
  const matchedId = nameToBuilderId.get(normalizeName(warrant.respondent_name)) || null;
  const key = matchedId || normalizeName(warrant.respondent_name);
  const respondent = entry.respondents.get(key) || {
    name: matchedId ? builderIdToName.get(matchedId) : warrant.respondent_name,
    id: matchedId,
    count: 0,
    amount: 0,
  };
  respondent.count += 1;
  respondent.amount += warrant.amount;
  entry.respondents.set(key, respondent);
}

const districtsOutput = {};
for (const [districtName, entry] of districts) {
  districtsOutput[districtName] = {
    count: entry.count,
    amount: entry.amount,
    // Full respondent list, sorted -- the landing page's district panel
    // shows the top 5 and lets a visitor expand to the rest, so this needs
    // everyone, not just a fixed top N.
    builders: [...entry.respondents.values()]
      .sort((a, b) => b.count - a.count)
      .map(({ name, id, count }) => ({ name, id, count })),
  };
}

writeFileSync(join(DEST_DISTRICTS), JSON.stringify({ districts: districtsOutput }, null, 2));
console.log(`Wrote ${Object.keys(districtsOutput).length} districts -> public/districts.json`);
