import { Field } from "./Field.jsx";
import { HALF_UPFRONT_PERCENTAGES } from "../../../firebase/functions/escrowProposalTerms.js";
import { EscrowPaymentPlanSummary } from "./EscrowPaymentPlanSummary.jsx";
import { AUDIT_REGISTRY_CONFIG } from "../config/auditRegistry.js";

export function EscrowPaymentPlanFields({ form, disabled, error, onChange, grant = false }) {
  const terms = form.immutableFundingTerms;
  const percentages = terms ? terms.trancheBps.map(bps => bps / 100).join(", ") : HALF_UPFRONT_PERCENTAGES;
  const voting = grant ? false : terms?.funderVoting ?? form.funderVoting ?? false;
  const fixedSelectionWindow = AUDIT_REGISTRY_CONFIG.escrow?.escrowAbi?.some(item => item.type === "function" && item.name === "rejectSelection");
  const mainReviewHint = fixedSelectionWindow
    ? "Use one whole-day window for all payments, or one per payment (1–365 days). Both owners have a separate fixed seven-day window from selection for upfront approval. The completion window starts when the upfront payment is released; allow enough time to deliver the work and obtain approvals."
    : "Use one whole-day window for all payments, or one per payment (1–365 days). The first window is capped at seven days and the posting deadline. The completion window starts when the upfront payment is released; allow enough time to deliver the work and obtain approvals.";
  return <fieldset className="field-group escrow-plan" disabled={disabled}>
    <legend>Escrow payment plan</legend>
    <Field htmlFor="proposal-tranches" label="Payment percentages" error={error} hint={terms ? "This proposal’s payment split is fixed at creation." : "New proposals use a fixed split: 50% upfront and 50% on completion."}>
      {({ id, describedBy, invalid }) => <input id={id} value={percentages} readOnly aria-invalid={invalid} aria-describedby={describedBy} />}
    </Field>
    <Field htmlFor="proposal-review-days" label="Approval window in days" hint={grant ? "Use one whole-day window for all payments, or one per payment (1–365 days). Grant acceptance has a separate fixed seven-day window. The upfront payment window starts at acceptance; the completion window starts when the upfront payment is released." : mainReviewHint}>
      {({ id, describedBy }) => <input id={id} value={form.reviewDays ?? "7"} maxLength={40} aria-describedby={describedBy} onChange={event => onChange("reviewDays", event.target.value)} />}
    </Field>
    {grant ? <p className="field-hint">Grant payments use approval from the grant owner and proposal owner.</p> : <fieldset className="field-group" disabled={Boolean(terms)}>
      <legend>Completion approval</legend>
      <div className="radio-group">
        <label className={`radio-card${!voting ? " selected" : ""}`}><input type="radio" name="completion-approval" checked={!voting} onChange={() => onChange("funderVoting", false)} /> Both owners</label>
        <label className={`radio-card${voting ? " selected" : ""}`}><input type="radio" name="completion-approval" checked={voting} onChange={() => onChange("funderVoting", true)} /> Both owners and a funding-weighted majority of funders</label>
      </div>
    </fieldset>}
    <EscrowPaymentPlanSummary trancheBps={terms?.trancheBps} funderVoting={voting} />
    <p className="field-hint">The token, amount, milestones and payment plan are fixed when this proposal is created. Each proposal receives its own escrow.</p>
  </fieldset>;
}
