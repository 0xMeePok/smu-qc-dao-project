/** A mined transaction is only the first half of publishing a submission. */
export function SubmissionProgress({ audit, saving, entityLabel, editing = false }) {
  // Only pass the result of the live anchor operation, never a stored receipt
  // or an intermediate status callback from an earlier attempt.
  if (audit?.status !== "confirmed" || !/^0x[\da-f]{64}$/i.test(audit.transactionHash ?? "")
    || !(Number(audit.blockNumber) > 0)) return null;
  const subject = editing ? "Changes" : entityLabel;
  return <section className="audit-receipt" aria-label="Submission progress">
    <h2>{saving ? `Saving ${subject.toLowerCase()}…` : `Transaction confirmed; ${subject.toLowerCase()} not saved`}</h2>
    <p role="status">{saving
      ? "Your transaction is confirmed on Arbitrum Sepolia. The submission is complete only after the save succeeds."
      : "Your transaction remains on Arbitrum Sepolia, but the app has not saved this submission. Your entries are still on this page."}</p>
    {audit.transactionHash && <a className="text-button audit-explorer-link"
      href={`https://sepolia.arbiscan.io/tx/${audit.transactionHash}`} target="_blank" rel="noreferrer">
      View confirmed transaction on Arbiscan
    </a>}
  </section>;
}
