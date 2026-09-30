import { useCallback, useEffect, useState } from "react";
import { useAuth } from "../context/AuthContext.jsx";
import { listIndependentListings } from "../lib/proposals.js";
import { queueError } from "../lib/proposalQueues.js";
import { PROPOSAL_CATEGORIES, PROPOSAL_MATURITY_LEVELS } from "../config/proposal.js";
import { ExpiryCountdown } from "../components/ExpiryCountdown.jsx";
import { shortenAddress } from "../lib/chain.js";

const categoryLabel = (value) => PROPOSAL_CATEGORIES.find((item) => item.value === value)?.label ?? value ?? "—";
const maturityLabel = (value) => PROPOSAL_MATURITY_LEVELS.find((item) => item.value === value)?.label ?? value ?? "—";

export default function IndependentListingsPage({ onNavigate }) {
  const { isAuthenticated } = useAuth();
  const [items, setItems] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async (append = false, nextCursor = null) => {
    setLoading(true); setError("");
    try {
      const page = await listIndependentListings({ cursor: append ? nextCursor : null });
      const rows = page?.items ?? [];
      setItems((current) => append
        ? [...current, ...rows.filter((item) => !current.some((old) => old.id === item.id))]
        : rows);
      setCursor(page?.nextCursor ?? null);
    } catch (err) {
      setError(queueError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { if (isAuthenticated) load(); }, [isAuthenticated, load]);

  return (
    <section className="page discover-page">
      <div className="page-heading">
        <h1>Independent solutions.</h1>
        <p>Published listings that are not attached to an existing problem statement. Funders and clients can approach the author with funding while the listing window is open.</p>
      </div>

      {error && <p className="notice notice-error" role="alert">{error}</p>}
      {loading && items.length === 0 && <p className="table-empty" role="status">Loading independent listings…</p>}
      {!loading && !error && items.length === 0 && (
        <div className="discover-empty" role="status">
          <h2>No independent listings yet</h2>
          <p>Published, unexpired solutions will appear here. Open opportunities stay on Discover.</p>
          <button className="secondary" type="button" onClick={() => onNavigate("discover")}>Browse opportunities</button>
        </div>
      )}
      {items.length > 0 && (
        <div className="card-table">
          <div className="table-header">
            <h3>Open listings {items.length > 0 && <span className="count-pill">{items.length}</span>}</h3>
          </div>
          {items.map((item) => (
            <div className="table-row" key={item.id}>
              <div>
                <strong>{item.title || "Untitled listing"}</strong>
                <small className="table-row-meta">
                  {categoryLabel(item.category)} · {maturityLabel(item.maturity)}
                  {item.researcherId ? ` · ${shortenAddress(item.researcherId)}` : ""}
                </small>
                {item.summary ? <p className="field-hint">{item.summary}</p> : null}
              </div>
              <div className="table-row-actions">
                {item.amount ? <strong>{item.currency} {Number(item.amount).toLocaleString()}</strong> : null}
                <ExpiryCountdown expiresAt={item.expiresAt} status="submitted" showInstant={false} />
                <button className="text-button" type="button" onClick={() => onNavigate(`proposal/${item.id}`)}>View listing</button>
              </div>
            </div>
          ))}
        </div>
      )}
      {cursor && (
        <div className="discover-load-more">
          <button type="button" className="secondary" disabled={loading} onClick={() => load(true, cursor)}>
            {loading ? "Loading…" : "Load more listings"}
          </button>
        </div>
      )}
    </section>
  );
}
