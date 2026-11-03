import { useId, useState } from "react";
import { formatInstant } from "../lib/datetime.js";
import {
  DueSandboxError,
  LOCAL_DUE_SANDBOX_KEY,
  createDueSandboxTransfer,
  dueSandboxMethods,
  quoteDueSandbox,
  simulateDueSandboxFunding,
  startDueSandbox,
} from "../lib/dueSandbox.js";
import { Modal } from "./Modal.jsx";

const METHODS = dueSandboxMethods();
const STATUS_LABEL = {
  awaiting_funds: "Awaiting funds",
  approved: "Approved",
  payment_submitted: "Payment submitted",
  payment_processed: "Payment processed",
  expired: "Expired",
};
const BANK_LABEL = {
  bankName: "Bank",
  accountName: "Account name",
  accountNumber: "Account number",
  routingNumber: "Routing number",
  iban: "IBAN",
  bankCode: "Bank code",
};

function failure(error) {
  return error instanceof DueSandboxError ? error.message : "The simulation could not continue. Close it and try again.";
}

function fiatCurrency(quote) {
  return quote.direction === "onramp" ? quote.source.currency : quote.destination.currency;
}

function QuoteSummary({ quote }) {
  return <dl className="due-ramp-summary">
    <div><dt>You send</dt><dd>{quote.source.amount} {quote.source.currency}</dd></div>
    <div><dt>Fee</dt><dd>{quote.source.fee} {quote.source.currency}</dd></div>
    <div><dt>You receive</dt><dd>{quote.destination.amount} {quote.destination.currency}</dd></div>
    <div><dt>Rate</dt><dd>1 USDC = {quote.fxRate} {fiatCurrency(quote)}</dd></div>
    <div><dt>Network</dt><dd>Arbitrum Sepolia</dd></div>
    <div><dt>Quote expires</dt><dd>{formatInstant(quote.expiresAt)}</dd></div>
  </dl>;
}

