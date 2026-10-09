import { contributionError } from "../lib/contributionValidation.js";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { QueryClientContext } from "@tanstack/react-query";
import { useAccount } from "wagmi";
import { useAuth } from "../context/AuthContext.jsx";
import { invalidateFundingDashboardSummaries } from "../lib/fundingDashboardCache.js";
import { AUDIT_REGISTRY_CHAIN_ID } from "../config/auditRegistry.js";
import { getIndependentFundingState, independentFundingAmount, independentFundingExplorer, independentFundingStatus,
  independentFundingDeploymentKey, independentFundingError, confirmIndependentFundingTransaction,
  syncIndependentFunding, writeIndependentFundingAction } from "../lib/independentEscrow.js";
import { ConnectWalletModal } from "./ConnectWalletModal.jsx";
import { Field } from "./Field.jsx";

const pending = new Map();
const pendingKey = (id, wallet) => `qcdao:independent-funding:v1:${independentFundingDeploymentKey()}:${id}:${wallet ?? ""}`;
function pendingTransaction(key) {
  try { return JSON.parse(sessionStorage.getItem(key)) || pending.get(key) || null; } catch { return pending.get(key) || null; }
}
function savePending(key, value) {
  if (value) pending.set(key, value); else pending.delete(key);
  try { if (value) sessionStorage.setItem(key, JSON.stringify(value)); else sessionStorage.removeItem(key); } catch { /* Keep it in this tab. */ }
}
const instant = seconds => Number(seconds) > 0 ? new Date(Number(seconds) * 1000).toLocaleString() : "—";

