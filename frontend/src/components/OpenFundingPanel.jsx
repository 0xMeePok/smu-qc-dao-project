import { useCallback, useContext, useEffect, useRef, useState } from "react";
import { QueryClientContext } from "@tanstack/react-query";
import { useAccount } from "wagmi";
import { useAuth } from "../context/AuthContext.jsx";
import { invalidateFundingDashboardSummaries } from "../lib/fundingDashboardCache.js";
import { AUDIT_REGISTRY_CONFIG } from "../config/auditRegistry.js";
import { getOpenFundingSummary, openFundingSupported, syncOpenFunding, writeOpenFundingAction } from "../lib/openFunding.js";
import { confirmEscrowTransaction, escrowErrorMessage } from "../lib/escrow.js";
import { escrowExplorer, escrowFundingAmount } from "../lib/escrowFunding.js";
import { fundingAmountUnits } from "../../../firebase/functions/escrowProposalTerms.js";
import { ConnectWalletModal } from "./ConnectWalletModal.jsx";
import { Field } from "./Field.jsx";
import { ACTION_ITEMS_KEY } from "../lib/proposalQueues.js";

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

export function OpenFundingView({ data, loading, error, notice, busy, walletReady, pending, amount, setAmount,
  withdrawalAmount = "", setWithdrawalAmount, onAction, onRefresh, onConfirm, onConnect, proposalId, onNavigate, integrityBlocked = false }) {
  const disabled = busy || loading || !walletReady || Boolean(pending);
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
    {loading && <p role="status">Reading the grant pool…</p>}
    {error && <p role="alert" className="error-banner">{error}</p>}
    {notice && <p role="status" className="proposal-success">{notice}</p>}
    {data?.supported === false && <p role="status">{data.message || "Open funding pools are awaiting a contract deployment."}</p>}
    {data?.supported && <>
      <dl className="escrow-stats">
        {[["Deposited", "totalDeposited"], ["Available", "available"], ["Reserved", "totalReserved"], ["Awarded to proposals", "totalAllocated"]].map(([label, key]) => <div key={key}><dt>{label}</dt><dd>{money(data[key])}</dd></div>)}
      </dl>
      {data.poolAddress ? <a href={escrowExplorer("address", data.poolAddress)} target="_blank" rel="noreferrer">View grant pool contract</a>
        : <p className="field-hint">The owner must create this pool, then deposit funds. The advertised budget is not a deposit.</p>}
      {!walletReady && <button type="button" className="secondary small" onClick={onConnect}>Connect your signed-in wallet</button>}
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
        return <div className="table-row" key={item.proposalId}><div><strong>{item.title || "Proposal"}</strong>
          <small className="table-row-meta">Requested {money(item.amountBaseUnits)} · {expired ? "Offer expired" : item.status === "pending" ? "Awaiting researcher acceptance" : item.status === "accepted" ? "Grant accepted" : item.status === "voided" ? "Offer voided" : "Seeking a grant"}</small>
          {Number(item.acceptanceDeadline) > 0 && <small className="table-row-meta">Accept before {new Date(Number(item.acceptanceDeadline) * 1000).toLocaleString()}</small>}
          {item.status === "none" && data.canSelect && !canSelect && <small className="table-row-meta">{item.canSelect === false ? "This proposal is not currently eligible for selection." : "Deposit more funds to cover this request."}</small>}
        </div><div className="table-row-actions">
          {canSelect && <button type="button" className="primary small" disabled={disabled || integrityBlocked} onClick={() => onAction("select", item.proposalId)}>Select for funding</button>}
          {item.canAccept && <button type="button" className="primary small" disabled={disabled || integrityBlocked} onClick={() => onAction("accept", item.proposalId)}>Accept grant</button>}
          {item.canVoid && <button type="button" className="secondary small" disabled={disabled} onClick={() => onAction("void", item.proposalId)}>Void expired offer</button>}
          {!proposalId && onNavigate && <button type="button" className="text-button" onClick={() => onNavigate(`proposal/${item.proposalId}?tab=funding`)}>View proposal</button>}
        </div></div>;
      })}
      {!selected.length && <p className="field-hint">No proposals seeking a grant yet.</p>}
      {data.truncated && <p className="field-hint">Showing a limited set of proposals. Open a proposal directly to check its offer.</p>}
    </>}
    {pending && <div role="status"><p>A submitted transaction still needs confirmation. Confirm it before starting another action.</p>
      <a href={escrowExplorer("tx", pending.transactionHash)} target="_blank" rel="noreferrer">View transaction</a>{" "}
      <button type="button" className="secondary small" disabled={busy} onClick={onConfirm}>Check transaction</button></div>}
  </section>;
}

