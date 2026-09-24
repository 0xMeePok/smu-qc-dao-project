import { useEffect, useState } from "react";
import { Field } from "./Field.jsx";
import { formatInstant } from "../lib/datetime.js";
import {
  OWNER_REVIEW_OUTCOMES,
  listOwnerReviews,
  ownerReviewError,
  ownerReviewLabel,
  recordOwnerReview,
} from "../lib/ownerReviews.js";

function shortWallet(address) {
  const value = String(address ?? "");
  return value.length > 12 ? `${value.slice(0, 6)}…${value.slice(-4)}` : value;
}

/** Owner-only interim review. Recording an outcome does not select or reject a winner. */
export function OwnerReviewPanel({ proposalId, canRecord = false, revisionPathOpen = false }) {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [outcome, setOutcome] = useState("feedback");
  const [rationale, setRationale] = useState("");
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError("");
    listOwnerReviews(proposalId)
      .then((data) => { if (!cancelled) setItems(data?.items ?? []); })
      .catch((err) => { if (!cancelled) setError(ownerReviewError(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [proposalId]);

  const submit = async (event) => {
    event.preventDefault();
    const text = rationale.trim();
    if (text.length < 10 || text.length > 2000) {
      setError("Review rationale must contain 10–2000 characters.");
      return;
    }
    if (outcome === "revision_requested" && !revisionPathOpen) {
      setError("Revisions can be requested only while the developer can still edit and resubmit this proposal. Record feedback instead.");
      return;
    }
    setBusy(true); setError("");
    try {
      const saved = await recordOwnerReview({ proposalId, outcome, rationale: text, requestId });
      setItems((current) => [saved, ...current.filter((item) => item.id !== saved.id)]);
      setRationale("");
      setRequestId(crypto.randomUUID());
    } catch (err) {
      setError(ownerReviewError(err));
    } finally {
      setBusy(false);
    }
  };

  const latest = items[0];
  const showRevisionBanner = !canRecord && latest?.outcome === "revision_requested" && latest.correctionPathOpen;
  if (!canRecord && loading) return null;
  if (!canRecord && !error && !items.length) return null;

  return <div className="detail-section">
    <h2>Owner review</h2>
    <p className="field-hint">Written feedback from the designated problem owner. It does not select or reject a winner.</p>
    {loading && <p role="status">Loading owner review…</p>}
    {error && <p className="error-banner" role="alert">{error}</p>}
    {showRevisionBanner && <p role="status">The problem owner requested revisions. Edit the proposal and resubmit. Their rationale is below.</p>}
    {canRecord && <form onSubmit={submit}>
      <Field htmlFor="owner-review-outcome" label="Outcome" hint={revisionPathOpen ? "A revision request sends the developer back to edit and resubmit." : "Request revisions is available only while the developer can still edit this proposal."}>
        {({ id, describedBy }) => <select id={id} value={outcome} aria-describedby={describedBy} disabled={busy} onChange={(event) => setOutcome(event.target.value)}>
          {OWNER_REVIEW_OUTCOMES.map(([value, label]) => <option key={value} value={value} disabled={value === "revision_requested" && !revisionPathOpen}>{label}</option>)}
        </select>}
      </Field>
      <Field htmlFor="owner-review-rationale" label="Rationale" hint="Required. 10–2000 characters. The developer sees this on their proposal.">
        {({ id, describedBy, invalid }) => <textarea id={id} rows={4} value={rationale} minLength={10} maxLength={2000} required disabled={busy} aria-describedby={describedBy} aria-invalid={invalid} onChange={(event) => { setRationale(event.target.value); setError(""); }} />}
      </Field>
      <button className="primary" type="submit" disabled={busy}>{busy ? "Saving…" : "Record review"}</button>
    </form>}
    {items.length > 0 && <ol className="revision-trail">
      {items.map((item) => <li key={item.id}>
        <p><strong>{ownerReviewLabel(item.outcome)}</strong> · <time>{formatInstant(item.createdAt)}</time></p>
        <p className="table-row-meta">By {shortWallet(item.actorId)} · {item.actorRole === "problem_owner" ? "Problem owner" : item.actorRole}</p>
        <p className="proposal-text">{item.rationale}</p>
      </li>)}
    </ol>}
  </div>;
}
