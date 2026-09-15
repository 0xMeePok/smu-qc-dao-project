import { useState } from "react";
import { httpsCallable } from "firebase/functions";
import { functions } from "../lib/firebase.js";
import { EXPIRY_REASON_LABELS } from "../config/workflowStatus.js";

const REASONS = Object.entries(EXPIRY_REASON_LABELS);

export function ExpiryAdminUtility() {
  const [problemId, setProblemId] = useState("");
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");

  const requestConfirmation = (event) => {
    event.preventDefault();
    setError(""); setMessage("");
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(problemId)) {
      setError("Enter a valid opportunity reference.");
      return;
    }
    if (!reason) {
      setError("Select the required lapse reason.");
      return;
    }
    setConfirming(true);
  };

  const forceExpiry = async () => {
    if (!functions || busy) return;
    setBusy(true); setError(""); setMessage("");
    try {
      const { data } = await httpsCallable(functions, "adminForceExpireOpportunity")({
        problemId: problemId.trim(), reason,
      });
      setMessage(`Opportunity ${data.problemId} expired. Audit and refund hand-off recorded; no funds moved.`);
      setConfirming(false);
    } catch (requestError) {
      setError(requestError?.message || "The opportunity could not be force-expired.");
      setConfirming(false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="expiry-admin-utility" aria-labelledby="force-expiry-title">
      <span className="eyebrow">Expiry administration</span>
      <h2 id="force-expiry-title">Force-expire an opportunity</h2>
      <p>Marks an open opportunity expired and records the audit/refund hand-off. No funds move.</p>
      <form onSubmit={requestConfirmation} noValidate>
        <label htmlFor="force-expiry-problem-id">Opportunity reference</label>
        <input
          id="force-expiry-problem-id"
          value={problemId}
          onChange={(event) => setProblemId(event.target.value)}
          autoComplete="off"
          disabled={busy}
        />
        <label htmlFor="force-expiry-reason">Required lapse reason</label>
        <select
          id="force-expiry-reason"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
          disabled={busy}
        >
          <option value="">Select a reason</option>
          {REASONS.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
        </select>
        <button className="secondary" type="submit" disabled={busy}>Force expiry…</button>
      </form>
      {confirming && (
        <div className="warning-banner" role="alert">
          <p><strong>Confirm force expiry.</strong> This cannot be undone from the browser.</p>
          <div className="form-actions">
            <button type="button" className="secondary" onClick={() => setConfirming(false)} disabled={busy}>Cancel</button>
            <button type="button" className="danger-btn" onClick={forceExpiry} disabled={busy}>
              {busy ? "Recording…" : "Confirm force expiry"}
            </button>
          </div>
        </div>
      )}
      {error && <p className="error-banner" role="alert">{error}</p>}
      {message && <p className="proposal-success" role="status">{message}</p>}
    </section>
  );
}

export default ExpiryAdminUtility;
