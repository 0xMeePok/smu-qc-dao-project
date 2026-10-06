import { formatInstant } from "../lib/datetime.js";
import { fundingApproachStatusLabel } from "../lib/fundingApproach.js";

const money = (item) => `${item.currency || ""} ${Number(item.amount ?? 0).toLocaleString()}`.trim();

/**
 * One party's funding approaches. `showFunder` is the researcher's incoming list;
 * the funder's sent list names the listing instead.
 */
export function FundingApproachList({ title, hint, empty, items = [], truncated = false, loading = false, error = "", onNavigate, showFunder = false, heading = "h2" }) {
  const Heading = heading === "h3" ? "h3" : "h2";
  return (
    <section className="card-table" aria-label={title}>
      <div className="table-header"><Heading>{title}</Heading></div>
      {hint && <p className="field-hint">{hint}</p>}
      {loading && <p role="status" className="table-empty">Loading funding approaches…</p>}
      {error && <p role="alert" className="error-banner">{error}</p>}
      {!loading && !error && items.length === 0 && <p className="table-empty">{empty}</p>}
      {!loading && !error && items.map((item) => (
        <div className="table-row" key={item.id}>
          <div>
            <strong>{item.proposalTitle || "Independent listing"}</strong>
            <small className="table-row-meta">
              {showFunder ? (item.funderName || "A client or funder") : "Sent by you"}
              {" · "}{money(item)} indicative · {fundingApproachStatusLabel(item.status)}
            </small>
            <small className="table-row-meta">Expires {formatInstant(item.expiresAt)}</small>
            {item.scope && <p>{item.scope}</p>}
            {item.message && <p>{item.message}</p>}
          </div>
          <div className="table-row-actions">
            <button type="button" className="text-button" onClick={() => onNavigate?.(`proposal/${item.proposalId}`)}>Open listing</button>
          </div>
        </div>
      ))}
      {truncated && <p className="field-hint">Showing a limited set of approaches. Open a listing for the full record.</p>}
    </section>
  );
}
