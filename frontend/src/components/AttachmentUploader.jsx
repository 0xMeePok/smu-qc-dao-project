import { useCallback, useEffect, useRef, useState } from "react";
import {
  ACCEPTED_MIME,
  MAX_FILES_PER_POSTING,
  MAX_FILE_BYTES,
  deleteAttachment,
  downloadAttachment,
  formatBytes,
  messageForStorageError,
  saveBlobAs,
  uploadAttachment,
  validateFile,
} from "../lib/attachments.js";

/**
 * QCDAO-58 - the reusable half of "attach supporting files to a posting".
 *
 * Deliberately a CONTROLLED component with no knowledge of postings, forms or
 * routing, so it can be dropped into the real posting form when that exists:
 *
 *   const [attachments, setAttachments] = useState([]);
 *   <AttachmentUploader
 *     ownerId={address}
 *     problemId={problemId}
 *     value={attachments}
 *     onChange={setAttachments}
 *     onPendingChange={setPendingCount}
 *   />
 *
 * `value` is exactly what belongs in the posting's `attachments` field, so the
 * host form saves it with the rest of its state and nothing else has to change.
 * `onPendingChange` reports how many transfers are still in flight so the host
 * can refuse to submit until every upload has settled.
 *
 * The one contract that matters: `problemId` must be decided BEFORE the first
 * upload, because it is part of the storage path. Generate the document id up
 * front (doc(collection(db, "problems")).id) rather than letting Firestore assign
 * one on save, or the files will be filed under a posting that never exists.
 */
