import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { QueryClientContext } from "@tanstack/react-query";
import { formatUnits, keccak256, stringToHex } from "viem";
import { useAccount } from "wagmi";
import { useAuth } from "../context/AuthContext.jsx";
import { AUDIT_REGISTRY_CHAIN_ID, AUDIT_REGISTRY_CONFIG } from "../config/auditRegistry.js";
import { isModerated } from "../lib/moderation.js";
import { confirmEscrowTransaction, escrowErrorMessage, hashEscrowEvidence, readEscrow, writeEscrowAction } from "../lib/escrow.js";
import { loadEscrowEvidence, saveEscrowEvidence } from "../lib/escrowEvidence.js";
import { ConnectWalletModal } from "./ConnectWalletModal.jsx";
import { Field } from "./Field.jsx";
import { getEscrowFundingHistory, prepareEscrowDeposit, startEscrowSettlement, syncEscrowFunding } from "../lib/escrowFunding.js";
import { EscrowFundingHistory } from "./EscrowFundingHistory.jsx";
import { ExpiryCountdown } from "./ExpiryCountdown.jsx";
import { ACTION_ITEMS_KEY } from "../lib/proposalQueues.js";
import { canApproachIndependentListing } from "../lib/independentFunding.js";
import { isIndependentProposal } from "../config/proposal.js";

const STATE_LABELS = ["Open for funding", "Awaiting upfront approval", "Fully paid", "Refunded", "Cancelled", "Expired", "Delivery in progress", "Voided"];
const explorer = (type, value) => `https://sepolia.arbiscan.io/${type}/${value}`;
const nonzero = value => value && !/^0x0{64}$/i.test(value);
const instant = seconds => seconds > 0n ? new Date(Number(seconds) * 1000).toLocaleString() : "—";
const refundActions = new Set(["claimRefund", "expire", "refundInvalidated"]);
const pendingTransactions = new Map();
const pendingKey = (proposalId, account) => `qcdao:escrow-pending:${AUDIT_REGISTRY_CHAIN_ID}:${AUDIT_REGISTRY_CONFIG.address}:${proposalId}:${account?.toLowerCase() ?? ""}`;
function savedTransaction(key) {
  let hash;
  try { hash = sessionStorage.getItem(key); } catch { hash = pendingTransactions.get(key); }
  return /^0x[0-9a-f]{64}$/i.test(hash ?? "") ? hash : null;
}
function saveTransaction(key, hash) {
  if (hash) pendingTransactions.set(key, hash); else pendingTransactions.delete(key);
  try { if (hash) sessionStorage.setItem(key, hash); else sessionStorage.removeItem(key); } catch { /* The current tab still retains the pending hash. */ }
}

