import { useLiveActivity } from "../hooks/useLiveActivity.js";
import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { QueryClientContext } from "@tanstack/react-query";
import { erc20Abi } from "viem";
import { useAuth } from "../context/AuthContext.jsx";
import { useSignIn } from "../context/SessionContext.jsx";
import { useWallet } from "../context/WalletContext.jsx";
import { invalidateFundingDashboardSummaries } from "../lib/fundingDashboardCache.js";
import { AUDIT_REGISTRY_CONFIG } from "../config/auditRegistry.js";
import { getOpenFundingSummary, openFundingSupported, syncOpenFunding, writeOpenFundingAction } from "../lib/openFunding.js";
import { confirmEscrowTransaction, createWalletEscrowAdapters, escrowErrorMessage } from "../lib/escrow.js";
import { escrowExplorer, escrowFundingAmount } from "../lib/escrowFunding.js";
import { fundingAmountUnits } from "../../../firebase/functions/escrowProposalTerms.js";
import { Field } from "./Field.jsx";
import { ACTION_ITEMS_KEY } from "../lib/proposalQueues.js";
import { prewarmCallable, prewarmTransaction } from "../lib/prewarm.js";
import { formatInstant } from "../lib/datetime.js";

const same = (a, b) => Boolean(a && b && a.toLowerCase() === b.toLowerCase());
const storageKey = (id, account) => `qcdao:grant-pending:${AUDIT_REGISTRY_CONFIG.chainId}:${AUDIT_REGISTRY_CONFIG.address}:${id}:${account?.toLowerCase()}`;
const pendingFallback = new Map();
function stored(key) {
  try { return JSON.parse(sessionStorage.getItem(key)) || pendingFallback.get(key) || null; }
  catch { return pendingFallback.get(key) || null; }
}
function save(key, value) {
  if (value) pendingFallback.set(key, value); else pendingFallback.delete(key);
  try { if (value) sessionStorage.setItem(key, JSON.stringify(value)); else sessionStorage.removeItem(key); } catch { /* Retain in this tab. */ }
}

// Typed amounts survive pool refreshes and a remount of this panel (for example
// when the posting reloads after "Create grant pool"). Only a confirmed deposit
// or withdrawal clears the amount it used. Session storage only: nothing leaves the tab.
const draftKey = key => `qcdao:grant-draft:${key}`;
function readDraft(key) {
  try { return JSON.parse(sessionStorage.getItem(draftKey(key))) || {}; } catch { return {}; }
}
function writeDraft(key, field, value) {
  try {
    const next = { ...readDraft(key), [field]: value };
    if (!next.amount && !next.withdrawalAmount) sessionStorage.removeItem(draftKey(key));
    else sessionStorage.setItem(draftKey(key), JSON.stringify(next));
  } catch { /* The panel state still holds the amount. */ }
}

const SUCCESS = {
  create: "Grant pool created. Enter an amount under Add funding, then deposit it to make grants.",
  deposit: "Deposit confirmed. The funds are now available in the grant pool.",
  select: "Offer recorded. The researcher has seven days to accept.",
  accept: "Grant accepted. The requested funds are now in proposal escrow.",
  decline: "Grant offer declined. The reserved amount has returned to the pool’s available balance.",
  void: "Offer voided. Its reserved amount has returned to the grant pool.",
  withdraw: "Withdrawal confirmed. Unreserved funds have returned to your wallet.",
};

function progressMessage(progress) {
  if (progress?.status === "awaiting_signature") return ["approve", "resetAllowance"].includes(progress.action)
    ? "Approve this token amount in your wallet." : "Confirm the transaction in your wallet.";
  if (progress?.status === "pending") return "Transaction submitted. Waiting for confirmation…";
  if (progress?.status === "confirmed") return "Transaction confirmed. Updating the grant pool…";
  return "Preparing your transaction… checking the grant pool before your wallet opens.";
}

const DECLINE_MIN = 10, DECLINE_MAX = 2000;
const declineLength = reason => String(reason ?? "").trim().normalize("NFC").length;

