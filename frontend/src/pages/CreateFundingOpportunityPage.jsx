import { useMemo, useRef, useState } from "react";
import { useAccount } from "wagmi";
import { AuditReceipt } from "../components/AuditReceipt.jsx";
import { ConnectWalletModal } from "../components/ConnectWalletModal.jsx";
import { ExpiryCountdown } from "../components/ExpiryCountdown.jsx";
import { OpportunityTypeSwitch } from "../components/OpportunityTypeSwitch.jsx";
import {
  CURRENCIES,
  EXPIRY_WINDOWS,
  MAX_CATEGORIES,
  POSTING_CATEGORIES,
  categoryLabel,
  expiryDateFrom,
} from "../config/postingCategories.js";
import { fundingTagsFromCategories } from "../config/fundingOpportunity.js";
import { useSession } from "../context/SessionContext.jsx";
import { formatInstant } from "../lib/datetime.js";
import { messageForFirebaseError } from "../lib/errors.js";
import {
  buildFundingOpportunityDocument,
  createFundingOpportunity,
  newFundingOpportunityId,
} from "../lib/fundingOpportunities.js";
import {
  anchorFundingOpportunityAudit,
  fundingOpportunityAuditReceipt,
  readFundingOpportunityAudit,
} from "../lib/fundingOpportunityAudit.js";

const EMPTY_FORM = {
  title: "",
  fundingThesis: "",
  eligibilityNotes: "",
  categories: [],
  amount: "",
  currency: CURRENCIES[0],
  expiryDays: 90,
};

function Section({ step, legend, hint, children }) {
  return (
    <fieldset className="field-group">
      <legend>{step}. {legend}</legend>
      {hint ? <p className="field-hint">{hint}</p> : null}
      {children}
    </fieldset>
  );
}

function TextField({ id, label, hint, error, rows, value, onChange, ...rest }) {
  const Tag = rows ? "textarea" : "input";
  const describedBy = [hint ? `${id}-hint` : null, error ? `${id}-error` : null]
    .filter(Boolean)
    .join(" ") || undefined;
  return (
    <div className={`field ${error ? "field-invalid" : ""}`}>
      <label htmlFor={id}>{label}</label>
      {hint ? <p className="field-hint" id={`${id}-hint`}>{hint}</p> : null}
      <Tag
        id={id}
        name={id}
        rows={rows}
        value={value}
        onChange={onChange}
        aria-invalid={Boolean(error)}
        aria-describedby={describedBy}
        {...rest}
      />
      {error ? <p className="field-error" id={`${id}-error`} role="alert">{error}</p> : null}
    </div>
  );
}

