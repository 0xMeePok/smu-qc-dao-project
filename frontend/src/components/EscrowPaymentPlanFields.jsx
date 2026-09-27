import { Field } from "./Field.jsx";

export function EscrowPaymentPlanFields({ form, disabled, error, onChange }) {
  return <fieldset className="field-group" disabled={disabled}>
    <legend>Escrow payment plan</legend>
    <Field htmlFor="proposal-tranches" label="Payment percentages" error={error} hint="Use 100 for one payment, or two to five percentages totaling 100, such as 20, 30, 50. Each payment follows the milestones described above.">
      {({ id, describedBy, invalid }) => <input id={id} value={form.tranchePercentages ?? "100"} maxLength={80} aria-invalid={invalid} aria-describedby={describedBy} onChange={event => onChange("tranchePercentages", event.target.value)} />}
    </Field>
    <Field htmlFor="proposal-review-days" label="Approval window in days" hint="Use one whole-day window for all payments, or one per payment (1–365 days). The first window is capped at seven days and the posting deadline.">
      {({ id, describedBy }) => <input id={id} value={form.reviewDays ?? "7"} maxLength={40} aria-describedby={describedBy} onChange={event => onChange("reviewDays", event.target.value)} />}
    </Field>
    <label><input type="checkbox" checked={form.funderVoting ?? false} onChange={event => onChange("funderVoting", event.target.checked)} /> Require a funding-weighted majority for later payments, in addition to both owners’ approvals</label>
    <p className="field-hint">The token, amount, milestones and payment plan are fixed when this proposal is created. Each proposal receives its own escrow.</p>
  </fieldset>;
}
