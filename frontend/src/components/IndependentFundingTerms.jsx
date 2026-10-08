import { Field } from "./Field.jsx";

export function IndependentFundingTerms({ reviewDays, onChange, disabled, error, readOnly = false }) {
  return <fieldset className="field-group escrow-plan" disabled={disabled}>
    <legend>Independent crowdfunding terms</legend>
    <p>Funders deposit toward your target. Accept or decline before the listing closes once the target is reached. Accepting immediately pays 50% to your wallet.</p>
    <p>The remaining 50% is paid after you submit delivery evidence and funders holding more than half of all deposited funds vote yes. If funding is declined, the listing expires before acceptance, or unpaid work is cancelled, funders claim the refundable balance.</p>
    <p className="field-hint">Platform fees apply only to researcher payouts. Refunds have no additional platform fee.</p>
    <Field htmlFor="independent-completion-days" label="Completion period in days" error={error}
      hint="Starts when you accept funding. Submit your evidence and obtain the funder majority before this deadline.">
      {({ id, describedBy, invalid }) => <input id={id} type="number" inputMode="numeric" min="1" max="365" step="1"
        required value={reviewDays} disabled={readOnly} aria-invalid={invalid} aria-describedby={describedBy}
        onChange={event => onChange?.("reviewDays", event.target.value)} />}
    </Field>
    {readOnly && <p className="field-hint">Target, token, expiry and completion period stay fixed once the crowdfunding escrow is activated.</p>}
  </fieldset>;
}
