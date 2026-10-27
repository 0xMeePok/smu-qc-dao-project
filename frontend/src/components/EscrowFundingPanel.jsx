import { ConvertedAmount } from "./CurrencyAmount.jsx";
import { useLiveActivity } from "../hooks/useLiveActivity.js";
import { contributionError } from "../lib/contributionValidation.js";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { QueryClient, QueryClientContext, QueryClientProvider } from "@tanstack/react-query";
import { formatUnits, keccak256, stringToHex } from "viem";
import { useAuth } from "../context/AuthContext.jsx";
import { useSignIn } from "../context/SessionContext.jsx";
import { useWallet } from "../context/WalletContext.jsx";
import { invalidateFundingDashboardSummaries } from "../lib/fundingDashboardCache.js";
import { AUDIT_REGISTRY_CHAIN_ID, AUDIT_REGISTRY_CONFIG } from "../config/auditRegistry.js";
import { isModerated } from "../lib/moderation.js";
import { confirmEscrowTransaction, escrowErrorMessage, hashEscrowEvidence, readEscrow, writeEscrowAction } from "../lib/escrow.js";
import { fetchEscrowSnapshot, useEscrowSnapshot } from "../lib/escrowReads.js";
import { loadEscrowEvidence, saveEscrowEvidence } from "../lib/escrowEvidence.js";
import { Field } from "./Field.jsx";
import { fundingActivityCovered, getEscrowFundingHistory, prepareEscrowDeposit, startEscrowSettlement, syncEscrowFunding } from "../lib/escrowFunding.js";
import { EscrowFundingHistory } from "./EscrowFundingHistory.jsx";
import { ExpiryCountdown } from "./ExpiryCountdown.jsx";
import { ACCEPTANCE_WINDOW_MS } from "../lib/deadlineUrgency.js";
import { ACTION_ITEMS_KEY } from "../lib/proposalQueues.js";
import { canApproachIndependentListing } from "../lib/independentFunding.js";
import { isIndependentProposal } from "../config/proposal.js";
import { escrowCustodyLock } from "../../../firebase/functions/escrowCustody.js";
import { EscrowCustodyNotice } from "./EscrowCustodyNotice.jsx";
import { FundingProgress } from "./FundingProgress.jsx";
import { EscrowLifecycleBadge } from "./EscrowLifecycle.jsx";
import { prewarmCallable, prewarmTransaction } from "../lib/prewarm.js";
import { formatInstant } from "../lib/datetime.js";

const STATE_LABELS = ["Open for funding", "Awaiting upfront approval", "Fully paid", "Refunded", "Cancelled", "Expired", "Delivery in progress", "Voided"];
const explorer = (type, value) => `https://sepolia.arbiscan.io/${type}/${value}`;
const nonzero = value => value && !/^0x0{64}$/i.test(value);
// The app shows every instant in UTC ("2026-11-16 02:05:06 UTC"), never the browser locale.
const instant = seconds => seconds > 0n ? formatInstant(new Date(Number(seconds) * 1000)) : "—";
const refundActions = new Set(["claimRefund", "expire", "refundInvalidated"]);
const pendingSettlement = new Set(["pending", "queued", "preparing", "retrying"]);
// Released, Refunded, Cancelled, Expired, Voided: no platform payment can follow.
const terminalStates = new Set([2, 3, 4, 5, 7]);
const SUCCESS_NOTICES = {
  deposit: "Deposit confirmed. Your tokens are held in escrow until an approved payment or an available refund.",
  approveSelection: "Your upfront approval is confirmed on-chain. Once both owners approve, the platform processes the upfront payment.",
  release: "The upfront payment release is confirmed.",
  rejectSelection: "Selection rejected. This proposal’s full contribution balance is refundable; other eligible proposals reopen.",
  submitMilestone: "Delivery evidence submitted. Both owners can now review it.",
  approveMilestone: "Your approval of this delivery is confirmed on-chain.",
  voteMilestone: "Your vote is recorded on-chain.",
  releaseMilestone: "The final payment release is confirmed.",
  claimRefund: "Refund claimed. The unpaid balance has been returned to your wallet.",
  expire: "Expired escrow refunds are open. Contributors can now claim their refunds.",
  refundInvalidated: "Withdrawal refunds are open. Contributors can now claim their refunds.",
};
/**
 * A stored settlement message describes the escrow as the platform last saw it.
 * Show it only while it still fits the verified on-chain state read here, so a
 * selected, released or refunded escrow does not repeat an earlier instruction.
 */
