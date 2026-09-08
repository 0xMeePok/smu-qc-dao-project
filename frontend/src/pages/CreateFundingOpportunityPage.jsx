import { useEffect, useMemo, useRef, useState } from "react";
import { useAccount } from "wagmi";
import { AttachmentUploader } from "../components/AttachmentUploader.jsx";
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
import { formatInstant, toDate } from "../lib/datetime.js";
import {
  FUNDING_STATUS_DRAFT,
  buildFundingOpportunityDocument,
  createFundingOpportunity,
  newFundingOpportunityId,
  publishFundingDraft,
  saveFundingDraft,
  updateFundingOpportunity,
} from "../lib/fundingOpportunities.js";
import { findPosting } from "../lib/postings.js";
import { deleteAttachment } from "../lib/attachments.js";
import { LeaveDraftPrompt } from "../components/LeaveDraftPrompt.jsx";
import { useDraftGuard } from "../lib/draftGuard.js";
import {
  anchorFundingOpportunityAudit,
  fundingOpportunityAuditReceipt,
  readFundingOpportunityAudit,
  receiptForWrite,
} from "../lib/fundingOpportunityAudit.js";
import { canEditOpportunity, materialFieldsLocked } from "../lib/opportunityEdit.js";
import { auditErrorMessage, messageForFirebaseError } from "../lib/errors.js";

const EMPTY_FORM = {
  title: "",
  fundingThesis: "",
  eligibilityNotes: "",
  categories: [],
  amount: "",
  currency: CURRENCIES[0],
  expiryDays: 90,
};

