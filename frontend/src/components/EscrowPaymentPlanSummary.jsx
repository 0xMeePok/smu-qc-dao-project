export function EscrowPaymentPlanSummary({ trancheBps = [5000, 5000], funderVoting = false }) {
  const halfUpfront = trancheBps.length === 2 && trancheBps.every(bps => bps === 5000);
  return <>
    <ol>
      <li><strong>{halfUpfront ? "50% upfront" : `${trancheBps[0] / 100}% first payment`}</strong>: released to the proposal owner once the full funding target is in escrow and both the problem owner and proposal owner approve the selection.</li>
      {trancheBps.length > 1 && <li><strong>{halfUpfront ? "50% on completion" : "Remaining payments"}</strong>: the proposal owner submits delivery evidence and confirms completion. The problem owner must review that evidence and accept the work as delivered before payment can be released.
        {funderVoting && <> Funders must also approve: yes votes must represent <strong>more than 50% of all contributed funds</strong>. Each funder’s voting weight is their total contribution. Exactly 50% is insufficient; abstentions do not reduce the threshold.</>}
      </li>}
    </ol>
    {trancheBps.length > 1 && <p className="field-hint">{funderVoting
      ? "Completion requires agreement from all three parties: the proposal owner, the problem owner, and the funders through a funding-weighted majority."
      : "Completion requires agreement from the proposal owner and the problem owner. Funders do not vote in this variant."} Replacing delivery evidence requires fresh approvals{funderVoting ? " and votes" : ""}.</p>}
    <p className="field-hint">Percentages are before platform fees. If the approval deadline passes, the unpaid balance becomes refundable to funders.</p>
  </>;
}
