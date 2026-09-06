import { categoryLabel } from "./postingCategories.js";

export const OPEN_FUNDING_TYPE = "open-funding";
export const MAX_FUNDING_TAGS = 8;
export const MAX_FUNDING_TAG_LENGTH = 40;

/**
 * Normalise stored tag arrays (and older comma-separated inputs) so discovery and
 * audit payloads use one stable representation. The first occurrence keeps its
 * display casing.
 */
export function parseFundingTags(value = "") {
  const source = Array.isArray(value) ? value : String(value).split(",");
  const seen = new Set();
  const tags = [];

  for (const item of source) {
    const tag = String(item ?? "").normalize("NFC").trim().replace(/\s+/g, " ");
    const key = tag.toLowerCase();
    if (!tag || seen.has(key)) continue;
    seen.add(key);
    tags.push(tag);
  }

  return tags;
}

/**
 * QCDAO-51 discovery tags come from the selected technology areas. Keeping this
 * mapping deterministic avoids asking funders to describe the same classification
 * twice and ensures the preview, Firestore record and on-chain audit agree.
 */
export function fundingTagsFromCategories(categories = []) {
  return parseFundingTags(categories.map(categoryLabel));
}
