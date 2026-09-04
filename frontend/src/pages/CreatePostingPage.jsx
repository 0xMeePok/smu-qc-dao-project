import { useMemo, useRef, useState } from "react";
import { useAccount } from "wagmi";
import { AttachmentUploader } from "../components/AttachmentUploader.jsx";
import { ConnectWalletModal } from "../components/ConnectWalletModal.jsx";
import { useSession } from "../context/SessionContext.jsx";
import {
  CURRENCIES,
  EXPIRY_WINDOWS,
  MAX_CATEGORIES,
  POSTING_CATEGORIES,
  categoryLabel,
  expiryDateFrom,
} from "../config/postingCategories.js";
import { buildPostingDocument, createPosting, newPostingId } from "../lib/postings.js";
import { deleteAttachment } from "../lib/attachments.js";
import { messageForFirebaseError } from "../lib/errors.js";
import { ExpiryCountdown } from "../components/ExpiryCountdown.jsx";
import { AuditReceipt } from "../components/AuditReceipt.jsx";
import { formatInstant } from "../lib/datetime.js";
import {
  anchorPostingAudit,
  postingAuditReceipt,
  readPostingAudit,
} from "../lib/postingAudit.js";

/**
 * QCDAO-48 - post a funded business problem statement.
 *
 * Replaces the AS-IS process of circulating problem statements through email and
 * spreadsheets, so the form is deliberately structured rather than free-text: each
 * section is a field a solution developer needs in order to judge whether they can
 * respond, and each is validated with its own message.
 *
 * NO DATA LOSS ON A FAILED SUBMIT. Everything the user typed stays in `form` state
 * whatever happens - validation failure, rules rejection, network error. The only
 * thing that clears the form is a successful write, and by then the posting exists.
 */

function abandonDraftAttachments(items) {
  return Promise.allSettled(items.map((item) => deleteAttachment(item)));
}

const EMPTY_FORM = {
  title: "",
  businessContext: "",
  summary: "",
  currentApproach: "",
  currentLimitations: "",
  expectedOutcome: "",
  successCriteria: "",
  dataAvailability: "",
  categories: [],
  amount: "",
  currency: "SGD",
  expiryDays: 90,
};

function Section({ step, legend, hint, children }) {
  return (
    <fieldset className="field-group">
      <legend>{step}. {legend}</legend>
      {hint && <p className="field-hint">{hint}</p>}
      {children}
    </fieldset>
  );
}

function TextField({ id, label, hint, error, rows, value, onChange, ...rest }) {
  const Tag = rows ? "textarea" : "input";
  return (
    <div className={`field ${error ? "field-invalid" : ""}`}>
      <label htmlFor={id}>{label}</label>
      {hint && <p className="field-hint">{hint}</p>}
      <Tag
        id={id}
        name={id}
        rows={rows}
        value={value}
        onChange={onChange}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? `${id}-error` : undefined}
        {...rest}
      />
      {error && <p className="field-error" id={`${id}-error`} role="alert">{error}</p>}
    </div>
  );
}

