import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { fetchBuilder } from "../lib/builders";
import { formatDate } from "../lib/format";
import { findCategory, summarizeComplaintCategories } from "../lib/categories";
import { categoryFacts, groupCategoryCases } from "../lib/categoryGrouping";
import EmptyState from "./EmptyState";
import "./CategoryScreen.css";

const BUYERS_PREVIEW_COUNT = 6;

function Header({ builder, category, facts }) {
  return (
    <div className="cat-header">
      <Link to={`/builder/${builder.builder_id}`} className="cat-header__back">
        ← {builder.builder_name} report
      </Link>
      <h1 className="cat-header__title">{category.label}</h1>
      <p className="cat-header__explainer">{category.explainer}</p>
      <div className="cat-header__facts">
        <span>
          <strong className="mono">{facts.buyers}</strong> buyer{facts.buyers === 1 ? "" : "s"}
        </span>
        <span>
          <strong className="mono">{facts.projects}</strong> project{facts.projects === 1 ? "" : "s"}
        </span>
        <span>
          <strong className="mono">
            {facts.buyersWon} of {facts.buyers}
          </strong>{" "}
          buyers won
        </span>
        {facts.warrants > 0 && (
          <span>
            <strong className="mono cat-header__warrant-count">{facts.warrants}</strong> of those buyers already have
            a recovery warrant
          </span>
        )}
      </div>
      <p className="muted cat-header__source">From the orders we read.</p>
    </div>
  );
}

function CategorySwitch({ builderId, categories, activeId }) {
  if (categories.length <= 1) return null;
  return (
    <div className="cat-switch">
      {categories.map((category) => (
        <Link
          key={category.id}
          to={`/builder/${builderId}/${category.id}`}
          className={`chip-tab ${category.id === activeId ? "chip-tab--active" : ""}`}
        >
          {category.label} · {category.count}
        </Link>
      ))}
    </div>
  );
}

function BuyerTable({ cases, showPaid }) {
  const [showAll, setShowAll] = useState(false);
  const visible = showAll ? cases : cases.slice(0, BUYERS_PREVIEW_COUNT);
  const remaining = cases.length - visible.length;

  return (
    <div className="buyer-table">
      <div className={`buyer-row buyer-row--head ${showPaid ? "" : "buyer-row--no-paid"}`}>
        <span>#</span>
        <span>Buyer</span>
        <span>Complaint no.</span>
        <span>Order date</span>
        {showPaid && <span>Paid?</span>}
      </div>
      {visible.map((c, index) => (
        <div key={c.complaintNo} className={`buyer-row ${showPaid ? "" : "buyer-row--no-paid"}`}>
          <span className="mono muted">{index + 1}</span>
          <span>{c.complainantNames.join(", ") || "Buyer"}</span>
          <span className="mono muted buyer-row__complaint">{c.complaintNo}</span>
          <span className="mono muted">{formatDate(c.orderDate)}</span>
          {showPaid && (
            <span className={`tag ${c.reliefs.some((r) => r.has_warrant) ? "tag--red" : "tag--grey"}`}>
              {c.reliefs.some((r) => r.has_warrant) ? "Warrant issued" : "No warrant yet"}
            </span>
          )}
        </div>
      ))}
      {remaining > 0 && (
        <button type="button" className="buyer-table__more" onClick={() => setShowAll(true)}>
          Show all {cases.length} buyers
        </button>
      )}
    </div>
  );
}

function RulingBlock({ ruling }) {
  const { summary } = ruling;
  return (
    <div className="ruling-block">
      <span className="mono ruling-block__eyebrow">THE RULING</span>
      <div className="ruling-block__grid">
        <div>
          <span className="muted">Who won</span>
          <span className={`ruling-block__who ${summary.whoWon === "Buyer" ? "ruling-block__who--buyer" : ""}`}>
            {summary.whoWon}
          </span>
        </div>
        {summary.orderedItems.length > 0 && (
          <div className="ruling-block__span2">
            <span className="muted">What was ordered</span>
            {summary.orderedItems.map((item, i) => (
              <span key={i} className="ruling-block__ordered">
                {item}
              </span>
            ))}
          </div>
        )}
        {summary.deniedItems.length > 0 && (
          <div className="ruling-block__span2">
            <span className="muted">What was denied</span>
            {summary.deniedItems.map((item, i) => (
              <span key={i} className="ruling-block__denied">
                {item}
              </span>
            ))}
          </div>
        )}
      </div>
      {summary.reasoning && <p className="ruling-block__why">Why: {summary.reasoning}</p>}
      {summary.warrantEligible > 0 && (
        <div className={`ruling-block__paid ${summary.warrantCount === 0 ? "ruling-block__paid--grey" : ""}`}>
          <span>
            <strong>Did they pay?</strong>{" "}
            {summary.warrantCount === 0
              ? `Not on record — no recovery warrant issued yet for ${summary.warrantEligible === 1 ? "this buyer" : `these ${summary.warrantEligible} buyers`}.`
              : summary.warrantCount === summary.warrantEligible
                ? `No — recovery warrants issued for all ${summary.warrantEligible} buyer${summary.warrantEligible === 1 ? "" : "s"}.`
                : `No — recovery warrants for ${summary.warrantCount} of ${summary.warrantEligible} buyers.`}
          </span>
          {summary.warrantCount > 0 &&
            summary.orderIds.map((orderId, i) => (
              <a key={orderId} href={`/orders/${orderId}.pdf`} target="_blank" rel="noreferrer">
                View order PDF{summary.orderIds.length > 1 ? ` (${i + 1})` : ""} ↗
              </a>
            ))}
        </div>
      )}
      {summary.warrantEligible === 0 &&
        summary.orderIds.map((orderId, i) => (
          <a key={orderId} className="ruling-block__pdf-link" href={`/orders/${orderId}.pdf`} target="_blank" rel="noreferrer">
            View order PDF{summary.orderIds.length > 1 ? ` (${i + 1})` : ""} ↗
          </a>
        ))}
      <BuyerTable cases={ruling.cases} showPaid={summary.orderedItems.length > 0} />
    </div>
  );
}