function DueRampDialog({ address, email, onDismiss }) {
  const titleId = `due-ramp-${useId().replace(/:/g, "")}`;
  const bannerId = `${titleId}-banner`;
  const amountId = `${titleId}-amount`;
  const [step, setStep] = useState("details");
  const [direction, setDirection] = useState("onramp");
  const [methodId, setMethodId] = useState("ach");
  const [amount, setAmount] = useState("");
  const [error, setError] = useState("");
  const [session, setSession] = useState(() => {
    try {
      return startDueSandbox({ address, email, apiKey: LOCAL_DUE_SANDBOX_KEY });
    } catch {
      return null;
    }
  });
  const [quote, setQuote] = useState(null);
  const [transfer, setTransfer] = useState(null);
  const method = METHODS.find((item) => item.id === methodId) ?? METHODS[0];
  const amountLabel = direction === "onramp" ? `Amount (${method.currency})` : "Amount (USDC)";

  const review = (event) => {
    event.preventDefault();
    setError("");
    if (!session) {
      setError("Sign in with your email before starting this simulation.");
      return;
    }
    try {
      const result = quoteDueSandbox({ session, direction, asset: "USDC", methodId, amount });
      setSession(result.session);
      setQuote(result.quote);
      setStep("review");
    } catch (cause) {
      setError(failure(cause));
    }
  };
  const confirm = () => {
    setError("");
    if (!session || !quote) return;
    try {
      const result = createDueSandboxTransfer({ session, quoteId: quote.id });
      setSession(result.session);
      setTransfer(result.transfer);
      setStep("instructions");
    } catch (cause) {
      setError(failure(cause));
    }
  };
  const simulate = () => {
    setError("");
    if (!session || !transfer) return;
    try {
      const result = simulateDueSandboxFunding({ session, transferId: transfer.id });
      setSession(result.session);
      setTransfer(result.transfer);
      setStep("result");
      if (result.transfer.status === "expired") setError("This simulated transfer expired before funds arrived. Start again.");
    } catch (cause) {
      setError(failure(cause));
    }
  };
  const restart = () => {
    try {
      setSession(startDueSandbox({ address, email, apiKey: LOCAL_DUE_SANDBOX_KEY }));
    } catch {
      setSession(null);
    }
    setStep("details");
    setQuote(null);
    setTransfer(null);
    setAmount("");
    setError("");
  };

  const instructions = transfer?.transferInstructions;
  return <Modal labelledBy={titleId} describedBy={bannerId} onDismiss={onDismiss} className="due-ramp-modal">
    <header className="modal-head"><div>
      <h2 id={titleId}>Add funds</h2>
      <p>Testnet simulation</p>
    </div></header>
    <div className="modal-body">
      <p className="due-ramp-banner" id={bannerId}>Testnet simulation on Arbitrum Sepolia. This does not charge a card, send a bank transfer, sign with your wallet, or move tokens. No request is sent to Due.</p>
      {!session && <p role="alert">Sign in with your email to link this simulation to your embedded wallet. It still cannot move funds.</p>}
      {session && step === "details" && <form id={`${titleId}-details`} className="due-ramp-grid" onSubmit={review}>
        <section className="due-ramp-account" aria-label="Sandbox account">
          <dl className="due-ramp-summary">
            <div><dt>Account</dt><dd><code>{session.accountId}</code></dd></div>
            <div><dt>KYC</dt><dd>Approved by the local stub</dd></div>
            <div><dt>Linked wallet</dt><dd><code>{session.address}</code></dd></div>
          </dl>
          <p className="field-hint">The local stub stands in for Due&apos;s sandbox KYC approval. The wallet link is your embedded wallet. Neither step leaves this browser.</p>
        </section>
        <fieldset className="due-ramp-directions">
          <legend>Direction</legend>
          <label className="due-ramp-choice"><input type="radio" name={`${titleId}-direction`} checked={direction === "onramp"} onChange={() => setDirection("onramp")} /> On-ramp: fiat to USDC</label>
          <label className="due-ramp-choice"><input type="radio" name={`${titleId}-direction`} checked={direction === "offramp"} onChange={() => setDirection("offramp")} /> Off-ramp: USDC to fiat</label>
        </fieldset>
        <label>Asset
          <select value="USDC" onChange={() => setError("")}>
            <option value="USDC">USDC</option>
            <option value="USDT" disabled>USDT (not available in this simulation)</option>
            <option value="XSGD" disabled>XSGD (not available in this simulation)</option>
          </select>
        </label>
        <label>Currency
          <select value={method.currency} onChange={(event) => setMethodId(METHODS.find((item) => item.currency === event.target.value).id)}>
            {METHODS.map((item) => <option key={item.currency} value={item.currency}>{item.currencyLabel}</option>)}
          </select>
        </label>
        <label>Payment method
          <select value={methodId} onChange={(event) => setMethodId(event.target.value)}>
            {METHODS.map((item) => <option key={item.id} value={item.id}>{item.label}</option>)}
          </select>
        </label>
        <p className="field-hint">Network: Arbitrum Sepolia. USDT and XSGD purchases are outside this simulation.</p>
        <label htmlFor={amountId}>{amountLabel}
          <input id={amountId} value={amount} onChange={(event) => setAmount(event.target.value)} inputMode="decimal" autoComplete="off" required />
        </label>
        <p className="field-hint">Up to 2 decimal places. Maximum 100000. The sandbox fee is 0.50%, with a minimum of 0.50.</p>
      </form>}
      {quote && (step === "review" || step === "confirmation") && <>
        <QuoteSummary quote={quote} />
        {step === "confirmation" && <p>Confirm this testnet simulation. Continuing creates a local transfer record only.</p>}
      </>}
      {transfer && step === "instructions" && instructions?.kind === "details" && <div className="due-ramp-grid">
        <p>Status: Awaiting funds (awaiting_funds). A completed pay-in would deliver USDC to your embedded wallet <code>{session.address}</code>. That delivery is not made here.</p>
        <dl className="due-ramp-summary">
          {Object.entries(instructions.details).filter(([key]) => key !== "schema").map(([key, value]) => <div key={key}><dt>{BANK_LABEL[key] || key}</dt><dd><code>{value}</code></dd></div>)}
          <div><dt>Reference</dt><dd><code>{instructions.memo}</code></dd></div>
          <div><dt>Amount</dt><dd>{transfer.source.amount} {transfer.source.currency}</dd></div>
        </dl>
        <p>These bank details are fictional. Sending money to them does nothing.</p>
      </div>}
      {transfer && step === "instructions" && instructions?.kind === "funding_reference" && <div className="due-ramp-grid">
        <p>Status: Awaiting funds (awaiting_funds). A real Due sandbox matches a crypto deposit by sender and exact amount. This screen has no funding address.</p>
        <dl className="due-ramp-summary">
          <div><dt>Funding reference</dt><dd><code>{instructions.details.reference}</code></dd></div>
          <div><dt>Token amount</dt><dd>{instructions.details.amount} {instructions.details.token}</dd></div>
          <div><dt>Network</dt><dd>Arbitrum Sepolia</dd></div>
        </dl>
        <p>This is not a wallet address. Do not send tokens from your wallet.</p>
      </div>}
      {transfer && step === "result" && <div className="due-ramp-grid">
        <ol className="due-ramp-status" aria-label="Transfer status">
          {transfer.statusLog.map((status) => <li key={status}>{STATUS_LABEL[status] || status} ({status})</li>)}
        </ol>
        {transfer.status === "payment_processed" && <p>No tokens moved. Your wallet balance is unchanged. Test USDC still comes from the faucet in the account menu.</p>}
      </div>}
      {error && <p role="alert">{error}</p>}
    </div>
    <footer className="modal-actions">
      <button type="button" className="secondary" onClick={onDismiss}>Close</button>
      {step === "details" && session && <button type="submit" form={`${titleId}-details`} className="primary">Review quote</button>}
      {step === "review" && <>
        <button type="button" className="secondary" onClick={() => { setError(""); setStep("details"); }}>Back</button>
        <button type="button" className="primary" onClick={() => { setError(""); setStep("confirmation"); }}>Continue to confirmation</button>
      </>}
      {step === "confirmation" && <>
        <button type="button" className="secondary" onClick={() => { setError(""); setStep("review"); }}>Back</button>
        <button type="button" className="primary" onClick={confirm}>Continue simulation</button>
      </>}
      {step === "instructions" && <button type="button" className="primary" onClick={simulate}>{transfer?.direction === "offramp" ? "Simulate sandbox deposit" : "Simulate sandbox pay-in"}</button>}
      {step === "result" && <button type="button" className="secondary" onClick={restart}>Start again</button>}
    </footer>
  </Modal>;
}

/** Add funds entry point. The button opens the testnet simulation and nothing else. */
export function DueOnOffRamp({ address = "", email = "", className = "" }) {
  const [open, setOpen] = useState(false);
  return <>
    <button type="button" className={className} title="Testnet simulation" onClick={() => setOpen(true)}>Add funds</button>
    {open && <DueRampDialog address={address} email={email} onDismiss={() => setOpen(false)} />}
  </>;
}
