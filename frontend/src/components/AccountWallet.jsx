import { useEffect, useId, useRef, useState } from "react";
import { encodeFunctionData, erc20Abi, formatUnits } from "viem";
import { httpsCallable } from "firebase/functions";
import { functions } from "../lib/firebase.js";
import { getPendingSponsoredTransaction, recoverPendingSponsoredTransaction, subscribePendingSponsoredTransactions } from "../lib/embeddedWallet.js";
import { isRpcQuotaExceeded, isRpcUnreachable, isWalletRejection, walletOutcomeError } from "../lib/errors.js";
import { useWallet } from "../context/WalletContext.jsx";
import { Modal } from "./Modal.jsx";
import { TokenSelect } from "./TokenSelect.jsx";
import { WALLET_TOKENS, readWalletBalances, validateTokenTransfer, sendWalletTokens, confirmWalletTokenTransfer, createFaucetClaim } from "../lib/walletTokens.js";

const defaults = {
  readWalletBalances, validateTokenTransfer, sendWalletTokens, confirmWalletTokenTransfer, createFaucetClaim,
  recoverPendingSponsoredTransaction,
  claimWalletTokens: async (data) => {
    if (!functions) throw new Error("The test token faucet is not configured. Contact an administrator.");
    const response = await httpsCallable(functions, "claimWalletTokens", { timeout: 120_000 })(data);
    return response.data;
  },
};
const same = (a, b) => Boolean(a && b && a.toLowerCase() === b.toLowerCase());
const WALLET_ERROR_FALLBACK = "The wallet request could not be completed. Refresh your balance and try again; check any pending transfer first.";
function message(error) {
  if (isWalletRejection(error)) return "The wallet request was declined. Your entries are kept; retry when ready.";
  const text = String(error?.message ?? "").replace(/^Firebase:\s*/, "").replace(/\s*\(functions\/[^)]+\)\.?$/, "");
  // The callable relays the faucet's cooldown copy; preserve it even when it
  // contains 'rate limit', which also appears in RPC transport failures.
  if (error?.code === "functions/resource-exhausted" && text && text.length <= 500) return text;
  const outcome = walletOutcomeError(error);
  if (outcome && typeof outcome.message === "string" && outcome.message.length <= 500 && !/[\r\n]|https?:\/\/|Contract Call:|Request Arguments:/i.test(outcome.message)) return outcome.message;
  if (isRpcQuotaExceeded(error)) return "Arbitrum Sepolia is over its request limit. Wait a moment, then refresh your balance. Check any pending transfer before sending again.";
  if (isRpcUnreachable(error)) return "Arbitrum Sepolia could not be reached. Check your connection and try again. Check any pending transfer before sending again.";
  const technical = /BaseError|ContractFunction|ContractExecution|CallExecution|Rpc|TransactionExecution|HttpRequest/i.test(String(error?.name ?? ""))
    || /[\r\n]|https?:\/\/|execution reverted|VM Exception|Contract Call:|Raw Call Arguments:|Request (?:Arguments|body):|Details:|Version: viem|Docs:/i.test(text);
  return text && text.length <= 500 && !technical ? text : WALLET_ERROR_FALLBACK;
}
const recoveryKey = (address) => `qcdao:wallet-transfer:${address.toLowerCase()}`;
const RECOVERY_CHANGED = "qcdao-wallet-transfer-recovery";
const recoveryMemory = new Map();
function storeRecovery(address, transfer) {
  const key = recoveryKey(address);
  if (transfer) recoveryMemory.set(key, transfer);
  let saved = false;
  try {
    if (transfer) sessionStorage.setItem(key, JSON.stringify({ ...transfer, amount: transfer.amount.toString() }));
    else { sessionStorage.removeItem(key); recoveryMemory.delete(key); }
    saved = true;
  } catch { /* Keep the in-memory hash and the previously saved unresolved intent. */ }
  window.dispatchEvent(new Event(RECOVERY_CHANGED));
  return saved;
}
function loadRecovery(address) {
  const key = recoveryKey(address);
  try {
    const raw = sessionStorage.getItem(key);
    if (!raw) { recoveryMemory.delete(key); return null; }
    const value = JSON.parse(raw);
    if (same(value?.address, address) && (/^0x[\da-f]{64}$/i.test(value.transactionHash) || value.unresolved === true) && WALLET_TOKENS.some(t => t.symbol === value.token) && /^\d{1,78}$/.test(value.amount) && BigInt(value.amount) > 0n && BigInt(value.amount) < (1n << 256n) && /^0x[\da-f]{40}$/i.test(value.recipient)) {
      return recoveryMemory.get(key)?.transactionHash ? recoveryMemory.get(key) : { ...value, amount: BigInt(value.amount) };
    }
    return { address, unresolved: true, unreadable: true };
  } catch { return recoveryMemory.get(key) ?? { address, unresolved: true, unreadable: true }; }
}
function prepareRecovery(address, transfer) {
  const probe = `${recoveryKey(address)}:probe`;
  try { sessionStorage.setItem(probe, "1"); sessionStorage.removeItem(probe); }
  catch { throw new Error("Enable site storage before sending tokens so a pending transfer can be recovered safely."); }
  if (!storeRecovery(address, { ...transfer, unresolved: true })) {
    throw new Error("The pending transfer could not be saved. Enable site storage before sending tokens.");
  }
}

