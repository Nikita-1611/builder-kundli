import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { FileCheck, Eye, Info } from "lucide-react";
import { fetchBuilderIndex, fetchBuilder } from "../lib/builders";
import { fetchDistricts } from "../lib/districts";
import { suggestBuilders, findExactMatch } from "../lib/search";
import { summarizeCategories } from "../lib/categories";
import { verdictHeadline, verdictSubline } from "../lib/verdict";
import { concernLevel, CONCERN_LEVELS } from "../lib/concern";
import { formatCr } from "../lib/format";
import { DISTRICT_SHADES } from "../lib/districtShade";
import ConcernScale from "../components/ConcernScale";
import MaharashtraMap from "../components/MaharashtraMap";
import "./LandingScreen.css";

const MAP_SOURCE = "MahaRERA warrant register, 20 July 2026";
const DEFAULT_DISTRICT = "Mumbai";

// Hardcoded because it's a registry-wide total, not something derivable
// from the ~25 builders in this dataset -- see the citation next to it.
const STATS = {
  warrants: "1,595",
  projects: "593",
  amount: "₹1,161 cr",
};
const STATS_SOURCE =
  "Source: MahaRERA warrant register, updated 20 July 2026. A warrant means the buyer won and the builder didn't pay.";

// The builder whose record anchors the hero preview card -- highest score
// in the dataset, so a first-time visitor immediately sees what a full
// finding looks like.
const HERO_BUILDER_ID = "jvpd-properties-pvt-ltd";

const TABS = [{ id: "all", label: "All" }, ...CONCERN_LEVELS.slice().reverse()];

// How many builders show as chips before the rest fold into "More
// builders". The wireframe shows 4 up front + 6 more, but this dataset
// only has 5 builders with readable orders in total -- so the split is
// smaller and the dropdown will only ever hold a couple of names here.
const VISIBLE_CHIP_COUNT = 3;

// How many builders the district panel shows before "Show all N builders".
const DISTRICT_BUILDERS_PREVIEW_COUNT = 5;

const SORTS = [
  { id: "concerns", label: "Most concerns first" },
  { id: "orders", label: "Most orders read" },
  { id: "az", label: "A–Z" },
];

const STEPS = [
  { n: "01", title: "Find", body: "Match a messy builder name to its RERA registrations.", out: "registration nos." },
  { n: "02", title: "Collect", body: "Pull each project's promised and actual dates.", out: "project list" },
  { n: "03", title: "Dig", body: "Fetch order PDFs and the warrant, abeyance and revoked lists.", out: "order PDFs" },
  { n: "04", title: "Read", body: "Extract the complaint, who won, what was ordered, the amount.", out: "structured orders" },
  { n: "05", title: "Score", body: "Add up points you can see, and write the report.", out: "report + sources" },
];

const TRUST = [
  {
    title: "Every claim has a source",
    body: "Each finding shows its complaint number so you can check it on MahaRERA yourself.",
    icon: FileCheck,
  },
  {
    title: "A score you can see inside",
    body: "Points, not a black box. The report shows exactly which orders and warrants add up.",
    icon: Eye,
  },
  {
    title: "Honest about gaps",
    body: "Where orders couldn't be retrieved, we say so instead of guessing.",
    icon: Info,
  },
];

const FAQS = [
  {
    q: "Is this legal advice?",
    a: "No. This shows what MahaRERA's own orders and warrants say about a builder. Whether to buy is your call, not ours.",
  },
  {
    q: "Why only Maharashtra?",
    a: "MahaRERA is the only state regulator whose order and warrant records we've read in full so far. Other states may follow.",
  },
  {
    q: "What does “recovery warrant” mean?",
    a: "MahaRERA already ordered the builder to pay a buyer, the builder didn't, and the authority issued a warrant to recover the amount as arrears — like a tax default.",
  },
  {
    q: "My builder isn't listed. Why?",
    a: "We have no MahaRERA warrants or orders on record for them under the name you're searching — either their record is clean, or we haven't matched their name to the registry yet.",
  },
];

function topCategoryLabel(builder) {
  if (builder.order_count === 0) return "Warrants only";
  const categories = summarizeCategories(builder);
  if (categories.length === 0) return "—";
  return categories.reduce((max, category) => (category.count > max.count ? category : max), categories[0]).label;
}

