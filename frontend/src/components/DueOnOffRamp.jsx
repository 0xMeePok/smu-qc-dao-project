import { useId, useState } from "react";
import { httpsCallable } from "firebase/functions";
import { functions } from "../lib/firebase.js";
import { formatInstant } from "../lib/datetime.js";
import { Modal } from "./Modal.jsx";

const CURRENCIES = [
  { id: "USD", label: "US dollar (USD)", method: "US bank transfer (ACH)" },
  { id: "SGD", label: "Singapore dollar (SGD)", method: "Singapore bank transfer, if the sandbox offers it" },
  { id: "EUR", label: "Euro (EUR)", method: "Euro bank transfer (SEPA)" },
];
const BANK_LABEL = {
  bankName: "Bank",
  accountName: "Account name",
  accountNumber: "Account number",
  routingNumber: "Routing number",
  iban: "IBAN",
  IBAN: "IBAN",
  bankCode: "Bank code",
  address: "Funding address",
  reference: "Reference",
  memo: "Reference",
  amount: "Amount",
  network: "Network",
  token: "Token",
};

function failure(error) {
  const text = String(error?.message ?? "").replace(/^Firebase:\s*/, "").replace(/\s*\(functions\/[^)]+\)\.?$/, "");
  return text && text.length <= 500 && !/[\r\n]/.test(text) ? text : "Due sandbox could not complete this request.";
}

async function callDue(data) {
  if (!functions) throw new Error("Due sandbox is not configured. Add DUE_API_KEY in firebase/functions/.env and restart the emulators.");
  const response = await httpsCallable(functions, "dueSandbox", { timeout: 60_000 })(data);
  return response.data;
}

function QuoteSummary({ quote }) {
  const fiat = quote.source.currency === "USDC" ? quote.destination.currency : quote.source.currency;
  return <dl className="due-ramp-summary">
    <div><dt>You send</dt><dd>{quote.source.amount} {quote.source.currency}</dd></div>
    <div><dt>Fee</dt><dd>{quote.source.fee ? `${quote.source.fee} ${quote.source.currency}` : "Shown by Due"}</dd></div>
    <div><dt>You receive</dt><dd>{quote.destination.amount} {quote.destination.currency}</dd></div>
    <div><dt>Rate</dt><dd>{quote.fxRate ? `1 USDC = ${quote.fxRate} ${fiat}` : "Set by Due"}</dd></div>
    <div><dt>Network</dt><dd>{quote.destination.currency === "USDC" ? quote.destination.rail : quote.source.rail}</dd></div>
    <div><dt>Quote expires</dt><dd>{formatInstant(quote.expiresAt)}</dd></div>
  </dl>;
}