export function OpenFundingPanel({ problemId, proposalId, onNavigate, onChange, integrityBlocked = false }) {
  const { user } = useAuth();
  const queryClient = useContext(QueryClientContext);
  const { address, isConnected, chainId } = useAccount();
  const [data, setData] = useState(null), [error, setError] = useState("");
  const [loading, setLoading] = useState(true), [busy, setBusy] = useState(false);
  const [amount, setAmount] = useState(""), [notice, setNotice] = useState("");
  const [withdrawalAmount, setWithdrawalAmount] = useState("");
  const [pending, setPending] = useState(null), [walletPrompt, setWalletPrompt] = useState(false);
  const actionBusy = useRef(false);
  const key = storageKey(problemId, user?.id);
  const activeKey = useRef(key); activeKey.current = key;
  const refresh = useCallback(async () => {
    const currentKey = key;
    setLoading(true);
    try {
      const next = openFundingSupported() ? await getOpenFundingSummary({ problemId, proposalId })
        : { supported: false, message: "The current contract deployment does not yet support grant pools. Grant transactions will be available after deployment." };
      if (activeKey.current === currentKey) setData(next);
    } catch (err) { if (activeKey.current === currentKey) { setData(null); setError(escrowErrorMessage(err)); } }
    finally { if (activeKey.current === currentKey) setLoading(false); }
  }, [problemId, proposalId, key]);
  useEffect(() => { setData(null); setError(""); setNotice(""); setAmount(""); setWithdrawalAmount(""); setPending(stored(key)); void refresh(); }, [refresh, key]);
  useEffect(() => {
    if (!openFundingSupported()) return undefined;
    const timer = setInterval(() => { if (!actionBusy.current) void refresh(); }, 20_000);
    return () => clearInterval(timer);
  }, [refresh]);
  const walletReady = Boolean(user?.id && isConnected && same(address, user.id) && chainId === AUDIT_REGISTRY_CONFIG.chainId);
  const remember = value => { save(key, value); if (activeKey.current === key) setPending(value); };
  const act = async (action, selectedProposalId) => {
    if (actionBusy.current || pending || !walletReady || (integrityBlocked && !["withdraw", "void"].includes(action))) return;
    actionBusy.current = true; setBusy(true); setError(""); setNotice("");
    try {
      const result = await writeOpenFundingAction({ problemId, proposalId: selectedProposalId, account: address,
        action, amount: action === "withdraw" ? withdrawalAmount : amount, decimals: data.tokenDecimals, tokenAddress: data.tokenAddress,
        onProgress: progress => {
          if (progress.status === "pending") remember({ transactionHash: progress.transactionHash, action: progress.action, proposalId: selectedProposalId });
          if (progress.status === "confirmed") remember(null);
        } });
      remember({ transactionHash: result.transactionHash, action, proposalId: selectedProposalId });
      void queryClient?.invalidateQueries({ queryKey: ACTION_ITEMS_KEY });
      try { await syncOpenFunding({ problemId, proposalId: selectedProposalId, transactionHash: result.transactionHash }); invalidateFundingDashboardSummaries(queryClient); }
      finally { if (activeKey.current === key) onChange?.({ proposalId: selectedProposalId, action, transactionHash: result.transactionHash }); }
      remember(null);
      if (activeKey.current === key) { setAmount(""); setWithdrawalAmount(""); setNotice(action === "select" ? "Offer recorded. The researcher has seven days to accept." : action === "accept" ? "Grant accepted. The requested funds are now in proposal escrow." : action === "withdraw" ? "Withdrawal confirmed. Unreserved funds have returned to your wallet." : "Grant pool updated."); }
      await refresh();
    } catch (err) {
      if (err.terminal || err.transactionSettled) remember(null);
      if (activeKey.current === key) setError(escrowErrorMessage(err));
    } finally { actionBusy.current = false; setBusy(false); }
  };
  const confirm = async () => {
    if (!pending || actionBusy.current) return;
    actionBusy.current = true; setBusy(true); setError("");
    try {
      const result = await confirmEscrowTransaction(pending.transactionHash, { confirmations: 2 });
      void queryClient?.invalidateQueries({ queryKey: ACTION_ITEMS_KEY });
      try { await syncOpenFunding({ problemId, proposalId: pending.proposalId, transactionHash: result.transactionHash }); invalidateFundingDashboardSummaries(queryClient); }
      finally { if (activeKey.current === key) onChange?.({ proposalId: pending.proposalId, action: pending.action, transactionHash: result.transactionHash }); }
      remember(null); setNotice("Transaction confirmed. The grant pool has been refreshed."); await refresh();
    } catch (err) { if (err.terminal) remember(null); setError(escrowErrorMessage(err)); }
    finally { actionBusy.current = false; setBusy(false); }
  };
  return <><OpenFundingView {...{ data, loading, error, notice, busy, walletReady, pending, amount, setAmount, withdrawalAmount, setWithdrawalAmount, proposalId, onNavigate, integrityBlocked }}
    onAction={act} onRefresh={() => { setError(""); void refresh(); }} onConfirm={confirm} onConnect={() => setWalletPrompt(true)} />
    {walletPrompt && <ConnectWalletModal onClose={() => setWalletPrompt(false)} />}</>;
}