// Copies a link to the clipboard with brief "Copied" feedback. Silently
// no-ops if the Clipboard API isn't available, same pattern ReportScreen
// uses for "Copy name".
function ShareButton({ href, children }) {
  const [copied, setCopied] = useState(false);

  async function handleClick() {
    try {
      await navigator.clipboard.writeText(new URL(href, window.location.origin).toString());
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // clipboard blocked -- nothing to fall back to
    }
  }

  return (
    <button type="button" className="btn btn--outline" onClick={handleClick}>
      {copied ? "Link copied" : children}
    </button>
  );
}

function BuilderRow({ builder }) {
  return (
    <div className="builders-table__row">
      <div className="builders-table__name">
        <span>{builder.builder_name}</span>
        <span className="muted">
          {builder.project_count} project{builder.project_count === 1 ? "" : "s"}
        </span>
      </div>
      <ConcernScale score={builder.score} variant="compact" />
      <span className="mono">{builder.order_count}</span>
      <span className="mono">{builder.warrant_count}</span>
      <span>{topCategoryLabel(builder)}</span>
      <Link to={`/builder/${builder.builder_id}`} className="builders-table__link">
        View report →
      </Link>
    </div>
  );
}

function HeroPreviewCard({ builder }) {
  if (!builder) return null;
  const categories = summarizeCategories(builder)
    .slice()
    .sort((a, b) => b.count - a.count)
    .slice(0, 3);
  const max = categories.length > 0 ? Math.max(...categories.map((c) => c.count)) : 0;

  return (
    <div className="hero-preview">
      <div className="hero-preview__card">
        <div className="hero-preview__head">
          <span className="hero-preview__name">{builder.builder_name}</span>
          <span className="hero-preview__tag">Report preview</span>
        </div>
        <ConcernScale score={builder.score} variant="full" />
        <div className="hero-preview__headline-group">
          <p className="hero-preview__headline">{verdictHeadline(builder)}</p>
          {verdictSubline(builder) && <p className="hero-preview__subline">{verdictSubline(builder)}</p>}
        </div>
        <div className="hero-preview__bars">
          {categories.map((category) => (
            <div key={category.id} className="hero-preview__bar-row">
              <div className="hero-preview__bar-label">
                <span>{category.label}</span>
                <span className="muted">{category.count}</span>
              </div>
              <div className="hero-preview__bar-track">
                <div
                  className="hero-preview__bar-fill"
                  style={{ width: `${max > 0 ? (category.count / max) * 100 : 0}%` }}
                />
              </div>
            </div>
          ))}
        </div>
        <div className="hero-preview__actions">
          <ShareButton href={`/builder/${builder.builder_id}`}>Share with family</ShareButton>
          <Link to={`/builder/${builder.builder_id}`} className="btn btn--ghost">
            See the orders
          </Link>
        </div>
      </div>
    </div>
  );
}

