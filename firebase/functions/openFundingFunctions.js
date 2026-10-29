import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getOpenFundingSummary, prepareOpenFundingAction, syncOpenFunding } from "./openFunding.js";
import { getFunderDashboard } from "./funderDashboard.js";

// prepareOpenFundingAction runs immediately before an owner's grant signature,
// so the grant panel pings it awake through `warmable` once the wallet is
// ready. That costs one short request; a minimum instance costs a full day of
// idle time whether or not anyone opens the panel.
export function registerOpenFundingFunctions({ db, client, config, requireMember, options }) {
  const callable = (service, { warmable = false, ...extra } = {}) => onCall({ ...options, timeoutSeconds: 180, ...extra }, async request => {
    // A signed-in panel may wake this instance before the owner clicks. The
    // ping reads no member data and returns nothing; App Check still applies.
    if (warmable && request.data?.warmup === true) {
      if (!/^0x[0-9a-f]{40}$/.test(request.auth?.uid ?? "")) throw new HttpsError("unauthenticated", "Sign in with your email.");
      try { await client.getChainId(); } catch { /* The real request reports RPC failures. */ }
      return { warm: true };
    }
    const uid = await requireMember(request);
    try { return await service({ db, client, config, uid, problemId: request.data?.problemId,
      proposalId: request.data?.proposalId, action: request.data?.action, amountBaseUnits: request.data?.amountBaseUnits,
      tokenAddress: request.data?.tokenAddress, transactionHash: request.data?.transactionHash,
      reason: request.data?.reason, reasonHash: request.data?.reasonHash }); }
    catch (error) {
      if (error instanceof HttpsError) throw error;
      throw new HttpsError("unavailable", "Confirmed funding information is temporarily unavailable. Try again shortly.");
    }
  });
  return { getOpenFundingSummary: callable(getOpenFundingSummary), prepareOpenFundingAction: callable(prepareOpenFundingAction, { warmable: true }),
    syncOpenFunding: callable(syncOpenFunding), getFunderDashboard: callable(getFunderDashboard) };
}
