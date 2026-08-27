import { useState } from "react";
import { Modal } from "./Modal.jsx";
import { shortenAddress } from "../lib/chain.js";
import { setUserSuspension } from "../lib/admin.js";

export function SuspendUserModal({ targetUser, onClose, onSuccess }) {
  const isSuspended = Boolean(targetUser?.suspended);
  const nextSuspendedState = !isSuspended;
  const actionLabel = nextSuspendedState ? "Suspend" : "Reinstate";

  const [reason, setReason] = useState("");
  const [step, setStep] = useState("form");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  if (!targetUser) return null;

  const handleReview = (e) => {
    e.preventDefault();
    if (!reason.trim() || reason.trim().length < 5) {
      setError("Please provide a substantive reason (at least 5 characters).");
      return;
    }
    setError(null);
    setStep("confirm");
  };

  const handleConfirm = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await setUserSuspension({
        targetAddress: targetUser.address,
        suspended: nextSuspendedState,
        reason: reason.trim(),
      });
      onSuccess?.({
        address: targetUser.address,
        suspended: nextSuspendedState,
      });
      onClose();
    } catch (err) {
      setError(err?.message || `Failed to ${actionLabel.toLowerCase()} user account.`);
      setSubmitting(false);
    }
  };

  return (
    <Modal
      labelledBy="suspend-modal-title"
      describedBy="suspend-modal-desc"
      onDismiss={onClose}
      className="admin-modal"
    >
      <div className="modal-header">
        <div className="modal-title-row">
          <span className="eyebrow">Account Governance</span>
          <h2 id="suspend-modal-title">
            {actionLabel} User Account
          </h2>
        </div>
        <p id="suspend-modal-desc" className="modal-subtitle">
          {nextSuspendedState
            ? `Suspending account access for ${targetUser.fullName || "User"} (${shortenAddress(targetUser.address)}).`
            : `Restoring account access for ${targetUser.fullName || "User"} (${shortenAddress(targetUser.address)}).`}
        </p>
      </div>

      {error && (
        <div className="modal-error-banner" role="alert">
          {error}
        </div>
      )}

      {step === "form" ? (
        <form onSubmit={handleReview} className="modal-form">
          <div className="modal-section">
            <label className="field-label">Current Account State</label>
            <div className="current-role-badge">
              <span className={`status-pill ${isSuspended ? "status-suspended" : "status-active"}`}>
                {isSuspended ? "Suspended" : "Active / Operational"}
              </span>
            </div>
          </div>

          <div className="modal-section">
            <label className="field-label" htmlFor="suspend-reason">
              Reason for {actionLabel} <span className="required-star">*</span>
            </label>
            <p className="field-hint">
              State the operational or governance reason for this account status update. Recorded in audit log.
            </p>
            <textarea
              id="suspend-reason"
              rows={3}
              required
              placeholder={
                nextSuspendedState
                  ? "e.g. Account suspended for cross-organization demonstration reset / policy breach"
                  : "e.g. Account reinstated following pilot verification / demo conclusion"
              }
              value={reason}
              onChange={(e) => {
                setReason(e.target.value);
                setError(null);
              }}
            />
          </div>

          <div className="modal-actions">
            <button className="secondary" type="button" onClick={onClose} disabled={submitting}>
              Cancel
            </button>
            <button
              className={nextSuspendedState ? "primary danger-btn" : "primary"}
              type="submit"
              disabled={submitting}
            >
              Review {actionLabel} Action
            </button>
          </div>
        </form>
      ) : (
        <div className="modal-review-step">
          <div className="review-card">
            <h4>Confirm {actionLabel} Action</h4>
            <div className="review-row">
              <span>Target Account:</span>
              <strong>{targetUser.fullName} ({shortenAddress(targetUser.address)})</strong>
            </div>
            <div className="review-row">
              <span>New Status:</span>
              <span className={`status-pill ${nextSuspendedState ? "status-suspended" : "status-active"}`}>
                {nextSuspendedState ? "Suspended" : "Active"}
              </span>
            </div>
            <div className="review-row">
              <span>Audit Reason:</span>
              <p className="review-reason">"{reason}"</p>
            </div>
          </div>

          <div className="modal-actions">
            <button
              className="secondary"
              type="button"
              onClick={() => setStep("form")}
              disabled={submitting}
            >
              Back
            </button>
            <button
              className={nextSuspendedState ? "primary danger-confirm" : "primary"}
              type="button"
              onClick={handleConfirm}
              disabled={submitting}
            >
              {submitting ? "Committing..." : `Confirm ${actionLabel}`}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