export function AttachmentUploader({
  ownerId,
  problemId,
  value = [],
  onChange,
  onPendingChange,
  disabled = false,
}) {
  // In-flight uploads, keyed by attachment id. Separate from `value` because a
  // transfer that is still running - or cancelled - must never be written to the
  // posting record.
  const [pending, setPending] = useState([]);
  const [error, setError] = useState(null);
  const inputRef = useRef(null);

  // `value` and `pending` are also tracked in refs because several uploads can be
  // in flight at once and each completion handler was captured at the moment its
  // upload started. Reading the props from that closure means two files finishing
  // together both compute `[...value, self]` from the SAME stale array, and the
  // second onChange silently discards the first file. Every completion path below
  // therefore reads the ref, never the closed-over prop.
  const valueRef = useRef(value);
  useEffect(() => {
    valueRef.current = value;
  }, [value]);

  const pendingRef = useRef(pending);
  useEffect(() => {
    pendingRef.current = pending;
  }, [pending]);

  const onPendingChangeRef = useRef(onPendingChange);
  useEffect(() => {
    onPendingChangeRef.current = onPendingChange;
  }, [onPendingChange]);

  useEffect(() => {
    onPendingChangeRef.current?.(pending.length);
  }, [pending.length]);

  // Cancels every in-flight upload if the component goes away mid-transfer,
  // rather than leaving orphaned objects in the bucket that nothing references.
  useEffect(() => () => {
    pendingRef.current.forEach((row) => {
      try {
        row.cancel();
      } catch {
        // Already settled - nothing to abort.
      }
    });
    onPendingChangeRef.current?.(0);
  }, []);

  const commit = useCallback((updater) => {
    const next = updater(valueRef.current);
    valueRef.current = next;
    onChange?.(next);
  }, [onChange]);

  const totalCount = value.length + pending.length;
  const atLimit = totalCount >= MAX_FILES_PER_POSTING;

  const handleFiles = useCallback(async (fileList) => {
    setError(null);
    const files = Array.from(fileList ?? []);
    if (files.length === 0) return;

    for (const file of files) {
      // Counts are re-read from the refs on every iteration, so selecting five
      // files at once is capped exactly the same way as adding them one at a time.
      const existingCount = pendingRef.current.length + valueRef.current.length;
      const validationError = await validateFile(file, { existingCount });
      if (validationError) {
        setError(validationError);
        continue;
      }

      let upload;
      try {
        upload = uploadAttachment({
          file,
          ownerId,
          problemId,
          onProgress: (progress) => {
            const id = upload.attachment.id;
            setPending((rows) => rows.map((row) => (
              row.attachment.id === id ? { ...row, progress } : row
            )));
          },
        });
      } catch (startError) {
        setError(messageForStorageError(startError));
        continue;
      }

      const uploadedId = upload.attachment.id;
      const row = { attachment: upload.attachment, progress: 0, cancel: upload.cancel };
      // Written straight to the ref as well as through setState: the next loop
      // iteration runs before React has re-rendered, and it has to see this row.
      pendingRef.current = [...pendingRef.current, row];
      setPending((rows) => [...rows, row]);

      const clearPending = () => {
        pendingRef.current = pendingRef.current.filter((r) => r.attachment.id !== uploadedId);
        setPending((rows) => rows.filter((r) => r.attachment.id !== uploadedId));
      };

      upload.done
        .then((attachment) => {
          clearPending();
          commit((current) => [...current, attachment]);
        })
        .catch((uploadError) => {
          clearPending();
          // A cancel is a deliberate user action, not a failure to report.
          if (uploadError?.code !== "storage/canceled") {
            setError(messageForStorageError(uploadError));
          }
        });
    }

    if (inputRef.current) inputRef.current.value = "";
  }, [commit, ownerId, problemId]);

  const cancelUpload = (row) => {
    try {
      row.cancel();
    } catch {
      setPending((rows) => rows.filter((r) => r.attachment.id !== row.attachment.id));
    }
  };

  const removeAttachment = async (attachment) => {
    setError(null);
    // Removed from the list first so the UI responds immediately, then put back if
    // the delete turns out to be refused - the row must never claim a file is gone
    // while it is still in the bucket.
    commit((current) => current.filter((item) => item.id !== attachment.id));
    try {
      await deleteAttachment(attachment);
    } catch (deleteError) {
      commit((current) => (
        current.some((item) => item.id === attachment.id) ? current : [...current, attachment]
      ));
      setError(messageForStorageError(deleteError));
    }
  };

  const download = async (attachment) => {
    setError(null);
    try {
      const blob = await downloadAttachment(attachment);
      saveBlobAs(blob, attachment.name);
    } catch (downloadError) {
      setError(messageForStorageError(downloadError));
    }
  };

  return (
    <div className="attachment-uploader">
      <div className="attachment-dropzone">
        <input
          ref={inputRef}
          id="attachment-input"
          className="attachment-input"
          type="file"
          accept={`${ACCEPTED_MIME},.pdf`}
          multiple
          disabled={disabled || atLimit}
          onChange={(event) => handleFiles(event.target.files)}
        />
        <label className="attachment-input-label" htmlFor="attachment-input">
          <span className="attachment-input-icon" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M12 16V4M8 8l4-4 4 4" />
              <path d="M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3" />
            </svg>
          </span>
          <span>
            <strong>{atLimit ? "Attachment limit reached" : "Choose PDF files"}</strong>
            <small>
              PDF only · up to {formatBytes(MAX_FILE_BYTES)} each · {totalCount} of{" "}
              {MAX_FILES_PER_POSTING} used
            </small>
          </span>
        </label>
      </div>

      {error && (
        <p className="attachment-error" role="alert">{error}</p>
      )}

      {(value.length > 0 || pending.length > 0) && (
        <ul className="attachment-list">
          {value.map((attachment) => (
            <li className="attachment-row" key={attachment.id}>
              <span className="attachment-mark" aria-hidden="true">PDF</span>
              <span className="attachment-meta">
                <strong>{attachment.name}</strong>
                <small>{formatBytes(attachment.size)} · attached</small>
              </span>
              <span className="attachment-actions">
                <button type="button" className="text-button" onClick={() => download(attachment)}>
                  Download
                </button>
                <button
                  type="button"
                  className="text-button attachment-remove"
                  disabled={disabled}
                  onClick={() => removeAttachment(attachment)}
                >
                  Remove
                </button>
              </span>
            </li>
          ))}

          {pending.map((row) => (
            <li className="attachment-row uploading" key={row.attachment.id}>
              <span className="attachment-mark" aria-hidden="true">PDF</span>
              <span className="attachment-meta">
                <strong>{row.attachment.name}</strong>
                <small>{formatBytes(row.attachment.size)} · uploading {row.progress}%</small>
                <progress className="attachment-progress" max="100" value={row.progress} />
              </span>
              <span className="attachment-actions">
                <button
                  type="button"
                  className="text-button attachment-remove"
                  onClick={() => cancelUpload(row)}
                >
                  Cancel
                </button>
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default AttachmentUploader;
