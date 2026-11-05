import { onCall } from "firebase-functions/v2/https";
import { persistDeliveryEvidence } from "./deliveryEvidence.js";

export function registerDeliveryEvidenceFunctions({ db, requireMember, options }) {
  return { saveDeliveryEvidence: onCall(options, async request => {
    const uid = await requireMember(request);
    // The client cannot choose an evidence namespace or impersonate an owner.
    return persistDeliveryEvidence({ db, uid, authTime: request.auth.token.auth_time ?? 0,
      proposalId: request.data?.proposalId, evidence: request.data?.evidence, evidenceHash: request.data?.evidenceHash });
  }) };
}
