import { onCall, HttpsError } from "firebase-functions/v2/https";
import { getIndependentFundingState, prepareIndependentFundingAction, syncIndependentFunding } from "./independentFunding.js";

/** The independent factory shares the existing signer and durable nonce outbox. */
export function registerIndependentFundingFunctions({ db, client, config, requireMember, options, region }) {
  const shared = { db, client, config };
  const callable = service => onCall({ ...options, timeoutSeconds: 180 }, async request => {
    const uid = await requireMember(request);
    const { proposalId, action, amount, evidence, evidenceHash, approve, reason, reasonHash, transactionHash } = request.data ?? {};
    try { return await service({ ...shared, uid, proposalId, action, amount, evidence,
      evidenceHash, approve, reason, reasonHash, transactionHash }); }
    catch (error) {
      if (error instanceof HttpsError) throw error;
      throw new HttpsError("unavailable", "Independent funding confirmation is temporarily unavailable. Retry the same transaction shortly.");
    }
  });
  return {
    getIndependentFundingState: callable(getIndependentFundingState),
    prepareIndependentFundingAction: callable(prepareIndependentFundingAction),
    syncIndependentFunding: callable(syncIndependentFunding),
  };
}
