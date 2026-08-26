import { useEffect } from "react";
import { useSession } from "../context/SessionContext.jsx";
import { isAdmin } from "../lib/roles.js";
import { go } from "../lib/router.js";
import { shortenAddress } from "../lib/chain.js";

/**
 * Only ever rendered for an account whose Firestore profile has role == 1 - see the
 * guard below and firebase/firestore.rules, which is what actually makes that value
 * trustworthy (fixed to 0 on create, immutable after, for every non-admin client).
 * This page itself is just a shell for now: no admin tooling exists yet.
 */
export default function AdminPage() {
  const { isSignedIn, isChecking, profile, address } = useSession();

  useEffect(() => {
    if (!isChecking && (!isSignedIn || !isAdmin(profile?.role))) go("home");
  }, [isChecking, isSignedIn, profile?.role]);

  if (isChecking) {
    return (
      <section className="page empty">
        <p className="lead">Checking your wallet…</p>
      </section>
    );
  }

  if (!isSignedIn || !isAdmin(profile?.role)) return null;

  return (
    <section className="page create-page">
      <div className="page-heading">
        <h1>Admin</h1>
        <p>
          Signed in as {profile?.fullName ?? "an administrator"} ({shortenAddress(address)}).
        </p>
      </div>
      <div className="notice">
        <strong>Nothing to manage yet</strong>
        <p>
          No admin tools are built yet — this page exists so the route and access
          check are in place before content moderation, user management, or other
          admin features land.
        </p>
      </div>
    </section>
  );
}
