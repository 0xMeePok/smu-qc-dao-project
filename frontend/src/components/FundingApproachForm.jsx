import { useState } from "react";
import { CURRENCIES } from "../config/postingCategories.js";
import { formatInstant } from "../lib/datetime.js";
import {
  APPROACH_TEXT_MAX,
  dateTimeLocalValue,
  emptyFundingApproach,
  fundingApproachPayload,
  validateFundingApproach,
} from "../lib/fundingApproach.js";
import { Field } from "./Field.jsx";
import { Modal } from "./Modal.jsx";

/**
 * Indicative interest from a client or funder. This does not deposit tokens;
 * the escrow tab remains the place that moves funds.
 *
 * `onSubmit` records the approach, then asks the funder's wallet to anchor its hash.
 * `pendingAnchor` is a saved approach whose wallet signature has not been stored yet.
 */
export function FundingApproachForm({ proposal, onDismiss, onSubmit, pendingAnchor = null }) {
  const [form, setForm] = useState(() => emptyFundingApproach(proposal));
  const [errors, setErrors] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [openedAt] = useState(() => new Date());
  const listingCloses = formatInstant(proposal.expiresAt);
  const earliest = dateTimeLocalValue(openedAt.getTime() + 60_000);
  const latest = dateTimeLocalValue(proposal.expiresAt);

  const update = (key) => (event) => {
    const value = event.target.value;
    setForm((current) => ({ ...current, [key]: value }));
    setErrors((current) => {
      if (!current[key] && !current.form) return current;
      const next = { ...current };
      delete next[key];
      delete next.form;
      return next;
    });
  };

  const submit = async (event) => {
    event.preventDefault();
    if (!pendingAnchor) {
      const next = validateFundingApproach(form, { listingExpiresAt: proposal.expiresAt });
      setErrors(next);
      if (Object.keys(next).length) return;
    }
    if (typeof onSubmit !== "function") return;
    setSubmitting(true);
    try {
      await onSubmit(pendingAnchor ? null : fundingApproachPayload(form));
      onDismiss();
    } catch (err) {
      setErrors((current) => ({ ...current, form: err?.message || "This approach could not be sent." }));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal labelledBy="funding-approach-title" describedBy="funding-approach-desc" onDismiss={() => { if (!submitting) onDismiss(); }}>
      <form onSubmit={submit}>
        <div className="modal-head">
          <div>
            <h2 id="funding-approach-title">Approach with funding</h2>
            <p id="funding-approach-desc">Tell the researcher the funding you have in mind. This does not deposit tokens. Your wallet then anchors a hash of this approach so the interest and its time can be verified. The message stays off-chain.</p>
          </div>
        </div>
        <div className="modal-body">
          {pendingAnchor ? <p>This approach is saved. Sign the anchor so Arbitrum Sepolia records its hash and time. You will not be asked to send it again.</p> : <>
          <Field htmlFor="approach-amount" label="Indicative funding amount" error={errors.amount}>
            {({ id, describedBy, invalid }) => (
              <input id={id} type="number" inputMode="decimal" min="0.000001" max="1000000000" step="any" required
                value={form.amount} disabled={submitting} aria-invalid={invalid} aria-describedby={describedBy}
                onChange={update("amount")} />
            )}
          </Field>
          <Field htmlFor="approach-currency" label="Currency" error={errors.currency}>
            {({ id, describedBy, invalid }) => (
              <select id={id} value={form.currency} required disabled={submitting} aria-invalid={invalid} aria-describedby={describedBy}
                onChange={update("currency")}>
                {CURRENCIES.map((code) => <option key={code} value={code}>{code}</option>)}
              </select>
            )}
          </Field>
          <Field htmlFor="approach-scope" label="Intended scope or conditions" error={errors.scope} hint={`${APPROACH_TEXT_MAX} characters at most.`}>
            {({ id, describedBy, invalid }) => (
              <textarea id={id} rows={3} maxLength={APPROACH_TEXT_MAX} required value={form.scope} disabled={submitting}
                aria-invalid={invalid} aria-describedby={describedBy} onChange={update("scope")} />
            )}
          </Field>
          <Field htmlFor="approach-message" label="Message to the researcher" error={errors.message} hint={`${APPROACH_TEXT_MAX} characters at most.`}>
            {({ id, describedBy, invalid }) => (
              <textarea id={id} rows={4} maxLength={APPROACH_TEXT_MAX} required value={form.message} disabled={submitting}
                aria-invalid={invalid} aria-describedby={describedBy} onChange={update("message")} />
            )}
          </Field>
          <Field htmlFor="approach-expiry" label="Approach expires" error={errors.expiresAt} hint={`In the future, and no later than the listing closes (${listingCloses}).`}>
            {({ id, describedBy, invalid }) => (
              <input id={id} type="datetime-local" required value={form.expiresAt} min={earliest || undefined} max={latest || undefined} disabled={submitting}
                aria-invalid={invalid} aria-describedby={describedBy} onChange={update("expiresAt")} />
            )}
          </Field>
          </>}
          {errors.form ? <p className="error-banner" role="alert">{errors.form}</p> : null}
        </div>
        <div className="modal-actions">
          <button className="secondary" type="button" disabled={submitting} onClick={onDismiss}>Cancel</button>
          <button className="primary" type="submit" disabled={submitting}>{submitting ? (pendingAnchor ? "Waiting for your wallet…" : "Sending…") : (pendingAnchor ? "Sign anchor" : "Send approach")}</button>
        </div>
      </form>
    </Modal>
  );
}
