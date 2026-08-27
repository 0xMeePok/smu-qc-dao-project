import { useState } from "react";
import { Modal } from "./Modal.jsx";
import { shortenAddress } from "../lib/chain.js";
import { roleLabel } from "../lib/roles.js";
import { updateUserRole } from "../lib/admin.js";

export function RoleChangeModal({ targetUser, onClose, onSuccess }) {
  const [newRole, setNewRole] = useState(targetUser?.role === 1 ? 0 : 1);
  const [reason, setReason] = useState("");
  const [step, setStep] = useState("form"); // "form" | "confirm"
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  if (!targetUser) return null;

  const currentRole = targetUser.role ?? 0;

  const handleReview = (e) => {
    e.preventDefault();
    if (!reason.trim() || reason.trim().length < 5) {
      setError("Please provide a substantive reason (at least 5 characters).");
      return;
    }
    if (newRole === currentRole) {
      setError("Please select a different role than the user's current role.");
      return;
    }
    setError(null);
    setStep("confirm");
  };

  const handleConfirm = async () => {
    setSubmitting(true);
    setError(null);
    try {
      await updateUserRole({
        targetAddress: targetUser.address,
        newRole,
        reason: reason.trim(),
      });
      onSuccess?.({
        address: targetUser.address,
        newRole,
      });
      onClose();
    } catch (err) {
      setError(err?.message || "Failed to update user role assignment.");
      setSubmitting(false);
    }
  };

  return (
    <Modal
      labelledBy="role-change-title"
      describedBy="role-change-desc"
      onDismiss={onClose}
      className="admin-modal"
    >
      <div className="modal-header">
        <div className="modal-title-row">
          <span className="eyebrow">Governance Action</span>
          <h2 id="role-change-title">Change User Role Assignment</h2>
        </div>
        <p id="role-change-desc" className="modal-subtitle">
          Modifying role for <strong>{targetUser.fullName || "User"}</strong> (
          <code>{shortenAddress(targetUser.address)}</code>).
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
            <label className="field-label">Current Role</label>
            <div className="current-role-badge">
              <span className={`role-badge role-${currentRole === 1 ? "admin" : "user"}`}>
                {roleLabel(currentRole)}
              </span>
            </div>
          </div>

          <div className="modal-section">
            <label className="field-label" htmlFor="new-role-select">
              New Role Assignment
            </label>
            <div className="role-radio-group">
              <label className={`radio-pill ${newRole === 0 ? "selected" : ""}`}>
                <input
                  type="radio"
                  name="newRole"
                  value={0}
                  checked={newRole === 0}
                  onChange={() => setNewRole(0)}
                  disabled={currentRole === 0}
                />
                <div>
                  <strong>Platform User (0)</strong>
                  <small>Standard participant access across problem ownership, research, and evaluation</small>
                </div>
              </label>

              <label className={`radio-pill ${newRole === 1 ? "selected" : ""}`}>
                <input
                  type="radio"
                  name="newRole"
                  value={1}
                  checked={newRole === 1}
                  onChange={() => setNewRole(1)}
                  disabled={currentRole === 1}
                />
                <div>
                  <strong>DAO Administrator (1)</strong>
                  <small>Full administrative governance, user management, and audit inspection</small>
                </div>
              </label>
            </div>
          </div>

          <div className="modal-section">
            <label className="field-label" htmlFor="role-change-reason">
              Reason for Role Change <span className="required-star">*</span>
            </label>
            <p className="field-hint">
              This explanation will be permanently recorded in the immutable audit trail with your signature.
            </p>
            <textarea
              id="role-change-reason"
              rows={3}
              required
              placeholder="e.g. Correct wrong role selection during pilot / setup simulated stakeholder for SMU demo"
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
            <button className="primary" type="submit" disabled={submitting}>
              Review & Confirm
            </button>
          </div>
        </form>
      ) : (
        <div className="modal-review-step">
          <div className="review-card">
            <h4>Confirm Role Transition</h4>
            <div className="review-row">
              <span>Target Account:</span>
              <strong>{targetUser.fullName} ({shortenAddress(targetUser.address)})</strong>
            </div>
            <div className="review-row">
              <span>Transition:</span>
              <div className="transition-tags">
                <span className="tag-old">{roleLabel(currentRole)}</span>
                <span className="transition-arrow">→</span>
                <span className="tag-new">{roleLabel(newRole)}</span>
              </div>
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
              className="primary danger-confirm"
              type="button"
              onClick={handleConfirm}
              disabled={submitting}
            >
              {submitting ? "Committing..." : "Confirm & Write Audit"}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
}