export default function LandingScreen() {
  const navigate = useNavigate();
  const [index, setIndex] = useState(null);
  const [detailed, setDetailed] = useState(null);
  const [query, setQuery] = useState("");
  const [tab, setTab] = useState("all");
  const [sort, setSort] = useState("concerns");
  const [openFaq, setOpenFaq] = useState(null);
  const [districts, setDistricts] = useState(null);
  const [selectedDistrict, setSelectedDistrict] = useState(DEFAULT_DISTRICT);

  useEffect(() => {
    let cancelled = false;
    fetchBuilderIndex().then(async (data) => {
      if (cancelled) return;
      setIndex(data);
      // The table lists every builder with something on record -- orders
      // we could read, or warrants even where we couldn't -- and leaves
      // out only the ones with neither (see the FAQ on why a builder might
      // be missing entirely).
      const withRecord = data.filter((entry) => entry.order_count > 0 || entry.warrant_count > 0);
      const records = await Promise.all(withRecord.map((entry) => fetchBuilder(entry.id)));
      if (!cancelled) setDetailed(records.filter(Boolean));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    fetchDistricts().then((data) => {
      if (!cancelled) setDistricts(data.districts);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const selectedDistrictData = districts ? districts[selectedDistrict] : null;

  const [buildersExpanded, setBuildersExpanded] = useState(false);
  const [expandedForDistrict, setExpandedForDistrict] = useState(selectedDistrict);
  if (selectedDistrict !== expandedForDistrict) {
    setExpandedForDistrict(selectedDistrict);
    setBuildersExpanded(false);
  }

  // Search only ever surfaces builders whose orders were actually read --
  // same rule SearchScreen follows, so a "Check" here never lands on a
  // report that's just a warrant count with nothing to read.
  const searchableIndex = useMemo(() => (index ? index.filter((entry) => entry.order_count > 0) : []), [index]);
  const suggestions = useMemo(() => suggestBuilders(query, searchableIndex), [query, searchableIndex]);
  const chips = useMemo(() => [...searchableIndex].sort((a, b) => b.score - a.score), [searchableIndex]);
  const visibleChips = chips.slice(0, VISIBLE_CHIP_COUNT);
  const moreChips = chips.slice(VISIBLE_CHIP_COUNT);

  const [moreOpen, setMoreOpen] = useState(false);
  const moreRef = useRef(null);

  useEffect(() => {
    if (!moreOpen) return;
    function handleClickOutside(event) {
      if (moreRef.current && !moreRef.current.contains(event.target)) setMoreOpen(false);
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [moreOpen]);

  const heroBuilder = useMemo(
    () => (detailed ? detailed.find((b) => b.builder_id === HERO_BUILDER_ID) || detailed[0] : null),
    [detailed],
  );

  // Split of the table: how many rows have orders actually read vs. just a
  // warrant count -- drives the subtitle under the table heading.
  const ordersReadCount = useMemo(() => (index ? index.filter((entry) => entry.order_count > 0).length : null), [index]);
  const warrantsOnlyCount = useMemo(
    () => (index ? index.filter((entry) => entry.order_count === 0 && entry.warrant_count > 0).length : null),
    [index],
  );

  const tableRows = useMemo(() => {
    if (!detailed) return [];
    const filtered = tab === "all" ? detailed : detailed.filter((b) => concernLevel(b.score).id === tab);
    const sorted = [...filtered];
    if (sort === "concerns") sorted.sort((a, b) => b.score - a.score);
    else if (sort === "orders") sorted.sort((a, b) => b.order_count - a.order_count);
    else sorted.sort((a, b) => a.builder_name.localeCompare(b.builder_name));
    return sorted;
  }, [detailed, tab, sort]);

  // Builders whose orders we've actually read always show. Warrants-only
  // rows (order_count === 0) fold under a collapsed toggle below them --
  // same filter/sort as above, just split into two groups afterward.
  const ordersReadRows = useMemo(() => tableRows.filter((b) => b.order_count > 0), [tableRows]);
  const warrantsOnlyRows = useMemo(() => tableRows.filter((b) => b.order_count === 0), [tableRows]);
  const [warrantsOnlyExpanded, setWarrantsOnlyExpanded] = useState(false);
  // No orders-read group to fold under -- the warrants-only rows just are
  // the list, so there's nothing to collapse.
  const warrantsShownDirectly = ordersReadRows.length === 0;
  const visibleCount = ordersReadRows.length + (warrantsShownDirectly || warrantsOnlyExpanded ? warrantsOnlyRows.length : 0);

  function goToBuilder(id) {
    navigate(`/builder/${id}`);
  }

  function handleHeroSubmit(event) {
    event.preventDefault();
    if (!index) return;
    const exact = findExactMatch(query, searchableIndex);
    if (exact) return goToBuilder(exact.id);
    if (suggestions.length > 0) return goToBuilder(suggestions[0].id);
    navigate("/search", { state: { query } });
  }

  return (
    <div className="landing">
      <header className="landing-nav">
        <div className="landing-nav__brand">
          <span className="landing-nav__mark" />
          <span className="landing-nav__name">Builder Risk Check</span>
        </div>
        <nav className="landing-nav__links">
          <a href="#how">How it works</a>
          <a href="#builders">Builders</a>
          <a href="#method">Our method</a>
          <a href="#faq">FAQ</a>
        </nav>
        <a href="#top" className="btn btn--primary">
          Check a builder
        </a>
      </header>

      <section id="top" className="hero">
        <div className="hero__copy">
          <span className="badge">MahaRERA · Maharashtra only</span>
          <h1 className="hero__title">
            Before you book, read what RERA <em>already ruled.</em>
          </h1>
          <p className="hero__subtitle">
            Other tools count complaints. We read the orders: what buyers complained about, what the authority
            ordered, and whether the builder actually paid.
          </p>
          <form className="hero__form" onSubmit={handleHeroSubmit} role="search">
            <label htmlFor="hero-search" className="hero__form-label">
              Builder or project name
            </label>
            <div className="hero__form-row">
              <input
                id="hero-search"
                type="text"
                inputMode="search"
                autoComplete="off"
                placeholder="e.g. Nirmal Lifestyle"
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                className="hero__input"
              />
              <button type="submit" className="btn btn--primary">
                Check
              </button>
            </div>
            {query && suggestions.length > 0 && (
              <ul className="hero__suggestions" role="listbox">
                {suggestions.map((entry) => (
                  <li key={entry.id}>
                    <button type="button" onClick={() => goToBuilder(entry.id)}>
                      {entry.name}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {!query && chips.length > 0 && (
              <div className="hero__chips">
                <span className="hero__chips-label">Try:</span>
                {visibleChips.map((entry) => (
                  <button key={entry.id} type="button" className="chip" onClick={() => goToBuilder(entry.id)}>
                    {entry.name}
                  </button>
                ))}
                {moreChips.length > 0 && (
                  <div className="hero__more" ref={moreRef}>
                    <button
                      type="button"
                      className="hero__more-toggle"
                      aria-expanded={moreOpen}
                      aria-controls="more-builders"
                      onClick={() => setMoreOpen((open) => !open)}
                    >
                      More builders
                      <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" strokeWidth="1.6">
                        {moreOpen ? <path d="M3 9l4-4 4 4" /> : <path d="M3 5l4 4 4-4" />}
                      </svg>
                    </button>
                    {moreOpen && (
                      <div id="more-builders" className="hero__more-panel">
                        <span className="hero__more-heading">MORE BUILDERS WE&#39;VE READ</span>
                        {moreChips.map((entry) => {
                          const level = concernLevel(entry.score);
                          return (
                            <button
                              key={entry.id}
                              type="button"
                              className="hero__more-item"
                              onClick={() => goToBuilder(entry.id)}
                            >
                              <span>{entry.name}</span>
                              <span className="hero__more-level">
                                <span className="hero__more-dot" style={{ background: level.color }} />
                                {level.label}
                              </span>
                            </button>
                          );
                        })}
                        <a href="#builders" className="hero__more-browse" onClick={() => setMoreOpen(false)}>
                          Browse all builders →
                        </a>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </form>
        </div>
        <HeroPreviewCard builder={heroBuilder} />
      </section>

      <section className="stats">
        <div className="stat">
          <span className="stat__value">{STATS.warrants}</span>
          <span className="stat__label">recovery warrants issued</span>
        </div>
        <div className="stat">
          <span className="stat__value">{STATS.projects}</span>
          <span className="stat__label">projects with a warrant</span>
        </div>
        <div className="stat">
          <span className="stat__value">{STATS.amount}</span>
          <span className="stat__label">under recovery warrants</span>
        </div>
        <p className="stats__source">{STATS_SOURCE}</p>
      </section>

      <section className="district-map">
        <div className="district-map__head">
          <span className="eyebrow">WHERE</span>
          <h2 className="section-title">Where the warrants are.</h2>
          <p className="section-body">
            Shaded by how many recovery warrants MahaRERA has issued in that district. Grey doesn&#39;t mean clean
            &mdash; it means we haven&#39;t scraped that district&#39;s warrant register yet.
          </p>
        </div>
        <div className="district-map__grid">
          <div className="district-map__visual">
            {districts ? (
              <MaharashtraMap data={districts} selected={selectedDistrict} onSelect={setSelectedDistrict} />
            ) : (
              <div className="district-map__loading">Loading map…</div>
            )}
            <div className="district-map__legend">
              {DISTRICT_SHADES.map((band) => (
                <span key={band.id} className="district-map__legend-item">
                  <span className="district-map__legend-swatch" style={{ background: band.color }} />
                  {band.label}
                </span>
              ))}
            </div>
            <p className="muted district-map__note">
              &ldquo;Mumbai&rdquo; on this map combines Mumbai City and Mumbai Suburban.
            </p>
            <p className="mono district-map__source">Source: {MAP_SOURCE}.</p>
          </div>

          <div className="district-map__panel">
            <span className="district-map__panel-name">{selectedDistrict}</span>
            {selectedDistrictData ? (
              <>
                <div className="district-map__panel-stats">
                  <div>
                    <span className="district-map__panel-value">{selectedDistrictData.count}</span>
                    <span className="muted">
                      recovery warrant{selectedDistrictData.count === 1 ? "" : "s"}
                    </span>
                  </div>
                  <div>
                    <span className="district-map__panel-value">{formatCr(selectedDistrictData.amount)}</span>
                    <span className="muted">total amount</span>
                  </div>
                </div>
                <div className="district-map__panel-builders">
                  <span className="district-map__panel-subhead">
                    {selectedDistrictData.builders.length} builder
                    {selectedDistrictData.builders.length === 1 ? "" : "s"} with warrants here
                  </span>
                  <ol className={buildersExpanded ? "district-map__panel-list district-map__panel-list--expanded" : "district-map__panel-list"}>
                    {(buildersExpanded
                      ? selectedDistrictData.builders
                      : selectedDistrictData.builders.slice(0, DISTRICT_BUILDERS_PREVIEW_COUNT)
                    ).map((builder, i) => (
                      <li key={`${builder.id || builder.name}-${i}`}>
                        {builder.id ? (
                          <Link to={`/builder/${builder.id}`}>{builder.name}</Link>
                        ) : (
                          <span>{builder.name}</span>
                        )}
                        <span className="muted">
                          {" "}
                          &mdash; {builder.count} warrant{builder.count === 1 ? "" : "s"}
                        </span>
                      </li>
                    ))}
                  </ol>
                  {!buildersExpanded && selectedDistrictData.builders.length > DISTRICT_BUILDERS_PREVIEW_COUNT && (
                    <button type="button" className="district-map__panel-expand" onClick={() => setBuildersExpanded(true)}>
                      Show all {selectedDistrictData.builders.length} builders
                    </button>
                  )}
                </div>
              </>
            ) : (
              districts && <p className="muted">No warrants scraped for this district yet.</p>
            )}
          </div>
        </div>
      </section>

      <section className="gap">
        <div className="gap__copy">
          <span className="eyebrow">THE GAP</span>
          <h2 className="section-title">The buyer won. The money never came.</h2>
          <p className="section-body">
            RERA closes a case when it rules. Whether the money ever reached the buyer sits inside legal PDFs nobody
            reads &mdash; and RERA organises by project, so a builder&#39;s pattern across projects stays invisible.
          </p>
        </div>
        <div className="gap__cards">
          <div className="gap__card gap__card--dashed">
            <span className="muted">What complaint counters show</span>
            <span className="gap__big-number">9</span>
            <span>complaints</span>
            <span className="muted gap__footnote">That&#39;s it. Illustrative example.</span>
          </div>
          <div className="gap__card gap__card--solid">
            <span className="muted">What we read from each order</span>
            <div className="gap__read-items">
              <div>
                <span className="gap__read-key">WHAT IT WAS ABOUT</span>
                <span>Delayed possession</span>
              </div>
              <div>
                <span className="gap__read-key">WHO WON</span>
                <span>Buyer</span>
              </div>
              <div>
                <span className="gap__read-key">WHAT WAS ORDERED</span>
                <span>Interest on paid amount</span>
              </div>
              <div>
                <span className="gap__read-key">DID THEY PAY?</span>
                <span>No &mdash; recovery warrant issued</span>
              </div>
            </div>
            <span className="muted gap__footnote">Illustrative example</span>
          </div>
        </div>
      </section>

      <section id="how" className="how">
        <div className="how__head">
          <div>
            <span className="eyebrow eyebrow--light">HOW IT&#39;S MADE</span>
            <h2 className="section-title section-title--light">
              We read the fine print, so you don&#39;t have to.
            </h2>
          </div>
          <p className="how__note">
            Five fixed steps, run ahead of time &mdash; not live. Every claim in a report links back to the order it
            came from.
          </p>
        </div>
        <div className="how__steps">
          {STEPS.map((step) => (
            <div key={step.n} className="how__step">
              <span className="how__step-n">{step.n}</span>
              <span className="how__step-title">{step.title}</span>
              <span className="how__step-body">{step.body}</span>
              <span className="how__step-out">{step.out}</span>
            </div>
          ))}
        </div>
      </section>

      <section id="builders" className="builders">
        <div className="builders__head">
          <div>
            <span className="eyebrow">BUILDERS</span>
            <h2 className="section-title">
              {detailed ? detailed.length : "…"} builder{detailed && detailed.length === 1 ? "" : "s"} with a
              MahaRERA record.
            </h2>
            <p className="section-body">
              {ordersReadCount !== null && warrantsOnlyCount !== null
                ? `${ordersReadCount} read order by order; ${warrantsOnlyCount} more have recovery warrants but no readable orders yet.`
                : "Every builder with a recovery warrant or a readable order."}
            </p>
          </div>
        </div>

        <div className="builders__controls">
          <div className="builders__tabs">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                className={`tab ${tab === t.id ? "tab--active" : ""}`}
                onClick={() => setTab(t.id)}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="builders__sort">
            <label htmlFor="list-sort">Sort</label>
            <select id="list-sort" value={sort} onChange={(event) => setSort(event.target.value)}>
              {SORTS.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.label}
                </option>
              ))}
            </select>
          </div>
        </div>

        <div className="builders-table">
          <div className="builders-table__row builders-table__row--head">
            <span>Builder</span>
            <span>Concern level</span>
            <span>Orders read</span>
            <span>Warrants</span>
            <span>Most common complaint</span>
            <span />
          </div>

          {detailed === null && <div className="builders-table__empty">Loading builders…</div>}

          {detailed !== null && tableRows.length === 0 && (
            <div className="builders-table__empty">No builders in this category yet.</div>
          )}

          {ordersReadRows.map((builder) => (
            <BuilderRow key={builder.builder_id} builder={builder} />
          ))}

          {warrantsOnlyRows.length > 0 && warrantsShownDirectly &&
            warrantsOnlyRows.map((builder) => <BuilderRow key={builder.builder_id} builder={builder} />)}

          {warrantsOnlyRows.length > 0 && !warrantsShownDirectly && !warrantsOnlyExpanded && (
            <button
              type="button"
              className="builders-table__toggle"
              aria-expanded={false}
              onClick={() => setWarrantsOnlyExpanded(true)}
            >
              {warrantsOnlyRows.length} more builders with warrants only ▾
            </button>
          )}

          {warrantsOnlyRows.length > 0 && !warrantsShownDirectly && warrantsOnlyExpanded && (
            <>
              <div className="builders-table__group-label">Warrants only — orders not read yet</div>
              {warrantsOnlyRows.map((builder) => (
                <BuilderRow key={builder.builder_id} builder={builder} />
              ))}
              <button
                type="button"
                className="builders-table__toggle"
                aria-expanded={true}
                onClick={() => setWarrantsOnlyExpanded(false)}
              >
                Show less ▴
              </button>
            </>
          )}

          <div className="builders-table__footer">
            <span>
              Showing {visibleCount} of {tableRows.length}
            </span>
          </div>
        </div>
      </section>

      <section id="method" className="trust">
        {TRUST.map((item) => (
          <div key={item.title} className="trust__card">
            <div className="trust__icon">
              <item.icon size={24} strokeWidth={1.75} />
            </div>
            <span className="trust__title">{item.title}</span>
            <span className="trust__body">{item.body}</span>
          </div>
        ))}
      </section>

      <section id="faq" className="faq">
        <h2 className="section-title">Questions buyers ask</h2>
        <div className="faq__list">
          {FAQS.map((item, i) => (
            <div key={item.q} className="faq__item">
              <button
                type="button"
                className="faq__question"
                aria-expanded={openFaq === i}
                onClick={() => setOpenFaq(openFaq === i ? null : i)}
              >
                <span>{item.q}</span>
                <svg width="20" height="20" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6">
                  {openFaq === i ? <path d="M4 10h12" /> : <path d="M10 4v12M4 10h12" />}
                </svg>
              </button>
              {openFaq === i && <p className="faq__answer">{item.a}</p>}
            </div>
          ))}
        </div>
      </section>

      <section className="cta">
        <h2 className="section-title">Buying a home takes months. Checking the builder takes a minute.</h2>
        <a href="#top" className="btn btn--primary">
          Check a builder
        </a>
      </section>

      <footer className="landing-footer">
        <div className="landing-footer__about">
          <span className="landing-footer__name">Builder Risk Check</span>
          <span>Flags things worth asking about. Not legal or investment advice. Maharashtra only. Data from public MahaRERA records.</span>
        </div>
        <div className="landing-footer__links">
          <a href="#method">Method</a>
          <a href="#faq">FAQ</a>
          <a href="#top">About</a>
        </div>
      </footer>
    </div>
  );
}