/** Private wallet details only appear within the verified member's account menu. */
export function AccountWallet({ address, email, visible = true, services = defaults }) {
  const wallet = useWallet();
  const identity = same(address, wallet.address) && wallet.isConnected ? address.toLowerCase() : null;
  const current = useRef(identity);
  const epoch = useRef(0);
  if (current.current !== identity) epoch.current += 1;
  current.current = identity;
  const renderEpoch = epoch.current;
  const alive = useRef(true);
  const request = useRef(0);
  const locked = useRef(false);
  const [balances, setBalances] = useState(null);
  const [stateIdentity, setStateIdentity] = useState(identity);
  const [loading, setLoading] = useState(false);
  const [readError, setReadError] = useState("");
  const [notice, setNotice] = useState("");
  const [action, setAction] = useState(null);
  const [symbol, setSymbol] = useState("USDC");
  const [amount, setAmount] = useState("");
  const [recipient, setRecipient] = useState("");
  const [review, setReview] = useState(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [phase, setPhase] = useState("");
  const [pending, setPending] = useState(null);
  const titleId = `wallet-${useId().replace(/:/g, "")}`;
  const valid = (id) => alive.current && current.current === id && epoch.current === renderEpoch;

  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);
  const refresh = async (id = identity) => {
    if (!id) return;
    const serial = ++request.current;
    setLoading(true); setReadError("");
    try {
      const result = await services.readWalletBalances(id);
      if (valid(id) && serial === request.current) {
        setBalances(result);
      }
    } catch (cause) {
      if (valid(id) && serial === request.current) { setBalances(null); setReadError(message(cause)); }
    } finally { if (valid(id) && serial === request.current) setLoading(false); }
  };
  useEffect(() => {
    ++request.current; locked.current = false;
    setStateIdentity(identity);
    setBalances(null); setReadError(""); setNotice(""); setAction(null); setReview(null); setError(""); setBusy(false); setPhase(""); setAmount(""); setRecipient("");
    setPending(identity ? loadRecovery(identity) : null);
  }, [identity]);
  useEffect(() => { if (visible && identity) refresh(identity); }, [visible, identity, services]); // Refresh on each menu opening.
  useEffect(() => {
    if (!identity) return undefined;
    const update = () => {
      if (valid(identity)) setPending(loadRecovery(identity));
    };
    const captureHash = () => {
      const transfer = loadRecovery(identity);
      const operation = getPendingSponsoredTransaction(identity);
      const selected = WALLET_TOKENS.find(t => t.symbol === transfer?.token);
      if (selected && operation?.transactionHash && same(operation.to, selected.address)
        && operation.data?.toLowerCase() === encodeFunctionData({ abi: erc20Abi, functionName: "transfer", args: [transfer.recipient, transfer.amount] }).toLowerCase()) {
        storeRecovery(identity, { ...transfer, transactionHash: operation.transactionHash, unresolved: false });
      }
    };
    window.addEventListener(RECOVERY_CHANGED, update);
    const unsubscribe = subscribePendingSponsoredTransactions(captureHash);
    captureHash();
    return () => { window.removeEventListener(RECOVERY_CHANGED, update); unsubscribe(); };
  }, [identity]);

  if (!identity || stateIdentity !== identity) return visible ? <p className="account-wallet-unavailable">Connect the embedded wallet for this account to view balances.</p> : null;
  const token = WALLET_TOKENS.find(t => t.symbol === symbol);
  const balance = balances?.[symbol];
  const amountText = (value, decimals = 6) => typeof value === "bigint" ? formatUnits(value, decimals) : "—";
  const open = (next) => { setError(""); setNotice(""); setAction(next); setReview(null); setPhase(""); };
  const dismiss = () => { if (!locked.current) { setAction(null); setReview(null); setError(""); } };
  const copy = async () => {
    try { await navigator.clipboard.writeText(address); if (valid(identity)) setNotice("Wallet address copied."); }
    catch { if (valid(identity)) setNotice("Copy is unavailable. Select and copy the full wallet address below."); }
  };
  const prepare = (event) => {
    event.preventDefault(); setError("");
    try {
      if (balance == null) throw new Error("Refresh your balance before sending tokens.");
      const transfer = services.validateTokenTransfer({ token: symbol, amount, recipient, address: identity, balance });
      setReview(transfer);
    } catch (cause) { setError(message(cause)); }
  };
  const send = async () => {
    if (locked.current || pending || !review || !valid(identity)) return;
    const saved = loadRecovery(identity);
    if (saved) { setPending(saved); setError("Check the existing transfer before sending again."); return; }
    locked.current = true; setBusy(true); setError(""); setPhase("Confirm the transfer in your embedded wallet.");
    const id = identity;
    const transfer = { token: symbol, amount: review.amount, recipient: review.recipient, address: id };
    let submitted = null;
    let prepared = false;
    try {
      prepareRecovery(id, transfer); prepared = true;
      const result = await services.sendWalletTokens({ ...transfer, onSubmitted: (progress) => {
        if (progress?.transactionHash) {
          submitted = { ...transfer, transactionHash: progress.transactionHash };
          const persisted = storeRecovery(id, submitted);
          if (valid(id)) setPending(submitted);
          if (!persisted && valid(id)) setError("The transfer was submitted but its hash could not be saved. Keep this page open and check its status before sending again.");
        }
        if (valid(id)) setPhase("Transfer submitted. Waiting for chain confirmation…");
      } });
      storeRecovery(id, null);
      if (!valid(id)) return;
      setPending(null); setAction(null); setReview(null); setAmount(""); setRecipient("");
      setNotice(`${symbol} transfer confirmed.`); await refresh(id);
      return result;
    } catch (cause) {
      const knownHash = submitted?.transactionHash || cause?.transactionHash || loadRecovery(id)?.transactionHash;
      let remaining = null;
      if (cause?.walletOutcome === "reverted") storeRecovery(id, null);
      else if (knownHash) { remaining = { ...transfer, transactionHash: knownHash }; storeRecovery(id, remaining); }
      else if (cause?.walletOutcome === "pending") { remaining = { ...transfer, unresolved: true }; storeRecovery(id, remaining); }
      else if (prepared) storeRecovery(id, null);
      if (!valid(id)) return;
      setPending(remaining || loadRecovery(id));
      setError(message(cause));
    } finally { if (valid(id)) { locked.current = false; setBusy(false); setPhase(""); } }
  };
  const recover = async () => {
    if (locked.current || !pending || pending.unreadable) return;
    const id = identity; locked.current = true; setBusy(true); setError(""); setNotice("");
    try {
      let transfer = loadRecovery(id) || pending;
      if (!transfer.transactionHash) {
        const hash = await (services.recoverPendingSponsoredTransaction || recoverPendingSponsoredTransaction)({ wallet: { address: id }, timeoutMs: 10_000 });
        transfer = loadRecovery(id) || transfer;
        if (!hash && !transfer.transactionHash) throw new Error("The transfer hash is still unavailable. Keep this request pending and contact an administrator before sending again.");
        transfer = { ...transfer, transactionHash: transfer.transactionHash || hash, unresolved: false };
        storeRecovery(id, transfer);
      }
      await services.confirmWalletTokenTransfer(transfer);
      storeRecovery(id, null);
      if (!valid(id)) return;
      setPending(null); setAction(null); setReview(null); setNotice("Token transfer confirmed."); await refresh(id);
    } catch (cause) { if (valid(id)) {
      if (cause?.walletOutcome === "reverted") { storeRecovery(id, null); setPending(null); setReview(null); }
      setError(message(cause));
    } }
    finally { if (valid(id)) { locked.current = false; setBusy(false); } }
  };
  const claim = async () => {
    if (locked.current || pending || !valid(identity)) return;
    const saved = loadRecovery(identity);
    if (saved) { setPending(saved); setError("Check the existing transfer before claiming tokens."); return; }
    const id = identity; locked.current = true; setBusy(true); setError(""); setPhase("Confirm the faucet message in your embedded wallet.");
    try {
      const claimData = services.createFaucetClaim({ token: symbol, address: wallet.address, issuedAt: Math.floor(Date.now() / 1000) });
      const signature = await wallet.signMessage(claimData.message, wallet.address);
      if (!valid(id)) return;
      setPhase("Claiming test tokens. Waiting for chain confirmation…");
      const result = await services.claimWalletTokens({ token: claimData.token, issuedAt: claimData.issuedAt, signature });
      if (!valid(id)) return;
      setNotice(`${result.amount || "10000"} test ${symbol} claimed.`); setAction(null); await refresh(id);
    } catch (cause) { if (valid(id)) setError(message(cause)); }
    finally { if (valid(id)) { locked.current = false; setBusy(false); setPhase(""); } }
  };
  const selection = <div className="wallet-token-field"><label htmlFor={`${titleId}-token`}>Token</label><TokenSelect id={`${titleId}-token`} value={symbol} disabled={busy} options={WALLET_TOKENS.map(t => ({ value: t.symbol, label: t.symbol }))} onChange={event => { setSymbol(event.target.value); setError(""); }} /></div>;

  return <>
    {visible && <section className="account-wallet" aria-label="Your embedded wallet">
      <p className="account-wallet-email">{email || wallet.email || "Email unavailable"}</p>
      <div className="account-wallet-address"><span>Embedded wallet</span><button type="button" onClick={copy} aria-label="Copy wallet address">Copy address</button><code>{address}</code></div>
      <div className="account-wallet-heading"><strong>Test token balances</strong><button type="button" disabled={loading} onClick={() => refresh()}>{loading ? "Refreshing…" : "Refresh"}</button></div>
      <small>Arbitrum Sepolia · gas sponsored</small>
      <dl className="account-wallet-balances">{WALLET_TOKENS.map(t => <div key={t.symbol}><dt>{t.symbol}</dt><dd>{amountText(balances?.[t.symbol], t.decimals)}</dd></div>)}</dl>
      {readError && <p role="alert">{readError}</p>}
      {pending && <div className="account-wallet-pending"><p>A transfer may already have been sent. Check its status before sending again.</p>{pending.unreadable ? <p>The saved transfer could not be read. Contact an administrator before sending again.</p> : <button type="button" disabled={busy} onClick={recover}>{busy ? "Checking transfer…" : "Check transfer status"}</button>}</div>}
      {notice && <p role="status">{notice}</p>}
      {!action && error && <p role="alert">{error}</p>}
      <div className="account-wallet-actions"><button type="button" onClick={() => open("send")} disabled={Boolean(pending)}>Send</button><button type="button" onClick={() => open("faucet")} disabled={Boolean(pending)}>Faucet</button><button type="button" onClick={() => open("preview")}>Add funds</button></div>
    </section>}
    {action && <Modal labelledBy={titleId} onDismiss={dismiss} className="wallet-action-modal">
      <header className="modal-head"><h2 id={titleId}>{action === "send" ? review ? "Confirm token transfer" : "Send test tokens" : action === "faucet" ? "Claim test tokens" : "Privy on-ramp preview"}</h2></header>
      <div className="modal-body">
        {action === "preview" ? <><p>Card funding is unavailable on testnet. This preview does not open a payment window or move tokens.</p><p>Use the faucet to claim test XSGD, USDT or USDC into your embedded wallet.</p></> : action === "send" ? review ? <div className="wallet-transfer-review"><p>Send <strong>{amountText(review.amount, token.decimals)} {symbol}</strong> on Arbitrum Sepolia.</p><p>Recipient</p><code>{review.recipient}</code><p>Gas is sponsored. You do not need ETH.</p></div> : <form id={`${titleId}-send`} className="wallet-action-form" onSubmit={prepare}>{selection}<p>Available: {amountText(balance, token.decimals)} {symbol}</p><label>Recipient address<input value={recipient} onChange={event => setRecipient(event.target.value)} autoComplete="off" spellCheck="false" required /></label><label>Amount<input value={amount} onChange={event => setAmount(event.target.value)} inputMode="decimal" autoComplete="off" required /></label></form> : <div className="wallet-action-form">{selection}<p>Claim test tokens into your embedded wallet. You will sign a faucet message; no separate wallet is needed.</p><code>{address}</code><p>The faucet’s per-token cooldown applies.</p></div>}
        {phase && <p role="status">{phase}</p>}{error && <p role="alert">{error}</p>}
        {pending && <p>A transfer is awaiting confirmation. Check its status in your account menu before sending again.</p>}
      </div>
      <footer className="modal-actions"><button type="button" className="secondary" disabled={busy} onClick={dismiss}>{action === "preview" || pending ? "Close" : "Cancel"}</button>{action === "send" && !pending && (review ? <><button type="button" className="secondary" disabled={busy} onClick={() => { setReview(null); setError(""); }}>Back</button><button type="button" className="primary" disabled={busy} onClick={send}>{busy ? "Sending…" : "Confirm and send"}</button></> : <button type="submit" form={`${titleId}-send`} className="primary" disabled={loading || balance == null}>Review transfer</button>)}{action === "faucet" && <button type="button" className="primary" disabled={busy || Boolean(pending)} onClick={claim}>{busy ? "Claiming…" : `Claim ${symbol}`}</button>}</footer>
    </Modal>}
  </>;
}
