import { MAIN_ESCROW_STATE } from "../config/workflowStatus.js";

function grantOfferLabel(offer) {
  if (offer?.status === "expired") return "Offer expired";
  if (offer?.declined === true) return "Offer declined by the researcher";
  switch (offer?.status) {
    case "none": return "Seeking a grant";
    case "pending": return "Awaiting researcher acceptance";
    case "accepted": return "Grant accepted";
    case "voided": return "Offer voided";
    default: return null;
  }
}

export function grantFundingLabel(offer) {
  const label = grantOfferLabel(offer);
  switch (offer?.escrowState) {
    case MAIN_ESCROW_STATE.CANCELLED:
    case MAIN_ESCROW_STATE.VOIDED:
      return offer.declined ? `Escrow cancelled · ${label}` : "Escrow cancelled";
    case MAIN_ESCROW_STATE.REFUNDED: return "Escrow refunded";
    case MAIN_ESCROW_STATE.EXPIRED: return "Escrow expired";
    default: return label;
  }
}
