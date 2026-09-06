import { useEffect, useRef, useState } from "react";
import { useAuth } from "../context/AuthContext.jsx";
import { Field } from "../components/Field.jsx";
import { ProposalCategorySelect } from "../components/ProposalCategorySelect.jsx";
import { AttachmentUploader } from "../components/AttachmentUploader.jsx";
import { ExpiryCountdown } from "../components/ExpiryCountdown.jsx";
import { findPosting } from "../lib/postings.js";
import { findActiveProposal, newProposalId, submitProposal } from "../lib/proposals.js";
import { proposalBlockReason, validateProposal, messageForProposalError } from "../lib/proposalValidation.js";
import { PROPOSAL_FIELDS, PROBLEM_FRAMING_FIELDS } from "../config/proposal.js";
import { OPEN_FUNDING_TYPE } from "../config/fundingOpportunity.js";
import ProposalDetailPage from "./ProposalDetailPage.jsx";

export default function CreateProposalPage({ postingId, onNavigate }) {
  const { user } = useAuth();
  const [posting, setPosting] = useState(null);
  const [proposalId, setProposalId] = useState(null);
  const [active, setActive] = useState(null);
  const [loading, setLoading] = useState(true);
  const [form, setForm] = useState({});
  const [attachments, setAttachments] = useState([]);
  const [pending, setPending] = useState(false);
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [errors, setErrors] = useState({});
  const [error, setError] = useState("");
  const [now, setNow] = useState(() => new Date());
  const submitting = useRef(false);
  const formRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    Promise.all([findPosting(postingId), findActiveProposal(postingId, user.id)])
      .then(([found, existing]) => {
        if (cancelled) return;
        setPosting(found); setActive(existing); setProposalId(newProposalId());
      }).catch((err) => { if (!cancelled) setError(messageForProposalError(err)); })
      .finally(() => { if (!cancelled) setLoading(false); });
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [postingId, user.id]);

  useEffect(() => {
    if (submitted) window.scrollTo({ top: 0, left: 0 });
  }, [submitted]);

  const update = (key, value) => { setForm((old) => ({ ...old, [key]: value })); setErrors((old) => ({ ...old, [key]: undefined })); };
  const submit = async (event) => {
    event.preventDefault();
    if (submitting.current || pending) return;
    const validation = validateProposal(form, posting);
    setErrors(validation);
    if (Object.keys(validation).length) {
      requestAnimationFrame(() => formRef.current?.querySelector('[aria-invalid="true"]')?.focus());
      return;
    }
    submitting.current = true; setBusy(true); setError("");
    try {
      await submitProposal({ proposalId, researcherId: user.id, posting, form, attachments });
      setSubmitted(true);
    } catch (err) { setError(messageForProposalError(err)); }
    finally { submitting.current = false; setBusy(false); }
  };

  if (submitted) return <ProposalDetailPage proposalId={proposalId} onNavigate={onNavigate} autoAnchor />;
  if (loading) return <section className="page empty" role="status">Loading opportunity…</section>;
  if (!posting) return <section className="page empty"><h1>Opportunity unavailable</h1><p role="alert">{error || "This opportunity could not be found."}</p><button className="secondary" onClick={() => onNavigate("discover")}>Browse opportunities</button></section>;
  const isOpenFunding = posting.opportunityType === OPEN_FUNDING_TYPE;
  const blocked = proposalBlockReason(posting, now);
  const textField = ([key, label, max]) => <Field key={key} htmlFor={`proposal-${key}`} label={label} error={errors[key]}>
    {({ id, describedBy, invalid }) => {
      const Tag = key === "title" ? "input" : "textarea";
      return <Tag id={id} rows={key === "title" ? undefined : 4} value={form[key] || ""} maxLength={max} aria-describedby={describedBy} aria-invalid={invalid} required onChange={(event) => update(key, event.target.value)} />;
    }}
  </Field>;

  return <section className="page create-page">
    <button className="back" onClick={() => onNavigate(`posting/${postingId}`)}>Back to opportunity</button>
    <div className="page-heading"><span className="eyebrow">{isOpenFunding ? "Problem + solution proposal" : "Solution proposal"}</span><h1>Submit a proposal</h1><p>Respond to {posting.title}. All fields are required; supporting PDFs are optional.</p></div>
    <div className="form-layout">
      <form className="brief-form proposal-form" ref={formRef} onSubmit={submit} noValidate>
        {error && <p className="error-banner" role="alert">{error}</p>}
        {active ? <div className="empty"><h2>You already have an active proposal</h2><p>Withdraw it before submitting a replacement.</p><button className="primary" type="button" onClick={() => onNavigate(`proposal/${active.id}`)}>View my proposal</button></div> : <>
          {blocked && <p className="error-banner" role="alert">{blocked}</p>}
          <fieldset className="field-group" disabled={busy || Boolean(blocked)}>
            <legend>Your approach</legend>
            {PROPOSAL_FIELDS.slice(0, 2).map(textField)}
            <Field htmlFor="proposal-category" label="Quantum or quantum-adjacent category" error={errors.category}>
              {({ id, describedBy, invalid }) => <ProposalCategorySelect id={id} value={form.category || ""} disabled={busy || Boolean(blocked)} invalid={invalid} describedBy={describedBy} onChange={(value) => update("category", value)} />}
            </Field>
            {PROPOSAL_FIELDS.slice(2).map(textField)}
          </fieldset>
          {isOpenFunding && <fieldset className="field-group" disabled={busy || Boolean(blocked)}><legend>Problem framing</legend><p className="field-hint">The funder acts as the problem owner for selection. Your proposal follows the same evaluation, selection and approval process as a funded problem proposal.</p>{PROBLEM_FRAMING_FIELDS.map(textField)}</fieldset>}
          <fieldset className="field-group" disabled={busy || Boolean(blocked)}><legend>Funding and supporting material</legend>
            <Field htmlFor="proposal-amount" label={`Requested funding amount (${posting.currency})`} error={errors.amount}>
              {({ id, describedBy, invalid }) => <input id={id} type="number" min="0.000001" max="1000000000" step="any" required value={form.amount || ""} aria-invalid={invalid} aria-describedby={describedBy} onChange={(event) => update("amount", event.target.value)} />}
            </Field>
            <AttachmentUploader ownerId={user.id} problemId={proposalId} scope="proposals" value={attachments} onChange={setAttachments} onPendingChange={setPending} disabled={busy || Boolean(blocked)} />
          </fieldset>
          <p className="field-hint">Your proposal is saved first. Wallet verification runs afterwards and can be retried if the test network is unavailable.</p>
          <button className="primary" type="submit" disabled={busy || pending || Boolean(blocked)}>{busy ? "Submitting…" : pending ? "Waiting for attachments…" : "Submit proposal"}</button>
        </>}
      </form>
      <aside className="context-panel"><span className="eyebrow">Responding to</span><h2>{posting.title}</h2><p>{posting.fundingThesis || posting.summary}</p><strong>{posting.currency} {Number(posting.amount).toLocaleString()}</strong><p>{posting.organisation}</p><ExpiryCountdown expiresAt={posting.expiresAt} />{isOpenFunding && <><h3>Eligibility</h3><p>{posting.eligibilityNotes}</p><p>The funder acts as the problem owner for selection.</p></>}</aside>
    </div>
  </section>;
}
