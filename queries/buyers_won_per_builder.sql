-- Builder-wide buyer counts, across every category combined. Feeds the
-- report page's headline, VerdictCard's "buyers won" fact, and the
-- OutcomeSection "Buyer won X of Y" box -- all three read this one query's
-- result (baked into builders/{id}.json by scripts/build.py), not three
-- separate re-derivations.
--
-- COUNT(DISTINCT complaint_no) throughout: complaints has one row per
-- relief, so COUNT(*) would count reliefs, not buyers -- see
-- queries/schema.sql's note on why that distinction is the whole point of
-- this table.
--
-- buyers_won_no_warrant is the same buyer-unit fix applied to what used to
-- be a relief-count mislabeled as an order-count in the website's copy
-- ("N orders ruled for the buyer, with no recovery warrant issued yet") --
-- see ReportScreen.jsx's verdictSentence. adverse_no_warrant_relief_count
-- is the relief-level count of that same population, kept separate on
-- purpose: "How we calculated this" needs the relief count (score.py
-- awards 10 pts per RELIEF, not per buyer) for its arithmetic to actually
-- add up to order_points below -- using the buyer-deduped number there
-- would silently break "N x 10 = order_points" for any buyer with more
-- than one such relief. Two columns, two units, both labeled -- exactly
-- the ambiguity this whole stage exists to remove.
--
-- order_points sums score.py's per-relief points for exactly that same
-- population (granted, no warrant) -- this is the "adverse order, no
-- warrant" half of raw_points (the other half is
-- queries/warrants_per_builder.sql's warrant_points), moved here from a
-- Python sum(...) over scored/order_*.json so the arithmetic in "How we
-- calculated this" traces back to one query result, not a re-sum.
SELECT
    builder_id,
    COUNT(*)                                                                          AS relief_count,
    COUNT(DISTINCT complaint_no)                                                      AS total_buyers,
    COUNT(DISTINCT CASE WHEN granted = 1 THEN complaint_no END)                        AS buyers_won,
    COUNT(DISTINCT CASE WHEN granted = 1 AND has_warrant = 1 THEN complaint_no END)     AS warranted_buyers,
    COUNT(DISTINCT CASE WHEN granted = 1 AND has_warrant = 0 THEN complaint_no END)     AS buyers_won_no_warrant,
    COUNT(*) FILTER (WHERE granted = 1 AND has_warrant = 0)                            AS adverse_no_warrant_relief_count,
    COALESCE(SUM(points) FILTER (WHERE granted = 1 AND has_warrant = 0), 0)            AS order_points
FROM complaints
WHERE builder_id = :builder_id
GROUP BY builder_id;
