-- Recovery-warrant counts and points, straight from MahaRERA's warrant
-- list (raw/warrants.json via the `warrants` table) -- a row count, not a
-- buyer count. Feeds the "Didn't pay" outcome box, the headline
-- ("MahaRERA issued N recovery warrants..."), and the recent/older split
-- in "How we calculated this".
--
-- project_count here is warrant-scoped (distinct project_no among this
-- builder's warrant rows) -- the same known-incomplete population
-- build.py's docstring already flags: it answers "how many projects does
-- this builder have a warrant on", not "how many projects has this
-- builder ever registered". Kept as-is, not something this SQLite stage
-- was asked to fix.
SELECT
    builder_id,
    COUNT(*)                                                    AS warrant_count,
    SUM(points)                                                 AS warrant_points,
    COUNT(*) FILTER (WHERE age_halved = 0)                      AS warrants_recent_count,
    COALESCE(SUM(points) FILTER (WHERE age_halved = 0), 0)      AS warrants_recent_points,
    COUNT(*) FILTER (WHERE age_halved = 1)                      AS warrants_older_count,
    COALESCE(SUM(points) FILTER (WHERE age_halved = 1), 0)      AS warrants_older_points,
    COUNT(DISTINCT project_no)                                  AS project_count
FROM warrants
WHERE builder_id = :builder_id
GROUP BY builder_id;
