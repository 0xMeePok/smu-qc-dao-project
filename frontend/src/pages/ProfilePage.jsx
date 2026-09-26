import { useEffect, useState } from "react";
import { Field } from "../components/Field.jsx";
import { useSession } from "../context/SessionContext.jsx";
import { roleLabel } from "../lib/roles.js";
import { shortenAddress } from "../lib/chain.js";
import { fieldForFirebaseError, messageForFirebaseError } from "../lib/errors.js";
import { validateProfile } from "../lib/validation.js";
import { ModerationNotifications } from "../components/ModerationNotifications.jsx";
import { OPEN_FUNDING_TYPE } from "../config/fundingOpportunity.js";
import { opportunityStatusLabel } from "../config/workflowStatus.js";
import { listOwnPostings } from "../lib/postings.js";
import { listProposals } from "../lib/proposals.js";
import { opportunityTypeLabel } from "../lib/opportunityPresentation.js";

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
  return roleLabel(role);
}

function formFromProfile(profile) {
  return {
    fullName: profile.fullName || "",
    organisation: profile.organisation || "",
    biography: profile.biography || "",
    expertise: Array.isArray(profile.expertise) ? profile.expertise : [],
  };
}

const PROFILE_TABS = [
  ["about", "About"],
  ["briefs", "My briefs"],
  ["proposals", "Proposals"],
];

function statusText(value) {
  const text = String(value || "").replace(/_/g, " ");
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : "";
}

// The owner's briefs and proposals, fetched only when their tab is first opened.
function useProfileList(tab, address) {
  const [lists, setLists] = useState({});
  useEffect(() => {
    if (!address || tab === "about" || lists[tab]) return undefined;
    let cancelled = false;
    setLists((current) => ({ ...current, [tab]: { loading: true, items: [] } }));
    const load = tab === "briefs"
      ? listOwnPostings(address).then((page) => page.items.map((posting) => ({
        id: posting.id,
        title: posting.title || "Untitled brief",
        sub: [opportunityTypeLabel(posting), `${Number(posting.proposalCount || 0)} ${Number(posting.proposalCount) === 1 ? "proposal" : "proposals"}`].join(" · "),
        status: opportunityStatusLabel(posting.status, { expiresAt: posting.expiresAt, matching: posting.matching }),
        route: posting.status === "draft"
          ? (posting.opportunityType === OPEN_FUNDING_TYPE ? `create-funding/${posting.id}` : `create/${posting.id}`)
          : `posting/${posting.id}`,
      })))
      : listProposals("researcherId", address).then((items) => items.map((proposal) => ({
        id: proposal.id,
        title: proposal.title || "Untitled proposal",
        sub: [proposal.currency && proposal.amount ? `${proposal.currency} ${Number(proposal.amount).toLocaleString()}` : "", formatDate(proposal.createdAt)].filter(Boolean).join(" · "),
        status: statusText(proposal.status),
        route: `proposal/${proposal.id}`,
      })));
    load
      .then((items) => { if (!cancelled) setLists((current) => ({ ...current, [tab]: { loading: false, items } })); })
      .catch((error) => { if (!cancelled) setLists((current) => ({ ...current, [tab]: { loading: false, items: [], error: messageForFirebaseError(error) } })); });
    return () => { cancelled = true; };
  }, [tab, address]);
  return lists[tab] ?? { loading: tab !== "about", items: [] };
}

function Chevron() {
  return (
    <svg className="settings-chevron" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true">
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

function navigateTo(route) {
  window.location.hash = `/${route}`;
}

export default function ProfilePage({ onNavigate = navigateTo }) {
  const { isSignedIn, isChecking, profile, address, saveProfile, signOut } = useSession();
  const [tab, setTab] = useState("about");
  const list = useProfileList(tab, address);
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

  const initial = (profile.fullName || "?").trim().charAt(0).toUpperCase();
  const emptyText = tab === "briefs" ? "No briefs yet. Publish one from New brief." : "No proposals yet.";

  return (
    <section className="page profile-page">
      <div className="profile-identity">
        <span className="profile-avatar profile-avatar-xl" aria-hidden="true">{initial}</span>
        <h1>{profile.fullName}</h1>
        <p>{formatRole(profile.role)}{profile.organisation ? ` · ${profile.organisation}` : ""}</p>
        <span className="profile-status">Verified wallet</span>
      </div>

      <ModerationNotifications userId={address} />

      <div className="profile-tabs">
        <div className="segmented" role="tablist" aria-label="Profile sections">
          {PROFILE_TABS.map(([value, label]) => (
            <button key={value} type="button" role="tab" id={`profile-tab-${value}`} aria-selected={tab === value}
              aria-controls="profile-tab-panel" className={tab === value ? "selected" : ""} onClick={() => setTab(value)}>
              {label}
            </button>
          ))}
        </div>
      </div>

      <div id="profile-tab-panel" role="tabpanel" aria-labelledby={`profile-tab-${tab}`} className="settings-group profile-tab-panel">
        {tab === "about" ? (
          <div className="profile-about">
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
          </div>
        ) : list.loading ? (
          <p className="settings-empty" role="status">Loading…</p>
        ) : list.error ? (
          <p className="settings-empty" role="alert">{list.error}</p>
        ) : list.items.length === 0 ? (
          <p className="settings-empty">{emptyText}</p>
        ) : list.items.map((item) => (
          <button key={item.id} type="button" className="settings-row settings-link" onClick={() => onNavigate(item.route)}>
            <span className="settings-row-main">
              <strong>{item.title}</strong>
              {item.sub && <small>{item.sub}</small>}
            </span>
            <span className="settings-row-value">{item.status}</span>
            <Chevron />
          </button>
        ))}
      </div>

      <div className="settings-heading">
        <h2>Account</h2>
        {!editing ? (
          <button className="text-button profile-edit-button" type="button" onClick={() => setEditing(true)}>
            Edit profile
          </button>
        ) : null}
      </div>
      {formError ? <div className="notice notice-error" role="alert"><p>{formError}</p></div> : null}
      {saved ? <div className="notice notice-success" role="status"><p>Profile updated.</p></div> : null}
      {editing ? (
        <form className="settings-group profile-form" onSubmit={submit} noValidate>
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
        <dl className="settings-group profile-details">
          <div className="settings-row"><dt>Name</dt><dd>{profile.fullName}</dd></div>
          <div className="settings-row"><dt>Organisation</dt><dd>{profile.organisation}</dd></div>
          <div className="settings-row"><dt>Role</dt><dd>{formatRole(profile.role)}</dd></div>
          <div className="settings-row"><dt>Connected wallet</dt><dd title={address}>{shortenAddress(address)}</dd></div>
          <div className="settings-row"><dt>Member since</dt><dd>{formatDate(profile.createdAt)}</dd></div>
          <div className="settings-row"><dt>UID</dt><dd className="profile-uid" title={profile.address}>{profile.address}</dd></div>
        </dl>
      )}

      <div className="settings-group">
        <button type="button" className="settings-row settings-signout" onClick={() => signOut()}>Sign out</button>
      </div>
    </section>
  );
}
