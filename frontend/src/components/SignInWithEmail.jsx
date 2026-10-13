import { useSession } from "../context/SessionContext.jsx";

/**
 * The header and login-page entry point. Opens Privy's own login modal, which
 * offers email and nothing else (see lib/privy.js).
 */
export function SignInWithEmail() {
  const { signIn, error, isBusy, isSigningOut } = useSession();

  return (
    <>
      <button className="primary signin-button" type="button" onClick={() => { void signIn(); }} disabled={isBusy || isSigningOut}>
        {isSigningOut ? "Signing out…" : isBusy ? "Signing in…" : "Sign in with email"}
      </button>
      {error ? <span className="signin-error" role="alert">{error}</span> : null}
    </>
  );
}
