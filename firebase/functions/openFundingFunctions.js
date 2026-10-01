import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getOpenFundingSummary, prepareOpenFundingAction, syncOpenFunding } from "./openFunding.js";
import { getFunderDashboard } from "./funderDashboard.js";

export function registerOpenFundingFunctions({ db, client, config, requireMember, options }) {
  const callable = service => onCall({ ...options, timeoutSeconds: 180 }, async request => {
    const uid = await requireMember(request);
    try { return await service({ db, client, config, uid, problemId: request.data?.problemId,
      proposalId: request.data?.proposalId, action: request.data?.action, amountBaseUnits: request.data?.amountBaseUnits,
      tokenAddress: request.data?.tokenAddress, transactionHash: request.data?.transactionHash }); }
    catch (error) {
      if (error instanceof HttpsError) throw error;
      throw new HttpsError("unavailable", "Confirmed funding information is temporarily unavailable. Try again shortly.");
    }
  });
  return { getOpenFundingSummary: callable(getOpenFundingSummary), prepareOpenFundingAction: callable(prepareOpenFundingAction),
    syncOpenFunding: callable(syncOpenFunding), getFunderDashboard: callable(getFunderDashboard) };
}
