import { getAuth } from "firebase-admin/auth";

/** A Firebase ID token for an address, without a Privy round trip. Emulator only. */
export async function idTokenForAddress(address) {
  const uid = address.toLowerCase();
  const customToken = await getAuth().createCustomToken(uid, { wallet: uid, chainId: 421614 });
  const response = await fetch(
    "http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signInWithCustomToken?key=fake-api-key",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: customToken, returnSecureToken: true }),
    },
  );
  const data = await response.json();
  if (!data.idToken) throw new Error("Auth emulator did not return an ID token");
  return data.idToken;
}
