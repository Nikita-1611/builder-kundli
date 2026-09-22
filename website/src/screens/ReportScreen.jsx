import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { fetchBuilder } from "../lib/builders";
import { fetchDistricts, findBuilderDistricts } from "../lib/districts";
import { formatCr, formatDate, formatNumber } from "../lib/format";
import { CATEGORIES, ORDERED_FALLBACK, categoryForReliefType, summarizeCategories, summarizeComplaintCategories } from "../lib/categories";
import { classifyDenial, OUTCOME_LABEL } from "../lib/denial";
import { builderBuyerStats } from "../lib/categoryGrouping";
import { verdictHeadline, verdictSubline } from "../lib/verdict";
import { summarizeOrder } from "../lib/orderSummary";
import { concernLevel } from "../lib/concern";
import {
  HALF_LIFE_YEARS,
  POINTS_ADVERSE_ORDER_NO_WARRANT,
  POINTS_RECOVERY_WARRANT,
  PROJECT_COUNT_LOG_WEIGHT,
  SCORE_SCALE,
  adjustedPoints,
} from "../lib/scoreFormula";
import ConcernScale from "../components/ConcernScale";
import EmptyState from "./EmptyState";
import "./ReportScreen.css";

const SOURCE_LINKS = [
  { label: "MahaRERA recovery warrant list", href: "https://maharera.maharashtra.gov.in/warrant-details" },
  { label: "MahaRERA orders & judgements search", href: "https://maharera.maharashtra.gov.in/orders-judgements" },
];

const ORDERS_PREVIEW_COUNT = 5;
const VARIANTS_PREVIEW_COUNT = 2;

// ---------- header ----------

function Header({ builder }) {
  const parts = [];
  if (builder.project_count > 0) {
    parts.push(`${builder.project_count} project${builder.project_count === 1 ? "" : "s"} in Maharashtra`);
  }
  if (builder.order_count > 0) {
    parts.push(`Report built from ${builder.order_count} RERA order${builder.order_count === 1 ? "" : "s"}`);
  }
  if (builder.last_built) parts.push(`Updated ${formatDate(builder.last_built)}`);

  return (
    <div className="report-header">
      <nav aria-label="Breadcrumb" className="report-header__crumb">
        <Link to="/">Builders</Link>
        <span>/</span>
        <span>{builder.builder_name}</span>
      </nav>
      <h1 className="report-header__name">{builder.builder_name}</h1>
      {parts.length > 0 && <span className="report-header__meta">{parts.join(" · ")}</span>}
    </div>
  );
}

// ---------- verdict ----------

// verdictHeadline/verdictSubline live in lib/verdict.js, shared with
// LandingScreen's hero preview card, so the two headlines can't say
// different things about the same builder.

// One shared calculation (lib/categoryGrouping.js's builderBuyerStats) for
// "buyers won" everywhere on this page -- the outcome box below and this
// fact row both call it, instead of each re-deriving their own buyer count.
function computeFacts(builder) {
  const stats = builderBuyerStats(builder);
  return {
    ordersRead: builder.order_count,
    buyersWon: stats.buyersWon,
    warrants: builder.warrant_count,
    projects: builder.project_count,
  };
}