export function currentSettlement(state, settlement) {
  if (!settlement || !state) return settlement ?? null;
  if (pendingSettlement.has(settlement.status)) return settlement;
  if (["confirmed", "complete", "released"].includes(settlement.status)) return settlement;
  if (terminalStates.has(state.state)) return null;
  if (state.isGrant && state.state === 0) return settlement;
  if (settlement.status === "waiting") return state.state === 6 && !/must select/i.test(settlement.message ?? "") ? settlement : null;
  if (["awaiting-approvals", "waiting_approval"].includes(settlement.status)) return [1, 6].includes(state.state) ? settlement : null;
  if (settlement.status === "awaiting-votes") return state.state === 6 ? settlement : null;
  return settlement;
}
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
  fundingBlockReason, notice, settlement, onSettle, onSync, rejectionReason = "", setRejectionReason, canDeposit = true, integrityBlocked = false, settling = false }) {
  const money = units => `${formatUnits(units ?? 0n, state?.decimals ?? 6)} ${state?.symbol ?? ""}`;
  // A passive background read never disables actions or inputs: each action
  // re-reads the chain before any wallet request, and disabling (or remounting)
  // controls mid-refresh swallowed clicks and keystrokes.
  const disabled = busy || !walletReady || Boolean(unresolvedTransaction);
  const amountError = state ? contributionError({ amount, decimals: state.decimals, symbol: state.symbol, remaining: state.remaining, balance: state.wallet?.balance }) : "";
  const evidenceReady = evidence && state?.currentMilestone?.evidenceHash === evidence.hash;
  const grantWaiting = state?.isGrant && state.state === 0;
  const terminal = terminalStates.has(state?.state);
  const deadline = state?.state === 0 ? state.expiresAt : [1, 6].includes(state?.state) ? state.approvalDeadline : 0n;
  const grantMessage = "Grant funding moves into this escrow when the researcher accepts the selected offer.";
  settlement = currentSettlement(state, settlement);
  const settlementMessage = grantWaiting && ["waiting", "not_ready", "waiting_approval"].includes(settlement?.status) ? grantMessage : settlement?.message;
  // Action feedback sits beside the actions once the escrow is shown. The
  // in-flight action owns its own pending hash, so recovery appears only after it ends.
  const feedback = <>
    {error && <p className="error-banner" role="alert">{error}</p>}
    {notice && <p className="proposal-success" role="status">{notice}</p>}
    {progress && <p role="status">{progress.status === "awaiting_signature" ? progress.action === "approve" ? "Step 1: approve this token amount in your wallet."
      : progress.action === "deposit" ? "Step 2: confirm the escrow deposit in your wallet." : progress.action === "resetAllowance" ? "Reset the existing token allowance in your wallet." : "Confirm the transaction in your wallet."
      : progress.status === "pending" ? "Transaction submitted. Waiting for confirmation…"
        : progress.status === "confirmed" ? "Transaction confirmed. Updating the escrow…" : "Checking current funding status and network fees…"}
      {progress.transactionHash && <> <a href={explorer("tx", progress.transactionHash)} target="_blank" rel="noreferrer">View transaction</a></>}</p>}
    {unresolvedTransaction && !busy && <p role="alert">This transaction is awaiting confirmation. Check it before starting another payment. <a href={explorer("tx", unresolvedTransaction)} target="_blank" rel="noreferrer">View pending transaction</a>{" "}
      <button type="button" className="secondary small" disabled={busy} onClick={onConfirm}>Retry confirmation</button></p>}
  </>;
  const custodyLock = state?.custodyLock ?? escrowCustodyLock(state ?? {});
  const refundLocked = custodyLock.status === "locked";
  const selectionAllowed = state?.selectionGate?.canSelect !== false && state?.fundingRequirementMet !== false;
  const action = (name, label, extra = {}, allowed = state?.can[name]) => <button type="button" className="primary small"
    disabled={disabled || !allowed || (name === "claimRefund" && refundLocked) || (name === "deposit" && (Boolean(fundingBlockReason) || !String(amount ?? "").trim() || Boolean(amountError))) || ((moderated || integrityBlocked) && !refundActions.has(name))} onClick={() => { if (name !== "claimRefund" || !refundLocked) onAction(name, extra); }}>{label}</button>;
  return <section className="card escrow-funding escrow-detail" aria-labelledby="escrow-funding-title">
    <div className="table-header"><div><h3 id="escrow-funding-title">On-chain escrow</h3><p>Arbitrum Sepolia · 50% upfront / 50% on completion</p></div>
      <button type="button" className="secondary small" disabled={busy || loading} aria-busy={loading} onClick={onRefresh}>Refresh escrow</button></div>
    {/* Background refreshes keep the verified escrow in place; only the first read shows a line here. */}
    {loading && !state && <p role="status">Reading the verified escrow…</p>}
    {!state && feedback}
    {!walletReady && <p className="field-hint">{walletMessage} <button type="button" className="text-button" onClick={onConnect}>Sign in</button></p>}
    {moderated && <p className="field-hint">This proposal is moderated. Funding and approval actions are paused here; available refunds can still be claimed.</p>}
    {fundingBlockReason && !state?.isGrant && !terminal && <p className="field-hint">{fundingBlockReason}</p>}
    {settlement && <p role="status">{settlementMessage || "Checking confirmed approvals and payment status."}
      {settlement.transactionHash && <> <a href={explorer("tx", settlement.transactionHash)} target="_blank" rel="noreferrer">View payment transaction</a></>}
      {!['confirmed', 'complete', 'released', 'not_ready', 'waiting_approval'].includes(settlement.status) && <>{" "}<button type="button" className="text-button" disabled={busy} onClick={onSync}>Retry payment status</button></>}
    </p>}
    {state && <>
      {state.isHistorical && <p className="field-hint">This escrow belongs to an earlier contract deployment. Its original balances and available refunds remain visible. Create a new posting to use the current funding workflow.</p>}
      {state.workflowPaused && !terminal && <p className="field-hint">Funding and approvals are paused while this posting is under review. A temporary pause does not open refunds.</p>}
      {state.blockedBySelection && !state.isGrant && !terminal && <p className="field-hint">Funding and selection are paused while another proposal awaits both owners’ approval. If that selection is rejected or expires, eligible proposals reopen. Once the selected proposal’s upfront payment is processed, other proposals close and their contributions become refundable.</p>}
      <div className="escrow-status-summary">
        <div className="escrow-status-heading"><strong>{grantWaiting ? "Waiting for grant funding" : state.isGrant && state.state === 1 && state.ownerApproved && state.solutionApproved
          ? "Upfront payment pending" : STATE_LABELS[state.state] ?? "Unknown state"}</strong><a href={explorer("address", state.address)} target="_blank" rel="noreferrer">View escrow contract</a></div>
        <EscrowLifecycleBadge summary={state} stale={Boolean(error)} compact={terminal && !error} showLabel={false} />
        {!terminal && <FundingProgress summary={state} stale={Boolean(error)} compact />}
        <EscrowCustodyNotice summary={state} stale={Boolean(error)} />
      </div>
      <section className="escrow-balance-section" aria-label="Escrow balances">
        <h4>Escrow balances</h4>
        <dl className="escrow-balance-grid">
          <div><dt>Held in escrow</dt><dd><ConvertedAmount text={money(state.outstandingBalance)} /></dd></div>
          <div><dt>Released before fees</dt><dd><ConvertedAmount text={money(state.totalReleased)} /></dd></div>
          <div><dt>Refunded to contributors</dt><dd><ConvertedAmount text={money(state.totalRefunded)} /></dd></div>
        </dl>
        <p className="escrow-deposit-reference">{terminal ? "Originally deposited" : "Total deposited"}: <ConvertedAmount text={money(state.totalDeposited)} /><span>Target: <ConvertedAmount text={money(state.fundingTarget)} /></span></p>
      </section>
      <section className="escrow-wallet-section" aria-label="Your funds">
        <h4>Your funds</h4>
        <dl className="escrow-wallet-grid">
          <div><dt>Your contribution</dt><dd><ConvertedAmount text={money(state.wallet.contribution)} /></dd></div>
          <div><dt>Your available refund</dt><dd><ConvertedAmount text={money(state.wallet.depositor?.claimable)} /></dd></div>
        </dl>
        {terminal && !error && custodyLock.status === "settled" && walletReady && <p className="field-hint">No refund remains to claim from this escrow.</p>}
      </section>
      {deadline > 0n && <dl className="escrow-deadline"><div><dt>{state.state === 0 ? state.isGrant ? "Posting closes" : "Funding closes" : "Current approval deadline"}</dt><dd>{instant(deadline)}</dd></div></dl>}
      {feedback}
      {grantWaiting && !settlementMessage && <p className="field-hint">{grantMessage} Manage the offer in the grant funding panel.</p>}
      {state.state === 0 && state.remaining > 0n && !state.isGrant && canDeposit && <div className="field-group">
        <p><strong>Funding token: {state.symbol}</strong> · This proposal accepts the token fixed in its payment plan.</p>
        <Field label={`Contribution (${state.symbol})`} htmlFor="escrow-contribution" hint={`Still needed: ${money(state.remaining)}. Use up to 2 decimal places. Minimum 1 ${state.symbol}, or the exact remaining balance. Wallet balance: ${money(state.wallet.balance)}.`} error={amountError}>
          {({ id, describedBy, invalid }) => <input id={id} aria-invalid={invalid} type="text" inputMode="decimal" maxLength={160} value={amount} aria-describedby={describedBy} disabled={disabled} onChange={event => setAmount(event.target.value)} />}
        </Field>
        <p className="field-hint">1. Approve only the entered token amount if needed. 2. Confirm the deposit. Deposited funds remain locked until an approved payment or an available refund.</p>
        {action("deposit", "Fund escrow", { amount })}
      </div>}
      {state.state === 0 && state.remaining === 0n && !state.isGrant && <div className="field-group">
        <p>The target is fully funded. The problem owner selects this proposal, then both owners approve the upfront payment.</p>
        {state.roles.problemOwner ? <button type="button" className="primary small" disabled={disabled || moderated || integrityBlocked || state.isHistorical || state.workflowActive === false || !selectionAllowed} onClick={onSettle}>Select proposal for upfront approval</button>
          : <p className="field-hint">Waiting for the problem owner to select this proposal.</p>}
        {settling && <p role="status">Requesting selection… The platform verifies the escrow’s custody and submits the selection on-chain. This can take up to a minute; keep this page open.</p>}
        {!selectionAllowed && <p className="field-hint">Selection requires the exact funding target to be held in verified escrow while the posting remains open. Evaluator feedback remains optional.</p>}
      </div>}
      {state.state === 1 && <div className="field-group">
        <h4>Upfront 50%</h4><p>Problem owner: {state.ownerApproved ? "approved" : "pending"}. Proposal owner: {state.solutionApproved ? "approved" : "pending"}.</p>
        {!state.isGrant && <>
          <p>{state.supportsSelectionRejection ? "Both owners have seven days from selection to approve, even if the posting closes during that window." : "Both owners must approve before the on-chain deadline."} Funding and selection are paused for every other proposal during this window.</p>
          <p>Upfront approval time remaining: <ExpiryCountdown expiresAt={new Date(Number(state.approvalDeadline) * 1000)} windowMs={ACCEPTANCE_WINDOW_MS} /></p>
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
            <p>Yes voting weight: <ConvertedAmount text={money(state.yesWeight)} /> of <ConvertedAmount text={money(state.totalDeposited)} />. More than 50% of all contributed funds must vote yes.</p>
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

function IsolatedQuery({ children }) {
  const [client] = useState(() => new QueryClient({ defaultOptions: { queries: { retry: false } } }));
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

export function EscrowFundingPanel(props) {
  const existing = useContext(QueryClientContext);
  if (existing) return <EscrowFundingPanelBody {...props} />;
  return <IsolatedQuery><EscrowFundingPanelBody {...props} /></IsolatedQuery>;
}

function EscrowFundingPanelBody({ proposal, onStateChange, onConfirmed, refreshVersion = 0, integrityBlocked = false }) {
  const { user } = useAuth();
  const queryClient = useContext(QueryClientContext);
  const { address, isConnected } = useWallet();
  const snapshotQuery = useEscrowSnapshot(proposal, address);
  const storageKey = pendingKey(proposal.id, address);
  const moderated = isModerated(proposal);
  const [state, setState] = useState(null), [evidence, setEvidence] = useState(null);
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false), [error, setError] = useState("");
  const [progress, setProgress] = useState(null), [unresolvedTransaction, setUnresolvedTransaction] = useState(() => savedTransaction(storageKey));
  const [amount, setAmount] = useState(""), [delivery, setDelivery] = useState({ summary: "", url: "" });
  const [rejectionReason, setRejectionReason] = useState("");
  const signIn = useSignIn(setError);
  const [history, setHistory] = useState(null), [historyError, setHistoryError] = useState("");
  const [syncError, setSyncError] = useState(""), [settlement, setSettlement] = useState(null);
  // One-shot notices are anchored to the escrow state they describe and clear
  // once the verified state moves on (funded, selected, released, refunded…).
  const [noticeEntry, setNoticeEntry] = useState(null), [settling, setSettling] = useState(false);
  const setNotice = text => setNoticeEntry(text ? { text, anchor: null } : null);
  const stateKey = state ? `${state.state}:${state.ownerApproved}:${state.solutionApproved}:${state.currentTranche ?? ""}:${state.remaining === 0n}:${state.currentMilestone?.evidenceHash ?? ""}` : null;
  useEffect(() => {
    if (!noticeEntry || busy || !stateKey) return;
    if (noticeEntry.anchor === null) setNoticeEntry(entry => entry && entry.anchor === null ? { ...entry, anchor: stateKey } : entry);
    else if (noticeEntry.anchor !== stateKey) setNoticeEntry(null);
  }, [noticeEntry, busy, stateKey]);
  const notice = noticeEntry?.text ?? "";
  const current = useRef({ proposal, onStateChange, onConfirmed }); current.current = { proposal, onStateChange, onConfirmed };
  const currentStorageKey = useRef(storageKey); currentStorageKey.current = storageKey;
  const generation = useRef(0), writing = useRef(false), periodicRefresh = useRef(null);
  const lastVerified = useRef(null), passiveSync = useRef(null), scope = useRef(null), versionSeen = useRef(refreshVersion);
  useEffect(() => { setUnresolvedTransaction(savedTransaction(storageKey)); }, [storageKey]);
  const walletReady = isConnected && address?.toLowerCase() === user?.id?.toLowerCase();
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
  const walletMessage = !isConnected ? "Sign in with your email to fund, approve or claim refunds."
    : "This wallet belongs to a different account. Sign in again with your email.";
  // Wake the deposit eligibility function while the member is still typing, so
  // "Fund escrow" does not wait for a cold start. The click still runs it in full.
  const depositOffered = walletReady && Boolean(state?.can?.deposit) && !fundingBlockReason && canDeposit && !moderated && !integrityBlocked;
  useEffect(() => {
    if (depositOffered) { prewarmCallable("prepareEscrowDeposit"); prewarmTransaction(); }
  }, [depositOffered, amount]);
  const refresh = useCallback(async ({ includeHistory = true, activityOnly = false, activitySnapshots = [], chain = true } = {}) => {
    const request = ++generation.current;
    const requestedProposal = current.current.proposal;
    const startedAt = Date.now();
    setLoading(true);
    // History and evidence cannot delay an independently verified balance. Each
    // result is scoped to this refresh so navigation cannot apply an old record.
    const records = includeHistory && user?.id
      ? getEscrowFundingHistory({ proposalId: requestedProposal.id }).then(data => ({ data }), err => ({ error: err.message })) : null;
    const observeEvidence = (pending, next) => {
      void pending.then(raw => {
        if (request !== generation.current) return;
        setEvidence(raw && hashEscrowEvidence(raw) === next.currentMilestone.evidenceHash ? { ...raw, hash: next.currentMilestone.evidenceHash } : null);
      }).catch(() => {
        if (request === generation.current) {
          setEvidence(null);
          setError("Delivery evidence could not be loaded. Refresh before approving; escrow balances and refunds remain available.");
        }
      });
    };
    try {
      // Only coalesce a push notification against a very recent verified read.
      // Manual refresh, focus/reconnect and periodic checks always read the chain.
      const previous = lastVerified.current;
      if (activityOnly && activitySnapshots.length && previous?.scope === storageKey
          && startedAt >= previous.startedAt && startedAt - previous.startedAt < 5000
          && activitySnapshots.every(snapshot => fundingActivityCovered(previous.snapshot, snapshot,
            { proposalId: requestedProposal.id, config: AUDIT_REGISTRY_CONFIG }))) {
        if (records) void records.then(result => {
          if (request === generation.current) { setHistory(result.data ?? null); setHistoryError(result.error || ""); }
        });
        // Re-observe a pending evidence read under this generation; the prior
        // observer is now stale, but its request and verified digest are reusable.
        if (previous.evidencePromise) observeEvidence(previous.evidencePromise, previous.snapshot);
        return previous.snapshot;
      }
      if (!chain) {
        if (records) void records.then(result => {
          if (request === generation.current) { setHistory(result.data ?? null); setHistoryError(result.error || ""); }
        });
        return previous?.snapshot;
      }
      const next = queryClient
        ? await fetchEscrowSnapshot(queryClient, requestedProposal, address)
        : await readEscrow({ proposal: requestedProposal, account: address, allowImmutableCache: true });
      if (request !== generation.current) return;
      lastVerified.current = { scope: storageKey, snapshot: next, startedAt };
      setState(next); setError(""); setLoading(false);
      setEvidence(saved => saved?.hash === next.currentMilestone?.evidenceHash ? saved : null);
      current.current.onStateChange?.(next);
      if (next.isHistorical) { setHistory(null); setHistoryError(""); }
      else if (records) void records.then(result => {
        if (request === generation.current) { setHistory(result.data ?? null); setHistoryError(result.error || ""); }
      });
      if (nonzero(next.currentMilestone?.evidenceHash)) {
        const evidencePromise = loadEscrowEvidence(requestedProposal.id, next.currentMilestone.evidenceHash);
        lastVerified.current.evidencePromise = evidencePromise;
        observeEvidence(evidencePromise, next);
      }
      return next;
    } catch (err) {
      if (request === generation.current) { lastVerified.current = null; setState(null); setEvidence(null); setError(escrowErrorMessage(err)); current.current.onStateChange?.(null); }
    } finally { if (request === generation.current) setLoading(false); }
  }, [proposal.id, address, user?.id, storageKey, queryClient]);
  useEffect(() => {
    if (!snapshotQuery.data) return;
    const next = snapshotQuery.data;
    setState(next);
    setLoading(false);
    lastVerified.current = { scope: storageKey, snapshot: next, startedAt: snapshotQuery.dataUpdatedAt || Date.now() };
    current.current.onStateChange?.(next);
    if (!nonzero(next.currentMilestone?.evidenceHash)) return;
    const proposalId = current.current.proposal.id;
    const evidencePromise = loadEscrowEvidence(proposalId, next.currentMilestone.evidenceHash);
    lastVerified.current.evidencePromise = evidencePromise;
    void evidencePromise.then(raw => {
      if (current.current.proposal.id !== proposalId) return;
      setEvidence(raw && hashEscrowEvidence(raw) === next.currentMilestone.evidenceHash ? { ...raw, hash: next.currentMilestone.evidenceHash } : null);
    }).catch(() => {
      if (current.current.proposal.id !== proposalId) return;
      setEvidence(null);
      setError("Delivery evidence could not be loaded. Refresh before approving; escrow balances and refunds remain available.");
    });
  }, [snapshotQuery.data, snapshotQuery.dataUpdatedAt, storageKey]);
  useEffect(() => {
    // Clear the displayed escrow only for a different proposal, wallet or member.
    // A refreshVersion bump re-reads in place, so controls and typed input stay mounted.
    // The shared query reads the chain on mount. This effect loads history, and a
    // version bump reads the chain again.
    const nextScope = `${storageKey}:${user?.id ?? ""}`;
    const versionChanged = scope.current === nextScope && refreshVersion !== versionSeen.current;
    versionSeen.current = refreshVersion;
    if (scope.current !== nextScope) {
      scope.current = nextScope;
      setState(snapshotQuery.data ?? null); setEvidence(null); setSettlement(null); setHistory(null); setNoticeEntry(null);
    }
    lastVerified.current = snapshotQuery.data
      ? { scope: storageKey, snapshot: snapshotQuery.data, startedAt: snapshotQuery.dataUpdatedAt || Date.now() }
      : null;
    refresh({ chain: versionChanged });
    // Preserve recovery of a known platform settlement; ordinary reads use live activity.
    const timer = setInterval(() => { if (!writing.current && document.visibilityState !== "hidden") periodicRefresh.current?.(); }, 30_000);
    return () => { generation.current += 1; clearInterval(timer); };
  }, [refresh, refreshVersion]);
  const recordSynchronized = result => {
    invalidateFundingDashboardSummaries(queryClient);
    setHistory(result); setSettlement(result.settlement); setSyncError("");
    current.current.onConfirmed?.();
  };
  const synchronizeConfirmed = async (args = {}, initialResult) => {
    const key = storageKey;
    let result = initialResult ?? await syncEscrowFunding({ proposalId: proposal.id, ...args });
    if (currentStorageKey.current !== key) return;
    recordSynchronized(result);
    // Platform release is a second transaction. Follow its known hash once;
    // never ask the wallet to repeat the already-confirmed user transaction.
    if (result.settlement?.status === "pending" && result.settlement.transactionHash) {
      setSettlement({ ...result.settlement, message: "The platform action is awaiting confirmation." });
      await confirmEscrowTransaction(result.settlement.transactionHash);
      if (currentStorageKey.current !== key) return;
      const updated = refresh({ includeHistory: false });
      try {
        result = await syncEscrowFunding({ proposalId: proposal.id });
        if (currentStorageKey.current === key) recordSynchronized(result);
      } finally { await updated; }
    }
    return result;
  };
  const act = async (action, extra = {}) => {
    if (!walletReady || writing.current || unresolvedTransaction || (action === "deposit" && fundingBlockReason) || ((moderated || integrityBlocked) && !refundActions.has(action))) return;
    const requestedProposal = current.current.proposal;
    writing.current = true; setBusy(true); setError(""); setSyncError(""); setProgress({ status: "preparing", action }); setNotice("");
    // A background payment-status check may be running; queue behind it rather than dropping the click.
    await waitForPassiveSync();
    const remember = hash => { saveTransaction(storageKey, hash); if (currentStorageKey.current === storageKey) setUnresolvedTransaction(hash); };
    const navigatedAway = new Error("The escrow panel changed before the wallet request.");
    // Revalidate current membership and posting eligibility before any deposit
    // signature. The server check runs alongside the escrow chain reads, and
    // writeEscrowAction opens no wallet request until it has passed.
    const eligibility = action === "deposit"
      ? prepareEscrowDeposit({ proposalId: proposal.id, amount }).then(() => null, failure => failure) : null;
    const ensureEligible = async () => {
      const failure = await eligibility;
      if (failure) throw failure;
      if (currentStorageKey.current !== storageKey) throw navigatedAway;
    };
    try {
      const payload = { proposal: requestedProposal, account: address, action, selectionId: state?.selectionId, ...extra,
        ...(eligibility ? { beforeWalletRequest: ensureEligible } : {}), onProgress: next => {
        if (next.status === "pending") remember(next.transactionHash);
        if (next.status === "confirmed") remember(null);
        if (currentStorageKey.current === storageKey) setProgress(next);
      } };
      if (action === "submitMilestone") {
        payload.evidence = { summary: delivery.summary.trim().normalize("NFC"), url: delivery.url.trim() };
        payload.evidenceHash = hashEscrowEvidence(payload.evidence);
        await saveEscrowEvidence({ proposalId: proposal.id, ownerId: user.id, evidence: payload.evidence, evidenceHash: payload.evidenceHash });
      } else if (["approveMilestone", "voteMilestone", "releaseMilestone"].includes(action)) {
        if (!evidence || evidence.hash !== state?.currentMilestone?.evidenceHash) throw new Error("Refresh and review the current delivery evidence first.");
        payload.evidenceHash = evidence.hash;
      } else if (action === "lockSelection") payload.selectionId = keccak256(stringToHex(crypto.randomUUID()));
      if (currentStorageKey.current !== storageKey) return;
      let result;
      try { result = await writeEscrowAction(payload); }
      catch (err) {
        // Nothing was sent: report the server's eligibility reason (or the
        // navigation) ahead of a client-side read failure that raced it.
        if (eligibility && !err.transactionHash) await ensureEligible();
        throw err;
      }
      remember(null);
      if (currentStorageKey.current !== storageKey) return;
      void queryClient?.invalidateQueries({ queryKey: ACTION_ITEMS_KEY });
      // Every confirmed action says so beside its button, not only in the audit trail.
      setNotice(SUCCESS_NOTICES[action] ?? "Transaction confirmed.");
      if (action === "rejectSelection") setRejectionReason("");
      const updated = refresh({ includeHistory: false });
      let syncFailure = null;
      try { if (!state?.isHistorical) {
        setSettlement({ status: "preparing", message: "Your transaction is confirmed. Updating funding records and checking payment readiness…" });
        await synchronizeConfirmed(result?.transactionHash ? { transactionHash: result.transactionHash } : {});
      } } catch (err) { syncFailure = err; }
      await updated;
      if (syncFailure && currentStorageKey.current === storageKey) {
        setSyncError(`The wallet transaction confirmed, but funding records could not be synchronized: ${syncFailure.message}. Use Reconcile funding records to retry.`);
        setError("Your transaction is confirmed on-chain, but the funding records have not caught up yet. Use Reconcile funding records below to retry; do not repeat the transaction.");
      }
      // The success notice replaces the step-by-step progress once records are updated.
      if (currentStorageKey.current === storageKey) setProgress(null);
      if (action === "deposit" && currentStorageKey.current === storageKey) setAmount("");
    } catch (err) {
      if (err === navigatedAway) return;
      if (err.transactionHash && !err.transactionSettled) remember(err.transactionHash);
      if (err.transactionSettled) remember(null);
      if (currentStorageKey.current === storageKey) {
        setError(escrowErrorMessage(err));
        if (!err.transactionHash || err.transactionSettled) setProgress(null);
      }
    } finally { writing.current = false; setBusy(false); }
  };
  const confirmPending = async () => {
    if (writing.current || !unresolvedTransaction) return;
    writing.current = true; setBusy(true);
    const settled = () => { saveTransaction(storageKey, null); if (currentStorageKey.current === storageKey) { setUnresolvedTransaction(null); setProgress(null); } };
    try {
      await confirmEscrowTransaction(unresolvedTransaction); settled();
      if (currentStorageKey.current !== storageKey) return;
      void queryClient?.invalidateQueries({ queryKey: ACTION_ITEMS_KEY });
      const updated = refresh({ includeHistory: false });
      try { if (!state?.isHistorical) {
        // A recovered hash may be an ERC20 approval, not an escrow event.
        await synchronizeConfirmed();
      } }
      catch (err) { if (currentStorageKey.current === storageKey) setSyncError(`Transaction confirmed. Funding records could not be synchronized: ${err.message}`); }
      await updated;
    }
    catch (err) { if (currentStorageKey.current === storageKey) setError(escrowErrorMessage(err)); if (err.transactionSettled) settled(); }
    finally { writing.current = false; setBusy(false); }
  };
  const waitForPassiveSync = () => passiveSync.current
    ? Promise.race([passiveSync.current.catch(() => {}), new Promise(resolve => setTimeout(resolve, 5_000))]) : null;
  const synchronize = async ({ select = false, passive = false } = {}) => {
    if (writing.current || !user?.id || (select && (!walletReady || integrityBlocked)) || unresolvedTransaction) return;
    if (passive) {
      // Background payment-status recovery runs without busy state, so it never
      // disables or swallows a member's click; actions queue briefly behind it.
      if (passiveSync.current) return;
      const key = storageKey;
      const run = (async () => {
        const updated = refresh({ includeHistory: false });
        try { await synchronizeConfirmed(); }
        catch (err) { if (currentStorageKey.current === key) setSyncError(err.message || "Funding status could not be updated. Retry when ready."); }
        finally { await updated; }
      })();
      passiveSync.current = run;
      try { await run; } finally { if (passiveSync.current === run) passiveSync.current = null; }
      return;
    }
    writing.current = true; setBusy(true); setSyncError(""); setError("");
    if (select) { setSettling(true); setNotice(""); }
    try {
      await waitForPassiveSync();
      if (select) {
        const result = await startEscrowSettlement({ proposalId: proposal.id });
        if (currentStorageKey.current !== storageKey) return;
        const updated = refresh({ includeHistory: false });
        let final;
        try { final = await synchronizeConfirmed({}, result); } finally { await updated; }
        // The request is saved once the callable returns. When another check
        // holds the platform signer, say so instead of silently re-enabling.
        const status = (final ?? result)?.settlement?.status;
        if (currentStorageKey.current === storageKey) setNotice(["confirmed", "complete", "released"].includes(status)
          ? "Selection confirmed on-chain. Both owners can now approve the upfront payment."
          : status === "pending" ? "Selection submitted on-chain. This panel updates when it confirms."
            : "Selection requested. The platform will submit it on-chain shortly; this panel updates when it confirms.");
      } else {
        const updated = refresh({ includeHistory: false });
        try { await synchronizeConfirmed(); } finally { await updated; }
      }
      void queryClient?.invalidateQueries({ queryKey: ACTION_ITEMS_KEY });
    } catch (err) {
      if (currentStorageKey.current === storageKey) {
        const message = err.message || "Funding status could not be updated. Retry when ready.";
        setSyncError(message);
        // Show the failure beside the panel's actions, not only in the audit trail below.
        setError(select ? `The selection could not be requested: ${message}` : `Funding status could not be updated: ${message}`);
      }
    }
    finally { writing.current = false; setBusy(false); if (select) setSettling(false); }
  };
  periodicRefresh.current = () => {
    if (pendingSettlement.has((settlement ?? history?.settlement)?.status) && user?.id && !state?.isHistorical) void synchronize({ passive: true });
  };
  useLiveActivity({ proposalId: proposal.id, channel: "funding", identity: user?.id, onRefresh: refresh,
    enabled: Boolean(proposal.id), blocked: busy || loading, triggers: "activity" });
  return <><EscrowFundingView {...{ state, evidence, loading, error, busy, progress, walletReady, walletMessage, amount, setAmount, delivery, setDelivery, rejectionReason, setRejectionReason, unresolvedTransaction, moderated, fundingBlockReason, notice, canDeposit, integrityBlocked, settling }}
    settlement={settlement ?? history?.settlement} onSettle={() => synchronize({ select: true })} onSync={() => synchronize()}
    onAction={act} onRefresh={refresh} onConnect={() => { void signIn(); }} onConfirm={confirmPending} />
    {user?.id && !state?.isHistorical && <EscrowFundingHistory data={history} error={syncError || historyError} busy={busy} onSync={() => synchronize()} />}</>;
}