function RulingRow({ ruling }) {
  const [open, setOpen] = useState(false);
  const { summary } = ruling;
  const tag =
    summary.warrantEligible > 0
      ? summary.warrantCount > 0
        ? { label: "Warrant issued", tone: "red" }
        : { label: "No warrant yet", tone: "grey" }
      : { label: "—", tone: "grey" };

  return (
    <div className={`ruling-row ${open ? "ruling-row--open" : ""}`}>
      <button
        type="button"
        className={`ruling-row__toggle ${open ? "ruling-row__toggle--open" : ""}`}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <div className="ruling-row__what">
          <span>{summary.orderedItems[0] || summary.deniedItems[0] || "Mixed outcome"}</span>
          <span className="muted">{summary.whoWon === "Buyer" ? "Buyer won" : summary.whoWon === "Builder" ? "Builder won" : summary.whoWon}</span>
        </div>
        <span className="muted ruling-row__count">
          {summary.buyerCount} buyer{summary.buyerCount === 1 ? "" : "s"}
        </span>
        <span className={`tag tag--${tag.tone}`}>{tag.label}</span>
        <svg
          className="ruling-row__chevron"
          width="16"
          height="16"
          viewBox="0 0 16 16"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.6"
          aria-hidden="true"
        >
          <path d="M5 3l6 5-6 5" />
        </svg>
      </button>
      {open && <RulingBlock ruling={ruling} />}
    </div>
  );
}

function ProjectGroup({ project }) {
  const sameRuling = project.rulings.length === 1;
  return (
    <section className="project-group">
      <div className="project-group__head">
        <div>
          <h2 className="project-group__name">{project.projectName || "Project not named in order"}</h2>
          {project.projectRegNo && <span className="mono muted">{project.projectRegNo}</span>}
        </div>
        <span className={`project-group__badge ${sameRuling ? "project-group__badge--same" : ""}`}>
          {project.caseCount} buyer{project.caseCount === 1 ? "" : "s"}
          {sameRuling ? " · same ruling" : ` · ${project.rulings.length} different rulings`}
        </span>
      </div>
      {sameRuling ? (
        <RulingBlock ruling={project.rulings[0]} />
      ) : (
        <>
          {project.rulings.map((ruling) => (
            <RulingRow key={ruling.signature} ruling={ruling} />
          ))}
        </>
      )}
    </section>
  );
}

export default function CategoryScreen() {
  const { id, category: categoryId } = useParams();
  const [builder, setBuilder] = useState(undefined); // undefined = loading, null = not found

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

  const category = findCategory(categoryId);
  const switcherCategories = useMemo(
    () => (builder ? summarizeComplaintCategories(builder) : []),
    [builder],
  );
  const projects = useMemo(() => (builder && category ? groupCategoryCases(builder, category) : []), [builder, category]);
  const facts = useMemo(() => (builder && category ? categoryFacts(builder, category) : null), [builder, category]);

  if (builder === undefined) {
    return (
      <div className="cat-page">
        <div className="cat-page__inner">
          <p className="muted">Loading...</p>
        </div>
      </div>
    );
  }

  if (builder === null) {
    return <EmptyState query={id.replace(/-/g, " ")} />;
  }

  if (!category) {
    return <EmptyState query={categoryId.replace(/-/g, " ")} />;
  }

  return (
    <div className="cat-page">
      <div className="cat-page__inner">
        <Header builder={builder} category={category} facts={facts} />
        <CategorySwitch builderId={builder.builder_id} categories={switcherCategories} activeId={category.id} />
        {projects.length === 0 ? (
          <p className="muted">No cases found in this category.</p>
        ) : (
          projects.map((project) => <ProjectGroup key={project.projectRegNo || project.projectName} project={project} />)
        )}
        <p className="muted cat-page__footnote">
          Every complaint number links to its order on MahaRERA. Flags things worth asking about — not legal advice.
        </p>
      </div>
    </div>
  );
}
