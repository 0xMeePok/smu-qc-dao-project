import { Modal } from "./Modal.jsx";

/**
 * QCDAO-50/57 - offered when someone leaves a draftable form with unsaved work.
 *
 * Three ways out, deliberately: keep editing, leave without keeping this, or
 * save and leave. "Discard" reads differently once a draft exists - it rolls back
 * to the last save rather than throwing everything away - so the wording follows
 * what is actually at stake.
 */
export function LeaveDraftPrompt({
  draftExists,
  saving,
  entityLabel,
  resumeLocation,
  onKeepEditing,
  onDiscard,
  onSave,
}) {
  return (
    <Modal labelledBy="leave-draft-title" describedBy="leave-draft-desc" onDismiss={onKeepEditing}>
      <div className="modal-head">
        <div>
          <h2 id="leave-draft-title">Save this as a draft?</h2>
          <p id="leave-draft-desc">
            {draftExists
              ? "You have changes that are not in the saved draft. Discarding rolls back to the last save."
              : `You have unsaved work on this ${entityLabel}. Save it as a draft and you can pick it up from ${resumeLocation} later.`}
          </p>
        </div>
      </div>
      <div className="modal-actions">
        <button className="secondary" type="button" disabled={saving} onClick={onKeepEditing}>
          Keep editing
        </button>
        <button className="secondary" type="button" disabled={saving} onClick={onDiscard}>
          {draftExists ? "Discard changes" : "Discard and leave"}
        </button>
        <button className="primary" type="button" disabled={saving} onClick={onSave}>
          {saving ? "Saving…" : "Save as draft and leave"}
        </button>
      </div>
    </Modal>
  );
}
