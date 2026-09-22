import { useLocation, useNavigate } from "react-router-dom";
import "./EmptyState.css";

const BUILDER_COUNT = 19;

// Used both as the /not-found route (query comes from router state, set by
// SearchScreen on an unmatched search) and inline inside ReportScreen when
// someone opens a /builder/:id link for an id that isn't in the dataset.
export default function EmptyState({ query: queryProp }) {
  const location = useLocation();
  const navigate = useNavigate();
  const query = queryProp ?? location.state?.query;

  return (
    <div className="page">
      <div className="page__inner empty-state">
        <h1 className="empty-state__title">Not in this prototype yet</h1>
        {query && (
          <p className="empty-state__query">
            No match for <strong>&ldquo;{query}&rdquo;</strong>.
          </p>
        )}
        <p className="muted">
          This prototype currently covers {BUILDER_COUNT} builders in Maharashtra. A builder not being listed here
          says nothing about their record either way -- it means they are not yet in this dataset.
        </p>
        <button type="button" className="empty-state__back" onClick={() => navigate("/")}>
          Back to search
        </button>
      </div>
    </div>
  );
}
