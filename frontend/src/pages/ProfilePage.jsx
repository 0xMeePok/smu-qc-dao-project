import { useEffect, useState } from "react";
import { Field } from "../components/Field.jsx";
import { useSession } from "../context/SessionContext.jsx";
import { ROLE_LABELS } from "../config/roles.js";
import { shortenAddress } from "../lib/chain.js";
import { fieldForFirebaseError, messageForFirebaseError } from "../lib/errors.js";
import { validateProfile } from "../lib/validation.js";

function formatDate(value) {
  if (!value) return "Not available";
  const date = typeof value?.toDate === "function" ? value.toDate() : new Date(value);
  if (Number.isNaN(date.getTime())) return "Not available";
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(date);
}

function formatRole(role) {
  return role === 1 ? ROLE_LABELS.admin : ROLE_LABELS.owner;
}

function formFromProfile(profile) {
  return {
    fullName: profile.fullName || "",
    organisation: profile.organisation || "",
    biography: profile.biography || "",
    expertise: Array.isArray(profile.expertise) ? profile.expertise : [],
  };
}

export default function ProfilePage() {
  const { isSignedIn, isChecking, profile, address, saveProfile } = useSession();
  const [editing, setEditing] = useState(false);
  const [form, setForm] = useState(() => formFromProfile(profile || {}));
  const [errors, setErrors] = useState({});
  const [formError, setFormError] = useState(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (profile) setForm(formFromProfile(profile));
  }, [profile]);

  if (isChecking || !isSignedIn || !profile) {
    return (
      <section className="page empty">
        <p className="lead">Loading your profile…</p>
      </section>
    );
  }

  const update = (event) => {
    const { name, value } = event.target;
    setForm((current) => ({ ...current, [name]: value }));
    setSaved(false);
    setFormError(null);
    if (errors[name]) setErrors((current) => ({ ...current, [name]: undefined }));
  };

  const updateExpertise = (event) => {
    setForm((current) => ({
      ...current,
      expertise: event.target.value.split(",").map((item) => item.trim()).filter(Boolean),
    }));
    setSaved(false);
    setFormError(null);
    if (errors.expertise) setErrors((current) => ({ ...current, expertise: undefined }));
  };

  const cancelEdit = () => {
    setForm(formFromProfile(profile));
    setErrors({});
    setFormError(null);
    setEditing(false);
  };

  const submit = async (event) => {
    event.preventDefault();
    setFormError(null);
    const found = validateProfile(form, address);
    if (Object.keys(found).length > 0) {
      setErrors(found);
      const firstField = Object.keys(found)[0];
      if (firstField !== "wallet") document.getElementById(firstField)?.focus();
      return;
    }

    setSaving(true);
    try {
      await saveProfile(form);
      setErrors({});
      setSaved(true);
      setEditing(false);
    } catch (caught) {
      const field = fieldForFirebaseError(caught);
      const message = messageForFirebaseError(caught);
      if (field && field !== "wallet") setErrors((current) => ({ ...current, [field]: message }));
      else setFormError(message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="page profile-page">
      <div className="page-heading">
        <span className="eyebrow">Account</span>
        <h1>Your profile</h1>
        <p>Keep the details stakeholders use to understand your work and expertise up to date.</p>
      </div>

      <div className="profile-layout">
        <article className="profile-card profile-summary-card">
          <div className="profile-avatar" aria-hidden="true">
            {(profile.fullName || "?").trim().charAt(0).toUpperCase()}
          </div>
          <div>
            <h2>{profile.fullName}</h2>
            <p>{profile.organisation}</p>
          </div>
          <span className="profile-status">Verified wallet</span>
        </article>

        <article className="profile-card">
          <div className="profile-card-heading">
            <div>
              <span className="eyebrow">Identity</span>
              <h2>Account details</h2>
            </div>
            {!editing ? (
              <button className="secondary profile-edit-button" type="button" onClick={() => setEditing(true)}>
                Edit profile
              </button>
            ) : null}
          </div>
          {formError ? <div className="notice notice-error" role="alert"><p>{formError}</p></div> : null}
          {saved ? <div className="notice notice-success" role="status"><p>Profile updated.</p></div> : null}
          {editing ? (
            <form className="profile-form" onSubmit={submit} noValidate>
              <Field label="Name" htmlFor="fullName" error={errors.fullName}>
                {({ id, describedBy, invalid }) => (
                  <input id={id} name="fullName" value={form.fullName} onChange={update} aria-describedby={describedBy} aria-invalid={invalid} />
                )}
              </Field>
              <Field label="Organisation" htmlFor="organisation" error={errors.organisation}>
                {({ id, describedBy, invalid }) => (
                  <input id={id} name="organisation" value={form.organisation} onChange={update} aria-describedby={describedBy} aria-invalid={invalid} />
                )}
              </Field>
              <Field label="Short biography" htmlFor="biography" error={errors.biography} hint="Up to 500 characters.">
                {({ id, describedBy, invalid }) => (
                  <textarea id={id} name="biography" value={form.biography} onChange={update} rows="4" aria-describedby={describedBy} aria-invalid={invalid} />
                )}
              </Field>
              <Field label="Areas of expertise" htmlFor="expertise" error={errors.expertise} hint="Separate areas with commas.">
                {({ id, describedBy, invalid }) => (
                  <input id={id} name="expertise" value={form.expertise.join(", ")} onChange={updateExpertise} aria-describedby={describedBy} aria-invalid={invalid} />
                )}
              </Field>
              <div className="profile-form-actions">
                <button className="secondary" type="button" onClick={cancelEdit} disabled={saving}>Cancel</button>
                <button className="primary" type="submit" disabled={saving}>{saving ? "Saving…" : "Save changes"}</button>
              </div>
            </form>
          ) : (
          <dl className="profile-details">
            <div>
              <dt>Name</dt>
              <dd>{profile.fullName}</dd>
            </div>
            <div>
              <dt>Organisation</dt>
              <dd>{profile.organisation}</dd>
            </div>
            <div>
              <dt>Role</dt>
              <dd>{formatRole(profile.role)}</dd>
            </div>
            <div>
              <dt>Connected wallet</dt>
              <dd title={address}>{shortenAddress(address)}</dd>
            </div>
            <div>
              <dt>Member since</dt>
              <dd>{formatDate(profile.createdAt)}</dd>
            </div>
            <div>
              <dt>UID</dt>
              <dd className="profile-uid" title={profile.address}>{profile.address}</dd>
            </div>
          </dl>
          )}
        </article>

        <article className="profile-card profile-bio-card">
          <span className="eyebrow">About you</span>
          <h2>Biography and expertise</h2>
          <div className="profile-readonly-field">
            <span>Short biography</span>
            <p>{profile.biography || "No biography added yet."}</p>
          </div>
          <div className="profile-readonly-field">
            <span>Areas of expertise</span>
            {profile.expertise?.length ? (
              <div className="profile-expertise-list">
                {profile.expertise.map((item) => <span key={item}>{item}</span>)}
              </div>
            ) : (
              <p>No areas of expertise added yet.</p>
            )}
          </div>
        </article>
      </div>
    </section>
  );
}