export function OpenFundingView({ data, loading, error, notice, busy, progress, walletReady, pending, amount, setAmount,
  withdrawalAmount = "", setWithdrawalAmount, onAction, onRefresh, onConfirm, onConnect, proposalId, onNavigate, integrityBlocked = false,
  decline = null, onDeclineChange }) {
  // A background pool read neither disables nor remounts controls; every action is
  // re-prepared and verified by the server before the wallet opens.
  const disabled = busy || !walletReady || Boolean(pending);
  const money = value => escrowFundingAmount(value, data?.tokenDecimals, data?.tokenSymbol);
  const selected = (data?.selections ?? []).filter(item => !proposalId || item.proposalId === proposalId);
  const canWithdraw = Boolean(data?.canWithdraw && data.closed && data.poolAddress && BigInt(data.available ?? 0) > 0n);
  let withdrawalError = "";
  if (canWithdraw && withdrawalAmount.trim()) {
    try {
      if (fundingAmountUnits(withdrawalAmount, data.tokenDecimals) > BigInt(data.available)) withdrawalError = "The amount exceeds the unreserved funds available.";
    } catch (err) { withdrawalError = err.message; }
  }
  return <section id="proposal-funding" className="card escrow-funding" aria-label="Open funding grant pool">
    <div className="table-header"><div><h3>Open funding grant pool</h3><p>One funder · multiple grants · seven days to accept</p></div>
      <button type="button" className="secondary small" disabled={busy || loading} onClick={onRefresh}>Refresh grant pool</button></div>
    <p className="field-hint">The owner deposits funds before choosing proposals. Each selection reserves its requested amount for seven days. Acceptance transfers that amount into the proposal’s escrow; an unaccepted offer is void after its deadline.</p>
    {loading && !data && <p role="status">Reading the grant pool…</p>}
    {busy && progress && !error && <p role="status">{progressMessage(progress)}</p>}
    {error && <p role="alert" className="error-banner">{error}</p>}
    {notice && <p role="status" className="proposal-success">{notice}</p>}
    {data?.supported === false && <p role="status">{data.message || "Open funding pools are awaiting a contract deployment."}</p>}
    {data?.supported && <>
      <dl className="escrow-stats">
        {[["Deposited", "totalDeposited"], ["Available", "available"], ["Reserved", "totalReserved"], ["Awarded to proposals", "totalAllocated"]].map(([label, key]) => <div key={key}><dt>{label}</dt><dd>{money(data[key])}</dd></div>)}
      </dl>
      {data.poolAddress ? <a href={escrowExplorer("address", data.poolAddress)} target="_blank" rel="noreferrer">View grant pool contract</a>
        : <p className="field-hint">The owner must create this pool, then deposit funds. The advertised budget is not a deposit.</p>}
      {!walletReady && <button type="button" className="secondary small" onClick={onConnect}>Sign in to use your wallet</button>}
      {data.canCreate && !data.poolAddress && <button type="button" className="primary small" disabled={disabled || integrityBlocked} onClick={() => onAction("create")}>Create grant pool</button>}
      {data.canDeposit && data.poolAddress && <div className="field-group">
        <Field label="Add funding" htmlFor="grant-deposit" hint={`Enter an additional amount in ${data.tokenSymbol}. You can increase the pool after awarding grants.`}>
          {({ id, describedBy }) => <input id={id} type="text" inputMode="decimal" value={amount} aria-describedby={describedBy} maxLength={160} disabled={disabled} onChange={event => setAmount(event.target.value)} />}
        </Field>
        <button type="button" className="primary small" disabled={disabled || integrityBlocked || !amount.trim()} onClick={() => onAction("deposit")}>Deposit funds</button>
        <p className="field-hint">Approve the entered token amount, then confirm the deposit in your wallet.</p>
      </div>}
      {canWithdraw && <div className="field-group">
        <Field label="Withdraw available funding" htmlFor="grant-withdrawal" hint={`This posting has closed. You can withdraw up to ${money(data.available)}. Reserved offers and awarded grants remain funded.`} error={withdrawalError}>
          {({ id, describedBy }) => <input id={id} type="text" inputMode="decimal" value={withdrawalAmount} aria-describedby={describedBy} aria-invalid={Boolean(withdrawalError)} maxLength={160} disabled={disabled} onChange={event => setWithdrawalAmount(event.target.value)} />}
        </Field>
        <button type="button" className="secondary small" disabled={disabled || !withdrawalAmount.trim() || Boolean(withdrawalError)} onClick={() => onAction("withdraw")}>Withdraw funds</button>
      </div>}
      {selected.map(item => {
        const expired = item.status === "expired";
        const canSelect = item.status === "none" && data.canSelect && item.canSelect !== false && BigInt(item.amountBaseUnits ?? 0) > 0n
          && BigInt(item.amountBaseUnits) <= BigInt(data.available ?? 0);
        const declining = Boolean(item.canDecline && decline?.proposalId === item.proposalId);
        const reasonId = `grant-decline-reason-${item.proposalId}`, reasonLength = declining ? declineLength(decline.reason) : 0;
        const reasonError = declining && reasonLength > 0 && reasonLength < DECLINE_MIN ? `Enter at least ${DECLINE_MIN} characters.` : "";
        const status = expired ? "Offer expired" : item.declined ? "Offer declined by the researcher" : item.status === "pending" ? "Awaiting researcher acceptance"
          : item.status === "accepted" ? "Grant accepted" : item.status === "voided" ? "Offer voided" : "Seeking a grant";
        return <div className="table-row" key={item.proposalId}><div><strong>{item.title || "Proposal"}</strong>
          <small className="table-row-meta">Requested {money(item.amountBaseUnits)} · {status}</small>
          {Number(item.acceptanceDeadline) > 0 && ["pending", "expired"].includes(item.status) && <small className="table-row-meta">Accept before {formatInstant(new Date(Number(item.acceptanceDeadline) * 1000))}</small>}
          {item.declined && item.declineReason && <small className="table-row-meta">Researcher’s reason: {item.declineReason}</small>}
          {item.canDecline && !declining && <small className="table-row-meta">Not taking this grant? Decline the offer to return the reserved amount to the pool’s available balance right away.</small>}
          {item.canAccept && !item.canDecline && <small className="table-row-meta">Not taking this grant? Leave it unaccepted and the reserved amount returns to the pool after this deadline. Withdrawing this proposal lets the reservation be released sooner.</small>}
          {item.status === "none" && data.canSelect && !canSelect && <small className="table-row-meta">{item.canSelect === false ? "This proposal is not currently eligible for selection." : "Deposit more funds to cover this request."}</small>}
          {declining && <div className="field-group" role="group" aria-label="Decline grant offer">
            <p>Declining is final: this proposal cannot be offered a grant from this pool again, and the reserved {money(item.amountBaseUnits)} returns to the pool’s available balance.</p>
            <Field label="Reason for declining" htmlFor={reasonId} error={reasonError}
              hint={`${DECLINE_MIN}–2,000 characters (${reasonLength.toLocaleString("en-US")} entered). The grant owner sees your reason; only its hash is recorded on-chain.`}>
              {({ id, describedBy, invalid }) => <textarea id={id} rows={3} required minLength={DECLINE_MIN} maxLength={DECLINE_MAX} value={decline.reason ?? ""}
                aria-describedby={describedBy} aria-invalid={invalid} disabled={disabled} onChange={event => onDeclineChange?.({ proposalId: item.proposalId, reason: event.target.value })} />}
            </Field>
            <button type="button" className="primary small" disabled={disabled || reasonLength < DECLINE_MIN || reasonLength > DECLINE_MAX}
              onClick={() => onAction("decline", item.proposalId, { reason: decline.reason })}>Confirm decline</button>{" "}
            <button type="button" className="secondary small" disabled={busy} onClick={() => onDeclineChange?.(null)}>Keep offer</button>
          </div>}
        </div><div className="table-row-actions">
          {canSelect && <button type="button" className="primary small" disabled={disabled || integrityBlocked} onClick={() => onAction("select", item.proposalId)}>Select for funding</button>}
          {item.canAccept && <button type="button" className="primary small" disabled={disabled || integrityBlocked || declining} onClick={() => onAction("accept", item.proposalId)}>Accept grant</button>}
          {item.canDecline && !declining && <button type="button" className="secondary small" disabled={disabled} onClick={() => onDeclineChange?.({ proposalId: item.proposalId, reason: "" })}>Decline grant offer</button>}
          {item.canVoid && <button type="button" className="secondary small" disabled={disabled} onClick={() => onAction("void", item.proposalId)}>{expired ? "Void expired offer" : "Release reserved funds"}</button>}
          {!proposalId && onNavigate && <button type="button" className="text-button" onClick={() => onNavigate(`proposal/${item.proposalId}?tab=funding`)}>View proposal</button>}
        </div></div>;
      })}
      {!selected.length && <p className="field-hint">No proposals seeking a grant yet.</p>}
      {data.truncated && <p className="field-hint">Showing a limited set of proposals. Open a proposal directly to check its offer.</p>}
    </>}
    {pending && !busy && <div role="status"><p>A submitted transaction still needs confirmation. Confirm it before starting another action.</p>
      <a href={escrowExplorer("tx", pending.transactionHash)} target="_blank" rel="noreferrer">View transaction</a>{" "}
      <button type="button" className="secondary small" disabled={busy} onClick={onConfirm}>Check transaction</button></div>}
  </section>;
}

