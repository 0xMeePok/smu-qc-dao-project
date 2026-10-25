import { useSession } from "../context/SessionContext.jsx";

/**
 * The header and login-page entry point. Opens Privy's own login modal, which
 * offers email and nothing else (see lib/privy.js).
 */
export function SignInWithEmail({ label = "Sign in with email" }) {
  const { signIn, error, signOutReason, isBusy, isSigningOut } = useSession();

  return (
    <>
      <button className="primary signin-button" type="button" data-closes-menu onClick={() => { void signIn(); }} disabled={isBusy || isSigningOut}>
        {isSigningOut ? "Signing out…" : isBusy ? "Signing in…" : label}
      </button>
      {error && signOutReason !== "idle" ? <span className="signin-error" role="alert">{error}</span> : null}
    </>
  );
}
