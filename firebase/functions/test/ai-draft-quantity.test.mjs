import test from "node:test";
import assert from "node:assert/strict";
import { hasAIDraftQuantityClaim, applyAIDraftQuantityPolicy } from "../aiDraftQuantityPolicy.js";

const blocked = [
  "Select 2–3 representative workloads.",
  "Select 2-3 representative workloads.",
  "Select 2‑3 representative workloads.",
  "Select 2 to 3 representative workloads.",
  "Select ２–３ representative workloads.",
  "Select two representative workloads.",
  "Select two to three representative workloads.",
  "Evaluate twenty-five workloads.",
  "Evaluate a hundred samples.",
  "Evaluate a dozen samples.",
  "Evaluate a single workload.",
  "Repeat the benchmark twice.",
  "Double the throughput.",
  "Aim for fivefold throughput gains.",
  "Deliver a tenfold improvement.",
  "Reduce the latency by half.",
  "Use 100 qubits.",
  "Use five qubits.",
  "Finish in three weeks.",
  "Finish within 2d.",
  "Use 5g of material.",
  "Improve accuracy by 10%.",
  "Improve accuracy by ten percent.",
  "Meet a latency target of 1.5 ms.",
  "Keep latency below one millisecond.",
  "Complete by 2027-01-25.",
  "Complete by 25/01/2027.",
  "Complete by January.",
  "June first: finish delivery.",
  "Complete within a month.",
  "Complete next Monday.",
  "Complete tomorrow.",
  "Complete on the fifth of May.",
  "1. Select 2–3 representative workloads.",
  "Phase 1: Evaluate three representative workloads.",
  "Apply 2-opt to 3 workloads.",
  "Phase 1: Establish the baseline. Phase 2: Evaluate three workloads.",
  "Use GPT-5 to produce two reports.",
];
for (const sentence of blocked) test(`withholds generated quantitative claim: ${sentence}`, () => {
  assert.equal(hasAIDraftQuantityClaim(sentence), true);
});

const qualitative = [
  "Select representative workloads agreed with the author.",
  "Compare suitable workloads against the agreed baseline.",
  "Agree measurable success criteria with the author before implementation.",
  "Establish the baseline, evaluate the approach, and review the findings.",
  "1. Establish the baseline.\n2. Evaluate representative workloads.\n3. Review the findings.",
  "(1) Establish the baseline.\n(2) Review the findings.",
  "Phase 1: Establish the baseline.\nPhase 2: Review the findings.",
  "Phase one: Establish the baseline.\nPhase two: Review the findings.",
  "Phase 1: Establish the baseline. Phase 2: Review the findings.",
  "1) Establish the baseline; 2) Evaluate representative workloads; 3) Review findings.",
  "**Phase 1:** Establish the baseline.\n**Phase 2:** Review the findings.",
  "## Phase 1: Establish the baseline.",
  "Apply 2-opt to representative routing workloads.",
  "Apply 2‑opt to representative routing workloads.",
  "Compare GPT-5 and GPT-5.2 for the author's chosen use case.",
  "Use AES-256 and SHA-256 where appropriate.",
  "Review ISO 27001 requirements and TLS 1.3 compatibility.",
  "Explore Web3 integration alongside quantum-inspired methods.",
  "Compare zero-shot and few-shot approaches.",
];
for (const sentence of qualitative) test(`keeps qualitative text and structural/technical identifiers: ${sentence}`, () => {
  assert.equal(hasAIDraftQuantityClaim(sentence), false);
});

test("policy omits only affected narrative fields without exposing their unsafe content", () => {
  const output = { message: "Review the proposed draft.", suggestions: { summary: "An editable qualitative solution summary.", methodology: "Select 2–3 representative workloads.", category: "hybrid" }, suggestedTags: ["Optimisation"] };
  const result = applyAIDraftQuantityPolicy(output, "proposal");
  assert.deepEqual(result.suggestions, { summary: output.suggestions.summary, category: "hybrid" });
  assert.deepEqual(result.suggestedTags, output.suggestedTags);
  assert.match(result.message, /Technical methodology/);
  assert.match(result.message, /quantities, numerical targets, or dates/);
  assert.equal(result.message.includes("2–3"), false);
  assert.equal(output.suggestions.methodology, "Select 2–3 representative workloads.");
});

test("chat cannot independently recommend invented quantities after field validation", () => {
  const result = applyAIDraftQuantityPolicy({ message: "Try two workloads before regenerating.", suggestions: {}, suggestedTags: [] }, "problem");
  assert.deepEqual(result.suggestions, {});
  assert.match(result.message, /enter quantities/);
  assert.equal(result.message.includes("two workloads"), false);
});
