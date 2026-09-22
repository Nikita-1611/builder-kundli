-- builder_risk.db schema -- stage 4.5 of the pipeline, between score.py
-- (stage 4) and build.py (stage 5). See ARCHITECTURE.md.
--
-- Loaded fresh on every run by scripts/load_db.py from scored/*.json
-- (score.py's output) -- this database is a derived artifact, not a
-- source of truth. Rerun scripts/load_db.py (or scripts/build.py, which
-- calls it) any time scored/ changes; nothing here is hand-edited.
--
-- The central design decision: `complaints` is one row per RELIEF, not one
-- row per buyer. complaint_no (the buyer/case identifier) is deliberately
-- NOT unique in that table -- a buyer can have several reliefs in one
-- order, and the same buyer can appear under more than one order_id (a
-- final order, then a later non-execution application filed as its own
-- PDF). Every "how many buyers" question is therefore
-- COUNT(DISTINCT complaint_no), never COUNT(*) -- see queries/*.sql. This
-- is what makes the report page and the category pages incapable of
-- disagreeing: there's exactly one place a buyer count can come from, and
-- getting it wrong (counting reliefs when you meant buyers) is a visible
-- choice in the SQL, not a silent bug in a hand-rolled JS dedupe loop --
-- see the conversation this schema was built to prevent a repeat of
-- (buildCases's per-order-scoped Map undercounting distinct buyers as 157
-- instead of 61 for one category on one builder).

DROP TABLE IF EXISTS complaints;
DROP TABLE IF EXISTS orders;
DROP TABLE IF EXISTS warrants;
DROP TABLE IF EXISTS builder_aliases;
DROP TABLE IF EXISTS builders;

CREATE TABLE builders (
    builder_id   TEXT PRIMARY KEY,
    builder_name TEXT NOT NULL,
    is_clean     INTEGER NOT NULL DEFAULT 0  -- 1 for the hand-verified zero-record builders (build.py's CLEAN_BUILDERS)
);

CREATE TABLE builder_aliases (
    builder_id TEXT NOT NULL REFERENCES builders(builder_id),
    alias      TEXT NOT NULL,
    PRIMARY KEY (builder_id, alias)
);

-- One row per raw/warrants.json record (MahaRERA's recovery warrant
-- registry). NOT the same population as complaints.has_warrant below --
-- this is every warrant MahaRERA has issued against this builder, however
-- many orders or buyers each one traces back to; has_warrant is a flag on
-- a buyer's relief, cross-referenced against this table's complaint_no
-- during score.py. Related, not interchangeable -- see
-- queries/warrants_per_builder.sql vs queries/buyers_won_per_builder.sql.
CREATE TABLE warrants (
    warrant_id       TEXT PRIMARY KEY,   -- "{district}_{sr_no}", matches scored/warrant_*.json's filename
    district         TEXT NOT NULL,
    sr_no            INTEGER NOT NULL,
    respondent_name  TEXT NOT NULL,      -- raw registry text, before builder-identity resolution
    builder_id       TEXT REFERENCES builders(builder_id),  -- NULL if not matched to a tracked builder
    project_no       TEXT,
    complaint_no     TEXT NOT NULL,
    date_of_dispatch TEXT,               -- ISO date, may be null
    amount           INTEGER,
    age_halved       INTEGER NOT NULL,   -- 1 if >3 years old (score.py's HALF_LIFE_YEARS rule)
    points           REAL NOT NULL       -- score.py's final_points: 30, or 15 if age_halved
);

-- One row per extracted, scored order PDF (score.py's scored/order_*.json,
-- one file per order). A single order can bundle many buyers (a MahaRERA
-- "common order" covering a whole project).
CREATE TABLE orders (
    order_id           TEXT PRIMARY KEY,
    respondent_name    TEXT NOT NULL,    -- the "promoter" name score.py picked out
    builder_id         TEXT REFERENCES builders(builder_id),
    order_date         TEXT,
    project_name       TEXT,
    project_reg_no     TEXT,
    age_halved         INTEGER NOT NULL,
    order_total_points REAL NOT NULL
);

-- One row per relief inside one order -- see the module comment above for
-- why complaint_no is intentionally repeated across rows.
CREATE TABLE complaints (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    complaint_no      TEXT NOT NULL,
    order_id          TEXT NOT NULL REFERENCES orders(order_id),
    builder_id        TEXT REFERENCES builders(builder_id),
    complainant_names TEXT,              -- comma-joined, display only
    relief_type       TEXT NOT NULL,
    category_id       TEXT NOT NULL,     -- plain-language category; see load_db.py's CATEGORY_MAP
    category_label    TEXT NOT NULL,
    granted           INTEGER NOT NULL,  -- 0/1
    has_warrant       INTEGER NOT NULL,  -- 0/1, cross-referenced against warrants.complaint_no by score.py
    amount_value       REAL,             -- nullable
    points            REAL NOT NULL      -- score.py's final_points for this one relief
);

CREATE INDEX idx_warrants_builder ON warrants(builder_id);
CREATE INDEX idx_orders_builder ON orders(builder_id);
CREATE INDEX idx_complaints_builder ON complaints(builder_id);
CREATE INDEX idx_complaints_complaint_no ON complaints(complaint_no);
CREATE INDEX idx_complaints_category ON complaints(builder_id, category_id);
