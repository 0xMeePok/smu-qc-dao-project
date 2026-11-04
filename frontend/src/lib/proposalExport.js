import { httpsCallable } from "firebase/functions";
import { functions } from "./firebase.js";
import { requireFirebase } from "./authFlow.js";
import { exportToCsv } from "../../../firebase/functions/proposalExportFormat.js";

export const MAX_EXPORT_PART_BYTES = 8 * 1024 * 1024;
const PART_NOTICE = "Partial segment of a proposal export. This export is incomplete without its final completion manifest. Keep every numbered part and the matching completion manifest.";
const encoder = new TextEncoder();
const GROUP = Symbol("postingIndex");
function compareIds(a, b) {
  const left = encoder.encode(a), right = encoder.encode(b);
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    if (left[i] !== right[i]) return left[i] - right[i];
  }
  return left.length - right.length;
}
const invalid = () => new Error("The export response was inconsistent. Start the export again.");
const id = (value) => typeof value === "string" && value.length > 0;
const count = (value) => Number.isSafeInteger(value) && value >= 0;
function same(a, b) {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object" || Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && same(a[key], b[key]));
}
const without = (value, field) => Object.fromEntries(Object.entries(value).filter(([key]) => key !== field));
function cancelled(signal) {
  if (signal?.aborted) throw new DOMException("Export stopped.", "AbortError");
}
function abortable(promise, signal) {
  if (!signal) return promise;
  cancelled(signal);
  return new Promise((resolve, reject) => {
    const abort = () => reject(new DOMException("Export stopped.", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}
function sortDocument(document) {
  for (const posting of document.postings) {
    delete posting[GROUP];
    posting.proposals.sort((a, b) => a.id.localeCompare(b.id));
    for (const proposal of posting.proposals) {
      proposal.comments.sort((a, b) => (a.createdAt || "").localeCompare(b.createdAt || "") || a.id.localeCompare(b.id));
    }
  }
  document.postings.sort((a, b) => (a.acceptedAt || a.createdAt || "").localeCompare(b.acceptedAt || b.createdAt || "") || a.id.localeCompare(b.id));
  return document;
}
function recount(document) {
  document.postingCount = document.postings.length;
  document.proposalCount = document.postings.reduce((n, p) => n + p.proposals.length, 0);
  document.commentCount = document.postings.reduce((n, p) => n + p.proposals.reduce((m, v) => m + v.comments.length, 0), 0);
  return document;
}
function emptyDocument(header) { return { ...header, postingCount: 0, proposalCount: 0, commentCount: 0, postings: [] }; }
function append(document, fragment, postingIndex) {
  for (const posting of fragment.postings) {
    let target = document.postings.find((entry) => entry[GROUP] === postingIndex);
    if (!target) { target = { ...posting, [GROUP]: postingIndex, proposals: [] }; document.postings.push(target); }
    if (posting.acceptedAt && (!target.acceptedAt || posting.acceptedAt < target.acceptedAt)) target.acceptedAt = posting.acceptedAt;
    for (const proposal of posting.proposals) {
      let selected = target.proposals.find((entry) => entry.id === proposal.id);
      if (!selected) { selected = { ...proposal, comments: [] }; target.proposals.push(selected); }
      selected.comments.push(...proposal.comments);
    }
  }
  return recount(document);
}
function serializedBytes(document) {
  return encoder.encode(`${JSON.stringify(document, null, 2)}\n`).byteLength + encoder.encode(exportToCsv(document)).byteLength;
}

/** Lists proposals an administrator can export, accepted or not. */
export async function listExportableProposals() {
  requireFirebase();
  return (await httpsCallable(functions, "adminListExportProposals")({})).data;
}

/** Consume sequential pages; release numbered parts before fetching more data. */
export async function exportSelectedProposals(input, { signal, onProgress, onPart, maxPartBytes = MAX_EXPORT_PART_BYTES } = {}) {
  requireFirebase();
  if (!Number.isSafeInteger(maxPartBytes) || maxPartBytes <= 0 || maxPartBytes > MAX_EXPORT_PART_BYTES) throw new Error("Invalid export part size.");
  const callable = httpsCallable(functions, "adminExportSelectedProposals");
  const requestId = globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  let request = { ...input, protocolVersion: 1, requestId };
  let exportId, header, totals, buffer, bufferedBytes = 0, page = 0, emittedComments = 0, partNumber = 0;
  let currentProposal, lastCommentId = null, currentMetadata, currentPostingIndex = -1, currentPostingMetadata;
  const postingIds = new Set(), proposalIds = new Set();
  const flush = async () => {
    if (!onPart) throw new Error("This export needs multiple files. Start it again with support for numbered parts.");
    cancelled(signal);
    const document = sortDocument({ ...buffer, notice: `${header.notice} ${PART_NOTICE}` });
    const csv = exportToCsv(document);
    await abortable(Promise.resolve(onPart({ document, csv, exportId, partNumber: ++partNumber, notice: PART_NOTICE, bytes: serializedBytes(document) })), signal);
    buffer = emptyDocument(header);
    bufferedBytes = 0;
  };
  const add = async (fragment, postingIndex) => {
    const size = serializedBytes({ ...fragment, notice: `${header.notice} ${PART_NOTICE}` });
    if (size > maxPartBytes) {
      const posting = fragment.postings[0], proposal = posting?.proposals[0];
      if (!proposal || proposal.comments.length < 2) throw new Error("One export row is too large to download safely.");
      // The server bounds each page. Splitting a page also permits smaller test budgets.
      for (const comment of proposal.comments) {
        await add(recount({ ...fragment, postings: [{ ...posting, proposals: [{ ...proposal, comments: [comment] }] }] }), postingIndex);
      }
      return;
    }
    if (bufferedBytes && bufferedBytes + size > maxPartBytes) await flush();
    append(buffer, fragment, postingIndex);
    bufferedBytes += size; // Repeated page headers deliberately overestimate the retained part.
  };
  while (true) {
    cancelled(signal);
    let response;
    for (let attempt = 0; ; attempt++) {
      try { response = (await abortable(callable(request), signal)).data; break; }
      catch (error) {
        cancelled(signal);
        if (attempt >= 2 || !["functions/unavailable", "functions/deadline-exceeded", "unavailable", "deadline-exceeded"].includes(error?.code)) throw error;
      }
    }
    cancelled(signal);
    // Old deployments return a single complete file; never accept a cursor without a version.
    if (page === 0 && response?.protocolVersion == null) {
      if (response?.nextCursor != null || response?.done != null || response?.exportId != null || !response?.document || typeof response.csv !== "string") throw invalid();
      if (serializedBytes(response.document) > maxPartBytes) throw new Error("Refresh and try again to download this large export in numbered parts.");
      return { ...response, csv: exportToCsv(response.document) };
    }
    if (response?.protocolVersion !== 1 || !id(response.exportId) || response.page !== page || typeof response.done !== "boolean") throw invalid();
    if (exportId && response.exportId !== exportId) throw invalid();
    exportId = response.exportId;
    if (response.done ? response.nextCursor !== null || !id(response.auditId) : response.auditId !== null || !same(response.nextCursor, { exportId, page: page + 1 })) throw invalid();
    const document = response.document, received = response.totals;
    if (!document || document.schemaVersion !== 2 || !id(document.exportedAt) || !document.scope || typeof document.notice !== "string" || !Array.isArray(document.postings) || document.postings.length > 1) throw invalid();
    const nextHeader = without(without(without(without(document, "postings"), "postingCount"), "proposalCount"), "commentCount");
    if (header && !same(header, nextHeader)) throw invalid();
    if (!header) { header = nextHeader; buffer = emptyDocument(header); }
    if (!received || !count(received.postingCount) || !count(received.proposalCount) || !count(received.commentCount) || received.postingCount > 500 || received.proposalCount > 500 || (totals && (totals.postingCount !== received.postingCount || totals.proposalCount !== received.proposalCount))) throw invalid();
    totals = received;
    let fragmentComments = 0, fragmentProposals = 0;
    for (const posting of document.postings) {
      if (typeof posting.id !== "string" || !count(response.postingIndex) || !Array.isArray(posting.proposals) || posting.proposals.length !== 1) throw invalid();
      const postingMetadata = without(posting, "proposals");
      if (response.postingIndex === currentPostingIndex) {
        if (!same(postingMetadata, currentPostingMetadata)) throw invalid();
      } else {
        if (response.postingIndex !== currentPostingIndex + 1) throw invalid();
        currentPostingIndex = response.postingIndex;
        currentPostingMetadata = postingMetadata;
      }
      postingIds.add(response.postingIndex);
      for (const proposal of posting.proposals) {
        if (!id(proposal.id) || !Array.isArray(proposal.comments) || proposal.comments.length > 50) throw invalid();
        fragmentProposals++;
        const metadata = { posting: without(posting, "proposals"), proposal: without(proposal, "comments") };
        if (currentProposal !== proposal.id) {
          if (proposalIds.has(proposal.id)) throw invalid();
          proposalIds.add(proposal.id);
          currentProposal = proposal.id; lastCommentId = null; currentMetadata = metadata;
        } else if (!same(currentMetadata, metadata)) throw invalid();
        for (const comment of proposal.comments) {
          // Firestore document IDs traverse in ascending order. A scalar watermark
          // detects replays/duplicates without retaining an unbounded ID set.
          if (!id(comment.id) || (lastCommentId !== null && compareIds(comment.id, lastCommentId) <= 0)) throw invalid();
          lastCommentId = comment.id; fragmentComments++;
        }
      }
    }
    if (postingIds.size > totals.postingCount || proposalIds.size > totals.proposalCount || document.postingCount !== document.postings.length || document.proposalCount !== fragmentProposals || document.commentCount !== fragmentComments || received.commentCount !== emittedComments + fragmentComments) throw invalid();
    emittedComments += fragmentComments;
    if (response.done && (postingIds.size !== totals.postingCount || proposalIds.size !== totals.proposalCount)) throw invalid();
    if (document.postings.length) await add(document, response.postingIndex);
    onProgress?.({ postingCount: postingIds.size, proposalCount: proposalIds.size, commentCount: emittedComments });
    cancelled(signal);
    if (response.done) {
      if (partNumber) {
        if (buffer.postings.length) await flush();
        const manifest = { status: "complete", exportId, auditId: response.auditId, partCount: partNumber, ...totals, exportedAt: header.exportedAt, scope: header.scope, ordering: "Segments follow proposal and comment ID traversal. Each segment is sorted by date and ID. Keep every numbered part; proposals can span parts." };
        return { multipart: true, manifest, auditId: response.auditId, ...totals };
      }
      const completed = sortDocument(buffer);
      return { document: completed, csv: exportToCsv(completed), auditId: response.auditId, ...totals };
    }
    request = response.nextCursor;
    page++;
  }
}