export function EscrowFundingView({ state, evidence, loading, error, busy, progress, walletReady, walletMessage,
  amount, setAmount, delivery, setDelivery, onAction, onRefresh, onConnect, unresolvedTransaction, onConfirm, moderated,
  fundingBlockReason, notice, settlement, onSettle, onSync, rejectionReason = "", setRejectionReason, canDeposit = true }) {
  const money = units => `${formatUnits(units ?? 0n, state?.decimals ?? 6)} ${state?.symbol ?? ""}`;
  const disabled = busy || !walletReady || loading || Boolean(unresolvedTransaction);
  const evidenceReady = evidence && state?.currentMilestone?.evidenceHash === evidence.hash;
  const grantWaiting = state?.isGrant && state.state === 0;
  const grantMessage = "Grant funding moves into this escrow when the researcher accepts the selected offer.";
  const settlementMessage = grantWaiting && ["waiting", "not_ready", "waiting_approval"].includes(settlement?.status) ? grantMessage : settlement?.message;
  const action = (name, label, extra = {}, allowed = state?.can[name]) => <button type="button" className="primary small"
    disabled={disabled || !allowed || (name === "deposit" && Boolean(fundingBlockReason)) || (moderated && !refundActions.has(name))} onClick={() => onAction(name, extra)}>{label}</button>;
  return <section className="card escrow-funding" aria-labelledby="escrow-funding-title">
    <div className="table-header"><div><h3 id="escrow-funding-title">On-chain escrow</h3><p>Arbitrum Sepolia · 50% upfront / 50% on completion</p></div>
      <button type="button" className="secondary small" disabled={busy || loading} onClick={onRefresh}>Refresh escrow</button></div>
    {loading && <p role="status">Reading the verified escrow…</p>}
    {error && <p className="error-banner" role="alert">{error}</p>}
    {notice && <p className="proposal-success" role="status">{notice}</p>}
    {progress && <p role="status">{progress.status === "awaiting_signature" ? progress.action === "approve" ? "Step 1: approve this token amount in your wallet."
      : progress.action === "deposit" ? "Step 2: confirm the escrow deposit in your wallet." : progress.action === "resetAllowance" ? "Reset the existing token allowance in your wallet." : "Confirm the transaction in your wallet."
      : progress.status === "pending" ? "Transaction submitted. Waiting for confirmation…"
        : progress.status === "confirmed" ? "Transaction confirmed." : "Checking current funding status and network fees…"}
      {progress.transactionHash && <> <a href={explorer("tx", progress.transactionHash)} target="_blank" rel="noreferrer">View transaction</a></>}</p>}
    {unresolvedTransaction && <p role="alert">This transaction is awaiting confirmation. Check it before starting another payment. <a href={explorer("tx", unresolvedTransaction)} target="_blank" rel="noreferrer">View pending transaction</a>{" "}
      <button type="button" className="secondary small" disabled={busy} onClick={onConfirm}>Retry confirmation</button></p>}
    {!walletReady && <p className="field-hint">{walletMessage} <button type="button" className="text-button" onClick={onConnect}>Connect wallet</button></p>}
    {moderated && <p className="field-hint">This proposal is moderated. Funding and approval actions are paused here; available refunds can still be claimed.</p>}
    {fundingBlockReason && !state?.isGrant && <p className="field-hint">{fundingBlockReason}</p>}
    {settlement && <p role="status">{settlementMessage || "Checking confirmed approvals and payment status."}
      {settlement.transactionHash && <> <a href={explorer("tx", settlement.transactionHash)} target="_blank" rel="noreferrer">View payment transaction</a></>}
      {!['confirmed', 'complete', 'released', 'not_ready', 'waiting_approval'].includes(settlement.status) && <>{" "}<button type="button" className="text-button" disabled={busy} onClick={onSync}>Retry payment status</button></>}
    </p>}
    {state && <>
      {state.isHistorical && <p className="field-hint">This escrow belongs to an earlier contract deployment. Its original balances and available refunds remain visible. Create a new posting to use the current funding workflow.</p>}
      {state.workflowPaused && <p className="field-hint">Funding and approvals are paused while this posting is under review. A temporary pause does not open refunds.</p>}
      {state.blockedBySelection && !state.isGrant && <p className="field-hint">Funding and selection are paused while another proposal awaits both owners’ approval. If that selection is rejected or expires, eligible proposals reopen. Once the selected proposal’s upfront payment is processed, other proposals close and their contributions become refundable.</p>}
      <p><strong>{grantWaiting ? "Waiting for grant funding" : state.isGrant && state.state === 1 && state.ownerApproved && state.solutionApproved
        ? "Upfront payment pending" : STATE_LABELS[state.state] ?? "Unknown state"}</strong> · <a href={explorer("address", state.address)} target="_blank" rel="noreferrer">View escrow contract</a></p>
      <dl className="settings-group">
        <div className="settings-row"><dt>Funded / target</dt><dd>{money(state.totalDeposited)} / {money(state.fundingTarget)}</dd></div>
        <div className="settings-row"><dt>Released before fees</dt><dd>{money(state.totalReleased)}</dd></div>
        <div className="settings-row"><dt>Held for unpaid work</dt><dd>{money(state.outstandingBalance)}</dd></div>
        <div className="settings-row"><dt>Your contribution</dt><dd>{money(state.wallet.contribution)}</dd></div>
        <div className="settings-row"><dt>Your available refund</dt><dd>{money(state.wallet.depositor?.claimable)}</dd></div>
        <div className="settings-row"><dt>{state.state === 0 ? state.isGrant ? "Posting closes" : "Funding closes" : "Current approval deadline"}</dt><dd>{instant(state.state === 0 ? state.expiresAt : state.approvalDeadline)}</dd></div>
      </dl>
      {grantWaiting && !settlementMessage && <p className="field-hint">{grantMessage} Manage the offer in the grant funding panel.</p>}
      {state.state === 0 && state.remaining > 0n && !state.isGrant && canDeposit && <div className="field-group">
        <p><strong>Funding token: {state.symbol}</strong> · This proposal accepts the token fixed in its payment plan.</p>
        <Field label={`Contribution (${state.symbol})`} htmlFor="escrow-contribution" hint={`Still needed: ${money(state.remaining)}. Wallet balance: ${money(state.wallet.balance)}.`}>
          {({ id, describedBy }) => <input id={id} type="text" inputMode="decimal" maxLength={160} value={amount} aria-describedby={describedBy} disabled={disabled} onChange={event => setAmount(event.target.value)} />}
        </Field>
        <p className="field-hint">1. Approve only the entered token amount if needed. 2. Confirm the deposit. Deposited funds remain locked until an approved payment or an available refund.</p>
        {action("deposit", "Fund escrow", { amount })}
      </div>}
      {state.state === 0 && state.remaining === 0n && !state.isGrant && <div className="field-group">
        <p>The target is fully funded. The problem owner selects this proposal, then both owners approve the upfront payment.</p>
        {state.roles.problemOwner ? <button type="button" className="primary small" disabled={disabled || moderated || state.isHistorical || state.workflowActive === false} onClick={onSettle}>Select proposal for upfront approval</button>
          : <p className="field-hint">Waiting for the problem owner to select this proposal.</p>}
      </div>}
      {state.state === 1 && <div className="field-group">
        <h4>Upfront 50%</h4><p>Problem owner: {state.ownerApproved ? "approved" : "pending"}. Proposal owner: {state.solutionApproved ? "approved" : "pending"}.</p>
        {!state.isGrant && <>
          <p>{state.supportsSelectionRejection ? "Both owners have seven days from selection to approve, even if the posting closes during that window." : "Both owners must approve before the on-chain deadline."} Funding and selection are paused for every other proposal during this window.</p>
          <p>Upfront approval time remaining: <ExpiryCountdown expiresAt={new Date(Number(state.approvalDeadline) * 1000)} /></p>
        </>}
        {(state.roles.problemOwner || state.roles.proposalOwner) && (!state.isGrant || !state.ownerApproved || !state.solutionApproved) && action("approveSelection", "Approve upfront payment")}
        {state.roles.platform && action("release", "Release upfront 50%")}
        {!state.isGrant && state.can.rejectSelection && <div className="field-group">
          <Field label="Reason for rejecting selection" htmlFor="escrow-selection-rejection" hint="10–2,000 characters. Rejecting opens full refunds for this proposal and reopens other eligible proposals.">
            {({ id, describedBy }) => <textarea id={id} minLength={10} maxLength={2000} value={rejectionReason} disabled={disabled} aria-describedby={describedBy} onChange={event => setRejectionReason?.(event.target.value)} />}
          </Field>
          {action("rejectSelection", "Reject selection and refund", { reason: rejectionReason }, state.can.rejectSelection && rejectionReason.trim().normalize("NFC").length >= 10)}
        </div>}
        <p className="field-hint">Once both approvals confirm, the platform processes the upfront payment. {state.supportsSelectionRejection && !state.isGrant
          ? "If either owner rejects or the approval deadline passes, this proposal’s full contribution balance becomes refundable and other eligible proposals reopen."
          : "If upfront approval lapses, refunds become available at the funding deadline."}</p>
      </div>}
      {state.state === 6 && <>
        <div className="field-group"><h4>Delivery evidence</h4>
          {evidenceReady ? <><p className="escrow-evidence">{evidence.summary}</p><a href={evidence.url} target="_blank" rel="noreferrer">Review delivery evidence</a><p className="field-hint">This evidence matches the hash submitted on-chain.</p></>
            : <p>{nonzero(state.currentMilestone?.evidenceHash) ? "The on-chain evidence is not available or does not match its saved content. Approvals are disabled until matching evidence can be reviewed." : "The proposal owner must submit delivery evidence before final approval."}</p>}
          {state.roles.proposalOwner && <>
            <Field label="Delivery summary" htmlFor="escrow-delivery-summary">{({ id }) => <textarea id={id} maxLength={4000} value={delivery.summary} disabled={disabled} onChange={event => setDelivery({ ...delivery, summary: event.target.value })} />}</Field>
            <Field label="Evidence link (HTTPS)" htmlFor="escrow-delivery-url">{({ id }) => <input id={id} type="url" maxLength={2048} value={delivery.url} disabled={disabled} onChange={event => setDelivery({ ...delivery, url: event.target.value })} />}</Field>
            <p className="field-hint">Share a link reviewers can access. Replacing evidence resets both owner approvals and all funder votes.</p>
            {action("submitMilestone", nonzero(state.currentMilestone?.evidenceHash) ? "Submit replacement evidence" : "Submit delivery evidence")}
          </>}
        </div>
        <div className="field-group"><h4>Final 50% approval</h4>
          <p>Problem owner: {state.ownerApproved ? "accepted as delivered" : "pending"}. Proposal owner: {state.solutionApproved ? "completion confirmed" : "pending"}.</p>
          {(state.roles.problemOwner || state.roles.proposalOwner) && action("approveMilestone", state.roles.problemOwner ? "Accept as delivered" : "Confirm completion", {}, evidenceReady && state.can.approveMilestone)}
          {state.funderVoting && <>
            <p>Yes voting weight: {money(state.yesWeight)} of {money(state.totalDeposited)}. More than 50% of all contributed funds must vote yes.</p>
            {state.roles.funder && (state.wallet.hasVoted ? <p>Your vote is recorded for this evidence.</p> : <div className="actions">
              {action("voteMilestone", "Vote yes", { approve: true }, evidenceReady && state.can.voteMilestone)}
              {action("voteMilestone", "Vote no", { approve: false }, evidenceReady && state.can.voteMilestone)}
            </div>)}
          </>}
          {state.roles.platform && action("releaseMilestone", "Release final 50%", {}, evidenceReady && state.can.releaseMilestone)}
          <p className="field-hint">Both owners{state.funderVoting ? " and a funding-weighted majority" : ""} must approve the same evidence. The platform then processes the final payment.</p>
        </div>
      </>}
      {(state.can.claimRefund || state.can.expire || state.can.refundInvalidated) && <div className="field-group"><h4>Refunds</h4>
        {state.can.refundInvalidated && action("refundInvalidated", "Open withdrawal refunds")}
        {state.can.expire && action("expire", "Open expired escrow refunds")}
        {state.can.claimRefund && action("claimRefund", "Claim my refund")}
        <p className="field-hint">{state.supportsSelectionRejection && !state.isGrant && [1, 4, 5].includes(state.state) && state.totalReleased === 0n
          ? "This proposal’s full contribution balance is refundable after rejection or expiry. Other eligible proposals can be funded or selected again while the posting remains open."
          : "Refunds return only the unpaid balance. Earlier payouts remain paid."}</p>
      </div>}
    </>}
  </section>;
}

