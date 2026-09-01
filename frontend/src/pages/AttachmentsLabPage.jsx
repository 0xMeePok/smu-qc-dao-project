import { useMemo, useState } from "react";
import { AttachmentUploader } from "../components/AttachmentUploader.jsx";
import { useSession } from "../context/SessionContext.jsx";
import {
  createPosting,
  findPosting,
  newPostingId,
  savePostingAttachments,
} from "../lib/postings.js";
import {
  deleteAttachment,
  downloadAttachment,
  formatBytes,
  messageForStorageError,
  saveBlobAs,
} from "../lib/attachments.js";
import { messageForFirebaseError } from "../lib/errors.js";
import { isStorageConfigured } from "../lib/firebase.js";

/**
 * QCDAO-58 - proof-of-concept harness for posting attachments.
 *
 * The posting form and posting detail page are being built under a separate
 * story. This page stands in for both so the upload/download path can be built,
 * reviewed and tested against the real security rules now, rather than waiting.
 *
 * It is a HARNESS, not a feature: the reusable pieces are
 * components/AttachmentUploader.jsx and lib/attachments.js, and neither knows this
 * page exists. THIS IS A POC PAGE WHILE WAITING FOR THE POSTING FORM TO BE CREATED
 */
export default function AttachmentsLabPage() {
  const { address, isSignedIn } = useSession();

  // Reserved up front, before any upload, because the id is part of every storage
  // path and of the rule that validates each attachment record.
  const [postingId, setPostingId] = useState(() => {
    try {
      return newPostingId();
    } catch {
      return null;
    }
  });

  const [form, setForm] = useState({
    title: "Attachment test posting",
    summary: "A posting created to exercise the QCDAO-58 attachment path end to end.",
    amount: "1000",
  });
  const [attachments, setAttachments] = useState([]);
  const [saved, setSaved] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);

  const canPublish = useMemo(
    () => isSignedIn && form.title.trim().length > 1 && form.summary.trim().length > 1 && !busy,
    [isSignedIn, form.title, form.summary, busy],
  );

  if (!isStorageConfigured) {
    return (
      <section className="page empty">
        <span className="http-status">Storage not configured</span>
        <h1>Firebase Storage is not wired up in this build.</h1>
        <p>
          Set <code>VITE_FIREBASE_STORAGE_BUCKET</code> in <code>frontend/.env.local</code>
          {" "}(and as a repository secret for deploys), then reload.
        </p>
      </section>
    );
  }

  const update = (event) => {
    const { name, value } = event.target;
    setForm((current) => ({ ...current, [name]: value }));
    setSaved(null);
  };

  const publish = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (saved) {
        await savePostingAttachments({ postingId, attachments });
      } else {
        await createPosting({ postingId, ownerId: address, form, attachments });
      }
      // Read back rather than trusting local state: this proves the write passed
      // the rules AND that the stored attachment records survive a round trip,
      // which is what the posting detail page will actually render from.
      const stored = await findPosting(postingId);
      setSaved(stored);
    } catch (publishError) {
      setError(messageForFirebaseError(publishError));
    } finally {
      setBusy(false);
    }
  };

  // Abandoning a draft must take its uploads with it. Clearing the list alone
  // would leave the objects in the bucket with nothing referencing them - the
  // orphans sweepAttachments exists to clean up, generated here by ordinary use
  // rather than by anyone misbehaving.
  //
  // Only unpublished attachments are removed: once the posting is saved they
  // belong to a real record, and starting a new draft must not delete them.
  const startOver = async () => {
    setError(null);
    const abandoned = saved ? [] : attachments;

    setPostingId(newPostingId());
    setAttachments([]);
    setSaved(null);

    // Best effort. A failure here is not worth blocking the user over, because
    // the scheduled sweeper is the backstop for exactly this case.
    await Promise.allSettled(abandoned.map((attachment) => deleteAttachment(attachment)));
  };

  const downloadFromDetail = async (attachment) => {
    setError(null);
    try {
      const blob = await downloadAttachment(attachment);
      saveBlobAs(blob, attachment.name);
    } catch (downloadError) {
      setError(messageForStorageError(downloadError));
    }
  };

  return (
    <section className="page create-page">
      <div className="page-heading">
        <span className="eyebrow">QCDAO-58 · integration harness</span>
        <h1>Posting attachments</h1>
        <p>
          Stands in for the posting form and the posting detail page until those exist.
          Everything below runs against the live Firestore and Storage rules.
        </p>
      </div>

      <div className="form-layout">
        <form className="brief-form" onSubmit={publish}>
          <fieldset className="field-group">
            <legend>1. Posting</legend>
            <p className="field-hint">
              Posting id <code>{postingId}</code> — reserved before the first upload,
              because it forms part of every attachment&apos;s storage path.
            </p>
            <div className="field">
              <label htmlFor="title">Title</label>
              <input id="title" name="title" type="text" required value={form.title} onChange={update} />
            </div>
            <div className="field">
              <label htmlFor="summary">Summary</label>
              <textarea id="summary" name="summary" rows={3} required value={form.summary} onChange={update} />
            </div>
            <div className="field">
              <label htmlFor="amount">Indicative budget</label>
              <input id="amount" name="amount" type="number" min="0" value={form.amount} onChange={update} />
            </div>
          </fieldset>

          <fieldset className="field-group">
            <legend>2. Supporting documents</legend>
            <p className="field-hint">
              PDF only. Upload, watch progress, cancel mid-transfer, or remove before
              publishing — removal deletes the stored object, it does not just hide the row.
            </p>
            <AttachmentUploader
              ownerId={address}
              problemId={postingId}
              value={attachments}
              onChange={setAttachments}
              disabled={busy}
            />
          </fieldset>

          <div className="form-actions">
            <button className="primary" type="submit" disabled={!canPublish}>
              {busy ? "Saving…" : saved ? "Save attachment changes" : "Publish posting"}
            </button>
            <button className="secondary" type="button" onClick={startOver} disabled={busy}>
              Start a new draft
            </button>
          </div>

          {error && <p className="attachment-error" role="alert">{error}</p>}
        </form>

        <aside className="preview-panel" aria-label="Posting detail preview">
          <div className="preview-sticky">
            <span className="eyebrow">Posting detail view</span>
            <div className="preview-card">
              {!saved ? (
                <>
                  <h3>Nothing published yet</h3>
                  <p>
                    Publish the posting to see what the detail page reads back from
                    Firestore, and to download the attachments through the rules.
                  </p>
                </>
              ) : (
                <>
                  <div className="card-top">
                    <span className="eyebrow">Stored posting</span>
                    <span className="status-dot">{saved.status}</span>
                  </div>
                  <h3>{saved.title}</h3>
                  <p>{saved.summary}</p>
                  <div className="attachment-detail-list">
                    <span className="eyebrow">Attachments ({saved.attachments.length})</span>
                    {saved.attachments.length === 0 && (
                      <p className="field-hint">No documents attached to this posting.</p>
                    )}
                    <ul className="attachment-list">
                      {saved.attachments.map((attachment) => (
                        <li className="attachment-row" key={attachment.id}>
                          <span className="attachment-mark" aria-hidden="true">PDF</span>
                          <span className="attachment-meta">
                            <strong>{attachment.name}</strong>
                            <small>{formatBytes(attachment.size)}</small>
                          </span>
                          <span className="attachment-actions">
                            <button
                              type="button"
                              className="text-button"
                              onClick={() => downloadFromDetail(attachment)}
                            >
                              Download
                            </button>
                          </span>
                        </li>
                      ))}
                    </ul>
                  </div>
                </>
              )}
            </div>
          </div>
        </aside>
      </div>
    </section>
  );
}