function Section({ step, legend, hint, disabled, children }) {
  return (
    <fieldset className="field-group" disabled={disabled}>
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

function abandonDraftAttachments(items, ownerId, opportunityId) {
  return Promise.allSettled(items.map((attachment) => deleteAttachment({
    attachment, ownerId, problemId: opportunityId,
  })));
}

/** What "unchanged since the last save" means, for the leave prompt. */
function snapshotOf(form, attachments) {
  return JSON.stringify({
    ...form,
    categories: [...form.categories].sort(),
    attachments: attachments.map((item) => item.id).sort(),
  });
}

function formFromOpportunity(opportunity) {
  return {
    ...EMPTY_FORM,
    title: opportunity.title ?? "",
    fundingThesis: opportunity.fundingThesis ?? "",
    eligibilityNotes: opportunity.eligibilityNotes ?? "",
    categories: Array.isArray(opportunity.categories) ? opportunity.categories : [],
    amount: opportunity.amount ? String(opportunity.amount) : "",
    currency: opportunity.currency ?? EMPTY_FORM.currency,
    expiryDays: expiryWindowFor(opportunity.expiresAt, opportunity.createdAt) ?? EMPTY_FORM.expiryDays,
  };
}

/**
 * Maps a stored expiry back to the window that produced it, so resuming a draft
 * shows the choice that was made rather than silently re-deriving a new one.
 */
function expiryWindowFor(expiresAt, createdAt) {
  const stored = expiresAt?.toDate?.() ?? (expiresAt ? new Date(expiresAt) : null);
  if (!stored || Number.isNaN(stored.getTime())) return null;
  const from = createdAt?.toDate?.() ?? (createdAt ? new Date(createdAt) : new Date());
  let best = null;
  for (const { value } of EXPIRY_WINDOWS) {
    const distance = Math.abs(expiryDateFrom(value, from).getTime() - stored.getTime());
    if (best === null || distance < best.distance) best = { value, distance };
  }
  return best?.value ?? null;
}

export default function CreateFundingOpportunityPage({ resumeId = null, editOpportunityId = null, onNavigate }) {
  const { address, profile } = useSession();
  const { address: connectedAddress, isConnected } = useAccount();
  const [opportunityId, setOpportunityId] = useState(() => editOpportunityId ?? resumeId ?? newFundingOpportunityId());
  const [existing, setExisting] = useState(null);
  const [editBlocked, setEditBlocked] = useState("");
  const [form, setForm] = useState(EMPTY_FORM);
  const [attachments, setAttachments] = useState([]);
  const [pendingCount, setPendingCount] = useState(0);
  const savedAttachmentIds = useRef(new Set());
  const [draftExists, setDraftExists] = useState(false);
  const [savedAt, setSavedAt] = useState(null);
  const [savingDraft, setSavingDraft] = useState(false);
  // Keeps the form inert until a resumed draft has loaded, so typing cannot be
  // overwritten by the load and a save cannot run with draftExists still false.
  const [loadingDraft, setLoadingDraft] = useState(Boolean(resumeId || editOpportunityId));
  const [baseline, setBaseline] = useState(null);
  const [errors, setErrors] = useState({});
  const [submitError, setSubmitError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const [published, setPublished] = useState(null);
  const [auditProgress, setAuditProgress] = useState(null);
  const [walletPromptOpen, setWalletPromptOpen] = useState(false);
  const pendingRecordRef = useRef(null);
  const formTop = useRef(null);
  const organisation = profile?.organisation ?? "";
  const editing = Boolean(editOpportunityId);
  const materialLocked = editing && materialFieldsLocked(existing);
  const ownHash = editOpportunityId
    ? `#/edit-posting/${editOpportunityId}`
    : resumeId ? `#/create-funding/${resumeId}` : "#/create/open-funding";

  useEffect(() => {
    if (!resumeId && !editOpportunityId) return undefined;
    let cancelled = false;
    findPosting(editOpportunityId ?? resumeId)
      .then((opportunity) => {
        if (cancelled) return;
        if (!opportunity) {
          if (editOpportunityId) setEditBlocked("This funding opportunity could not be found or you do not have access.");
          return;
        }
        if (editOpportunityId) {
          if (!canEditOpportunity(opportunity, address)) {
            setEditBlocked(opportunity.status === "draft"
              ? "Resume this funding call from My Problems — drafts are not edited here."
              : `This funding opportunity can no longer be edited. Its status is ${opportunity.status}.`);
            return;
          }
          setExisting(opportunity);
        } else if (opportunity.status && opportunity.status !== FUNDING_STATUS_DRAFT) {
          setEditBlocked("This funding opportunity is already published. Open it from My Problems to edit.");
          return;
        }
        const loaded = formFromOpportunity(opportunity);
        const loadedAttachments = opportunity.attachments ?? [];
        setForm(loaded);
        setAttachments(loadedAttachments);
        if (!editOpportunityId) setDraftExists(true);
        setSavedAt(opportunity.updatedAt ?? null);
        setBaseline(snapshotOf(loaded, loadedAttachments));
        savedAttachmentIds.current = new Set(loadedAttachments.map((item) => item.id));
      })
      .catch((error) => { if (!cancelled) setSubmitError(messageForFirebaseError(error)); })
      .finally(() => { if (!cancelled) setLoadingDraft(false); });
    return () => { cancelled = true; };
  }, [resumeId, editOpportunityId, address]);

  // Unsaved work, not "any work". Against a saved baseline this is a comparison,
  // so saving a draft - or resuming one and changing nothing - leaves the form
  // clean and the prompt stays out of the way.
  const isDirty = useMemo(() => {
    if (baseline === null) {
      return ["title", "fundingThesis", "eligibilityNotes", "amount"]
        .some((key) => String(form[key] ?? "").trim().length > 0)
        || form.categories.length > 0
        || attachments.length > 0;
    }
    return snapshotOf(form, attachments) !== baseline;
  }, [form, attachments, baseline]);

  const { leaveTarget, setLeaveTarget, goTo } = useDraftGuard({
    isDirty,
    active: !published && !editing,
    ownHashes: [ownHash],
    onNavigate,
  });

  // No validation gate: saving half a form is the point of a draft. In-flight
  // uploads are not in `attachments` yet, so a save while they are pending
  // would persist a draft that omits files the user just selected.
  const persistDraft = async () => {
    if (pendingCount > 0 || editing) return false;
    setSubmitError(null);
    setSavingDraft(true);
    try {
      const saved = await saveFundingDraft({
        opportunityId, ownerId: address, organisation, form, attachments, exists: draftExists,
      });
      setDraftExists(true);
      setSavedAt(saved?.updatedAt ?? new Date());
      setBaseline(snapshotOf(form, attachments));
      savedAttachmentIds.current = new Set(attachments.map((item) => item.id));
      return true;
    } catch (error) {
      setSubmitError(messageForFirebaseError(error));
      return false;
    } finally {
      setSavingDraft(false);
    }
  };

  const saveThenLeave = async () => {
    const target = leaveTarget;
    // Leaving on a rejected save would discard the very work the prompt offered
    // to keep, so the dialog stays open and persistDraft reports the reason.
    if (!await persistDraft()) return;
    setLeaveTarget(null);
    goTo(target);
  };

  /**
   * Leaves without keeping the current edits. Files the saved draft already
   * references are kept - deleting those would gut the draft the user chose to
   * keep. With no saved draft nothing was persisted, so everything goes.
   */
  const discardAndLeave = async () => {
    const target = leaveTarget;
    setLeaveTarget(null);
    const unsaved = attachments.filter((item) => !savedAttachmentIds.current.has(item.id));
    setAttachments([]);
    await abandonDraftAttachments(unsaved, address, opportunityId);
    goTo(target);
  };

  const cancel = () => {
    if (isDirty) { setLeaveTarget("discover"); return; }
    goTo("discover");
  };

  const expiryPreview = useMemo(
    () => formatInstant(expiryDateFrom(
      form.expiryDays,
      editing ? (toDate(existing?.createdAt) ?? new Date()) : new Date(),
    )),
    [form.expiryDays, editing, existing?.createdAt],
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
        attachments,
        ...(editing ? {
          status: existing?.status ?? "submitted",
          now: toDate(existing?.createdAt) ?? new Date(),
        } : {}),
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

      const opportunity = editing
        ? await updateFundingOpportunity({
          opportunityId, ownerId: address, organisation, form, attachments, record,
          audit: receiptForWrite(audit),
        })
        : draftExists
        ? await publishFundingDraft({
          // The anchored record, not a rebuild: rebuilding derives a fresh
          // expiresAt that would no longer match the confirmed hash.
          opportunityId, ownerId: address, organisation, form, attachments, record,
        })
        : await createFundingOpportunity({
          opportunityId,
          ownerId: address,
          organisation,
          form,
          attachments,
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
      setSubmitError(latestAudit?.transactionHash
        ? messageForFirebaseError(error)
        : auditErrorMessage(error));
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

  if (editBlocked) {
    return (
      <section className="page empty">
        <h1>Funding opportunity unavailable</h1>
        <p role="alert">{editBlocked}</p>
        <button className="secondary" type="button" onClick={() => onNavigate(editOpportunityId ? `posting/${editOpportunityId}` : "my-problems")}>
          {editOpportunityId ? "View opportunity" : "My problems"}
        </button>
      </section>
    );
  }

  if (published) {
    return (
      <section className="page confirmation-page">
        <div className="success-banner confirmation-card" role="status">
          <span className="eyebrow">{editing ? "Funding opportunity updated" : "Funding opportunity submitted"}</span>
          <h1>{published.title}</h1>
          <p>
            {editing
              ? "Your changes are live. The new content hash is anchored on Arbitrum Sepolia beside the original."
              : "Your open funding call is live. Researchers can now propose a suitable problem and the approach they would use to solve it."}
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
            <div><dt>Tags</dt><dd>{(published.tags ?? []).join(", ")}</dd></div>
          </dl>
          <AuditReceipt
            audit={fundingOpportunityAuditReceipt(published)}
            eventLabel={editing ? "Open funding opportunity updated" : "Open funding opportunity submitted"}
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
            <button className="secondary" type="button" onClick={editing ? () => onNavigate("my-problems") : startAnother}>
              {editing ? "Back to my problems" : "Post another funding call"}
            </button>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="page create-page" ref={formTop}>
      {editing && (
        <button className="back" type="button" onClick={() => onNavigate(`posting/${opportunityId}`)}>
          Back to opportunity
        </button>
      )}
      <div className="page-heading">
        <span className="eyebrow">Open funding opportunity</span>
        <h1>{editing ? "Edit your funding opportunity" : "Post an open funding call"}</h1>
        <p>
          {editing
            ? (materialLocked
              ? "A proposal has already been received, so the funding thesis, amount and eligibility are locked. You can still replace supporting documents."
              : "Correct the call while it is still open and no proposal has been received. Your wallet signs updateOpportunity first; Firestore is updated after that transaction is mined.")
            : "Share what you want to fund without prescribing a problem statement. Researchers can respond with both the problem they would tackle and a solution."}
        </p>
      </div>

      {!editing && (
      <OpportunityTypeSwitch
        activeType="open-funding"
        onNavigate={onNavigate}
        disabled={submitting}
      />
      )}

      <div className="form-layout">
        <form className="brief-form" onSubmit={submit} noValidate>
          <Section step="1" legend="Funding direction" hint="Describe the outcomes and themes you are prepared to back." disabled={materialLocked}>
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

          <Section step="2" legend="Who can apply" disabled={materialLocked}>
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
            disabled={materialLocked}
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

          <Section step="4" legend="Funding and timing" disabled={materialLocked}>
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

          <Section step="5" legend="Supporting material" hint="Optional. Terms, scope notes or an application pack, as PDFs.">
            <AttachmentUploader
              ownerId={address}
              problemId={opportunityId}
              value={attachments}
              onChange={setAttachments}
              onPendingChange={(count) => setPendingCount(Number(count) || 0)}
              disabled={submitting || savingDraft || loadingDraft}
            />
          </Section>

          {editing && (
            <p className="field-hint">
              Your wallet signs updateOpportunity first. The opportunity is updated only after that transaction is confirmed on Arbitrum Sepolia.
            </p>
          )}
          {auditProgress?.status === "confirmed" && (
            <div className="detail-section">
              <AuditReceipt
                audit={auditProgress}
                eventLabel={editing ? "Open funding opportunity updated" : "Open funding opportunity submitted"}
                actorRole="Funder"
              />
            </div>
          )}
          <div className="form-actions">
            <button className="primary" type="submit" disabled={submitting || savingDraft || loadingDraft || pendingCount > 0}>
              {submitting
                ? (auditProgress?.transactionHash ? "Confirming on-chain…" : "Waiting for your wallet…")
                : pendingCount > 0
                  ? "Waiting for attachments…"
                  : editing ? "Sign and save changes" : "Submit funding opportunity"}
            </button>
            {!editing && (
            <button className="secondary" type="button" disabled={submitting || savingDraft || loadingDraft || pendingCount > 0} onClick={persistDraft}>
              {savingDraft ? "Saving…" : "Save as draft"}
            </button>
            )}
            <button className="secondary" type="button" disabled={submitting || savingDraft} onClick={editing ? () => onNavigate(`posting/${opportunityId}`) : cancel}>
              Cancel
            </button>
          </div>

          {!editing && (savingDraft
            ? <p className="draft-status" role="status">Saving draft…</p>
            : savedAt
              ? <p className="draft-status" role="status">Draft saved <strong>{formatInstant(savedAt)}</strong>. Only you can see it.</p>
              : <p className="draft-status muted" role="status">Not saved yet. Save as draft to keep this and finish later.</p>)}

          {leaveTarget && (
            <LeaveDraftPrompt
              draftExists={draftExists}
              saving={savingDraft}
              entityLabel="funding opportunity"
              resumeLocation="My Problems"
              onKeepEditing={() => setLeaveTarget(null)}
              onDiscard={discardAndLeave}
              onSave={saveThenLeave}
            />
          )}

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