export function EscrowFundingPanel({ proposal, onStateChange, refreshVersion = 0 }) {
  const { user } = useAuth();
  const queryClient = useContext(QueryClientContext);
  const { address, isConnected, chainId } = useAccount();
  const storageKey = pendingKey(proposal.id, address);
  const moderated = isModerated(proposal);
  const [state, setState] = useState(null), [evidence, setEvidence] = useState(null);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [progress, setProgress] = useState(null), [unresolvedTransaction, setUnresolvedTransaction] = useState(() => savedTransaction(storageKey));
  const [amount, setAmount] = useState(""), [delivery, setDelivery] = useState({ summary: "", url: "" });
  const [rejectionReason, setRejectionReason] = useState("");
  const [connect, setConnect] = useState(false);
  const [history, setHistory] = useState(null), [historyError, setHistoryError] = useState("");
  const [syncError, setSyncError] = useState(""), [settlement, setSettlement] = useState(null);
  const [notice, setNotice] = useState("");
  const current = useRef({ proposal, onStateChange }); current.current = { proposal, onStateChange };
  const currentStorageKey = useRef(storageKey); currentStorageKey.current = storageKey;
  const generation = useRef(0), writing = useRef(false);
  useEffect(() => { setUnresolvedTransaction(savedTransaction(storageKey)); }, [storageKey]);
  const walletReady = isConnected && address?.toLowerCase() === user?.id?.toLowerCase() && chainId === AUDIT_REGISTRY_CHAIN_ID;
  const roles = user?.roles ?? (user?.role ? [user.role] : []);
  const independent = isIndependentProposal(proposal);
  const canDeposit = !independent || canApproachIndependentListing({ proposal, user });
  const authorViewing = independent && user?.id && proposal.researcherId
    && user.id.toLowerCase() === proposal.researcherId.toLowerCase();
  const fundingBlockReason = user?.isSuspended ? "Deposits are unavailable while this account is suspended."
    : independent && !canDeposit
      ? (authorViewing ? history?.summary?.fundingBlockReason : "Only a client or funder can approach this listing with funding.")
      : !roles.some(role => ["funder", "owner"].includes(role)) ? "Sign in with a funder or problem owner account to deposit."
        : history?.summary?.fundingBlockReason;
  const walletMessage = !isConnected ? "Connect your signed-in wallet to fund, approve or claim refunds."
    : address?.toLowerCase() !== user?.id?.toLowerCase() ? "Connect the wallet belonging to your signed-in account."
      : "Switch your wallet to Arbitrum Sepolia to continue.";
  const refresh = useCallback(async () => {
    const request = ++generation.current;
    setLoading(true);
    try {
      const [next, records] = await Promise.all([
        readEscrow({ proposal: current.current.proposal, account: address }),
        user?.id ? getEscrowFundingHistory({ proposalId: current.current.proposal.id }).then(data => ({ data }), err => ({ error: err.message })) : null,
      ]);
      let saved = null, evidenceError = "";
      if (nonzero(next.currentMilestone?.evidenceHash)) {
        try {
          const raw = await loadEscrowEvidence(current.current.proposal.id, next.currentMilestone.evidenceHash);
          if (raw && hashEscrowEvidence(raw) === next.currentMilestone.evidenceHash) saved = { ...raw, hash: next.currentMilestone.evidenceHash };
        } catch { evidenceError = "Delivery evidence could not be loaded. Refresh before approving; escrow balances and refunds remain available."; }
      }
      if (request !== generation.current) return;
      setState(next); setEvidence(saved); setError(evidenceError);
      if (next.isHistorical) { setHistory(null); setHistoryError(""); }
      else if (records) { setHistory(records.data ?? null); setHistoryError(records.error || ""); }
      current.current.onStateChange?.(next);
    } catch (err) {
      if (request === generation.current) { setState(null); setEvidence(null); setError(escrowErrorMessage(err)); current.current.onStateChange?.(null); }
    } finally { if (request === generation.current) setLoading(false); }
  }, [proposal.id, address, user?.id]);
  useEffect(() => {
    setState(null); setEvidence(null);
    refresh();
    const timer = setInterval(() => { if (!writing.current) refresh(); }, 30_000);
    return () => { generation.current += 1; clearInterval(timer); };
  }, [refresh, refreshVersion]);
  const act = async (action, extra = {}) => {
    if (!walletReady || writing.current || unresolvedTransaction || (action === "deposit" && fundingBlockReason) || (moderated && !refundActions.has(action))) return;
    writing.current = true; setBusy(true); setError(""); setProgress({ status: "preparing", action }); setNotice("");
    const remember = hash => { saveTransaction(storageKey, hash); if (currentStorageKey.current === storageKey) setUnresolvedTransaction(hash); };
    try {
      // Revalidate current membership and posting eligibility immediately before any deposit signature.
      if (action === "deposit") await prepareEscrowDeposit({ proposalId: proposal.id });
      const payload = { proposal: current.current.proposal, account: address, action, selectionId: state?.selectionId, ...extra, onProgress: next => {
        setProgress(next);
        if (next.status === "pending") remember(next.transactionHash);
        if (next.status === "confirmed") remember(null);
      } };
      if (action === "submitMilestone") {
        payload.evidence = { summary: delivery.summary.trim().normalize("NFC"), url: delivery.url.trim() };
        payload.evidenceHash = hashEscrowEvidence(payload.evidence);
        await saveEscrowEvidence({ proposalId: proposal.id, ownerId: user.id, evidence: payload.evidence, evidenceHash: payload.evidenceHash });
      } else if (["approveMilestone", "voteMilestone", "releaseMilestone"].includes(action)) {
        if (!evidence || evidence.hash !== state?.currentMilestone?.evidenceHash) throw new Error("Refresh and review the current delivery evidence first.");
        payload.evidenceHash = evidence.hash;
      } else if (action === "lockSelection") payload.selectionId = keccak256(stringToHex(crypto.randomUUID()));
      const result = await writeEscrowAction(payload);
      void queryClient?.invalidateQueries({ queryKey: ACTION_ITEMS_KEY });
      if (action === "deposit") setNotice("Deposit confirmed. Your tokens are held in escrow until an approved payment or an available refund.");
      if (action === "rejectSelection") { setNotice("Selection rejected. This proposal’s full contribution balance is refundable; other eligible proposals reopen."); setRejectionReason(""); }
      try { if (!state?.isHistorical) {
        const synchronized = await syncEscrowFunding({ proposalId: proposal.id, ...(result?.transactionHash ? { transactionHash: result.transactionHash } : {}) });
        setHistory(synchronized); setSettlement(synchronized.settlement); setSyncError("");
      } } catch (err) { setSyncError(`The wallet transaction confirmed, but funding records could not be synchronized: ${err.message}. Use Reconcile funding records to retry.`); }
      await refresh();
      if (action === "deposit") setAmount("");
    } catch (err) {
      setError(escrowErrorMessage(err));
      if (!err.transactionHash) setProgress(null);
      if (err.transactionHash && !err.transactionSettled) remember(err.transactionHash);
      if (err.transactionSettled) { remember(null); setProgress(null); }
    } finally { writing.current = false; setBusy(false); }
  };
  const confirmPending = async () => {
    if (writing.current || !unresolvedTransaction) return;
    writing.current = true; setBusy(true);
    const settled = () => { saveTransaction(storageKey, null); if (currentStorageKey.current === storageKey) { setUnresolvedTransaction(null); setProgress(null); } };
    try {
      await confirmEscrowTransaction(unresolvedTransaction); settled();
      void queryClient?.invalidateQueries({ queryKey: ACTION_ITEMS_KEY });
      try { if (!state?.isHistorical) {
        // A recovered hash can belong to the ERC20 approval step rather than the deposit.
        // Reconcile the canonical proposal stream instead of treating that token receipt as an escrow event.
        const synchronized = await syncEscrowFunding({ proposalId: proposal.id });
        setHistory(synchronized); setSettlement(synchronized.settlement); setSyncError("");
      } }
      catch (err) { setSyncError(`Transaction confirmed. Funding records could not be synchronized: ${err.message}`); }
      await refresh();
    }
    catch (err) { setError(escrowErrorMessage(err)); if (err.transactionSettled) settled(); }
    finally { writing.current = false; setBusy(false); }
  };
  const synchronize = async (select = false) => {
    if (writing.current || !user?.id || (select && !walletReady) || unresolvedTransaction) return;
    writing.current = true; setBusy(true); setSyncError("");
    try {
      const result = await (select ? startEscrowSettlement : syncEscrowFunding)({ proposalId: proposal.id });
      void queryClient?.invalidateQueries({ queryKey: ACTION_ITEMS_KEY });
      setHistory(result); setSettlement(result.settlement); await refresh();
    } catch (err) { setSyncError(err.message || "Funding status could not be updated. Retry when ready."); }
    finally { writing.current = false; setBusy(false); }
  };
  return <><EscrowFundingView {...{ state, evidence, loading, error, busy, progress, walletReady, walletMessage, amount, setAmount, delivery, setDelivery, rejectionReason, setRejectionReason, unresolvedTransaction, moderated, fundingBlockReason, notice, canDeposit }}
    settlement={settlement ?? history?.settlement} onSettle={() => synchronize(true)} onSync={() => synchronize()}
    onAction={act} onRefresh={refresh} onConnect={() => setConnect(true)} onConfirm={confirmPending} />
    {user?.id && !state?.isHistorical && <EscrowFundingHistory data={history} error={syncError || historyError} busy={busy || loading} onSync={() => synchronize()} />}
    {connect && <ConnectWalletModal onClose={() => setConnect(false)} />}</>;
}
