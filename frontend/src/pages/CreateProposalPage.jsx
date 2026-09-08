import { useEffect, useMemo, useRef, useState } from "react";
import { useAuth } from "../context/AuthContext.jsx";
import { Field } from "../components/Field.jsx";
import { ProposalCategorySelect } from "../components/ProposalCategorySelect.jsx";
import { AttachmentUploader } from "../components/AttachmentUploader.jsx";
import { ExpiryCountdown } from "../components/ExpiryCountdown.jsx";
import { findPosting } from "../lib/postings.js";
import {
  PROPOSAL_STATUS_DRAFT,
  buildProposalDocument,
  findActiveProposal,
  findProposal,
  findProposalDraft,
  newProposalId,
  saveProposalDraft,
  submitProposal,
  updateProposal,
  updateProposalReceipt,
} from "../lib/proposals.js";
import { anchorProposalBeforeWrite, receiptForWrite } from "../lib/proposalAudit.js";
import { deleteAttachment } from "../lib/attachments.js";
import { LeaveDraftPrompt } from "../components/LeaveDraftPrompt.jsx";
import { useDraftGuard } from "../lib/draftGuard.js";
import { auditErrorMessage } from "../lib/errors.js";
import { AuditReceipt } from "../components/AuditReceipt.jsx";
import { useAccount } from "wagmi";
import { proposalBlockReason, validateProposal, messageForProposalError } from "../lib/proposalValidation.js";
import { PROPOSAL_FIELDS, PROBLEM_FRAMING_FIELDS } from "../config/proposal.js";
import { OPEN_FUNDING_TYPE } from "../config/fundingOpportunity.js";
import { formatInstant } from "../lib/datetime.js";
import ProposalDetailPage from "./ProposalDetailPage.jsx";

const ALL_FIELDS = [...PROPOSAL_FIELDS, ...PROBLEM_FRAMING_FIELDS];

function abandonDraftAttachments(items, ownerId, proposalId) {
  return Promise.allSettled(items.map((attachment) => deleteAttachment({
    attachment, ownerId, problemId: proposalId, scope: "proposals",
  })));
}

/** What "unchanged since the last save" means, for the leave prompt. */
function snapshotOf(form, attachments) {
  return JSON.stringify({
    ...Object.fromEntries(ALL_FIELDS.map(([key]) => [key, String(form[key] ?? "")])),
    category: form.category ?? "",
    amount: String(form.amount ?? ""),
    attachments: attachments.map((item) => item.id).sort(),
  });
}

/** Seeds the form from a stored record, so a resumed draft or an edit starts where it left off. */
export function formFromProposal(record) {
  return {
    ...Object.fromEntries(ALL_FIELDS.map(([key]) => [key, record?.[key] ?? ""])),
    category: record?.category ?? "",
    amount: record?.amount ? String(record.amount) : "",
  };
}

function DraftStatus({ savedAt, saving }) {
  if (saving) return <p className="draft-status" role="status">Saving draft…</p>;
  if (!savedAt) {
    return <p className="draft-status muted" role="status">Not saved yet. Save as draft to keep this and finish later.</p>;
  }
  return <p className="draft-status" role="status">Draft saved <strong>{formatInstant(savedAt)}</strong>. Only you can see it.</p>;
}