function VerdictCard({ builder }) {
  const level = concernLevel(builder.score);
  const facts = computeFacts(builder);

  // Two different sources, kept visually separate so the numbers never
  // read as one blended count -- see verdictSentence above and the
  // conversation this was built to fix (a headline that implied 127
  // warrants meant 127 buyers won, when the two are related but not the
  // same number).
  const orderFacts = [
    facts.buyersWon > 0 && { value: facts.buyersWon, label: facts.buyersWon === 1 ? "buyer won" : "buyers won" },
    facts.projects > 0 && {
      value: facts.projects,
      label: facts.projects === 1 ? "project affected" : "projects affected",
    },
  ].filter(Boolean);
  const warrantFacts = [
    facts.warrants > 0 && {
      value: facts.warrants,
      label: facts.warrants === 1 ? "recovery warrant" : "recovery warrants",
    },
  ].filter(Boolean);

  return (
    <section className="verdict-card">
      <div className="verdict-card__head">
        <span className="eyebrow">VERDICT</span>
        <span className="verdict-card__level">
          <span className="verdict-card__dot" style={{ background: level.color }} />
          {level.label}
        </span>
      </div>
      <ConcernScale score={builder.score} variant="full" />
      <div className="verdict-card__headline">
        <p className="verdict-card__sentence">{verdictHeadline(builder)}</p>
        {verdictSubline(builder) && <p className="verdict-card__subline">{verdictSubline(builder)}</p>}
      </div>

      {orderFacts.length > 0 && (
        <div className="verdict-card__facts-group">
          <span className="eyebrow verdict-card__facts-source">
            FROM THE {facts.ordersRead} ORDER{facts.ordersRead === 1 ? "" : "S"} WE READ
          </span>
          <div className="verdict-card__facts">
            {orderFacts.map((fact) => (
              <span key={fact.label}>
                <strong className="mono">{fact.value}</strong> {fact.label}
              </span>
            ))}
          </div>
        </div>
      )}

      {warrantFacts.length > 0 && (
        <div className="verdict-card__facts-group">
          <span className="eyebrow verdict-card__facts-source">FROM MAHARERA&#39;S WARRANT LIST</span>
          <div className="verdict-card__facts">
            {warrantFacts.map((fact) => (
              <span key={fact.label}>
                <strong className="mono">{fact.value}</strong> {fact.label}
              </span>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

// ---------- categories ----------

function CategorySection({ builder, categories }) {
  // Orders genuinely unread (not just zero adverse categories among orders
  // that were read) gets its own explanatory line instead of hiding the
  // section -- a warrant-only builder still has a score and a warrant
  // count worth showing, just not a complaint breakdown.
  if (builder.order_count === 0) {
    return (
      <section className="report-block">
        <h2 className="report-block__title">What buyers complained about</h2>
        <p className="muted">
          We haven&#39;t read this builder&#39;s orders yet, so we can&#39;t show what the complaints were about.
        </p>
      </section>
    );
  }

  if (categories.length === 0) return null;
  const max = Math.max(...categories.map((category) => category.count));

  return (
    <section className="report-block">
      <div className="report-block__head">
        <h2 className="report-block__title">What buyers complained about</h2>
        <p className="muted">Click a category to see every complaint of that type.</p>
      </div>
      <div className="panel panel--rows">
        {categories.map((category) => (
          <Link key={category.id} to={`/builder/${builder.builder_id}/${category.id}`} className="category-row">
            <span className="category-row__label">{category.label}</span>
            <span className="category-row__track">
              <span className="category-row__fill" style={{ width: `${(category.count / max) * 100}%` }} />
            </span>
            <span className="mono category-row__count">{category.count}</span>
            <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
              <path d="M7 4l5 5-5 5" />
            </svg>
          </Link>
        ))}
      </div>
    </section>
  );
}

// ---------- outcomes ----------

function sumOrderedAmount(orders) {
  let total = 0;
  for (const order of orders) {
    for (const relief of order.reliefs) {
      if (relief.granted && relief.amount?.value != null) total += relief.amount.value;
    }
  }
  return total;
}

function OutcomeSection({ builder }) {
  const orders = builder.orders || [];
  if (orders.length === 0) return null;

  // Same buyer count as VerdictCard's "buyers won" -- one calculation
  // (builderBuyerStats), not a fresh order-count re-derivation here. An
  // order can bundle several buyers, so "X of Y orders" would be a
  // different, smaller-looking number than "X of Y buyers" for no real
  // reason -- see the conversation this fixed.
  const stats = builderBuyerStats(builder);
  const orderedAmount = sumOrderedAmount(orders);

  return (
    <section className="report-block">
      <h2 className="report-block__title">What happened after the ruling</h2>
      <div className="outcome-grid">
        <div className="outcome-box">
          <span className="muted">Buyer won</span>
          <span className="outcome-box__value">
            {stats.buyersWon} of {stats.totalBuyers}
          </span>
          <span className="muted">
            buyers won something, from the {orders.length} order{orders.length === 1 ? "" : "s"} we read
          </span>
        </div>
        {orderedAmount > 0 && (
          <div className="outcome-box">
            <span className="muted">Ordered to pay</span>
            <span className="outcome-box__value">{formatCr(orderedAmount)}</span>
            <span className="muted">refunds, interest and compensation</span>
          </div>
        )}
        {builder.warrant_count > 0 && (
          <div className="outcome-box outcome-box--warrant">
            <span>Didn&#39;t pay</span>
            <span className="outcome-box__value">
              {builder.warrant_count} warrant{builder.warrant_count === 1 ? "" : "s"}
            </span>
            <span>from MahaRERA&#39;s warrant list, escalated to recovery</span>
          </div>
        )}
      </div>
    </section>
  );
}

// ---------- districts ----------

function DistrictSection({ builder, districtRows }) {
  if (districtRows.length === 0) return null;
  const max = Math.max(...districtRows.map((row) => row.count));

  return (
    <section className="report-block">
      <div className="report-block__head">
        <h2 className="report-block__title">Where their projects are</h2>
        <p className="muted">Is the trouble in your area, or somewhere else?</p>
      </div>
      <div className="panel">
        <div className="district-row district-row--head">
          <span>District</span>
          <span>Projects</span>
          <span>Warrants</span>
          <span />
        </div>
        {districtRows.map((row) => (
          <div key={row.district} className="district-row">
            <span className="district-row__name">{row.district}</span>
            <span className="mono">{builder.project_count}</span>
            <span className="mono">{row.count}</span>
            <span className="district-row__track">
              <span className="district-row__fill" style={{ width: `${(row.count / max) * 100}%` }} />
            </span>
          </div>
        ))}
      </div>
    </section>
  );
}

// ---------- orders ----------

function distinctBy(list, keyFn) {
  const seen = new Map();
  for (const item of list) {
    const key = keyFn(item);
    if (!seen.has(key)) seen.set(key, item);
  }
  return [...seen.values()];
}

function OrderDetail({ order }) {
  // Dedupe by the label actually shown, not relief_type -- see the matching
  // comment in lib/categoryGrouping.js's summarizeRuling.
  const askedFor = distinctBy(
    order.reliefs.map((relief) => categoryForReliefType(relief.relief_type).label),
    (label) => label,
  );
  const granted = distinctBy(
    order.reliefs.filter((relief) => relief.granted).map((relief) => ORDERED_FALLBACK[relief.relief_type] || "Ordered in the buyer's favor."),
    (label) => label,
  );
  const denied = distinctBy(
    order.reliefs
      .filter((relief) => !relief.granted)
      .map((relief) => {
        const outcome = classifyDenial(relief.reasoning);
        return `${categoryForReliefType(relief.relief_type).label} — ${OUTCOME_LABEL[outcome.bucket]}`;
      }),
    (label) => label,
  );
  const reasoning = order.reliefs[0]?.reasoning;

  return (
    <div className="order-detail">
      <div>
        <span className="mono order-detail__label">BUYER ASKED FOR</span>
        <ul>
          {askedFor.map((line, i) => (
            <li key={i}>{line}</li>
          ))}
        </ul>
      </div>
      {granted.length > 0 && (
        <div>
          <span className="mono order-detail__label order-detail__label--granted">GRANTED</span>
          <ul>
            {granted.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        </div>
      )}
      {denied.length > 0 && (
        <div>
          <span className="mono order-detail__label order-detail__label--denied">DENIED</span>
          <ul>
            {denied.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        </div>
      )}
      <div className="order-detail__footer">
        {reasoning && <span className="muted">Why: {reasoning}</span>}
        <a href={`/orders/${order.order_id}.pdf`} target="_blank" rel="noreferrer">
          Read the order PDF ↗
        </a>
      </div>
    </div>
  );
}

function OrderRow({ order }) {
  const [open, setOpen] = useState(false);
  const summary = useMemo(() => summarizeOrder(order), [order]);

  return (
    <div className="order-row">
      <button type="button" className="order-row__toggle" aria-expanded={open} onClick={() => setOpen((value) => !value)}>
        <span className="mono order-row__date">{formatDate(order.order_date)}</span>
        <span className="order-row__cat">
          <span>{summary.categoryLabel}</span>
          <span className="mono muted order-row__complaint">{summary.complaintLabel}</span>
        </span>
        <span className="order-row__outcome">{summary.outcome}</span>
        <span className={`order-tag order-tag--${summary.tag.tone}`}>{summary.tag.label}</span>
        <svg width="18" height="18" viewBox="0 0 18 18" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
          {open ? <path d="M4 11l5-5 5 5" /> : <path d="M4 7l5 5 5-5" />}
        </svg>
      </button>
      {open && <OrderDetail order={order} />}
    </div>
  );
}

function OrdersSection({ builder }) {
  const orders = useMemo(() => builder.orders || [], [builder.orders]);
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [showAll, setShowAll] = useState(false);

  const availableCategories = useMemo(() => summarizeCategories(builder), [builder]);

  const sorted = useMemo(() => [...orders].sort((a, b) => (a.order_date < b.order_date ? 1 : -1)), [orders]);

  const filtered = useMemo(() => {
    if (categoryFilter === "all") return sorted;
    const reliefTypes = new Set(CATEGORIES.find((category) => category.id === categoryFilter)?.reliefTypes || []);
    return sorted.filter((order) => order.reliefs.some((relief) => reliefTypes.has(relief.relief_type)));
  }, [sorted, categoryFilter]);

  if (orders.length === 0) return null;

  const visible = showAll ? filtered : filtered.slice(0, ORDERS_PREVIEW_COUNT);
  const remaining = filtered.length - visible.length;

  return (
    <section id="orders" className="report-block">
      <div className="report-block__head report-block__head--row">
        <div>
          <h2 className="report-block__title">Every order we read</h2>
          <p className="muted">Newest first. Open one to see what was asked, granted and denied.</p>
        </div>
        {availableCategories.length > 1 && (
          <div className="order-filter">
            <label htmlFor="order-filter">Category</label>
            <select
              id="order-filter"
              value={categoryFilter}
              onChange={(event) => {
                setCategoryFilter(event.target.value);
                setShowAll(false);
              }}
            >
              <option value="all">All categories</option>
              {availableCategories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.label}
                </option>
              ))}
            </select>
          </div>
        )}
      </div>
      <div className="panel">
        {visible.map((order) => (
          <OrderRow key={order.order_id} order={order} />
        ))}
        {remaining > 0 && (
          <button type="button" className="orders-more" onClick={() => setShowAll(true)}>
            Show {remaining} more order{remaining === 1 ? "" : "s"}
          </button>
        )}
      </div>
    </section>
  );
}

// ---------- calculation ----------

function CalculationSection({ builder }) {
  if (builder.raw_points === 0) return null;
  // Relief-level count, not the buyer-deduped buyers_won_no_warrant used
  // elsewhere on this page -- score.py awards points per relief, so this
  // is the number that actually multiplies out to order_points below. See
  // queries/buyers_won_per_builder.sql's comment on why the two are kept
  // as separate fields.
  const adverseReliefs = builder.adverse_no_warrant_relief_count || 0;
  const adjusted = adjustedPoints(builder.raw_points, builder.project_count);
  const recentWarrants = builder.warrants_recent_count || 0;
  const olderWarrants = builder.warrants_older_count || 0;

  return (
    <details className="panel calc-details">
      <summary>How we calculated this</summary>
      <div className="calc-details__body">
        {(recentWarrants > 0 || olderWarrants > 0) && (
          <p>
            {recentWarrants > 0 &&
              `${recentWarrants} recent warrant${recentWarrants === 1 ? "" : "s"} × ${POINTS_RECOVERY_WARRANT} = ${formatNumber(builder.warrants_recent_points)}`}
            {recentWarrants > 0 && olderWarrants > 0 && ", "}
            {olderWarrants > 0 &&
              `${olderWarrants} warrant${olderWarrants === 1 ? "" : "s"} older than ${HALF_LIFE_YEARS} years (half weight) × ${POINTS_RECOVERY_WARRANT / 2} = ${formatNumber(builder.warrants_older_points)}`}
          </p>
        )}
        {adverseReliefs > 0 && (
          <p>
            {adverseReliefs} claim{adverseReliefs === 1 ? "" : "s"} won with no warrant yet × {POINTS_ADVERSE_ORDER_NO_WARRANT}{" "}
            pts each (halved once older than {HALF_LIFE_YEARS} years) = {formatNumber(builder.order_points)} pts
          </p>
        )}
        <p>
          Raw points: {formatNumber(builder.warrant_points)} + {formatNumber(builder.order_points)} ={" "}
          {formatNumber(builder.raw_points)}
        </p>
        {builder.project_count > 1 && (
          <p>
            These warrants and orders span {builder.project_count} different projects, not just one — that adds a
            small amount to the score, since the same harm spread across more projects is a broader pattern, not a
            smaller one. <span className="mono muted">→ {adjusted.toFixed(1)} pts</span>
          </p>
        )}
        <p>
          Points are converted to a 0–10 scale. Scores rise more slowly as points increase, so only extreme cases
          approach 10. This builder scores <strong>{builder.score.toFixed(1)} / 10</strong>.
        </p>
        <details className="calc-details__formula">
          <summary>Show formula</summary>
          <p className="mono muted">
            adjusted points = raw points × (1 + {PROJECT_COUNT_LOG_WEIGHT} × ln(project count))
            <br />
            score = 10 × (1 − e^−(adjusted points / {SCORE_SCALE})), rounded to 1 decimal
          </p>
        </details>
      </div>
    </details>
  );
}

// ---------- check it yourself ----------

function CopyBuilderName({ name }) {
  const [copied, setCopied] = useState(false);
  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(name);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard blocked -- nothing to fall back to
    }
  }
  return (
    <button type="button" className="btn btn--outline" onClick={handleCopy}>
      {copied ? "Copied" : "Copy name"}
    </button>
  );
}

function CheckItYourselfSection({ builder }) {
  const [variantsExpanded, setVariantsExpanded] = useState(false);
  const otherVariants = builder.name_variants.filter((name) => name !== builder.builder_name);
  const visibleVariants = variantsExpanded ? otherVariants : otherVariants.slice(0, VARIANTS_PREVIEW_COUNT);
  const remainingVariants = otherVariants.length - VARIANTS_PREVIEW_COUNT;

  return (
    <section className="report-block check-section">
      <div className="check-section__head">
        <h2 className="check-section__title">Check it yourself</h2>
        {builder.last_built && <span className="mono muted">Records last checked {formatDate(builder.last_built)}</span>}
      </div>
      <div className="check-section__search">
        <span className="muted">Search this name on MahaRERA:</span>
        <span className="mono check-section__name">{builder.builder_name}</span>
        <CopyBuilderName name={builder.builder_name} />
      </div>
      <div className="check-section__links">
        {SOURCE_LINKS.map((source) => (
          <a key={source.href} href={source.href} target="_blank" rel="noreferrer" className="check-section__link">
            <span>{source.label}</span>
            <span>↗</span>
          </a>
        ))}
      </div>
      {otherVariants.length > 0 && (
        <details className="check-section__variants">
          <summary>Also filed under {otherVariants.length} other spelling{otherVariants.length === 1 ? "" : "s"}</summary>
          <p>
            {visibleVariants.join(", ")}
            {!variantsExpanded && remainingVariants > 0 && (
              <button type="button" className="orders-more orders-more--inline" onClick={() => setVariantsExpanded(true)}>
                +{remainingVariants} more
              </button>
            )}
          </p>
        </details>
      )}
    </section>
  );
}

// ---------- sidebar ----------

const QUESTION_POOL = [
  { when: (b) => b.warrant_count > 0, text: "Are there unpaid RERA orders against this company?" },
  { when: (b) => (b.buyers_won_no_warrant || 0) > 0, text: "What happens to my money if this project stalls?" },
  {
    when: (b) => summarizeCategories(b).some((c) => c.id === "late-possession"),
    text: "Has possession been delayed on your other projects?",
  },
  {
    when: (b) => summarizeCategories(b).some((c) => c.id === "refund"),
    text: "How many buyers have asked for refunds on your other projects?",
  },
  { when: () => true, text: "Can I see the RERA registration and completion timeline for this project?" },
];

function ShareCard({ builder }) {
  const [copied, setCopied] = useState(false);
  const level = concernLevel(builder.score);
  const shareText = `${builder.builder_name} on MahaRERA: ${level.label.toLowerCase()}. ${window.location.href}`;

  async function handleCopyLink() {
    try {
      await navigator.clipboard.writeText(window.location.href);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard blocked -- nothing to fall back to
    }
  }

  return (
    <div className="share-card">
      <span className="share-card__title">Buying with family? Send them this.</span>
      <span className="share-card__body">A one-page summary with the verdict and top complaints.</span>
      <a
        className="btn btn--share-primary"
        href={`https://wa.me/?text=${encodeURIComponent(shareText)}`}
        target="_blank"
        rel="noreferrer"
      >
        Share on WhatsApp
      </a>
      <button type="button" className="btn btn--share-outline" onClick={handleCopyLink}>
        {copied ? "Link copied" : "Copy link"}
      </button>
    </div>
  );
}

function QuestionsCard({ builder }) {
  const questions = QUESTION_POOL.filter((q) => q.when(builder)).slice(0, 3);
  if (builder.score === 0) return null;
  return (
    <div className="questions-card">
      <span className="questions-card__title">Questions to ask the builder</span>
      {questions.map((q) => (
        <span key={q.text} className="questions-card__item">
          {q.text}
        </span>
      ))}
    </div>
  );
}

function Sidebar({ builder }) {
  return (
    <aside className="report-sidebar">
      <ShareCard builder={builder} />
      <QuestionsCard builder={builder} />
      <p className="report-sidebar__disclaimer">
        Flags things worth asking about. Not legal advice. Every finding links to its MahaRERA order.
      </p>
    </aside>
  );
}

// ---------- page ----------

export default function ReportScreen() {
  const { id } = useParams();
  const [builder, setBuilder] = useState(undefined); // undefined = loading, null = not found
  const [districtsData, setDistrictsData] = useState(null);

  useEffect(() => {
    let cancelled = false;
    setBuilder(undefined);
    fetchBuilder(id).then((data) => {
      if (!cancelled) setBuilder(data);
    });
    return () => {
      cancelled = true;
    };
  }, [id]);

  useEffect(() => {
    let cancelled = false;
    fetchDistricts().then((data) => {
      if (!cancelled) setDistrictsData(data.districts);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const categories = useMemo(() => (builder ? summarizeComplaintCategories(builder) : []), [builder]);
  const districtRows = useMemo(
    () => (builder && districtsData ? findBuilderDistricts(districtsData, builder.builder_id) : []),
    [builder, districtsData],
  );

  if (builder === undefined) {
    return (
      <div className="report-page">
        <div className="report-page__inner">
          <p className="muted">Loading...</p>
        </div>
      </div>
    );
  }

  if (builder === null) {
    return <EmptyState query={id.replace(/-/g, " ")} />;
  }

  return (
    <div className="report-page">
      <div className="report-page__inner">
        <div className="report-page__left">
          <Header builder={builder} />
          <VerdictCard builder={builder} />
          <CategorySection builder={builder} categories={categories} />
          <OutcomeSection builder={builder} />
          <DistrictSection builder={builder} districtRows={districtRows} />
          <OrdersSection builder={builder} />
          <CalculationSection builder={builder} />
          <CheckItYourselfSection builder={builder} />
        </div>
        <Sidebar builder={builder} />
      </div>
    </div>
  );
}
