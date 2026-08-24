import { useEffect, useRef, useState } from "react";
import { Field } from "./Field.jsx";
import { Modal } from "./Modal.jsx";
import { useSession } from "../context/SessionContext.jsx";
import { shortenAddress } from "../lib/chain.js";
import { go } from "../lib/router.js";
import { validateOnboarding } from "../lib/validation.js";
import { fieldForFirebaseError, messageForFirebaseError } from "../lib/errors.js";

const initialForm = { fullName: "", organisation: "", acceptedTerms: false };


/**
 * Shown only when a verified wallet has no profile in Firestore. There is no public
 * registration URL: this is the entire sign-up surface, and it cannot be reached
 * without first connecting and signing.
 */
export function OnboardingModal() {
  const { needsOnboarding, completeOnboarding, cancelOnboarding, address } = useSession();
  const [form, setForm] = useState(initialForm);
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState(null);
  const [submitting, setSubmitting] = useState(false);
  const firstFieldRef = useRef(null);

  useEffect(() => {
    if (needsOnboarding) {
      setForm(initialForm);
      setErrors({});
      setFormError(null);
      firstFieldRef.current?.focus();
    }
  }, [needsOnboarding]);

  if (!needsOnboarding) return null;

  const update = (event) => {
    const { name, value, type, checked } = event.target;
    setForm((current) => ({ ...current, [name]: type === "checkbox" ? checked : value }));
    setFormError(null);
    if (errors[name]) {
      setErrors((current) => {
        const next = { ...current };
        delete next[name];
        return next;
      });
    }
  };

  const submit = async (event) => {
    event.preventDefault();
    setFormError(null);

    const found = validateOnboarding(form, address);
    if (Object.keys(found).length > 0) {
      setErrors(found);
      document.getElementById(Object.keys(found)[0])?.focus();
      return;
    }

    setSubmitting(true);
    try {
      await completeOnboarding(form);
      go("role-selection");
    } catch (caught) {
      const field = fieldForFirebaseError(caught);
      const message = messageForFirebaseError(caught);
      if (field && field !== "wallet") {
        setErrors((current) => ({ ...current, [field]: message }));
        document.getElementById(field)?.focus();
      } else {
        setFormError(message);
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      labelledBy="onboarding-title"
      describedBy="onboarding-description"
      onDismiss={cancelOnboarding}
      initialFocusRef={firstFieldRef}
    >
        <header className="modal-head">
          <span className="modal-badge" aria-hidden="true">✓</span>
          <div>
            <h2 id="onboarding-title">Wallet verified — finish setting up</h2>
            <p id="onboarding-description">
              <code>{shortenAddress(address)}</code> is verified and new to us. Tell us
              who you are and this wallet becomes your account.
            </p>
          </div>
        </header>

        {formError ? (
          <div className="notice notice-error" role="alert">
            <strong>We could not finish setting up your account</strong>
            <p>{formError}</p>
          </div>
        ) : null}

        <form onSubmit={submit} noValidate>
          <div className="modal-body">
            <Field label="Full name" htmlFor="fullName" error={errors.fullName}>
              {({ id, describedBy, invalid }) => (
                <input
                  id={id}
                  name="fullName"
                  ref={firstFieldRef}
                  value={form.fullName}
                  onChange={update}
                  autoComplete="name"
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  placeholder="Ada Lovelace"
                />
              )}
            </Field>

            <Field label="Organisation" htmlFor="organisation" error={errors.organisation}>
              {({ id, describedBy, invalid }) => (
                <input
                  id={id}
                  name="organisation"
                  value={form.organisation}
                  onChange={update}
                  autoComplete="organization"
                  aria-describedby={describedBy}
                  aria-invalid={invalid}
                  placeholder="Singapore Management University"
                />
              )}
            </Field>

            <label
              className={`consent${errors.acceptedTerms ? " field-invalid" : ""}`}
              htmlFor="acceptedTerms"
            >
              <input
                id="acceptedTerms"
                name="acceptedTerms"
                type="checkbox"
                checked={form.acceptedTerms}
                onChange={update}
                aria-invalid={Boolean(errors.acceptedTerms)}
              />
              <span>
                I accept the platform terms and understand that proposal hashes and
                evaluation outcomes are recorded publicly on Arbitrum Sepolia.
              </span>
            </label>
            {errors.acceptedTerms ? (
              <p className="field-error" role="alert">{errors.acceptedTerms}</p>
            ) : null}
          </div>

          <footer className="modal-actions">
            <button className="secondary" type="button" onClick={cancelOnboarding} disabled={submitting}>
              Cancel
            </button>
            <button className="primary" type="submit" disabled={submitting}>
              {submitting ? "Creating your account…" : "Create account"}
            </button>
          </footer>
      </form>
    </Modal>
  );
}