export function IndependentFundingView({ snapshot, loading, error, busy, progress, notice, walletReady, onConnect,
  amount, onAmount, delivery, onDelivery, reason = "", onReason, onAction, onRefresh, unresolved, onConfirm, integrityBlocked = false }) {
  const summary = snapshot?.summary, actions = snapshot?.actions ?? {}, wallet = snapshot?.wallet ?? {};
  const disabled = loading || busy || !walletReady || Boolean(unresolved);
  const remaining = summary ? BigInt(summary.fundingTarget ?? summary.target ?? 0) - BigInt(summary.totalDeposited ?? 0) : null;
  const amountError = summary ? contributionError({ amount, decimals: summary.tokenDecimals, symbol: summary.tokenSymbol, remaining }) : "";
  const money = value => independentFundingAmount(value, summary?.tokenDecimals, summary?.tokenSymbol);
  const button = (action, label, extra = {}) => actions[action] ? <button type="button" className="primary small"
    disabled={disabled || (action === "deposit" && (!String(amount ?? "").trim() || Boolean(amountError))) || (integrityBlocked && !["claimRefund", "expire"].includes(action))} onClick={() => onAction(action, extra)}>{label}</button> : null;
  return <section className="card escrow-funding" aria-label="Independent crowdfunding">
    <div className="table-header"><div><h3>Independent crowdfunding</h3><p>50% on researcher acceptance · 50% after funder completion approval</p></div>
      <button type="button" className="secondary small" disabled={loading || busy} onClick={onRefresh}>Refresh crowdfunding</button></div>
    {loading && <p role="status">Reading confirmed crowdfunding status…</p>}
    {error && <p role="alert" className="error-banner">{error}</p>}
    {notice && <p role="status" className="proposal-success">{notice}</p>}
    {progress && <p role="status">{progress.status === "awaiting_signature" ? ["approve", "resetAllowance"].includes(progress.action)
      ? "Approve the exact contribution amount in your wallet." : "Confirm this crowdfunding action in your wallet."
      : progress.status === "pending" ? "Transaction submitted. Waiting for confirmation…" : progress.status === "confirmed" ? "Transaction confirmed." : "Preparing verified crowdfunding action…"}</p>}
    {unresolved && <p role="alert">A wallet transaction is awaiting confirmation. <a href={independentFundingExplorer("tx", unresolved.transactionHash)} target="_blank" rel="noreferrer">View transaction</a>{" "}
      <button type="button" className="secondary small" disabled={busy} onClick={onConfirm}>Retry confirmation</button></p>}
    {!walletReady && <p className="field-hint">Connect the wallet for your signed-in account on Arbitrum Sepolia. <button type="button" className="text-button" onClick={onConnect}>Connect wallet</button></p>}
    {!loading && snapshot?.configured === false && <p className="field-hint">Independent crowdfunding is awaiting its contract deployment.</p>}
    {!loading && snapshot?.hidden && <p className="field-hint">This listing's funding actions are unavailable. Any confirmed available refund can still be claimed.</p>}
    {!loading && snapshot?.configured !== false && snapshot?.exists === false && <div className="field-group">
      <p>The researcher can activate crowdfunding for this published listing. Activation fixes the target, token, listing expiry and completion period.</p>
      {button("activate", "Activate crowdfunding")}
    </div>}
    {summary && <>
      <p><strong>{independentFundingStatus(snapshot).label}</strong>{summary.escrowAddress && <> · <a href={independentFundingExplorer("address", summary.escrowAddress)} target="_blank" rel="noreferrer">Escrow contract</a></>}</p>
      <dl className="settings-group">
        <div className="settings-row"><dt>Funded / target</dt><dd>{money(summary.totalDeposited)} / {money(summary.fundingTarget ?? summary.target)}</dd></div>
        <div className="settings-row"><dt>Released before payout fees</dt><dd>{money(summary.totalReleased)}</dd></div>
        {summary.feePaid != null && <div className="settings-row"><dt>Researcher received after fees</dt><dd>{money(BigInt(summary.totalReleased) - BigInt(summary.feePaid))}</dd></div>}
        <div className="settings-row"><dt>Held for unpaid work</dt><dd>{money(summary.outstandingBalance)}</dd></div>
        <div className="settings-row"><dt>Your contribution</dt><dd>{money(wallet.deposited)}</dd></div>
        <div className="settings-row"><dt>Your available refund</dt><dd>{money(wallet.claimable)}</dd></div>
        <div className="settings-row"><dt>Fund and accept by</dt><dd>{instant(summary.expiresAt)}</dd></div>
        {Number(summary.completionDeadline) > 0 && <div className="settings-row"><dt>Complete and approve by</dt><dd>{instant(summary.completionDeadline)}</dd></div>}
      </dl>
      {actions.deposit && <div className="field-group">
        <Field htmlFor="independent-contribution" label={`Contribution (${summary.tokenSymbol})`} hint={`Still needed: ${money(remaining)}. Your wallet approves only the entered amount, then deposits it into this listing's escrow.`} error={amountError}>
          {({ id, describedBy, invalid }) => <input id={id} aria-invalid={invalid} type="text" inputMode="decimal" value={amount} maxLength={160} disabled={disabled}
            aria-describedby={describedBy} onChange={event => onAmount(event.target.value)} />}
        </Field>{button("deposit", "Fund independent listing", { amount })}
      </div>}
      {(actions.accept || actions.decline) && <div className="field-group"><h4>Researcher funding decision</h4>
        <p>The funding target has been reached. Accepting releases 50% immediately and starts your completion period. Declining makes every contribution refundable.</p>
        {button("accept", "Accept funding and release 50%")}
        {actions.decline && <Field htmlFor="independent-decline-reason" label="Reason for declining funding" hint="10–2,000 characters. A hash of your reason is recorded with the decline.">
          {({ id, describedBy }) => <textarea id={id} minLength={10} maxLength={2000} value={reason} disabled={disabled} aria-describedby={describedBy}
            onChange={event => onReason(event.target.value)} />}</Field>}
        {button("decline", "Decline funding and enable refunds", { reason })}
      </div>}
      {snapshot.evidence && <div className="field-group"><h4>Delivery evidence</h4><p>{snapshot.evidence.summary}</p>
        <a href={snapshot.evidence.url} target="_blank" rel="noreferrer">Open delivery evidence</a></div>}
      {actions.submitEvidence && <div className="field-group"><h4>Submit delivery evidence</h4>
        <Field htmlFor="independent-delivery-summary" label="Delivery summary">{({ id }) => <textarea id={id} maxLength={4000} value={delivery.summary} disabled={disabled}
          onChange={event => onDelivery({ ...delivery, summary: event.target.value })} />}</Field>
        <Field htmlFor="independent-delivery-url" label="Evidence link (HTTPS)">{({ id }) => <input id={id} type="url" maxLength={2048} value={delivery.url} disabled={disabled}
          onChange={event => onDelivery({ ...delivery, url: event.target.value })} />}</Field>
        {button("submitEvidence", "Submit evidence for funder vote", { evidence: delivery })}
      </div>}
      {Number(summary.completionDeadline) > 0 && <p className="field-hint">Completion needs yes votes weighted by more than 50% of all deposited funds. Current yes weight: {money(summary.yesWeight)} of {money(summary.totalDeposited)}.</p>}
      {actions.vote && <div className="field-group"><h4>Funder completion vote</h4><p>Review the submitted evidence. Your vote is weighted by your deposited contribution. The yes vote that takes approval above 50% releases the final payment immediately.</p>
        {button("vote", "Vote yes for completion", { evidenceHash: summary.evidenceHash, approve: true })}
        {button("vote", "Vote no for completion", { evidenceHash: summary.evidenceHash, approve: false })}
      </div>}
      {wallet.hasVoted && <p className="field-hint">Your completion vote is recorded.</p>}
      {actions.releaseCompletion && <div className="field-group"><p>The required funder majority has approved this evidence. Confirm the final payment to release the remaining 50%.</p>
        {button("releaseCompletion", "Release final 50%")}</div>}
      {button("claimRefund", "Claim my refund")}
      <p className="field-hint">Platform fees apply only to researcher payouts. Refunds have no additional platform fee.</p>
    </>}
  </section>;
}

export function IndependentFundingPanel({ proposal, onStateChange, refreshVersion = 0, initialTransaction = null, integrityBlocked = false }) {
  const { user } = useAuth(), { address, isConnected, chainId } = useAccount();
  const queryClient = useContext(QueryClientContext);
  const [snapshot, setSnapshot] = useState(null), [loading, setLoading] = useState(true), [error, setError] = useState("");
  const [busy, setBusy] = useState(false), [progress, setProgress] = useState(null), [notice, setNotice] = useState("");
  const [amount, setAmount] = useState(""), [delivery, setDelivery] = useState({ summary: "", url: "" }), [connect, setConnect] = useState(false);
  const [reason, setReason] = useState("");
  const key = pendingKey(proposal.id, user?.id?.toLowerCase());
  const [unresolved, setUnresolved] = useState(() => initialTransaction || pendingTransaction(key));
  const activeKey = useRef(key); activeKey.current = key;
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const version = useRef(0), change = useRef(onStateChange); change.current = onStateChange;
  const walletReady = Boolean(isConnected && address?.toLowerCase() === user?.id?.toLowerCase() && chainId === AUDIT_REGISTRY_CHAIN_ID);
  const load = useCallback(async () => {
    const current = ++version.current; setLoading(true); setError("");
    try { const next = await getIndependentFundingState({ proposalId: proposal.id });
      if (alive.current && activeKey.current === key && current === version.current) { setSnapshot(next); change.current?.(next); }
    } catch (err) { if (alive.current && activeKey.current === key && current === version.current) { setSnapshot(null); change.current?.(null); setError(independentFundingError(err, { reading: true })); } }
    finally { if (alive.current && activeKey.current === key && current === version.current) setLoading(false); }
  }, [proposal.id, user?.id, key]);
  useEffect(() => { setSnapshot(null); setNotice(""); setProgress(null); setBusy(false); setUnresolved(initialTransaction || pendingTransaction(key));
    if (initialTransaction) savePending(key, initialTransaction); void load();
    return () => { ++version.current; }; }, [load, key, refreshVersion]);
  const currentPanel = () => alive.current && activeKey.current === key;
  const remember = value => { savePending(key, value); if (currentPanel()) setUnresolved(value); };
  const sync = async (transactionHash, action) => {
    const next = !["approve", "resetAllowance"].includes(action)
      ? await syncIndependentFunding({ proposalId: proposal.id, transactionHash }) : null;
    invalidateFundingDashboardSummaries(queryClient);
    remember(null);
    if (currentPanel()) {
      if (next?.configured && typeof next.exists === "boolean"
          && (!next.summary?.proposalId || next.summary.proposalId === proposal.id)) {
        // Sync already verified this confirmed state. Supersede older background reads.
        ++version.current; setSnapshot(next); setLoading(false); setError(""); change.current?.(next);
      } else await load(); // Approvals and older backend responses still need a fresh read.
    }
    queryClient?.invalidateQueries({ queryKey: ["actionItems"] });
    queryClient?.invalidateQueries({ queryKey: ["developerDashboard"] });
  };
  const act = async (action, extra = {}) => {
    if (busy || unresolved || (integrityBlocked && !["claimRefund", "expire"].includes(action))) return;
    if (!walletReady) { setConnect(true); return; }
    setBusy(true); setError(""); setNotice("");
    try {
      const result = await writeIndependentFundingAction({ proposalId: proposal.id, action, account: address, ...extra,
        onChange: next => { if (currentPanel()) setProgress(next); if (next.status === "pending") remember({ transactionHash: next.transactionHash, action: next.action });
          if (next.status === "confirmed" && ["approve", "resetAllowance"].includes(next.action)) remember(null); } });
      await sync(result.transactionHash, action); if (currentPanel()) setNotice("Crowdfunding transaction confirmed.");
    } catch (err) { if (err.transactionHash && !err.transactionSettled) remember({ transactionHash: err.transactionHash, action: err.action || action });
      else if (err.transactionSettled) remember(null); if (currentPanel()) setError(independentFundingError(err, { transactionHash: pendingTransaction(key)?.transactionHash })); }
    finally { if (currentPanel()) { setBusy(false); setProgress(null); } }
  };
  const confirm = async () => {
    if (busy || !unresolved) return; setBusy(true); setError("");
    try { const result = await confirmIndependentFundingTransaction(unresolved.transactionHash); await sync(result.transactionHash, unresolved.action); if (currentPanel()) setNotice("Crowdfunding transaction confirmed."); }
    catch (err) { if (err.transactionSettled) remember(null); if (currentPanel()) setError(independentFundingError(err, { transactionHash: pendingTransaction(key)?.transactionHash })); }
    finally { if (currentPanel()) setBusy(false); }
  };
  return <><IndependentFundingView snapshot={snapshot} loading={loading} error={error} busy={busy} progress={progress} notice={notice}
    walletReady={walletReady} onConnect={() => setConnect(true)} amount={amount} onAmount={setAmount} delivery={delivery} onDelivery={setDelivery}
    reason={reason} onReason={setReason}
    integrityBlocked={integrityBlocked} onAction={act} onRefresh={load} unresolved={unresolved} onConfirm={confirm} />
    {connect && <ConnectWalletModal onClose={() => setConnect(false)} />}</>;
}
