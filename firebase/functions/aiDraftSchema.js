/** QCDAO-157 browser-safe contract. No secrets, SDKs, or mutable provider config. */
export const AI_POSTING_CATEGORIES = Object.freeze([
  { value: "ai", label: "AI & machine learning" }, { value: "quantum", label: "Quantum" },
  { value: "web3", label: "Web3 & blockchain" }, { value: "robotics", label: "Robotics" },
  { value: "iot", label: "IoT & sensors" }, { value: "data", label: "Data & analytics" },
  { value: "security", label: "Security & cryptography" }, { value: "cloud", label: "Cloud & infrastructure" },
  { value: "simulation", label: "Simulation & modelling" }, { value: "optimisation", label: "Optimisation" },
  { value: "sustainability", label: "Sustainability" }, { value: "other", label: "Other" },
]);
export const AI_PROPOSAL_CATEGORIES = Object.freeze([
  { value: "gate-model", label: "Gate-based quantum computing" },
  { value: "quantum-inspired", label: "Quantum-inspired approaches" },
  { value: "quantum-annealing", label: "Quantum annealing" },
  { value: "hybrid", label: "Hybrid quantum / classical" },
  { value: "quantum-adjacent", label: "Other quantum-adjacent approach" },
]);
export const AI_TAGS = Object.freeze([...AI_POSTING_CATEGORIES, ...AI_PROPOSAL_CATEGORIES].map(item => item.label));
const text = (key, label) => Object.freeze({ key, label, type: "text", maxLength: 4000 });
const categories = Object.freeze({ key: "categories", label: "Technology areas", type: "categories", maxLength: 6 });
const category = Object.freeze({ key: "category", label: "Quantum category", type: "category", maxLength: 64 });
export const AI_FIELD_CONFIG = Object.freeze({
  problem: Object.freeze([
    text("businessContext", "Business context"), text("summary", "Problem description"),
    text("currentApproach", "Current approach"), text("currentLimitations", "Current limitations"),
    text("expectedOutcome", "Expected outcome"), text("successCriteria", "Success criteria"),
    text("dataAvailability", "Relevant data availability"), categories,
  ]),
  "open-funding": Object.freeze([text("fundingThesis", "Funding thesis"), text("eligibilityNotes", "Eligibility notes"), categories]),
  proposal: Object.freeze([
    text("summary", "Approach summary"), text("methodology", "Technical methodology"),
    text("suitability", "Why this approach suits the problem"), text("expectedOutcomes", "Expected outcomes"),
    text("successCriteria", "Measurable success criteria"), text("timeline", "Delivery timeline"),
    text("milestones", "Milestones and deliverables"), category,
    text("proposedProblem", "Proposed problem statement"), text("relevance", "Business or scientific relevance"),
    text("thesisFit", "Fit with the funder's thesis"),
  ]),
  independent: Object.freeze([text("summary", "Solution summary"), text("methodology", "Technical approach"), text("addressedProblems", "Problems this solution could address"), category]),
});
export const AI_DRAFT_LIMITS = Object.freeze({ inputChars: 24000, messageChars: 3000, messageCount: 8, outputChars: 24000 });
const ID = /^[A-Za-z0-9_-]{1,128}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const plainObject = value => value !== null && typeof value === "object" && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
function invalid(message) { const error = new Error(message); error.code = "invalid-argument"; throw error; }
function allowedKeys(object, keys) { return Object.keys(object).every(key => keys.includes(key)); }
export const isEmptyAIField = value => value == null || value === "" || (typeof value === "string" && !value.trim()) || (Array.isArray(value) && !value.length);
export function getAIFieldConfig(kind) { return AI_FIELD_CONFIG[kind] ?? []; }
function fieldValue(field, value, allowEmpty = true) {
  if (allowEmpty && isEmptyAIField(value)) return field.type === "categories" ? [] : "";
  if (field.type === "categories") {
    if (!Array.isArray(value) || !value.length || value.length > 6 || value.some(item => !AI_POSTING_CATEGORIES.some(c => c.value === item)) || new Set(value).size !== value.length) invalid("Choose categories from the platform taxonomy.");
    return [...value];
  }
  if (typeof value !== "string" || value.length > field.maxLength || !value.trim()) invalid(`Invalid ${field.label.toLowerCase()}.`);
  if (field.type === "category" && !AI_PROPOSAL_CATEGORIES.some(item => item.value === value)) invalid("Choose a supported quantum category.");
  return value.trim();
}
export function validateDraftRequest(data) {
  if (!plainObject(data) || !allowedKeys(data, ["kind", "title", "fields", "requestedFields", "messages", "problemId", "recordId", "requestId"])) invalid("Invalid AI drafting request.");
  if (!Object.hasOwn(AI_FIELD_CONFIG, data.kind)) invalid("Choose a supported drafting form.");
  if (typeof data.title !== "string" || data.title.trim().length < 2 || data.title.length > 160) invalid("Enter a title between 2 and 160 characters first.");
  if (!UUID.test(data.requestId ?? "")) invalid("Start a new AI request and try again.");
  const config = AI_FIELD_CONFIG[data.kind];
  if (!plainObject(data.fields) || !allowedKeys(data.fields, config.map(field => field.key))) invalid("Only draftable text fields may be sent to AI.");
  const fields = Object.fromEntries(Object.entries(data.fields).map(([key, value]) => [key, fieldValue(config.find(field => field.key === key), value)]));
  if (!Array.isArray(data.requestedFields) || data.requestedFields.length > config.length || new Set(data.requestedFields).size !== data.requestedFields.length
      || data.requestedFields.some(key => typeof key !== "string" || !config.some(field => field.key === key))) invalid("Choose supported fields to draft.");
  const messages = data.messages ?? [];
  if (!Array.isArray(messages) || messages.length > AI_DRAFT_LIMITS.messageCount || messages.some(message => !plainObject(message)
      || !allowedKeys(message, ["role", "content"]) || !["user", "assistant"].includes(message.role)
      || typeof message.content !== "string" || !message.content.trim() || message.content.length > AI_DRAFT_LIMITS.messageChars)) invalid("Keep the conversation to eight short messages. Start a fresh conversation to continue.");
  for (const key of ["problemId", "recordId"]) if (data[key] != null && !ID.test(data[key])) invalid("Invalid form context.");
  if (data.kind === "proposal" && !data.problemId) invalid("A proposal needs its parent posting.");
  if (data.kind !== "proposal" && data.problemId != null) invalid("This form cannot use a parent posting.");
  if (JSON.stringify(data).length > AI_DRAFT_LIMITS.inputChars) invalid("The draft context is too long. Shorten the conversation or form text.");
  return { ...data, title: data.title.trim(), fields, requestedFields: [...data.requestedFields], messages: messages.map(message => ({ role: message.role, content: message.content.trim() })) };
}
export function draftOutputSchema(kind, requestedFields) {
  const properties = {};
  for (const key of requestedFields) {
    const field = AI_FIELD_CONFIG[kind].find(item => item.key === key);
    if (!field) invalid("Unsupported draft field.");
    properties[key] = field.type === "categories" ? { type: ["array", "null"], items: { type: "string", enum: AI_POSTING_CATEGORIES.map(item => item.value) }, maxItems: 6 }
      : field.type === "category" ? { type: ["string", "null"], enum: [...AI_PROPOSAL_CATEGORIES.map(item => item.value), null] }
        : { type: ["string", "null"], maxLength: field.maxLength };
  }
  return { type: "object", properties: {
    message: { type: "string", maxLength: 2000 },
    suggestions: { type: "object", properties, required: requestedFields, additionalProperties: false },
    suggestedTags: { type: "array", items: { type: "string", enum: AI_TAGS }, maxItems: 8 },
  }, required: ["message", "suggestions", "suggestedTags"], additionalProperties: false };
}
export function validateDraftOutput(output, kind, requestedFields) {
  if (!plainObject(output) || Object.keys(output).length !== 3 || !allowedKeys(output, ["message", "suggestions", "suggestedTags"])
      || typeof output.message !== "string" || !output.message.trim() || output.message.length > 2000
      || !plainObject(output.suggestions) || !allowedKeys(output.suggestions, requestedFields)
      || requestedFields.some(key => !Object.hasOwn(output.suggestions, key))
      || !Array.isArray(output.suggestedTags) || output.suggestedTags.length > 8 || output.suggestedTags.some(tag => !AI_TAGS.includes(tag))
      || new Set(output.suggestedTags).size !== output.suggestedTags.length
      || JSON.stringify(output).length > AI_DRAFT_LIMITS.outputChars) invalid("The AI response could not be validated. Your form has not changed.");
  const suggestions = {};
  for (const [key, value] of Object.entries(output.suggestions)) {
    if (value !== null) suggestions[key] = fieldValue(AI_FIELD_CONFIG[kind].find(field => field.key === key), value, false);
  }
  return { message: output.message.trim(), suggestions, suggestedTags: [...output.suggestedTags] };
}