export default function CreatePostingPage({ onNavigate }) {
  const { address, profile } = useSession();
  const { address: connectedAddress, isConnected } = useAccount();

  // Reserved up front: attachments are uploaded while the form is still being
  // filled in, and this id is part of their storage path.
  const [postingId, setPostingId] = useState(() => newPostingId());
  const [form, setForm] = useState(EMPTY_FORM);
  const [attachments, setAttachments] = useState([]);
  const [pendingCount, setPendingCount] = useState(0);
  const [errors, setErrors] = useState({});
  const [submitError, setSubmitError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [published, setPublished] = useState(null);
  const [auditProgress, setAuditProgress] = useState(null);
  const [walletPromptOpen, setWalletPromptOpen] = useState(false);
  const formTop = useRef(null);
  const pendingCountRef = useRef(0);
  const pendingRecordRef = useRef(null);

  const updatePendingCount = (count) => {
    pendingCountRef.current = count;
    setPendingCount(count);
  };

  const organisation = profile?.organisation ?? "";

  // Same UTC-to-the-second format the posting will be stored and displayed in, so
  // what the form promises and what the detail page shows cannot disagree.
  const expiryPreview = useMemo(
    () => formatInstant(expiryDateFrom(form.expiryDays)),
    [form.expiryDays],
  );

  // Keeps only digits, so separators from a pasted "1,000,000" are stripped rather
  // than reaching Number() as NaN, and letters cannot be typed at all.
  const updateAmount = (event) => {
    const digitsOnly = event.target.value.replace(/[^0-9]/g, "");
    setForm((current) => ({ ...current, amount: digitsOnly }));
    setSubmitError(null);
    if (errors.amount) setErrors((current) => ({ ...current, amount: undefined }));
  };

  const update = (event) => {
    const { name, value } = event.target;
    setForm((current) => ({ ...current, [name]: value }));
    setSubmitError(null);
    if (errors[name]) setErrors((current) => ({ ...current, [name]: undefined }));
  };

  const toggleCategory = (value) => {
    setForm((current) => {
      const selected = current.categories.includes(value);
      if (selected) {
        return { ...current, categories: current.categories.filter((item) => item !== value) };
      }
      if (current.categories.length >= MAX_CATEGORIES) return current;
      return { ...current, categories: [...current.categories, value] };
    });
    setErrors((current) => ({ ...current, categories: undefined }));
  };



  const submit = async (event) => {
    event.preventDefault();
    setSubmitError(null);

    // Pending uploads are not in `attachments`. Submitting now would publish
    // without them and unmount the uploader, which cancels the transfers.
    if (pendingCountRef.current > 0) return;

    // Imported lazily so the validator and the rules stay the single source of
    // truth for the shape, rather than this component re-deriving it.
    const { validatePosting } = await import("../lib/validation.js");
    const found = validatePosting(form);
    if (Object.keys(found).length > 0) {
      setErrors(found);
      // Guarded: scrollIntoView is absent in jsdom and in some embedded webviews,
      // and an exception here would swallow the field errors that were the whole
      // point of this branch.
      if (typeof formTop.current?.scrollIntoView === "function") {
        formTop.current.scrollIntoView({ behavior: "smooth", block: "start" });
      }
      return;
    }

    if (pendingCountRef.current > 0) return;

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
      const record = pendingRecordRef.current ?? buildPostingDocument({
        ownerId: address,
        organisation,
        form,
        attachments,
      });
      pendingRecordRef.current = record;

      const audit = await anchorPostingAudit({
        id: postingId,
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

      const posting = await createPosting({
        postingId,
        ownerId: address,
        organisation,
        form,
        attachments,
        // The contract is authoritative for the audit. Firebase stores only the
        // posting content, after its exact hash has been confirmed on-chain.
        record,
      });
      setPublished({ ...posting, audit });
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

  const cancel = async () => {
    const abandoned = attachments;
    setAttachments([]);
    await abandonDraftAttachments(abandoned);
    onNavigate("discover");
  };

  const startAnother = async () => {
    const abandoned = published ? [] : attachments;
    setPostingId(newPostingId());
    setForm(EMPTY_FORM);
    setAttachments([]);
    setErrors({});
    setSubmitError(null);
    setPublished(null);
    setAuditProgress(null);
    pendingRecordRef.current = null;
    await abandonDraftAttachments(abandoned);
  };

  if (published) {
    return (
      <section className="page confirmation-page">
        <div className="success-banner confirmation-card" role="status">
          <span className="eyebrow">Posting submitted</span>
          <h1>{published.title}</h1>
          <p>
            Your funded problem statement is live. Solution developers can now find it
            and propose quantum or quantum-adjacent approaches.
          </p>
          <dl className="confirmation-facts">
            <div><dt>Reference</dt><dd><code>{published.id}</code></dd></div>
            <div><dt>Organisation</dt><dd>{published.organisation}</dd></div>
            <div>
              <dt>Funding</dt>
              <dd>{published.currency} {Number(published.amount).toLocaleString()}</dd>
            </div>
            <div><dt>Submitted</dt><dd>{formatInstant(published.createdAt)}</dd></div>
            <div>
              <dt>Closes</dt>
              <dd><ExpiryCountdown expiresAt={published.expiresAt} /></dd>
            </div>
            <div>
              <dt>Categories</dt>
              <dd>{published.categories.map(categoryLabel).join(", ")}</dd>
            </div>
            <div><dt>Attachments</dt><dd>{published.attachments.length} PDF(s)</dd></div>
          </dl>
          <AuditReceipt
            audit={postingAuditReceipt(published)}
            eventLabel="Funded problem statement submitted"
            actorRole="Problem owner"
            firebaseReference={`problems/${published.id}`}
            onVerify={() => readPostingAudit(published)}
          />
          <div className="form-actions">
            <button
              className="primary"
              type="button"
              onClick={() => onNavigate(`posting/${published.id}`)}
            >
              View the posting
            </button>
            <button className="secondary" type="button" onClick={startAnother}>
              Post another problem
            </button>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="page create-page" ref={formTop}>
      <div className="page-heading">
        <span className="eyebrow">Funded business problem statement</span>
        <h1>Post a problem</h1>
        <p>
          Describe the problem in enough detail that a solution developer in another
          organisation can judge whether they can help, without needing a call first.
        </p>
      </div>

      <div className="form-layout">
        <form className="brief-form" onSubmit={submit} noValidate>
          <Section step="1" legend="The problem" hint="What is going wrong, and in what business context.">
            <TextField
              id="title" label="Title" value={form.title} onChange={update} error={errors.title}
              placeholder="e.g. Route optimisation for cold-chain delivery under demand spikes"
            />
            <TextField
              id="businessContext" label="Business context" rows={3}
              hint="The operation this sits in, and why it matters commercially."
              value={form.businessContext} onChange={update} error={errors.businessContext}
            />
            <TextField
              id="summary" label="Problem description" rows={4}
              hint="The technical problem itself, stated concretely."
              value={form.summary} onChange={update} error={errors.summary}
            />
          </Section>

          <Section step="2" legend="What you do today" hint="Solution developers need to know what they are improving on.">
            <TextField
              id="currentApproach" label="Current approach" rows={3}
              value={form.currentApproach} onChange={update} error={errors.currentApproach}
            />
            <TextField
              id="currentLimitations" label="Limitations of that approach" rows={3}
              hint="Where it breaks down: scale, runtime, accuracy, cost."
              value={form.currentLimitations} onChange={update} error={errors.currentLimitations}
            />
          </Section>

          <Section step="3" legend="What success looks like">
            <TextField
              id="expectedOutcome" label="Expected outcome" rows={3}
              value={form.expectedOutcome} onChange={update} error={errors.expectedOutcome}
            />
            <TextField
              id="successCriteria" label="Success criteria" rows={3}
              hint="How a proposal will be judged. Measurable where possible."
              value={form.successCriteria} onChange={update} error={errors.successCriteria}
            />
            <TextField
              id="dataAvailability" label="Relevant data availability" rows={3}
              hint="What data exists, its shape and size, and any access constraints."
              value={form.dataAvailability} onChange={update} error={errors.dataAvailability}
            />
          </Section>

          <Section
            step="4"
            legend="Technology areas"
            hint={`Which fields could help? Pick up to ${MAX_CATEGORIES}. Describe the problem, not the technique - proposers choose the approach.`}
          >
            <div className={`category-grid ${errors.categories ? "field-invalid" : ""}`} role="group">
              {POSTING_CATEGORIES.map((category) => {
                const selected = form.categories.includes(category.value);
                return (
                  <label
                    key={category.value}
                    className={`category-card ${selected ? "selected" : ""}`}
                  >
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
            {errors.categories && (
              <p className="field-error" role="alert">{errors.categories}</p>
            )}
          </Section>

          <Section step="5" legend="Funding and timing">
            <div className="funding-row">
              {/*
                Deliberately NOT type="number". A focused number input steps its own
                value on ArrowUp/ArrowDown and on scroll-wheel, so tabbing past the
                field or scrolling the page silently changed the figure - 1000000
                became 999997 after three arrow presses, with nothing on screen to
                say the amount had moved. Money must not be adjustable by accident.
              */}
              <TextField
                id="amount"
                label="Funding requirement"
                type="text"
                inputMode="numeric"
                autoComplete="off"
                value={form.amount}
                onChange={updateAmount}
                error={errors.amount}
                placeholder="80000"
              />
              <div className={`field ${errors.currency ? "field-invalid" : ""}`}>
                <label htmlFor="currency">Currency</label>
                <select id="currency" name="currency" value={form.currency} onChange={update}>
                  {CURRENCIES.map((code) => <option key={code} value={code}>{code}</option>)}
                </select>
                {errors.currency && <p className="field-error" role="alert">{errors.currency}</p>}
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
              {errors.expiryDays && <p className="field-error" role="alert">{errors.expiryDays}</p>}
            </div>
          </Section>


          <Section step="6" legend="Supporting documents" hint="Optional. PDF only, up to 10 MB each.">
            <AttachmentUploader
              ownerId={address}
              problemId={postingId}
              value={attachments}
              onChange={setAttachments}
              onPendingChange={updatePendingCount}
              disabled={submitting}
            />
          </Section>

          <div className="form-actions">
            <button className="primary" type="submit" disabled={submitting || pendingCount > 0}>
              {submitting ? "Submitting…" : "Submit problem statement"}
            </button>
            <button
              className="secondary" type="button" disabled={submitting}
              onClick={cancel}
            >
              Cancel
            </button>
          </div>

          {submitError && (
            <p className="attachment-error" role="alert">
              {submitError} Nothing you typed has been lost — fix the problem and submit again.
            </p>
          )}
          {Object.keys(errors).length > 0 && (
            <p className="field-hint" role="status">
              {Object.keys(errors).length} field(s) need attention above.
            </p>
          )}
        </form>

        {walletPromptOpen && (
          <ConnectWalletModal onClose={() => setWalletPromptOpen(false)} />
        )}

        <aside className="preview-panel" aria-label="Live preview">
          <div className="preview-sticky">
            <span className="eyebrow">How this will appear</span>
            <div className="preview-card">
              <div className="card-top">
                <span className="eyebrow">Funded problem</span>
                <span className="status-dot">Submitted</span>
              </div>
              <h3>{form.title || "Untitled problem statement"}</h3>
              <p>{form.summary || "The problem description will appear here as you type."}</p>
              <div className="preview-meta">
                <div>
                  <small>Funding</small>
                  <strong>
                    {form.amount ? `${form.currency} ${Number(form.amount).toLocaleString()}` : "—"}
                  </strong>
                </div>
                <div>
                  <small>Open until</small>
                  <span>{expiryPreview}</span>
                </div>
              </div>
              {form.categories.length > 0 && (
                <div className="tag-list">
                  {form.categories.map((value) => (
                    <span className="tag-chip static" key={value}>{categoryLabel(value)}</span>
                  ))}
                </div>
              )}
              <p className="field-hint">
                Posted by {organisation || "your organisation"} · {attachments.length} attachment(s)
              </p>
            </div>
          </div>
        </aside>
      </div>
    </section>
  );
}
