import { HttpsError } from "firebase-functions/v2/https";

// The SIWE `domain` field binds a signature to ONE site. Its whole purpose is to
// make a signature collected on one origin useless on another.
// Now the domain is server-controlled: an Origin is only honoured when it appears on
// an allow-list this deployment owns, and anything else is refused outright.
const SIWE_DOMAIN_FALLBACK = "smu-qc-dao";

// Dev origins are allowed ONLY under the emulator. Allow-listing localhost in
// production would reopen the hole: an attacker would forge `Origin:
// localhost:5173` and be handed a signable message again.
const DEV_HOSTS = ["localhost:5173", "127.0.0.1:5173"];

function emulatorActive(env = process.env) {
  return env.FUNCTIONS_EMULATOR === "true";
}

// Cloud Functions sets GCLOUD_PROJECT; Firebase Hosting always provisions
// <project>.web.app and <project>.firebaseapp.com. Deriving them means the common
// deployment needs no configuration and still keeps the message accurate for real
// users, instead of a hardcoded guess that rots the moment the project is renamed.
function defaultAllowedHosts(env = process.env) {
  const projectId = (env.GCLOUD_PROJECT || env.GCP_PROJECT || "").trim();
  return projectId ? [`${projectId}.web.app`, `${projectId}.firebaseapp.com`] : [];
}

function canonicalDomain(env = process.env) {
  return (env.SIWE_DOMAIN || "").trim().toLowerCase()
    || defaultAllowedHosts(env)[0]
    || SIWE_DOMAIN_FALLBACK;
}

function allowedHosts(env = process.env) {
  const configured = (env.SIWE_ALLOWED_HOSTS || "")
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);

  const hosts = [canonicalDomain(env), ...defaultAllowedHosts(env), ...configured];
  if (emulatorActive(env)) hosts.push(...DEV_HOSTS);

  return new Set(hosts.filter(Boolean));
}

export function resolveDomain(request, env = process.env) {
  const origin = request.rawRequest?.headers?.origin;

  // Production nonce issuance is browser-only. Missing Origin is not evidence of a
  // trusted server flow, so fail closed unless the emulator is running.
  if (!origin) {
    if (emulatorActive(env)) return canonicalDomain(env);
    throw new HttpsError("permission-denied", "Sign-in requires an approved browser origin.");
  }

  let parsedOrigin;
  try {
    parsedOrigin = new URL(origin);
  } catch {
    throw new HttpsError("permission-denied", "Sign-in is not available from this origin.");
  }
  const host = parsedOrigin.host.toLowerCase();
  const emulatorDevOrigin = emulatorActive(env)
    && parsedOrigin.protocol === "http:"
    && DEV_HOSTS.includes(host);
  if (parsedOrigin.protocol !== "https:" && !emulatorDevOrigin) {
    throw new HttpsError("permission-denied", "Sign-in requires a secure approved origin.");
  }

  // Fails CLOSED. An unrecognised Origin is a positive signal that a browser on a
  // site we do not serve is asking for a signable message, so it is refused rather
  // than quietly downgraded. Note this is deliberately NOT the shape of a check
  // that skips itself when the env var is unset - a security control that does
  // nothing until someone remembers to configure it is one that will be forgotten
  // exactly once, in production.
  // Preview channels are accepted only when their complete generated host appears
  // in SIWE_ALLOWED_HOSTS. A hostname pattern cannot prove Firebase project ownership.
  if (!allowedHosts(env).has(host)) {
    throw new HttpsError("permission-denied", "Sign-in is not available from this origin.");
  }

  return host;
}
