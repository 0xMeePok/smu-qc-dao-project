const OPEN_FUNDING_TYPE = "open-funding";
const trimmed = (value) => String(value ?? "").trim();
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

export function postingAuditPayload(posting) {
  return {
    ownerId: trimmed(posting.ownerId).toLowerCase(),
    organisation: trimmed(posting.organisation),
    title: trimmed(posting.title),
    businessContext: trimmed(posting.businessContext),
    summary: trimmed(posting.summary),
    currentApproach: trimmed(posting.currentApproach),
    currentLimitations: trimmed(posting.currentLimitations),
    expectedOutcome: trimmed(posting.expectedOutcome),
    successCriteria: trimmed(posting.successCriteria),
    dataAvailability: trimmed(posting.dataAvailability),
    categories: [...(posting.categories ?? [])].map(trimmed).sort(),
    amount: Number(posting.amount),
    currency: trimmed(posting.currency),
    expiresAt: posting.expiresAt,
    attachments: [...(posting.attachments ?? [])]
      .map((item) => ({
        id: trimmed(item.id),
        name: trimmed(item.name),
        size: Number(item.size),
        contentType: trimmed(item.contentType || "application/pdf"),
      }))
      .sort((left, right) => left.id.localeCompare(right.id)),
  };
}

export function fundingOpportunityAuditPayload(opportunity) {
  const attachments = [...(opportunity.attachments ?? [])]
    .map((item) => ({
      id: trimmed(item.id),
      name: trimmed(item.name),
      size: Number(item.size),
      contentType: trimmed(item.contentType || "application/pdf"),
    }))
    .sort((left, right) => left.id.localeCompare(right.id));
  return {
    opportunityType: OPEN_FUNDING_TYPE,
    ownerId: trimmed(opportunity.ownerId).toLowerCase(),
    organisation: trimmed(opportunity.organisation),
    title: trimmed(opportunity.title),
    fundingThesis: trimmed(opportunity.fundingThesis),
    eligibilityNotes: trimmed(opportunity.eligibilityNotes),
    categories: [...(opportunity.categories ?? [])].map(trimmed).sort(),
    tags: parseFundingTags(opportunity.tags).sort(),
    amount: Number(opportunity.amount),
    currency: trimmed(opportunity.currency),
    expiresAt: opportunity.expiresAt,
    ...(attachments.length > 0 ? { attachments } : {}),
  };
}
