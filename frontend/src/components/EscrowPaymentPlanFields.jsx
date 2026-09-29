import { Field } from "./Field.jsx";
import { HALF_UPFRONT_PERCENTAGES } from "../../../firebase/functions/escrowProposalTerms.js";
import { EscrowPaymentPlanSummary } from "./EscrowPaymentPlanSummary.jsx";

export function EscrowPaymentPlanFields({ form, disabled, error, onChange }) {
  const terms = form.immutableFundingTerms;
  const percentages = terms ? terms.trancheBps.map(bps => bps / 100).join(", ") : HALF_UPFRONT_PERCENTAGES;
  const voting = terms?.funderVoting ?? form.funderVoting ?? false;
  return <fieldset className="field-group" disabled={disabled}>
    <legend>Escrow payment plan</legend>
    <Field htmlFor="proposal-tranches" label="Payment percentages" error={error} hint={terms ? "This proposal’s payment split is fixed at creation." : "New proposals use a fixed split: 50% upfront and 50% on completion."}>
      {({ id, describedBy, invalid }) => <input id={id} value={percentages} readOnly aria-invalid={invalid} aria-describedby={describedBy} />}
    </Field>
    <Field htmlFor="proposal-review-days" label="Approval window in days" hint="Use one whole-day window for all payments, or one per payment (1–365 days). The first window is capped at seven days and the posting deadline. The completion window starts when the upfront payment is released; allow enough time to deliver the work and obtain approvals.">
      {({ id, describedBy }) => <input id={id} value={form.reviewDays ?? "7"} maxLength={40} aria-describedby={describedBy} onChange={event => onChange("reviewDays", event.target.value)} />}
    </Field>
    <fieldset className="field-group" disabled={Boolean(terms)}>
      <legend>Completion approval</legend>
      <div className="radio-group">
        <label className={`radio-card${!voting ? " selected" : ""}`}><input type="radio" name="completion-approval" checked={!voting} onChange={() => onChange("funderVoting", false)} /> Both owners</label>
        <label className={`radio-card${voting ? " selected" : ""}`}><input type="radio" name="completion-approval" checked={voting} onChange={() => onChange("funderVoting", true)} /> Both owners and a funding-weighted majority of funders</label>
      </div>
    </fieldset>
    <EscrowPaymentPlanSummary trancheBps={terms?.trancheBps} funderVoting={voting} />
    <p className="field-hint">The token, amount, milestones and payment plan are fixed when this proposal is created. Each proposal receives its own escrow.</p>
  </fieldset>;
}