function DueRampDialog({ address, onDismiss }) {
  const titleId = `due-ramp-${useId().replace(/:/g, "")}`;
  const bannerId = `${titleId}-banner`;
  const amountId = `${titleId}-amount`;
  const [step, setStep] = useState("details");
  const [direction, setDirection] = useState("onramp");
  const [currency, setCurrency] = useState("USD");
  const [amount, setAmount] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [quote, setQuote] = useState(null);
  const [transfer, setTransfer] = useState(null);
  const amountLabel = direction === "onramp" ? `Amount (${currency})` : "Amount (USDC)";

  const review = async (event) => {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      const result = await callDue({ action: "quote", direction, currency, amount });
      setQuote(result.quote);
      setStep("review");
    } catch (cause) {
      setError(failure(cause));
    } finally {
      setBusy(false);
    }
  };
  const create = async () => {
    if (busy || !quote?.token) return;
    setBusy(true);
    setError("");
    try {
      const result = await callDue({ action: "create", direction, currency, quoteToken: quote.token });
      setTransfer(result.transfer);
      setStep("instructions");
    } catch (cause) {
      setError(failure(cause));
    } finally {
      setBusy(false);
    }
  };
  const payIn = async () => {
    if (busy || !transfer?.id) return;
    setBusy(true);
    setError("");
    try {
      const result = await callDue({ action: "payin", transferId: transfer.id });
      setTransfer(result.transfer);
      setStep("result");
    } catch (cause) {
      setError(failure(cause));
    } finally {
      setBusy(false);
    }
  };
  const refresh = async () => {
    if (busy || !transfer?.id) return;
    setBusy(true);
    setError("");
    try {
      const result = await callDue({ action: "status", transferId: transfer.id });
      setTransfer(result.transfer);
      setStep("result");
    } catch (cause) {
      setError(failure(cause));
    } finally {
      setBusy(false);
    }
  };

  const detailEntries = Object.entries(transfer?.details || {}).filter(([, value]) => value && value !== transfer?.fundingAddress);
  return <Modal labelledBy={titleId} describedBy={bannerId} onDismiss={onDismiss} className="due-ramp-modal">
    <header className="modal-head"><div>
      <h2 id={titleId}>Add funds</h2>
      <p>Testnet simulation</p>
    </div></header>
    <div className="modal-body">
      <p className="due-ramp-banner" id={bannerId}>Due sandbox, not Due production. Every request goes to api.sandbox.due.network. Due accepts the sandbox API key on the functions server, not in this page.</p>
      {step === "details" && <form id={`${titleId}-details`} className="due-ramp-grid" onSubmit={review}>
        {address && <p className="field-hint">Linked wallet <code>{address}</code></p>}
        <fieldset className="due-ramp-directions">
          <legend>What do you want to do?</legend>
          <label className="due-ramp-choice">
            <input type="radio" name={`${titleId}-direction`} checked={direction === "onramp"} onChange={() => setDirection("onramp")} />
            <span><strong>Buy USDC</strong><small>You pay from a bank. Due&apos;s sandbox quotes how much USDC that payment would buy.</small></span>
          </label>
          <label className="due-ramp-choice">
            <input type="radio" name={`${titleId}-direction`} checked={direction === "offramp"} onChange={() => setDirection("offramp")} />
            <span><strong>Sell USDC</strong><small>You start with USDC. Due&apos;s sandbox quotes how much you would receive, then gives a funding address.</small></span>
          </label>
        </fieldset>
        <label>Currency
          <select value={currency} onChange={(event) => setCurrency(event.target.value)}>
            {CURRENCIES.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
        </label>
        <p className="field-hint">{CURRENCIES.find((item) => item.id === currency)?.method}. Due chooses the rail from the channels on this sandbox key. USDC is the only asset.</p>
        <label htmlFor={amountId}>{amountLabel}
          <input id={amountId} value={amount} onChange={(event) => setAmount(event.target.value)} inputMode="decimal" autoComplete="off" required />
        </label>
      </form>}
      {quote && (step === "review" || step === "confirmation") && <>
        <QuoteSummary quote={quote} />
        {step === "confirmation" && <p>Confirming creates this transfer in the Due sandbox. It does not send crypto from your wallet.</p>}
      </>}
      {transfer && step === "instructions" && direction === "onramp" && <div className="due-ramp-grid">
        <p>Status: {transfer.status || "awaiting_funds"}. These are the sandbox payment details Due returned.</p>
        <dl className="due-ramp-summary">
          {detailEntries.map(([key, value]) => <div key={key}><dt>{BANK_LABEL[key] || key}</dt><dd><code>{value}</code></dd></div>)}
          {transfer.memo && <div><dt>Reference</dt><dd><code>{transfer.memo}</code></dd></div>}
        </dl>
        <p>Use the reference Due returned. Simulate sandbox pay-in asks Due&apos;s sandbox to pretend the bank payment arrived. It cannot move crypto.</p>
      </div>}
      {transfer && step === "instructions" && direction === "offramp" && <div className="due-ramp-grid">
        <p>Status: {transfer.status || "awaiting_funds"}. Send the exact quoted USDC to this funding address from the same wallet, before the quote expires.</p>
        <dl className="due-ramp-summary">
          <div><dt>Funding address</dt><dd><code>{transfer.fundingAddress || "Due did not return an address yet."}</code></dd></div>
          <div><dt>Amount</dt><dd>{transfer.source.amount} {transfer.source.currency}</dd></div>
        </dl>
        <p>Due only matches its own sandbox USDC. The QC DAO faucet token is a different token and will not be credited. Mint Due&apos;s sandbox USDC to your wallet first, from Due&apos;s stub admin.</p>
      </div>}
      {transfer && step === "result" && <p>Due sandbox status: {transfer.status || "unknown"}.</p>}
      {error && <p role="alert">{error}</p>}
    </div>
    <footer className="modal-actions">
      <button type="button" className="secondary" disabled={busy} onClick={onDismiss}>Close</button>
      {step === "details" && <button type="submit" form={`${titleId}-details`} className="primary" disabled={busy}>{busy ? "Asking Due…" : "Review quote"}</button>}
      {step === "review" && <>
        <button type="button" className="secondary" disabled={busy} onClick={() => { setError(""); setStep("details"); }}>Back</button>
        <button type="button" className="primary" disabled={busy} onClick={() => { setError(""); setStep("confirmation"); }}>Continue to confirmation</button>
      </>}
      {step === "confirmation" && <>
        <button type="button" className="secondary" disabled={busy} onClick={() => { setError(""); setStep("review"); }}>Back</button>
        <button type="button" className="primary" disabled={busy} onClick={create}>{busy ? "Creating transfer…" : "Create sandbox transfer"}</button>
      </>}
      {step === "instructions" && direction === "onramp" && <button type="button" className="primary" disabled={busy} onClick={payIn}>{busy ? "Asking Due…" : "Simulate sandbox pay-in"}</button>}
      {step === "instructions" && direction === "offramp" && <button type="button" className="secondary" disabled={busy} onClick={refresh}>{busy ? "Checking…" : "Check status"}</button>}
      {step === "result" && <button type="button" className="secondary" disabled={busy} onClick={() => { setStep("details"); setQuote(null); setTransfer(null); setError(""); }}>Start again</button>}
    </footer>
  </Modal>;
}

/** Add funds entry point. The dialog calls the dueSandbox function, which holds the sandbox key. */
export function DueOnOffRamp({ address = "", className = "" }) {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" className={className} title="Due sandbox" onClick={() => setOpen(true)}>Add funds</button>
    {open && <DueRampDialog address={address} onDismiss={() => setOpen(false)} />}
  </>;
}