export default function CreateProposalPage({ postingId, proposalId: editProposalId, onNavigate }) {
  const { user } = useAuth();
  const { address, isConnected } = useAccount();
  const [auditProgress, setAuditProgress] = useState(null);
  const [posting, setPosting] = useState(null);
  const [proposalId, setProposalId] = useState(null);
  const [active, setActive] = useState(null);
  const [record, setRecord] = useState(null);
  const [draftExists, setDraftExists] = useState(false);
  const [savedAt, setSavedAt] = useState(null);
  const [savingDraft, setSavingDraft] = useState(false);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({});
  const [attachments, setAttachments] = useState([]);
  const [pending, setPending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [errors, setErrors] = useState({});
  const [error, setError] = useState("");
  const [now, setNow] = useState(() => new Date());
  // Snapshot of the last saved state; null until the draft is first saved.
  const [baseline, setBaseline] = useState(null);
  // Attachments the saved draft already references, so discard leaves them alone.
  const savedAttachmentIds = useRef(new Set());
  const submitting = useRef(false);
  const formRef = useRef(null);
  const editing = record?.status === "submitted";

  // Unsaved work, not "any work". Against a saved baseline this is a comparison,
  // so saving a draft - or resuming one and changing nothing - leaves the form
  // clean and the prompt stays out of the way.
  const isDirty = useMemo(() => {
    if (baseline === null) {
      return ALL_FIELDS.some(([key]) => String(form[key] ?? "").trim().length > 0)
        || String(form.category ?? "").length > 0
        || String(form.amount ?? "").trim().length > 0
        || attachments.length > 0;
    }
    return snapshotOf(form, attachments) !== baseline;
  }, [form, attachments, baseline]);

  // Not while editing a submitted proposal: there is no draft to offer, and the
  // record on screen is already the saved one.
  const { leaveTarget, setLeaveTarget, goTo } = useDraftGuard({
    isDirty,
    active: !editing && !submitted,
    ownHashes: [
      postingId ? `#/submit-proposal/${postingId}` : "",
      proposalId ? `#/edit-proposal/${proposalId}` : "",
    ],
    onNavigate,
  });

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      if (editProposalId) {
        const found = await findProposal(editProposalId);
        if (!found) return { error: "This proposal could not be found or you do not have access." };
        return { posting: await findPosting(found.problemId), record: found, proposalId: found.id };
      }
      const [found, existing, draft] = await Promise.all([
        findPosting(postingId),
        findActiveProposal(postingId, user.id),
        findProposalDraft(postingId, user.id),
      ]);
      return { posting: found, active: existing, record: draft, proposalId: draft?.id ?? newProposalId() };
    };
    load().then((result) => {
      if (cancelled) return;
      if (result.error) { setError(result.error); return; }
      setPosting(result.posting);
      setActive(result.active ?? null);
      setRecord(result.record ?? null);
      setProposalId(result.proposalId);
      setDraftExists(result.record?.status === PROPOSAL_STATUS_DRAFT);
      if (result.record) {
        const loadedForm = formFromProposal(result.record);
        const loadedAttachments = result.record.attachments ?? [];
        setForm(loadedForm);
        setAttachments(loadedAttachments);
        if (result.record.status === PROPOSAL_STATUS_DRAFT) {
          setSavedAt(result.record.updatedAt);
          // Resuming and changing nothing is not unsaved work.
          setBaseline(snapshotOf(loadedForm, loadedAttachments));
          savedAttachmentIds.current = new Set(loadedAttachments.map((item) => item.id));
        }
      }
    }).catch((err) => { if (!cancelled) setError(messageForProposalError(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [postingId, editProposalId, user.id]);

  useEffect(() => {
    if (submitted) window.scrollTo({ top: 0, left: 0 });
  }, [submitted]);

  const update = (key, value) => { setForm((old) => ({ ...old, [key]: value })); setErrors((old) => ({ ...old, [key]: undefined })); };

  // No validation gate: saving half a form is the point of a draft.
  const persistDraft = async () => {
    if (savingDraft || busy) return;
    setSavingDraft(true); setError("");
    try {
      const saved = await saveProposalDraft({
        proposalId, researcherId: user.id, posting, form, attachments, exists: draftExists,
      });
      setDraftExists(true);
      setSavedAt(saved?.updatedAt ?? new Date());
      setBaseline(snapshotOf(form, attachments));
      savedAttachmentIds.current = new Set(attachments.map((item) => item.id));
      return true;
    } catch (err) { setError(messageForProposalError(err)); return false; }
    finally { setSavingDraft(false); }
  };

  /**
   * Leaves without keeping the current edits. Files the saved draft already
   * references are kept - deleting those would gut the draft the user chose to
   * keep. With no saved draft nothing was persisted, so everything goes.
   */
  const leave = async (target) => {
    const unsaved = attachments.filter((item) => !savedAttachmentIds.current.has(item.id));
    setAttachments([]);
    await abandonDraftAttachments(unsaved, user.id, proposalId);
    goTo(target);
  };

  const saveThenLeave = async () => {
    const target = leaveTarget;
    // Leaving on a rejected save would discard the very work the prompt offered
    // to keep, so the dialog stays open and persistDraft reports the reason.
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
    const target = editing ? `proposal/${proposalId}` : `posting/${postingId ?? posting?.id}`;
    if (isDirty && !editing) { setLeaveTarget(target); return; }
    goTo(target);
  };

  const submit = async (event) => {
    event.preventDefault();
    if (submitting.current || pending) return;
    const validation = validateProposal(form, posting);
    setErrors(validation);
    if (Object.keys(validation).length) {
      requestAnimationFrame(() => formRef.current?.querySelector('[aria-invalid="true"]')?.focus());
      return;
    }
    if (!isConnected || address?.toLowerCase() !== user.id.toLowerCase()) {
      setError("Connect the wallet that owns this account to sign and submit.");
      return;
    }
    submitting.current = true; setBusy(true); setError("");
    let audit = null;
    try {
      const record = buildProposalDocument({
        researcherId: user.id, posting, form, attachments,
      });
      audit = await anchorProposalBeforeWrite({ id: proposalId, ...record }, {
        account: address,
        onChange: setAuditProgress,
      });
      if (editing) {
        // A correction MUST carry its receipt: the stored one attests to the
        // content being replaced, so leaving it untouched is not an option.
        await updateProposal({
          proposalId, researcherId: user.id, posting, form, attachments,
          record, audit: receiptForWrite(audit),
        });
      } else {
        // The receipt follows in its own write rather than riding along here.
        // A create already pays for the whole schema, the parent opportunity and
        // every attachment entry, and adding the audit map on top crosses
        // Firestore's 1000-expression rule cap for an open-funding proposal with
        // an attachment - which surfaced as a bare permission-denied AFTER the
        // author had paid for the transaction. The ordering guarantee is
        // unaffected: the chain is still written first, and this record does not
        // exist until that transaction is confirmed.
        await submitProposal({
          proposalId, researcherId: user.id, posting, form, attachments,
          fromDraft: draftExists, record,
        });
        try {
          await updateProposalReceipt({ recordId: proposalId, audit: receiptForWrite(audit) });
        } catch {
          // The proposal is saved and the transaction is on-chain; only the
          // receipt copy is missing. The trigger queues it and the detail page
          // offers a retry, so this must not fail the submission.
        }
      }
      setSubmitted(true);
    } catch (err) {
      // Distinguish the two halves: a wallet or chain failure has changed
      // nothing, while a failure after the anchor leaves a paid-for transaction
      // whose record still needs saving.
      setError(audit?.transactionHash
        ? `The verification transaction was confirmed, but saving the proposal failed. ${messageForProposalError(err)} Your entries are still here — submitting again reuses the same anchor.`
        : auditErrorMessage(err));
    }
    finally { submitting.current = false; setBusy(false); setAuditProgress(null); }
  };

  // Deliberately NOT autoAnchor: the proposal was anchored before it was
  // written, so a second attempt here would either revert on a taken id or
  // append a pointless on-chain revision.
  if (submitted) return <ProposalDetailPage proposalId={proposalId} onNavigate={onNavigate} justSubmitted />;
  if (loading) return <section className="page empty" role="status">{editProposalId ? "Loading proposal…" : "Loading opportunity…"}</section>;
  if (!posting) {
    const missingProposal = Boolean(editProposalId);
    return <section className="page empty"><h1>{missingProposal ? "Proposal unavailable" : "Opportunity unavailable"}</h1><p role="alert">{error || (missingProposal ? "This proposal could not be found or you do not have access." : "This opportunity could not be found.")}</p><button className="secondary" onClick={() => onNavigate(missingProposal ? "proposals" : "discover")}>{missingProposal ? "My proposals" : "Browse opportunities"}</button></section>;
  }
  // Nothing may be edited once evaluation begins; firestore.rules enforces the
  // same boundary, so a stale tab cannot write past it either.
  if (editProposalId && record && !["draft", "submitted"].includes(record.status)) {
    return <section className="page empty"><h1>This proposal can no longer be edited</h1><p role="alert">Its status is {record.status}. A proposal is locked once evaluation begins.</p><button className="secondary" onClick={() => onNavigate(`proposal/${record.id}`)}>View proposal</button></section>;
  }
  const isOpenFunding = posting.opportunityType === OPEN_FUNDING_TYPE;
  const blocked = proposalBlockReason(posting, now);
  const disabled = busy || savingDraft || Boolean(blocked);
  const textField = ([key, label, max]) => <Field key={key} htmlFor={`proposal-${key}`} label={label} error={errors[key]}>
    {({ id, describedBy, invalid }) => {
      const Tag = key === "title" ? "input" : "textarea";
      return <Tag id={id} rows={key === "title" ? undefined : 4} value={form[key] || ""} maxLength={max} aria-describedby={describedBy} aria-invalid={invalid} required onChange={(event) => update(key, event.target.value)} />;
    }}
  </Field>;

  return <section className="page create-page">
    <button className="back" onClick={back}>{editing ? "Back to proposal" : "Back to opportunity"}</button>
    <div className="page-heading"><span className="eyebrow">{isOpenFunding ? "Problem + solution proposal" : "Solution proposal"}</span>
      <h1>{editing ? "Edit your proposal" : draftExists ? "Resume your draft" : "Submit a proposal"}</h1>
      <p>Respond to {posting.title}. All fields are required to submit; you can save an unfinished draft at any point. Supporting PDFs are optional.</p></div>
    <div className="form-layout">
      <form className="brief-form proposal-form" ref={formRef} onSubmit={submit} noValidate>
        {error && <p className="error-banner" role="alert">{error}</p>}
        {active && !editing && !draftExists ? <div className="empty"><h2>You already have an active proposal</h2><p>Withdraw it before submitting a replacement.</p><button className="primary" type="button" onClick={() => onNavigate(`proposal/${active.id}`)}>View my proposal</button></div> : <>
          {blocked && <p className="error-banner" role="alert">{blocked}</p>}
          {editing && <p className="field-hint" role="status">This proposal has been submitted but not yet evaluated. Saving your changes records the edit — the changed fields, your wallet and the time — and returns the proposal for wallet verification, which appends a revision on Arbitrum Sepolia beside the original.</p>}
          <fieldset className="field-group" disabled={disabled}>
            <legend>Your approach</legend>
            {PROPOSAL_FIELDS.slice(0, 2).map(textField)}
            <Field htmlFor="proposal-category" label="Quantum or quantum-adjacent category" error={errors.category}>
              {({ id, describedBy, invalid }) => <ProposalCategorySelect id={id} value={form.category || ""} disabled={disabled} invalid={invalid} describedBy={describedBy} onChange={(value) => update("category", value)} />}
            </Field>
            {PROPOSAL_FIELDS.slice(2).map(textField)}
          </fieldset>
          {isOpenFunding && <fieldset className="field-group" disabled={disabled}><legend>Problem framing</legend><p className="field-hint">The funder acts as the problem owner for selection. Your proposal follows the same evaluation, selection and approval process as a funded problem proposal.</p>{PROBLEM_FRAMING_FIELDS.map(textField)}</fieldset>}
          <fieldset className="field-group" disabled={disabled}><legend>Funding and supporting material</legend>
            <Field htmlFor="proposal-amount" label={`Requested funding amount (${posting.currency})`} error={errors.amount}>
              {({ id, describedBy, invalid }) => <input id={id} type="number" min="0.000001" max="1000000000" step="any" required value={form.amount || ""} aria-invalid={invalid} aria-describedby={describedBy} onChange={(event) => update("amount", event.target.value)} />}
            </Field>
            <AttachmentUploader ownerId={user.id} problemId={proposalId} scope="proposals" value={attachments} onChange={setAttachments} onPendingChange={setPending} disabled={disabled} />
          </fieldset>
          <p className="field-hint">{editing
            ? "Your wallet signs the amendment first. The proposal is updated only after that transaction is confirmed on Arbitrum Sepolia, so the stored version always matches its on-chain record."
            : "Your wallet signs first. The proposal is saved only after that transaction is confirmed on Arbitrum Sepolia, so nothing enters evaluation unverified."}</p>
          {auditProgress && <div className="detail-section"><AuditReceipt entityLabel="Proposal" audit={auditProgress} eventLabel={editing ? "Proposal updated" : "Proposal submitted"} actorRole="Researcher / solution developer" /></div>}
          <div className="form-actions">
            <button className="primary" type="submit" disabled={disabled || pending}>{busy ? (auditProgress?.transactionHash ? "Confirming on-chain…" : "Waiting for your wallet…") : pending ? "Waiting for attachments…" : editing ? "Sign and save changes" : "Sign and submit proposal"}</button>
            {!editing && <button className="secondary" type="button" disabled={disabled || pending} onClick={persistDraft}>{savingDraft ? "Saving…" : "Save as draft"}</button>}
          </div>
          {!editing && <DraftStatus savedAt={savedAt} saving={savingDraft} />}
        </>}
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
      <aside className="context-panel"><span className="eyebrow">Responding to</span><h2>{posting.title}</h2><p>{posting.fundingThesis || posting.summary}</p><strong>{posting.currency} {Number(posting.amount).toLocaleString()}</strong><p>{posting.organisation}</p><ExpiryCountdown expiresAt={posting.expiresAt} />{isOpenFunding && <><h3>Eligibility</h3><p>{posting.eligibilityNotes}</p><p>The funder acts as the problem owner for selection.</p></>}</aside>
    </div>
  </section>;
}
