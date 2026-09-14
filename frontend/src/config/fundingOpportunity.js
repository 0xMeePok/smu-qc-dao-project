import { categoryLabel } from "./postingCategories.js";

export const OPEN_FUNDING_TYPE = "open-funding";
export const MAX_FUNDING_TAGS = 8;
export const MAX_FUNDING_TAG_LENGTH = 40;

/**
 * Normalise stored tag arrays (and older comma-separated inputs) so discovery and
 * audit payloads use one stable representation. The first occurrence keeps its
 * display casing.
 */
export { parseFundingTags } from "../../../firebase/functions/opportunityAuditPayload.js";
import { parseFundingTags } from "../../../firebase/functions/opportunityAuditPayload.js";

/**
 * QCDAO-51 discovery tags come from the selected technology areas. Keeping this
 * mapping deterministic avoids asking funders to describe the same classification
 * twice and ensures the preview, Firestore record and on-chain audit agree.
 */
export function fundingTagsFromCategories(categories = []) {
  return parseFundingTags(categories.map(categoryLabel));
}
