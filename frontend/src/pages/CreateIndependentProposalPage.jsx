import { useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "../context/AuthContext.jsx";
import { Field } from "../components/Field.jsx";
import { ProposalCategorySelect } from "../components/ProposalCategorySelect.jsx";
import { AttachmentUploader } from "../components/AttachmentUploader.jsx";
import { ExpiryCountdown } from "../components/ExpiryCountdown.jsx";
import {
  INDEPENDENT_PROPOSAL_FIELDS,
  PROPOSAL_CATEGORIES,
  PROPOSAL_MATURITY_LEVELS,
  independentListingWindowOpen,
  isIndependentProposal,
} from "../config/proposal.js";
import {
  CURRENCIES,
  DEFAULT_EXPIRY_DAYS,
  EXPIRY_WINDOWS,
  expiryDateFrom,
} from "../config/postingCategories.js";
import {
  PROPOSAL_STATUS_DRAFT,
  PROPOSAL_STATUS_SUBMITTED,
  buildIndependentProposalDocument,
  findProposal,
  newProposalId,
  saveIndependentProposalDraft,
  submitIndependentProposal,
  updateIndependentProposal,
} from "../lib/proposals.js";
import { anchorProposalBeforeWrite, receiptForWrite } from "../lib/proposalAudit.js";
import { assertCurrentAuditRecord } from "../lib/opportunityAuditFlow.js";
import { deleteAttachment } from "../lib/attachments.js";
import { LeaveDraftPrompt } from "../components/LeaveDraftPrompt.jsx";
import { useDraftGuard } from "../lib/draftGuard.js";
import { auditErrorMessage, messageForPublicationSaveError } from "../lib/errors.js";
import { SubmissionError } from "../components/SubmissionError.jsx";
import { SubmissionProgress } from "../components/SubmissionProgress.jsx";
import { useAccount } from "wagmi";
import { validateIndependentProposal, messageForProposalError } from "../lib/proposalValidation.js";
import { formatInstant, toDate } from "../lib/datetime.js";
import { proposalMatchingLocked } from "../lib/matching.js";
import { proposalWorkflowStatus, workflowStatusLabel } from "../config/workflowStatus.js";
import ProposalDetailPage from "./ProposalDetailPage.jsx";
import { AUDIT_REGISTRY_CONFIG } from "../config/auditRegistry.js";
import { isEscrowRegistry } from "../../../firebase/functions/escrowAudit.js";
import { fundingAmountText, HALF_UPFRONT_PERCENTAGES } from "../../../firebase/functions/escrowProposalTerms.js";
import { EscrowPaymentPlanFields } from "../components/EscrowPaymentPlanFields.jsx";
import { readEscrow } from "../lib/escrow.js";
import { ReviewRows, WizardPanel, WizardSteps, useWizard } from "../components/BriefWizard.jsx";

const ESCROW_LINKED = isEscrowRegistry(AUDIT_REGISTRY_CONFIG);

const STEPS = [
  { key: "solution", label: "Your solution", fields: ["title", "summary", "methodology", "category"] },
  { key: "fit", label: "Fit & team", fields: ["addressedProblems", "maturity", "team"] },
  { key: "funding", label: "Funding & documents", fields: ["amount", "currency", "expiryDays", "fundingPlan"] },
  { key: "review", label: "Review", fields: [] },
];

const EMPTY_FORM = {
  title: "",
  summary: "",
  methodology: "",
  addressedProblems: "",
  team: "",
  category: "",
  maturity: "",
  amount: "",
  currency: CURRENCIES[0],
  expiryDays: DEFAULT_EXPIRY_DAYS,
  tranchePercentages: HALF_UPFRONT_PERCENTAGES,
  reviewDays: "7",
  funderVoting: false,
};

function abandonDraftAttachments(items, ownerId, proposalId) {
  return Promise.allSettled(items.map((attachment) => deleteAttachment({
    attachment, ownerId, problemId: proposalId, scope: "proposals",
  })));
}

function snapshotOf(form, attachments) {
  return JSON.stringify({
    ...Object.fromEntries(INDEPENDENT_PROPOSAL_FIELDS.map(([key]) => [key, String(form[key] ?? "")])),
    category: form.category ?? "",
    maturity: form.maturity ?? "",
    amount: String(form.amount ?? ""),
    currency: form.currency ?? "",
    expiryDays: Number(form.expiryDays) || DEFAULT_EXPIRY_DAYS,
    tranchePercentages: form.tranchePercentages ?? HALF_UPFRONT_PERCENTAGES,
    reviewDays: form.reviewDays ?? "7",
    funderVoting: form.funderVoting ?? false,
    attachments: attachments.map((item) => item.id).sort(),
  });
}

function windowFromExpiry(expiresAt, createdAt) {
  const expiry = toDate(expiresAt);
  if (!expiry) return DEFAULT_EXPIRY_DAYS;
  const from = toDate(createdAt) ?? new Date();
  const days = Math.round((expiry.getTime() - from.getTime()) / (24 * 60 * 60 * 1000));
  return EXPIRY_WINDOWS.reduce(
    (closest, option) => (Math.abs(option.value - days) < Math.abs(closest - days) ? option.value : closest),
    DEFAULT_EXPIRY_DAYS,
  );
}

export function formFromIndependentProposal(record) {
  const terms = record?.status !== "draft" ? record?.fundingTerms : null;
  return {
    ...EMPTY_FORM,
    ...Object.fromEntries(INDEPENDENT_PROPOSAL_FIELDS.map(([key]) => [key, record?.[key] ?? ""])),
    category: record?.category ?? "",
    maturity: record?.maturity ?? "",
    amount: record?.amount ? (ESCROW_LINKED ? fundingAmountText(record.amount) : String(record.amount)) : "",
    currency: record?.currency || CURRENCIES[0],
    expiryDays: windowFromExpiry(record?.expiresAt, record?.createdAt),
    ...(ESCROW_LINKED ? {
      tranchePercentages: terms ? terms.trancheBps.map((bps) => bps / 100).join(", ") : HALF_UPFRONT_PERCENTAGES,
      reviewDays: terms ? terms.reviewWindows.map((seconds) => seconds / 86400).join(", ") : record?.fundingPlan?.reviewDays ?? "7",
      funderVoting: terms?.funderVoting ?? record?.fundingPlan?.funderVoting ?? false,
      ...(terms && record.status !== "draft" ? { immutableFundingTerms: terms } : {}),
    } : {}),
  };
}

function DraftStatus({ savedAt, saving }) {
  if (saving) return <p className="draft-status" role="status">Saving draft…</p>;
  if (!savedAt) {
    return <p className="draft-status muted" role="status">Not saved yet. Save as draft to keep this and finish later.</p>;
  }
  return <p className="draft-status" role="status">Draft saved <strong>{formatInstant(savedAt)}</strong>. Only you can see it.</p>;
}

export default function CreateIndependentProposalPage({ resumeId, onNavigate }) {
  const { user } = useAuth();
  const { address, isConnected } = useAccount();
  const [auditProgress, setAuditProgress] = useState(null);
  const [saveFailed, setSaveFailed] = useState(false);
  const [confirmedAudit, setConfirmedAudit] = useState(null);
  const [proposalId, setProposalId] = useState(resumeId || null);
  const [record, setRecord] = useState(null);
  const [draftExists, setDraftExists] = useState(false);
  const [savedAt, setSavedAt] = useState(null);
  const [savingDraft, setSavingDraft] = useState(false);
  const [loading, setLoading] = useState(Boolean(resumeId));
  const [form, setForm] = useState(EMPTY_FORM);
  const [attachments, setAttachments] = useState([]);
  const [pending, setPending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [errors, setErrors] = useState({});
  const [error, setError] = useState("");
  const [baseline, setBaseline] = useState(null);
  const savedAttachmentIds = useRef(new Set());
  const submitting = useRef(false);
  const formRef = useRef(null);
  const openedAt = useRef(new Date());
  const wizard = useWizard(STEPS);
  const stepIndex = (key) => STEPS.findIndex((step) => step.key === key);

  const editing = record?.status === PROPOSAL_STATUS_SUBMITTED;
  const listingExpiry = editing
    ? (toDate(record?.expiresAt) ?? expiryDateFrom(Number(form.expiryDays) || DEFAULT_EXPIRY_DAYS, toDate(record?.createdAt) ?? openedAt.current))
    : expiryDateFrom(
      Number(form.expiryDays) || DEFAULT_EXPIRY_DAYS,
      toDate(record?.createdAt) ?? openedAt.current,
    );

  const isDirty = useMemo(() => {
    if (baseline === null) {
      return INDEPENDENT_PROPOSAL_FIELDS.some(([key]) => String(form[key] ?? "").trim().length > 0)
        || String(form.category ?? "").length > 0
        || String(form.maturity ?? "").length > 0
        || String(form.amount ?? "").trim().length > 0
        || (Number(form.expiryDays) || DEFAULT_EXPIRY_DAYS) !== DEFAULT_EXPIRY_DAYS
        || (form.currency && form.currency !== CURRENCIES[0])
        || (ESCROW_LINKED && ((form.reviewDays ?? "7") !== "7" || form.funderVoting === true))
        || attachments.length > 0;
    }
    return snapshotOf(form, attachments) !== baseline;
  }, [form, attachments, baseline]);

  const { leaveTarget, setLeaveTarget, goTo } = useDraftGuard({
    isDirty,
    active: !submitted && !editing,
    ownHashes: ["#/create-proposal", proposalId ? `#/create-proposal/${proposalId}` : ""],
    onNavigate,
  });

  useEffect(() => {
    if (resumeId || proposalId) return undefined;
    setProposalId(newProposalId());
    return undefined;
  }, [resumeId, proposalId]);

  useEffect(() => {
    if (!resumeId) return undefined;
    let cancelled = false;
    findProposal(resumeId).then((found) => {
      if (cancelled) return;
      if (!found) {
        setError("This proposal could not be found or you do not have access.");
        return;
      }
      if (!isIndependentProposal(found) || found.researcherId !== user.id.toLowerCase()) {
        setError("This is not an independent proposal you can resume.");
        return;
      }
      const loadedForm = formFromIndependentProposal(found);
      const loadedAttachments = found.attachments ?? [];
      setRecord(found);
      setProposalId(found.id);
      setDraftExists(found.status === PROPOSAL_STATUS_DRAFT);
      setForm(loadedForm);
      setAttachments(loadedAttachments);
      if (found.status === PROPOSAL_STATUS_DRAFT) {
        setSavedAt(found.updatedAt);
      }
      setBaseline(snapshotOf(loadedForm, loadedAttachments));
      savedAttachmentIds.current = new Set(loadedAttachments.map((item) => item.id));
    }).catch((err) => { if (!cancelled) setError(messageForProposalError(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [resumeId, user.id]);

  useEffect(() => {
    if (submitted) window.scrollTo({ top: 0, left: 0 });
  }, [submitted]);

  const update = (key, value) => { setForm((old) => ({ ...old, [key]: value })); setErrors((old) => ({ ...old, [key]: undefined })); };

  const persistDraft = async () => {
    if (editing || savingDraft || busy) return;
    setSavingDraft(true); setError("");
    try {
      const saved = await saveIndependentProposalDraft({
        proposalId, researcherId: user.id, form, attachments, exists: draftExists, expiresAt: listingExpiry,
      });
      setDraftExists(true);
      setRecord(saved);
      setSavedAt(saved?.updatedAt ?? new Date());
      setBaseline(snapshotOf(form, attachments));
      savedAttachmentIds.current = new Set(attachments.map((item) => item.id));
      if (!resumeId && proposalId && window.location.hash !== `#/create-proposal/${proposalId}`) {
        window.history.replaceState(window.history.state, "", `#/create-proposal/${proposalId}`);
      }
      return true;
    } catch (err) { setError(messageForProposalError(err)); return false; }
    finally { setSavingDraft(false); }
  };

  const leave = async (target) => {
    const unsaved = attachments.filter((item) => !savedAttachmentIds.current.has(item.id));
    setAttachments([]);
    await abandonDraftAttachments(unsaved, user.id, proposalId);
    goTo(target);
  };

  const saveThenLeave = async () => {
    const target = leaveTarget;
    if (!await persistDraft()) return;
    setLeaveTarget(null);
    goTo(target);
  };

  const discardAndLeave = async () => {
    const target = leaveTarget;
    setLeaveTarget(null);
    await leave(target);
  };

  const back = () => {
    const target = editing ? `proposal/${proposalId}` : "proposals";
    if (isDirty && !editing) { setLeaveTarget(target); return; }
    goTo(target);
  };

  const submit = async (event) => {
    event.preventDefault();
    if (submitting.current || pending) return;
    const validation = validateIndependentProposal(form);
    setErrors(validation);
    if (Object.keys(validation).length) {
      const invalidStep = wizard.stepWithError(validation);
      if (invalidStep !== null) wizard.goTo(invalidStep);
      requestAnimationFrame(() => formRef.current?.querySelector('.wizard-panel.is-active [aria-invalid="true"]')?.focus());
      return;
    }
    if (!isConnected || address?.toLowerCase() !== user.id.toLowerCase()) {
      setError("Connect the wallet that owns this account to sign and submit.");
      return;
    }
    wizard.goTo(STEPS.length - 1);
    submitting.current = true; setBusy(true); setError("");
    let audit = null;
    setSaveFailed(false);
    setConfirmedAudit(null);
    try {
      if (editing) {
        await assertCurrentAuditRecord(record);
        if (!independentListingWindowOpen(record) && record.status === PROPOSAL_STATUS_SUBMITTED) {
          throw new Error("The listing window has closed. This proposal can no longer be edited.");
        }
        if (form.immutableFundingTerms) {
          const current = await findProposal(proposalId, { fromServer: true });
          if (!current || (await readEscrow({ proposal: current, account: address })).totalDeposited > 0n) {
            throw new Error("Funding has started. This proposal can no longer be edited.");
          }
        } else {
          const current = await findProposal(proposalId, { fromServer: true });
          if (!current || proposalMatchingLocked(current)) {
            throw new Error("Funding or matching has started. This proposal can no longer be edited.");
          }
        }
      }
      const storedAttachments = editing ? (record.attachments ?? []) : attachments;
      const listingWindow = editing ? record.expiresAt : listingExpiry;
      const built = buildIndependentProposalDocument({
        researcherId: user.id,
        form: editing ? { ...form, currency: record.currency } : form,
        attachments: storedAttachments,
        expiresAt: listingWindow,
      });
      audit = await anchorProposalBeforeWrite({ id: proposalId, ...built, audit: auditProgress }, {
        account: address,
        onChange: setAuditProgress,
      });
      setAuditProgress(audit);
      setConfirmedAudit(audit);
      if (editing) {
        await updateIndependentProposal({
          proposalId, researcherId: user.id, form, attachments: storedAttachments,
          record: built, audit: receiptForWrite(audit), expiresAt: listingWindow,
        });
      } else {
        await submitIndependentProposal({
          proposalId, researcherId: user.id, form, attachments,
          fromDraft: draftExists, record: built, audit: receiptForWrite(audit), expiresAt: listingExpiry,
        });
      }
      setSubmitted(true);
    } catch (err) {
      setSaveFailed(Boolean(audit?.transactionHash));
      setError(audit?.transactionHash
        ? `The verification transaction was confirmed, but saving the proposal failed. ${messageForPublicationSaveError(err)} Your entries are still here — submitting again reuses the same anchor.`
        : auditErrorMessage(err));
    }
    finally { submitting.current = false; setBusy(false); if (!audit) setAuditProgress(null); }
  };

  if (submitted) return <ProposalDetailPage proposalId={proposalId} onNavigate={onNavigate} justSubmitted />;
  if (loading || !proposalId) return <section className="page empty" role="status">{resumeId ? "Loading proposal…" : "Loading form…"}</section>;
  if (resumeId && !record) {
    return <section className="page empty"><h1>Proposal unavailable</h1><p role="alert">{error || "This proposal could not be found or you do not have access."}</p>
      <button className="secondary" onClick={() => onNavigate("proposals")}>My proposals</button></section>;
  }
  if (resumeId && record && (proposalMatchingLocked(record)
    || (!["draft", "submitted"].includes(record.status))
    || (record.status === PROPOSAL_STATUS_SUBMITTED && !independentListingWindowOpen(record)))) {
    return <section className="page empty"><h1>This proposal can no longer be edited</h1><p role="alert">{proposalMatchingLocked(record) ? "Funding or matching has started. The listing is locked to preserve the funders’ commitment." : record.status === PROPOSAL_STATUS_SUBMITTED && !independentListingWindowOpen(record) ? "The listing window has closed. This proposal can no longer be edited." : `Its status is ${workflowStatusLabel(proposalWorkflowStatus(record))}. A listing is locked once it leaves submitted.`}</p><button className="secondary" onClick={() => onNavigate(`proposal/${record.id}`)}>View listing</button></section>;
  }

  const disabled = busy || savingDraft;
  const textField = ([key, label, max]) => <Field key={key} htmlFor={`independent-${key}`} label={label} error={errors[key]}>
    {({ id, describedBy, invalid }) => {
      const Tag = key === "title" ? "input" : "textarea";
      return <Tag id={id} rows={key === "title" ? undefined : 4} value={form[key] || ""} maxLength={max}
        aria-describedby={describedBy} aria-invalid={invalid} required
        onChange={(event) => update(key, event.target.value)} />;
    }}
  </Field>;
  const text = (key) => String(form[key] ?? "").trim();

  return <section className="page create-page">
    <button className="back" onClick={back}>{editing ? "Back to listing" : "Back to My Proposals"}</button>
    <div className="page-heading">
      <span className="eyebrow">Independent solution proposal</span>
      <h1>{editing ? "Edit your independent listing" : draftExists ? "Resume your draft" : "Publish an independent proposal"}</h1>
      <p>{editing
        ? "Update the listing while no funding approach has been accepted. Currency, listing window and supporting PDFs stay as published."
        : "Share a solution that is not attached to an existing problem statement. Clients and funders can discover it and approach you with funding. All fields are required to submit; you can save an unfinished draft at any point. Supporting PDFs are optional."}</p>
    </div>
    <WizardSteps steps={STEPS} current={wizard.current} onSelect={wizard.goTo} errorSteps={wizard.errorSteps(errors)}
      completeSteps={wizard.completeSteps(validateIndependentProposal(form))} visitedSteps={wizard.visited} lockForward={pending} />
    <div className="form-layout">
      <form className="brief-form proposal-form" ref={formRef} onSubmit={submit} noValidate>
        <SubmissionError message={error} />
        {editing && <p className="field-hint" role="status">This listing is published but no funding approach has been accepted. Saving your changes records the edit — the changed fields, your wallet and the time — and returns the listing for wallet verification, which appends a revision on Arbitrum Sepolia beside the original.</p>}
        <div className="wizard-card">
          <WizardPanel index={stepIndex("solution")} current={wizard.current}>
            <fieldset className="field-group" disabled={disabled}>
              <legend>Your solution</legend>
              {INDEPENDENT_PROPOSAL_FIELDS.slice(0, 3).map(textField)}
              <Field htmlFor="independent-category" label="Quantum or quantum-adjacent category" error={errors.category}>
                {({ id, describedBy, invalid }) => <ProposalCategorySelect id={id} value={form.category || ""} disabled={disabled} invalid={invalid} describedBy={describedBy} onChange={(value) => update("category", value)} />}
              </Field>
            </fieldset>
          </WizardPanel>
          <WizardPanel index={stepIndex("fit")} current={wizard.current}>
            <fieldset className="field-group" disabled={disabled}>
              <legend>Problems this could address, and the team</legend>
              {textField(INDEPENDENT_PROPOSAL_FIELDS.find(([key]) => key === "addressedProblems"))}
              <Field htmlFor="independent-maturity" label="Maturity or readiness level" error={errors.maturity}>
                {({ id, describedBy, invalid }) => (
                  <select id={id} value={form.maturity || ""} required aria-invalid={invalid} aria-describedby={describedBy}
                    onChange={(event) => update("maturity", event.target.value)}>
                    <option value="">Choose a level</option>
                    {PROPOSAL_MATURITY_LEVELS.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}
                  </select>
                )}
              </Field>
              {textField(INDEPENDENT_PROPOSAL_FIELDS.find(([key]) => key === "team"))}
            </fieldset>
          </WizardPanel>
          <WizardPanel index={stepIndex("funding")} current={wizard.current}>
            <fieldset className="field-group" disabled={disabled}>
              <legend>Funding and supporting material</legend>
              <Field htmlFor="independent-amount" label="Indicative funding sought" error={errors.amount}>
                {({ id, describedBy, invalid }) => <input id={id} type={ESCROW_LINKED ? "text" : "number"} inputMode="decimal"
                  min="0.000001" max="1000000000" step="any" disabled={ESCROW_LINKED && editing} required value={form.amount || ""}
                  aria-invalid={invalid} aria-describedby={describedBy}
                  onChange={(event) => update("amount", event.target.value)} />}
              </Field>
              <Field htmlFor="independent-currency" label="Currency" error={errors.currency}>
                {({ id, describedBy, invalid }) => (
                  <select id={id} value={form.currency} required disabled={editing} aria-invalid={invalid} aria-describedby={describedBy}
                    onChange={(event) => update("currency", event.target.value)}>
                    {CURRENCIES.map((code) => <option key={code} value={code}>{code}</option>)}
                  </select>
                )}
              </Field>
              <Field htmlFor="independent-expiry" label="Listing window" error={errors.expiryDays} hint={`Closes on ${formatInstant(listingExpiry)}.`}>
                {({ id, describedBy, invalid }) => (
                  <select id={id} value={form.expiryDays} required disabled={editing} aria-invalid={invalid} aria-describedby={describedBy}
                    onChange={(event) => update("expiryDays", Number(event.target.value))}>
                    {EXPIRY_WINDOWS.map((window) => <option key={window.value} value={window.value}>{window.label}</option>)}
                  </select>
                )}
              </Field>
              {ESCROW_LINKED && <EscrowPaymentPlanFields form={form} disabled={disabled || editing} error={errors.fundingPlan} onChange={update} />}
              {editing && <p className="field-hint">Supporting PDFs cannot be changed after publication. They stay as the files on the listing.</p>}
              <AttachmentUploader ownerId={user.id} problemId={proposalId} scope="proposals" value={attachments}
                onChange={setAttachments} onPendingChange={(count) => setPending(count > 0)} disabled={disabled || editing} />
            </fieldset>
          </WizardPanel>
          <WizardPanel index={stepIndex("review")} current={wizard.current}>
            <div className="wizard-review-head">
              <h2>Review</h2>
              <p className="field-hint">Check everything before you {editing ? "save your changes" : "submit"}. This listing is not attached to an existing problem statement.</p>
            </div>
            <ReviewRows onEdit={wizard.goTo} rows={[
              { label: "Title", value: text("title"), step: stepIndex("solution") },
              { label: "Summary", value: text("summary"), step: stepIndex("solution") },
              { label: "Technical approach", value: text("methodology"), step: stepIndex("solution") },
              { label: "Category", value: PROPOSAL_CATEGORIES.find((item) => item.value === form.category)?.label ?? "", empty: "Not chosen", step: stepIndex("solution") },
              { label: "Problems this could address", value: text("addressedProblems"), step: stepIndex("fit") },
              { label: "Maturity", value: PROPOSAL_MATURITY_LEVELS.find((item) => item.value === form.maturity)?.label ?? "", empty: "Not chosen", step: stepIndex("fit") },
              { label: "Team", value: text("team"), step: stepIndex("fit") },
              { label: "Indicative funding", value: form.amount ? `${form.currency} ${ESCROW_LINKED ? text("amount") : Number(form.amount).toLocaleString()}` : "", empty: "Not set", step: stepIndex("funding") },
              { label: "Listing window", value: formatInstant(listingExpiry), step: stepIndex("funding") },
              { label: "Attachments", value: attachments.length ? `${attachments.length} PDF(s)` : "", empty: "None", step: stepIndex("funding") },
            ]} />
            <p className="field-hint">{editing
              ? "Your wallet signs the amendment first. The listing is updated only after that transaction is confirmed on Arbitrum Sepolia, so the stored version always matches its on-chain record."
              : "Your wallet signs first. The proposal is saved only after that transaction is confirmed on Arbitrum Sepolia, so nothing is listed unverified."}</p>
          </WizardPanel>
          <div className="wizard-nav">
            <button className={`secondary wizard-back${wizard.isFirst ? " is-invisible" : ""}`} type="button" onClick={wizard.back} disabled={wizard.isFirst}>Back</button>
            <div className="wizard-nav-end">
              {!wizard.isLast && <button className={editing ? "secondary" : "primary"} type="button" onClick={wizard.next} disabled={pending}>Continue</button>}
              {(wizard.isLast || editing || busy || saveFailed || pending) && <button className="primary" type="submit" disabled={disabled || pending}>{busy ? (confirmedAudit ? "Saving…" : auditProgress?.transactionHash ? "Confirming on-chain…" : "Waiting for your wallet…") : pending ? "Waiting for attachments…" : saveFailed ? "Retry saving" : editing ? "Sign and save changes" : "Sign and publish proposal"}</button>}
            </div>
          </div>
        </div>
        <SubmissionProgress audit={confirmedAudit} saving={busy} entityLabel="Proposal" editing={editing} />
        {!editing && <div className="form-actions wizard-secondary">
          <button className="secondary" type="button" disabled={disabled || pending} onClick={persistDraft}>{savingDraft ? "Saving…" : "Save as draft"}</button>
          <DraftStatus savedAt={savedAt} saving={savingDraft} />
        </div>}
        {Object.values(errors).some(Boolean) && <p className="field-hint" role="status">{Object.values(errors).filter(Boolean).length} field(s) need attention. Steps marked ! have the details.</p>}
        {leaveTarget && (
          <LeaveDraftPrompt
            draftExists={draftExists}
            saving={savingDraft}
            entityLabel="proposal"
            resumeLocation="My Proposals"
            onKeepEditing={() => setLeaveTarget(null)}
            onDiscard={discardAndLeave}
            onSave={saveThenLeave}
          />
        )}
      </form>
      <aside className="context-panel">
        <span className="eyebrow">Independent listing</span>
        <h2>{text("title") || "Untitled proposal"}</h2>
        <p>This is not a response to a posted problem. Funders browse independent listings separately from open opportunities.</p>
        {form.amount ? <strong>{form.currency} {ESCROW_LINKED ? text("amount") : Number(form.amount).toLocaleString()}</strong> : null}
        <ExpiryCountdown expiresAt={listingExpiry} status="submitted" />
        <p className="field-hint">{EXPIRY_WINDOWS.find((item) => item.value === Number(form.expiryDays))?.label ?? `${form.expiryDays} days`}</p>
      </aside>
    </div>
  </section>;
}
