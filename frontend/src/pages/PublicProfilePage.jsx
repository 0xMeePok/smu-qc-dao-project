import { useEffect, useState } from "react";
import { findPublicProfileByAddress } from "../lib/profile.js";
import { messageForFirebaseError } from "../lib/errors.js";
import { shortenAddress } from "../lib/chain.js";

function formatDate(value) {
  if (!value) return null;
  const date = typeof value?.toDate === "function" ? value.toDate() : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(date);
}

export default function PublicProfilePage({ address, onNavigate }) {
  const [profile, setProfile] = useState(null);
  const [state, setState] = useState("loading");
  const [error, setError] = useState(null);

  useEffect(() => {
    let active = true;
    setState("loading");
    setError(null);
    findPublicProfileByAddress(address)
      .then((found) => {
        if (!active) return;
        setProfile(found);
        setState(found ? "ready" : "missing");
      })
      .catch((caught) => {
        if (!active) return;
        setError(messageForFirebaseError(caught));
        setState("error");
      });
    return () => { active = false; };
  }, [address]);

  if (state === "loading") {
    return <section className="page empty"><p className="lead">Loading profile…</p></section>;
  }

  if (state === "error") {
    return (
      <section className="page empty">
        <span className="http-status">Profile unavailable</span>
        <h1>We could not load this profile.</h1>
        <p>{error}</p>
        <button className="secondary" type="button" onClick={() => onNavigate("discover")}>Back to opportunities</button>
      </section>
    );
  }

  if (state === "missing") {
    return (
      <section className="page empty">
        <span className="http-status">Profile not found</span>
        <h1>This public profile is not available.</h1>
        <p>The profile may have been removed or the address may be incorrect.</p>
        <button className="secondary" type="button" onClick={() => onNavigate("discover")}>Back to opportunities</button>
      </section>
    );
  }

  return (
    <section className="page profile-page public-profile-page">
      <button className="back" type="button" onClick={() => onNavigate("discover")}>Back to opportunities</button>
      <div className="page-heading">
        <span className="eyebrow">Public profile</span>
        <h1>{profile.fullName}</h1>
        <p>{profile.organisation}</p>
      </div>
      <div className="profile-layout">
        <article className="profile-card profile-summary-card">
          <div className="profile-avatar" aria-hidden="true">{profile.fullName.trim().charAt(0).toUpperCase()}</div>
          <div>
            <h2>{profile.fullName}</h2>
            <p>{profile.organisation}</p>
          </div>
          <span className="profile-status">Verified wallet: {shortenAddress(profile.address)}</span>
        </article>
        <article className="profile-card profile-bio-card">
          <span className="eyebrow">About</span>
          <h2>Biography and expertise</h2>
          <div className="profile-readonly-field">
            <span>Short biography</span>
            <p>{profile.biography || "No biography added yet."}</p>
          </div>
          <div className="profile-readonly-field">
            <span>Areas of expertise</span>
            {profile.expertise.length ? (
              <div className="profile-expertise-list">
                {profile.expertise.map((item) => <span key={item}>{item}</span>)}
              </div>
            ) : <p>No areas of expertise added yet.</p>}
          </div>
          {formatDate(profile.createdAt) ? (
            <div className="profile-readonly-field">
              <span>Member since</span>
              <p>{formatDate(profile.createdAt)}</p>
            </div>
          ) : null}
        </article>
      </div>
    </section>
  );
}