export function OpenFundingPanel({ problemId, proposalId, onNavigate, onChange, integrityBlocked = false }) {
  const { user } = useAuth();
  const queryClient = useContext(QueryClientContext);
  const { address, isConnected } = useWallet();
  const [data, setData] = useState(null), [error, setError] = useState("");
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
  const [amount, setAmountState] = useState(""), [notice, setNotice] = useState("");
  const [withdrawalAmount, setWithdrawalState] = useState("");
  const [pending, setPending] = useState(null), [progress, setProgress] = useState(null);
  // Only one decline form is open at a time; its text never leaves the tab until confirmed.
  const [decline, setDecline] = useState(null);
  const signIn = useSignIn(setError);
  const actionBusy = useRef(false);
  const key = storageKey(problemId, user?.id);
  const setAmount = value => { setAmountState(value); writeDraft(key, "amount", value); };
  const setWithdrawalAmount = value => { setWithdrawalState(value); writeDraft(key, "withdrawalAmount", value); };
  const viewKey = `${key}:${proposalId || ""}`;
  const activeKey = useRef(viewKey); activeKey.current = viewKey;
  const version = useRef(0), inFlight = useRef(null);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const currentPanel = () => alive.current && activeKey.current === viewKey;
  const refresh = useCallback(() => {
    if (inFlight.current?.key === viewKey) return inFlight.current.promise;
    const current = ++version.current;
    setLoading(true);
    const promise = Promise.resolve().then(async () => {
      try {
        const next = openFundingSupported() ? await getOpenFundingSummary({ problemId, proposalId })
          : { supported: false, message: "The current contract deployment does not yet support grant pools. Grant transactions will be available after deployment." };
        if (alive.current && activeKey.current === viewKey && current === version.current) { setData(next); setError(""); }
      } catch (err) { if (alive.current && activeKey.current === viewKey && current === version.current) { setData(null); setError(escrowErrorMessage(err)); } }
      finally {
        if (alive.current && activeKey.current === viewKey && current === version.current) setLoading(false);
        if (inFlight.current?.promise === promise) inFlight.current = null;
      }
    });
    inFlight.current = { key: viewKey, promise };
    return promise;
  }, [problemId, proposalId, viewKey]);
  const applySynced = async next => {
    if (!currentPanel()) return;
    if (next?.supported && Array.isArray(next.selections) && (!next.problemId || next.problemId === problemId)) {
      ++version.current; setData(next); setLoading(false); setError("");
    } else await refresh(); // Rolling deployments may still return a legacy sync response.
  };
  useEffect(() => {
    const draft = readDraft(key);
    setData(null); setError(""); setNotice(""); setDecline(null); setAmountState(draft.amount ?? ""); setWithdrawalState(draft.withdrawalAmount ?? ""); setPending(stored(key));
    void refresh(); return () => { ++version.current; inFlight.current = null; };
  }, [refresh, key]);
  useLiveActivity({ problemId, channel: "funding", identity: user?.id, onRefresh: refresh,
    enabled: Boolean(problemId) && openFundingSupported(), blocked: busy || loading });
  const walletReady = Boolean(user?.id && isConnected && same(address, user.id));
  // Wake the pre-signature function before a click so it does not pay a cold start.
  useEffect(() => {
    if (walletReady && data?.supported) { prewarmCallable("prepareOpenFundingAction"); prewarmTransaction(); }
  }, [walletReady, data?.supported]);
  const remember = value => { save(key, value); if (currentPanel()) setPending(value); };
  const act = async (action, selectedProposalId, extra = {}) => {
    // Exits (withdraw, void, decline) stay available on an integrity mismatch.
    if (actionBusy.current || pending || !walletReady || (integrityBlocked && !["withdraw", "void", "decline"].includes(action))) return;
    actionBusy.current = true; setBusy(true); setError(""); setNotice(""); setProgress({ status: "preparing", action });
    // Refresh the browser RPC's chain check while the server prepares the call.
    prewarmTransaction();
    let walletStep;
    const pendingRecord = (transactionHash, step) => ({ transactionHash, action: step, proposalId: selectedProposalId,
      ...(["approve", "resetAllowance"].includes(step) ? { tokenAddress: data.tokenAddress, poolAddress: data.poolAddress } : {}) });
    try {
      const result = await writeOpenFundingAction({ problemId, proposalId: selectedProposalId, account: address,
        action, amount: action === "withdraw" ? withdrawalAmount : amount, decimals: data.tokenDecimals, tokenAddress: data.tokenAddress,
        ...(action === "decline" ? { reason: extra.reason } : {}),
        onProgress: progress => {
          if (currentPanel()) setProgress(progress);
          if (progress.action) walletStep = progress.action;
          if (progress.status === "pending" && /^0x[0-9a-f]{64}$/i.test(progress.transactionHash ?? "")) remember(pendingRecord(progress.transactionHash, walletStep || action));
          if (progress.status === "confirmed") remember(null);
        } });
      remember({ transactionHash: result.transactionHash, action, proposalId: selectedProposalId });
      void queryClient?.invalidateQueries({ queryKey: ACTION_ITEMS_KEY });
      try { const next = await syncOpenFunding({ problemId, proposalId: selectedProposalId, transactionHash: result.transactionHash }); invalidateFundingDashboardSummaries(queryClient); await applySynced(next); }
      finally { if (currentPanel()) onChange?.({ proposalId: selectedProposalId, action, transactionHash: result.transactionHash }); }
      remember(null);
      if (action === "deposit") writeDraft(key, "amount", "");
      if (action === "withdraw") writeDraft(key, "withdrawalAmount", "");
      if (currentPanel()) {
        // Clear only the amount this action spent; an amount typed for the next step stays.
        if (action === "deposit") setAmountState("");
        if (action === "withdraw") setWithdrawalState("");
        if (action === "decline") setDecline(null);
        setNotice(SUCCESS[action] ?? "Grant pool updated.");
      }
    } catch (err) {
      if (err.terminal || err.transactionSettled) remember(null);
      else if (/^0x[0-9a-f]{64}$/i.test(err.transactionHash ?? "")) remember(pendingRecord(err.transactionHash, walletStep || err.action || action));
      if (currentPanel()) setError(escrowErrorMessage(err));
    } finally { actionBusy.current = false; if (alive.current) { setBusy(false); setProgress(null); } }
  };
  const confirm = async () => {
    if (!pending || actionBusy.current) return;
    actionBusy.current = true; setBusy(true); setError(""); setNotice("");
    setProgress({ status: "pending", action: pending.action, transactionHash: pending.transactionHash });
    try {
      const result = await confirmEscrowTransaction(pending.transactionHash, { confirmations: 2 });
      if (["approve", "resetAllowance"].includes(pending.action)) {
        const next = await getOpenFundingSummary({ problemId, proposalId: pending.proposalId });
        if (!next?.supported || next.chainId !== AUDIT_REGISTRY_CONFIG.chainId
            || !/^0x[0-9a-f]{40}$/i.test(next.poolAddress ?? "") || !/^0x[0-9a-f]{40}$/i.test(next.tokenAddress ?? "")
            || (pending.poolAddress && !same(pending.poolAddress, next.poolAddress))
            || (pending.tokenAddress && !same(pending.tokenAddress, next.tokenAddress))) {
          throw new Error("The approved token or grant pool changed. Refresh before continuing.");
        }
        const allowance = BigInt(await createWalletEscrowAdapters().readContract({ address: next.tokenAddress, abi: erc20Abi,
          functionName: "allowance", args: [user.id, next.poolAddress], chainId: AUDIT_REGISTRY_CONFIG.chainId }));
        if (allowance < 0n) throw new Error("The token allowance could not be verified. Check this transaction again.");
        await applySynced(next);
        remember(null);
        if (currentPanel()) setNotice(allowance === 0n
          ? "Token allowance reset confirmed. No funds were deposited. Review the amount and deposit funds when ready."
          : "Token approval confirmed. No funds were deposited. Review the amount and deposit funds when ready.");
        return;
      }
      void queryClient?.invalidateQueries({ queryKey: ACTION_ITEMS_KEY });
      try { const next = await syncOpenFunding({ problemId, proposalId: pending.proposalId, transactionHash: result.transactionHash }); invalidateFundingDashboardSummaries(queryClient); await applySynced(next); }
      finally { if (currentPanel()) onChange?.({ proposalId: pending.proposalId, action: pending.action, transactionHash: result.transactionHash }); }
      remember(null); if (currentPanel()) setNotice("Transaction confirmed. The grant pool has been refreshed.");
    } catch (err) { if (err.terminal) remember(null); if (currentPanel()) setError(escrowErrorMessage(err)); }
    finally { actionBusy.current = false; setBusy(false); setProgress(null); }
  };
  return <><OpenFundingView {...{ data, loading, error, notice, busy, progress, walletReady, pending, amount, setAmount, withdrawalAmount, setWithdrawalAmount, proposalId, onNavigate, integrityBlocked, decline }}
    onDeclineChange={setDecline}
    onAction={act} onRefresh={() => { setError(""); void refresh(); }} onConfirm={confirm} onConnect={() => { void signIn(); }} /></>;
}