export default function CreateFundingOpportunityPage({ onNavigate }) {
  const { address, profile } = useSession();
  const { address: connectedAddress, isConnected } = useAccount();
  const [opportunityId, setOpportunityId] = useState(() => newFundingOpportunityId());
  const [form, setForm] = useState(EMPTY_FORM);
  const [errors, setErrors] = useState({});
  const [submitError, setSubmitError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [published, setPublished] = useState(null);
  const [auditProgress, setAuditProgress] = useState(null);
  const [walletPromptOpen, setWalletPromptOpen] = useState(false);
  const pendingRecordRef = useRef(null);
  const formTop = useRef(null);
  const organisation = profile?.organisation ?? "";

  const expiryPreview = useMemo(
    () => formatInstant(expiryDateFrom(form.expiryDays)),
    [form.expiryDays],
  );
  const generatedTags = useMemo(
    () => fundingTagsFromCategories(form.categories),
    [form.categories],
  );

  const clearFieldError = (name) => {
    setErrors((current) => current[name] ? { ...current, [name]: undefined } : current);
  };

  const update = (event) => {
    const { name, value } = event.target;
    setForm((current) => ({ ...current, [name]: value }));
    setSubmitError(null);
    clearFieldError(name);
  };

  const updateAmount = (event) => {
    const amount = event.target.value.replace(/[^0-9]/g, "");
    setForm((current) => ({ ...current, amount }));
    setSubmitError(null);
    clearFieldError("amount");
  };

  const toggleCategory = (value) => {
    setForm((current) => {
      if (current.categories.includes(value)) {
        return { ...current, categories: current.categories.filter((item) => item !== value) };
      }
      if (current.categories.length >= MAX_CATEGORIES) return current;
      return { ...current, categories: [...current.categories, value] };
    });
    clearFieldError("categories");
  };

  const submit = async (event) => {
    event.preventDefault();
    setSubmitError(null);
    const { validateFundingOpportunity } = await import("../lib/validation.js");
    const found = validateFundingOpportunity(form);
    if (Object.keys(found).length > 0) {
      setErrors(found);
      const firstInvalid = formTop.current?.querySelector(`[name="${Object.keys(found)[0]}"]`);
      if (typeof firstInvalid?.focus === "function") firstInvalid.focus();
      else formTop.current?.scrollIntoView?.({ behavior: "smooth", block: "start" });
      return;
    }

    const sameWallet = isConnected
      && connectedAddress?.toLowerCase() === address?.toLowerCase();
    if (!sameWallet) {
      setSubmitError("Reconnect the wallet used to sign in before submitting the on-chain audit.");
      setWalletPromptOpen(true);
      return;
    }

    setSubmitting(true);
    let latestAudit = auditProgress;
    try {
      const record = pendingRecordRef.current ?? buildFundingOpportunityDocument({
        ownerId: address,
        organisation,
        form,
      });
      pendingRecordRef.current = record;

      const audit = await anchorFundingOpportunityAudit({
        id: opportunityId,
        ...record,
        audit: latestAudit,
      }, {
        account: address,
        persistReceipt: false,
        onChange: (nextAudit) => {
          latestAudit = nextAudit;
          setAuditProgress(nextAudit);
        },
      });

      const opportunity = await createFundingOpportunity({
        opportunityId,
        ownerId: address,
        organisation,
        form,
        record,
      });
      setPublished({ ...opportunity, audit });
      setAuditProgress(null);
      pendingRecordRef.current = null;
    } catch (error) {
      if (!latestAudit?.transactionHash) {
        setAuditProgress(null);
        pendingRecordRef.current = null;
      }
      setSubmitError(messageForFirebaseError(error));
    } finally {
      setSubmitting(false);
    }
  };

  const startAnother = () => {
    setOpportunityId(newFundingOpportunityId());
    setForm(EMPTY_FORM);
    setErrors({});
    setSubmitError(null);
    setPublished(null);
    setAuditProgress(null);
    pendingRecordRef.current = null;
  };

  if (published) {
    return (
      <section className="page confirmation-page">
        <div className="success-banner confirmation-card" role="status">
          <span className="eyebrow">Funding opportunity submitted</span>
          <h1>{published.title}</h1>
          <p>
            Your open funding call is live. Researchers can now propose a suitable
            problem and the approach they would use to solve it.
          </p>
          <dl className="confirmation-facts">
            <div><dt>Reference</dt><dd><code>{published.id}</code></dd></div>
            <div><dt>Organisation</dt><dd>{published.organisation}</dd></div>
            <div>
              <dt>Indicative funding</dt>
              <dd>{published.currency} {Number(published.amount).toLocaleString()}</dd>
            </div>
            <div><dt>Submitted</dt><dd>{formatInstant(published.createdAt)}</dd></div>
            <div><dt>Closes</dt><dd><ExpiryCountdown expiresAt={published.expiresAt} /></dd></div>
            <div><dt>Tags</dt><dd>{published.tags.join(", ")}</dd></div>
          </dl>
          <AuditReceipt
            audit={fundingOpportunityAuditReceipt(published)}
            eventLabel="Open funding opportunity submitted"
            actorRole="Funder"
            firebaseReference={`problems/${published.id}`}
            onVerify={() => readFundingOpportunityAudit(published)}
          />
          <div className="form-actions">
            <button
              className="primary"
              type="button"
              onClick={() => onNavigate(`posting/${published.id}`)}
            >
              View the opportunity
            </button>
            <button className="secondary" type="button" onClick={startAnother}>
              Post another funding call
            </button>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="page create-page" ref={formTop}>
      <div className="page-heading">
        <span className="eyebrow">Open funding opportunity</span>
        <h1>Post an open funding call</h1>
        <p>
          Share what you want to fund without prescribing a problem statement.
          Researchers can respond with both the problem they would tackle and a solution.
        </p>
      </div>

      <OpportunityTypeSwitch
        activeType="open-funding"
        onNavigate={onNavigate}
        disabled={submitting}
      />

      <div className="form-layout">
        <form className="brief-form" onSubmit={submit} noValidate>
          <Section step="1" legend="Funding direction" hint="Describe the outcomes and themes you are prepared to back.">
            <TextField
              id="title"
              label="Title"
              value={form.title}
              onChange={update}
              error={errors.title}
              placeholder="e.g. Open call for resilient quantum-enabled supply chains"
            />
            <TextField
              id="fundingThesis"
              label="Funding thesis and areas of interest"
              rows={5}
              hint="Explain the outcomes, sectors or research questions you want applicants to explore."
              value={form.fundingThesis}
              onChange={update}
              error={errors.fundingThesis}
            />
          </Section>

          <Section step="2" legend="Who can apply">
            <TextField
              id="eligibilityNotes"
              label="Eligibility notes"
              rows={4}
              hint="State organisation, geography, maturity, consortium or other eligibility conditions."
              value={form.eligibilityNotes}
              onChange={update}
              error={errors.eligibilityNotes}
            />
          </Section>

          <Section
            step="3"
            legend="Technology areas"
            hint={`Select up to ${MAX_CATEGORIES} areas. Your selections become the discovery tags automatically. Quantum includes gate-based, annealing and quantum-inspired work.`}
          >
            <div className={`category-grid ${errors.categories ? "field-invalid" : ""}`} role="group" aria-label="Technology areas">
              {POSTING_CATEGORIES.map((category) => {
                const selected = form.categories.includes(category.value);
                return (
                  <label key={category.value} className={`category-card ${selected ? "selected" : ""}`}>
                    <input
                      type="checkbox"
                      name="categories"
                      value={category.value}
                      checked={selected}
                      onChange={() => toggleCategory(category.value)}
                    />
                    <div>
                      <strong>{category.label}</strong>
                      <span>{category.note}</span>
                    </div>
                  </label>
                );
              })}
            </div>
            {errors.categories ? <p className="field-error" role="alert">{errors.categories}</p> : null}
            <div className="generated-tags" data-testid="generated-tags" aria-live="polite">
              <span className="field-label">Discovery tags</span>
              {generatedTags.length > 0 ? (
                <div className="tag-list">
                  {generatedTags.map((tag) => (
                    <span className="tag-chip static" key={tag}>{tag}</span>
                  ))}
                </div>
              ) : (
                <p className="field-hint">Select a technology area to add its tag.</p>
              )}
            </div>
          </Section>

          <Section step="4" legend="Funding and timing">
            <div className="funding-row">
              <TextField
                id="amount"
                label="Indicative funding amount"
                type="text"
                inputMode="numeric"
                autoComplete="off"
                value={form.amount}
                onChange={updateAmount}
                error={errors.amount}
                placeholder="250000"
              />
              <div className={`field ${errors.currency ? "field-invalid" : ""}`}>
                <label htmlFor="currency">Currency</label>
                <select id="currency" name="currency" value={form.currency} onChange={update}>
                  {CURRENCIES.map((code) => <option key={code} value={code}>{code}</option>)}
                </select>
                {errors.currency ? <p className="field-error" role="alert">{errors.currency}</p> : null}
              </div>
            </div>
            <div className={`field ${errors.expiryDays ? "field-invalid" : ""}`}>
              <label htmlFor="expiryDays">Open for</label>
              <p className="field-hint">Closes on {expiryPreview}.</p>
              <select id="expiryDays" name="expiryDays" value={form.expiryDays} onChange={update}>
                {EXPIRY_WINDOWS.map((window) => (
                  <option key={window.value} value={window.value}>{window.label}</option>
                ))}
              </select>
              {errors.expiryDays ? <p className="field-error" role="alert">{errors.expiryDays}</p> : null}
            </div>
          </Section>

          <div className="form-actions">
            <button className="primary" type="submit" disabled={submitting}>
              {submitting ? "Submitting…" : "Submit funding opportunity"}
            </button>
            <button className="secondary" type="button" disabled={submitting} onClick={() => onNavigate("discover")}>
              Cancel
            </button>
          </div>

          {submitError ? (
            <p className="attachment-error" role="alert">
              {submitError} Nothing you typed has been lost — fix the problem and submit again.
            </p>
          ) : null}
          {Object.keys(errors).length > 0 ? (
            <p className="field-hint" role="status">{Object.keys(errors).length} field(s) need attention above.</p>
          ) : null}
        </form>

        {walletPromptOpen ? <ConnectWalletModal onClose={() => setWalletPromptOpen(false)} /> : null}

        <aside className="preview-panel" aria-label="Live preview">
          <div className="preview-sticky">
            <span className="eyebrow">How this will appear</span>
            <div className="preview-card">
              <div className="card-top">
                <span className="eyebrow">Open funding</span>
                <span className="status-dot">Submitted</span>
              </div>
              <h3>{form.title || "Untitled funding opportunity"}</h3>
              <p>{form.fundingThesis || "Your funding thesis will appear here as you type."}</p>
              <div className="preview-meta">
                <div>
                  <small>Indicative funding</small>
                  <strong>{form.amount ? `${form.currency} ${Number(form.amount).toLocaleString()}` : "—"}</strong>
                </div>
                <div><small>Open until</small><span>{expiryPreview}</span></div>
              </div>
              {form.categories.length > 0 ? (
                <div className="tag-list">
                  {form.categories.map((value) => (
                    <span className="tag-chip static" key={value}>{categoryLabel(value)}</span>
                  ))}
                </div>
              ) : null}
              <p className="field-hint">Posted by {organisation || "your organisation"}</p>
            </div>
          </div>
        </aside>
      </div>
    </section>
  );
}
