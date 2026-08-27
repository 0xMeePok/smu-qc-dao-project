import { useSession } from "../context/SessionContext.jsx";
import { ROLE_LABELS } from "../config/roles.js";
import { shortenAddress } from "../lib/chain.js";

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

export default function ProfilePage() {
  const { isSignedIn, isChecking, profile, address } = useSession();

  if (isChecking || !isSignedIn || !profile) {
    return (
      <section className="page empty">
        <p className="lead">Loading your profile…</p>
      </section>
    );
  }

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
          </div>
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
        </article>

        <article className="profile-card profile-bio-card">
          <span className="eyebrow">About you</span>
          <h2>Biography and expertise</h2>
          <div className="profile-readonly-field">
            <span>Short biography</span>
            <p>{profile.biography || "Add a short introduction when profile editing is available."}</p>
          </div>
          <div className="profile-readonly-field">
            <span>Areas of expertise</span>
            {profile.expertise?.length ? (
              <div className="profile-expertise-list">
                {profile.expertise.map((item) => <span key={item}>{item}</span>)}
              </div>
            ) : (
              <p>Add the areas where you can contribute most effectively.</p>
            )}
          </div>
        </article>
      </div>
    </section>
  );
}