import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { funderOutcome } from "../components/FundingApproachList.jsx";
import { FundingApproachReceiptPane } from "../components/FundingApproachReceiptPane.jsx";
import { useAuth } from "../context/AuthContext.jsx";
import { formatCountdown, formatInstant, isExpired } from "../lib/datetime.js";
import { fundingApproachError, fundingApproachStatusLabel, getFundingApproach } from "../lib/fundingApproach.js";

const money = (item) => `${item.currency || ""} ${Number(item.amount ?? 0).toLocaleString()}`.trim();

function outcomeLine(record, status) {
  if (status === "pending") return "No decision recorded.";
  return funderOutcome(record, status);
}

export default function FundingApproachDetailPage({ approachId, onNavigate }) {
  const { user } = useAuth();
  const query = useQuery({
    queryKey: ["fundingApproach", approachId, user?.id],
    queryFn: () => getFundingApproach(approachId),
    enabled: Boolean(user?.id && approachId),
  });
  const record = query.data;
  const [now, setNow] = useState(() => new Date());
  const [receiptOpen, setReceiptOpen] = useState(false);
  const status = record?.status === "pending" && isExpired(record.expiresAt, now) ? "expired" : record?.status;
  const pending = status === "pending";
  useEffect(() => {
    if (!pending) return undefined;
    const timer = setInterval(() => setNow(new Date()), 60 * 1000);
    return () => clearInterval(timer);
  }, [pending]);
  const error = query.error ? fundingApproachError(query.error, "This approach could not be loaded. Please try again.") : "";

  if (!approachId) {
    return (
      <section className="page empty">
        <h1>This funding approach is no longer available</h1>
        <button className="secondary" type="button" onClick={() => onNavigate("proposals")}>Back to proposals</button>
      </section>
    );
  }

  return (
    <section className="page">
      <div className="page-heading">
        <span className="eyebrow">Legacy funding approach</span>
        <h1>{record?.proposalTitle || (query.isPending ? "Loading funding approach…" : "Funding approach")}</h1>
      </div>
      {query.isPending && <p role="status">Loading funding approach…</p>}
      {error && <p className="error-banner" role="alert">{error}</p>}
      <p className="field-hint">This funding approach is preserved as a read-only audit record. Independent listings now receive contributions through crowdfunding escrow.</p>
      {record && (
        <>
          <dl className="audit-receipt-grid">
            <div><dt>Listing</dt><dd>{record.proposalTitle || "Independent listing"}</dd></div>
            <div><dt>Funder</dt><dd>{record.funderName || "A client or funder"}</dd></div>
            <div><dt>Researcher</dt><dd>{record.researcherName || "The researcher"}</dd></div>
            <div><dt>Amount</dt><dd>{money(record)} indicative</dd></div>
            <div><dt>Status</dt><dd>{fundingApproachStatusLabel(status)}</dd></div>
            <div><dt>Outcome</dt><dd>{outcomeLine(record, status)}</dd></div>
            {pending && (
              <div>
                <dt>Time remaining</dt>
                <dd>{formatCountdown(record.expiresAt, now)} · Expires {formatInstant(record.expiresAt)}</dd>
              </div>
            )}
            {!pending && <div><dt>Expires</dt><dd>{formatInstant(record.expiresAt)}</dd></div>}
            {record.scope && <div><dt>Scope</dt><dd>{record.scope}</dd></div>}
            {record.message && <div><dt>Message</dt><dd>{record.message}</dd></div>}
          </dl>
          <div className="table-row-actions">
            <button type="button" className="text-button" onClick={() => setReceiptOpen(true)}>Audit receipt</button>
            <button type="button" className="text-button" onClick={() => onNavigate(`proposal/${record.proposalId}?tab=funding`)}>Open crowdfunding</button>
          </div>
        </>
      )}
      {receiptOpen && record && (
        <FundingApproachReceiptPane record={record} onClose={() => setReceiptOpen(false)} />
      )}
    </section>
  );
}
