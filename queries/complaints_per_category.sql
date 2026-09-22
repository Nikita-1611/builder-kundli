-- The single number every buyer-facing category surface reads: the report
-- page's category bars, the category-switch tabs, AND the category detail
-- page's header all get their "N buyers" from this exact query's result
-- (scripts/build.py runs it once per builder and bakes the rows into
-- builder.categories in builders/{id}.json) -- they cannot disagree
-- because there is only one number, computed once, here.
--
-- This is the query that would have caught the original bug: grouping by
-- category_id and counting DISTINCT complaint_no, over every relief
-- regardless of which order_id it came from, is exactly what a per-order
-- JS dedupe loop was failing to do (see queries/schema.sql).
--
-- project_count joins to orders for project_reg_no/project_name -- a
-- buyer whose reliefs in this category span two different projects (rare,
-- but possible with a builder that has multiple registrations) counts
-- both, same as the report page's per-builder project_count counts every
-- distinct project a warrant touches.
SELECT
    c.builder_id,
    c.category_id,
    c.category_label,
    COUNT(DISTINCT c.complaint_no)                                                          AS buyers,
    COUNT(DISTINCT CASE WHEN c.granted = 1 THEN c.complaint_no END)                          AS buyers_won,
    COUNT(DISTINCT CASE WHEN c.granted = 1 AND c.has_warrant = 1 THEN c.complaint_no END)    AS warranted_buyers,
    COUNT(DISTINCT COALESCE(o.project_reg_no, o.project_name, 'unknown-project'))            AS project_count
FROM complaints c
JOIN orders o ON o.order_id = c.order_id
WHERE c.builder_id = :builder_id
GROUP BY c.builder_id, c.category_id, c.category_label
ORDER BY buyers DESC;
