import { AI_FIELD_CONFIG } from "./aiDraftSchema.js";

/**
 * Server-side, conservative quantity gate for generated narrative text.
 *
 * Author input is deliberately NOT a bag of facts that can authorize model
 * quantities: an unrelated numeral, negated example, assistant turn, or retrieved
 * snippet must never ground a new claim. Even repeated author quantities are
 * withheld from suggestions; the original author fields are never touched.
 *
 * This lexical gate is not a general fact checker. It catches numeric forms,
 * English cardinal counts/multipliers, and common explicit calendar expressions.
 * Narrow technical names and structural list/phase labels are not quantities.
 */
const DASHES = /[\u2010-\u2015\u2212\ufe58\ufe63\uff0d]/g;
const NUMBER_WORDS = /\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|hundreds|thousand|thousands|million|millions|billion|billions|trillion|trillions|dozen|dozens|single|pair|couple|half|halves|quarter|quarters|once|twice|thrice|double|doubled|triple|tripled|quadruple|twofold|threefold|fourfold)\b/iu;
const MONTHS = "january|february|march|april|may|june|july|august|september|october|november|december";
const MULTIPLIER = /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|hundred|thousand)fold\b/iu;
const UNAMBIGUOUS_MONTHS = /\b(?:january|february|april|june|july|august|september|october|november|december)\b/iu;
const IMPLICIT_DURATION = /\b(?:within|after|before|in|for|over|every)\s+(?:a|an)\s+(?:second|minute|hour|day|week|month|year)\b/iu;
const WEEKDAYS = "monday|tuesday|wednesday|thursday|friday|saturday|sunday";
const ORDINALS = "first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth|eleventh|twelfth|thirteenth|fourteenth|fifteenth|sixteenth|seventeenth|eighteenth|nineteenth|twentieth|thirtieth";
const CALENDAR = new RegExp(`\\b(?:(?:by|before|after|until|on|in|during|from|starting|beginning|ending)\\s+(?:(?:the|next|this|coming)\\s+)*(?:${MONTHS}|${WEEKDAYS})|(?:next|this|coming)\\s+(?:${WEEKDAYS}|week|month|year)|today|tomorrow|yesterday|(?:${ORDINALS})\\s+(?:of\\s+)?(?:${MONTHS}))\\b`, "iu");
// Explicit, bounded identifier patterns, not arbitrary alphanumeric strings.
// A model can mention 2-opt or GPT-5 without claiming a workload count or target.
const TECHNICAL_IDENTIFIER = /(?<![\p{L}\p{N}])(?:gpt-\d{1,2}(?:\.\d{1,2})?(?:-(?:mini|nano|pro))?|[23]-opt|[23]-sat|sha-(?:1|224|256|384|512)|aes-(?:128|192|256)|rsa-(?:1024|2048|3072|4096)|utf-(?:8|16|32)|(?:tls|http)[ /-]?\d(?:\.\d)?|ipv[46]|(?:iso|iec|rfc|erc|eip)[ -]?\d{1,6}|web3|covid-19|(?:zero|one|few)-shot|one-hot|two-phase commit)(?![\p{L}\p{N}])/giu;
const STRUCTURAL_LABEL = /^([\t ]*(?:[-*][\t ]+|#{1,6}[\t ]+)?(?:\*\*|__)?)((?:\d{1,2}[.)]|\(\d{1,2}\))(?=[\t ])|(?:phase|step|stage|milestone|work package)[\t ]+(?:\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)[\t ]*[:.)-](?=[\t ]|[*_]|$))/gimu;
const INLINE_LIST_LABEL = /([;.][\t ]+)(\d{1,2}[.)])(?=[\t ])/gu;
const PHASE_LABEL = /(?<![\p{L}\p{N}])(?:phase|step|stage|milestone|work package)[\t ]+(?:\d{1,2}|one|two|three|four|five|six|seven|eight|nine|ten)[\t ]*[:.)-](?=[\t ]|[*_]|$)/giu;
const erase = text => " ".repeat(text.length);

export function hasAIDraftQuantityClaim(value) {
  if (typeof value !== "string" || !value) return false;
  // Schema validation caps each field at 4,000 characters before this gate.
  const normalized = value.normalize("NFKC").replace(DASHES, "-");
  const narrative = normalized.replace(STRUCTURAL_LABEL, (_match, prefix, label) => prefix + erase(label))
    .replace(INLINE_LIST_LABEL, (_match, prefix, label) => prefix + erase(label))
    .replace(PHASE_LABEL, erase)
    .replace(TECHNICAL_IDENTIFIER, erase);
  return /\p{N}/u.test(narrative) || NUMBER_WORDS.test(narrative) || MULTIPLIER.test(narrative) || CALENDAR.test(narrative) || UNAMBIGUOUS_MONTHS.test(narrative) || IMPLICIT_DURATION.test(narrative);
}

export function applyAIDraftQuantityPolicy(output, kind) {
  const fields = new Map((AI_FIELD_CONFIG[kind] ?? []).map(field => [field.key, field]));
  const omitted = [];
  const suggestions = Object.fromEntries(Object.entries(output.suggestions).filter(([key, value]) => {
    if (fields.get(key)?.type !== "text" || !hasAIDraftQuantityClaim(value)) return true;
    omitted.push(fields.get(key).label);
    return false;
  }));
  let message = output.message;
  if (omitted.length) {
    message = `I left out suggestions for ${omitted.join(", ")} because they contained quantities, numerical targets, or dates that you need to enter yourself. ${Object.keys(suggestions).length ? "Other suggestions are still available to review." : "Describe the field qualitatively or enter these details yourself."} Your existing form text has not changed.`;
  } else if (hasAIDraftQuantityClaim(message)) {
    message = "I can help draft qualitative text. Please enter quantities, numerical targets, and dates yourself. Review any available suggestions before applying them; your existing form text has not changed.";
  }
  return { ...output, message, suggestions };
}
