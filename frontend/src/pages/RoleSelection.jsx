import { useEffect, useState } from "react";
import { useSession } from "../context/SessionContext.jsx";
import { roleLabel, roles } from "../lib/roles.js";
import { go } from "../lib/router.js";
import { updateRole } from "../lib/profile.js";
import { messageForFirebaseError } from "../lib/errors.js";
import { statLabels, withDefaults } from "../lib/stats.js";
import { validateRole } from "../lib/validation.js";

export default function RoleSelection() {
  const { profile, address, isSignedIn, isChecking, needsOnboarding, applyProfilePatch } = useSession();
  const [selected, setSelected] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (profile?.role) setSelected(profile.role);
  }, [profile?.role]);

  // This screen is only reachable with a signed-in wallet. The modal handles the
  // needs-onboarding case on top of whatever page is underneath.
  useEffect(() => {
    if (!isChecking && !isSignedIn && !needsOnboarding) go("home");
  }, [isChecking, isSignedIn, needsOnboarding]);

  if (isChecking) {
    return (
      <section className="page empty">
        <p className="lead">Checking your wallet…</p>
      </section>
    );
  }

  if (!isSignedIn) return null;

  const confirm = async () => {
    const roleError = validateRole(selected);
    if (roleError) {
      setError(roleError);
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await updateRole({ address, role: selected });
      applyProfilePatch({ role: selected, onboardingComplete: true });
      go("home");
    } catch (caught) {
      setError(messageForFirebaseError(caught));
    } finally {
      setSaving(false);
    }
  };

  const stats = withDefaults(profile?.stats);

  return (
    <section className="page create-page">
      <div className="page-heading">
        <h1>Welcome{profile?.fullName ? `, ${profile.fullName.split(" ")[0]}` : ""}</h1>
        <p>
          Your wallet is now your account. Confirm how you want to take part — this
          decides which parts of the platform you see.
        </p>
      </div>

      {error ? (
        <div className="notice notice-error" role="alert">
          <strong>We could not save your role</strong>
          <p>{error}</p>
        </div>
      ) : null}

      <fieldset className="role-picker role-picker-wide">
        <legend className="visually-hidden">Choose your role</legend>
        {roles.map((option) => (
          <label className={selected === option.value ? "chosen" : ""} key={option.value}>
            <input
              type="radio"
              name="selectedRole"
              value={option.value}
              checked={selected === option.value}
              onChange={(event) => {
                setSelected(event.target.value);
                setError(null);
              }}
            />
            <strong>{option.label}</strong>
            <span>{option.note}</span>
          </label>
        ))}
      </fieldset>

      <div className="stats-strip">
        <span className="eyebrow">Your contribution record</span>
        <dl>
          {Object.entries(statLabels).map(([key, label]) => (
            <div key={key}>
              <dt>{label}</dt>
              <dd>{stats[key]}</dd>
            </div>
          ))}
        </dl>
      </div>

      <div className="form-actions">
        <p>{selected ? `Continuing as ${roleLabel(selected)}.` : "Nothing selected yet."}</p>
        <button className="primary" type="button" onClick={confirm} disabled={saving}>
          {saving ? "Saving…" : "Continue"}
        </button>
      </div>
    </section>
  );
}
