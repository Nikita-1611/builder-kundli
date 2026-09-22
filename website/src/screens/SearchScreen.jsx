import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { fetchBuilderIndex } from "../lib/builders";
import { suggestBuilders, findExactMatch } from "../lib/search";
import "./SearchScreen.css";

const CHIP_COUNT = 6;

export default function SearchScreen() {
  const navigate = useNavigate();
  const [index, setIndex] = useState(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    let cancelled = false;
    fetchBuilderIndex().then((data) => {
      if (!cancelled) setIndex(data);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // Search only ever surfaces builders whose orders were actually read --
  // a warrant-only builder has a points total but no "what happened" to
  // show, and this product's point is showing what happened. Those
  // builders stay in builders/*.json and are still reachable by a direct
  // /builder/:id link (ReportScreen shows a note there instead), just
  // never suggested here.
  const searchableIndex = useMemo(() => (index ? index.filter((entry) => entry.order_count > 0) : []), [index]);

  const suggestions = useMemo(() => suggestBuilders(query, searchableIndex), [query, searchableIndex]);

  // Shown when the input is empty, as a way to explore the tool without
  // typing a name -- the builders with the most on record, so a first-time
  // visitor immediately sees what the report actually looks like.
  const suggestedChips = useMemo(() => {
    return [...searchableIndex].sort((a, b) => b.score - a.score).slice(0, CHIP_COUNT);
  }, [searchableIndex]);

  function goToBuilder(id) {
    navigate(`/builder/${id}`);
  }

  function handleSubmit(event) {
    event.preventDefault();
    if (!index) return;
    const exact = findExactMatch(query, searchableIndex);
    if (exact) {
      goToBuilder(exact.id);
      return;
    }
    if (suggestions.length > 0) {
      goToBuilder(suggestions[0].id);
      return;
    }
    navigate("/not-found", { state: { query } });
  }

  return (
    <div className="page">
      <div className="page__inner search-screen">
        <h1 className="search-screen__title">Check a builder's record</h1>
        <p className="muted search-screen__subtitle">
          Search a Maharashtra real estate developer to see their MahaRERA order and recovery-warrant history.
        </p>

        <form className="search-screen__form" onSubmit={handleSubmit} role="search">
          <input
            type="text"
            inputMode="search"
            autoComplete="off"
            className="search-screen__input"
            placeholder="Builder or company name"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            aria-label="Builder or company name"
          />
          <button type="submit" className="search-screen__submit">
            Search
          </button>
        </form>

        {query && suggestions.length > 0 && (
          <ul className="search-screen__suggestions" role="listbox">
            {suggestions.map((entry) => (
              <li key={entry.id}>
                <button type="button" className="search-screen__suggestion" onClick={() => goToBuilder(entry.id)}>
                  {entry.name}
                </button>
              </li>
            ))}
          </ul>
        )}

        {!query && suggestedChips.length > 0 && (
          <div className="search-screen__chips-block">
            <p className="muted search-screen__chips-label">Or try one of these</p>
            <div className="search-screen__chips">
              {suggestedChips.map((entry) => (
                <button key={entry.id} type="button" className="chip" onClick={() => goToBuilder(entry.id)}>
                  {entry.name}
                </button>
              ))}
            </div>
          </div>
        )}

        {index && (
          <p className="muted search-screen__scope-note">
            This prototype currently covers {searchableIndex.length} builders in Maharashtra with a readable order.
          </p>
        )}
      </div>
    </div>
  );
}
