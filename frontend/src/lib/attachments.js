import {
  getBlob,
  ref as storageRef,
  uploadBytesResumable,
} from "firebase/storage";
import { httpsCallable } from "firebase/functions";
import { getToken as getAppCheckToken } from "firebase/app-check";
import { sha256 } from "viem";
import { appCheck, auth, functions, FUNCTIONS_REGION, isUsingEmulators,
  storage, isStorageConfigured, storageNeedsEmulator } from "./firebase.js";

/**
 * QCDAO-58 - supporting files attached to a posting.
 *
 * Storage layout, which firebase/storage.rules authorises directly from the path:
 *
 *     problems/{ownerId}/{problemId}/{attachmentId}.pdf
 *
 * Everything above the Firebase calls in this file is a pure function, so the
 * validation rules can be tested without an emulator (see
 * frontend/test/unit/attachments.test.js). The pure checks are a courtesy that
 * gives the user an instant, specific error; the checks that actually matter are
 * the identical ones in storage.rules, which run on Google's servers where a
 * modified client cannot reach them.
 */

// Must stay in step with maxBytes() in firebase/storage.rules and the 10485760
// literal in the attachment validator in firebase/firestore.rules.
export const MAX_FILE_BYTES = 10 * 1024 * 1024;
export const MAX_FILES_PER_POSTING = 2;
export const ACCEPTED_MIME = "application/pdf";
export const ACCEPTED_EXTENSION = ".pdf";

// PDF magic number. Every valid PDF begins with these five bytes.
const PDF_SIGNATURE = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return "-";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function attachmentPath({ ownerId, problemId, attachmentId, scope = "problems" }) {
  if (!["problems", "proposals"].includes(scope)) throw new Error("Invalid attachment scope.");
  return `${scope}/${String(ownerId).toLowerCase()}/${problemId}/${attachmentId}${ACCEPTED_EXTENSION}`;
}

export function newAttachmentId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Node 18 and any browser without randomUUID. Only needs to be collision-free
  // within one posting, and the result must satisfy the ^[A-Za-z0-9_-]{8,64}$
  // that both rules files enforce.
  return `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * The display name shown in the UI. The stored object is always named
 * {attachmentId}.pdf, so this never reaches a filesystem path - but it IS
 * rendered, and it comes from a filename the user chose, so strip the characters
 * that make a name dangerous to display or to echo into a header later.
 */
export function safeDisplayName(rawName) {
  const base = String(rawName ?? "").split(/[\\/]/).pop() || "document.pdf";
  // Control characters, the path/shell metacharacters, and the Unicode bidi
  // overrides. The last group matters: U+202E and friends reorder how the rest of
  // a string is DISPLAYED, so "reportEXEc.pdf" with an override in the middle can
  // render as "reportfdp.exe" - the classic filename-spoofing trick. Stripping
  // more than this would mangle ordinary names like "Q3 report (final).pdf".
  const cleaned = base
    .replace(/[\u0000-\u001f\u007f<>:"|?*]/g, "")
    .replace(/[\u200e\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, "")
    .trim();
  const named = cleaned.length > 0 ? cleaned : "document.pdf";
  return named.length > 200 ? `${named.slice(0, 196)}.pdf` : named;
}

/**
 * Synchronous checks - everything knowable without reading the file.
 * Returns null when the file is acceptable, or a user-facing message.
 */
export function validateFileMetadata(file, { existingCount = 0 } = {}) {
  if (!file) return "Choose a PDF file to attach.";

  if (existingCount >= MAX_FILES_PER_POSTING) {
    return `A posting can carry at most ${MAX_FILES_PER_POSTING} attachments. Remove one before adding another.`;
  }

  const name = String(file.name ?? "");
  if (!name.toLowerCase().endsWith(ACCEPTED_EXTENSION)) {
    return "Only PDF files can be attached. Choose a file ending in .pdf.";
  }

  // Browsers occasionally report an empty type for a drag-and-dropped file, so an
  // absent type is tolerated and left to the magic-number check. A type that is
  // present and wrong is rejected outright.
  if (file.type && file.type !== ACCEPTED_MIME) {
    return `Only PDF files can be attached. That file is ${file.type}.`;
  }

  if (typeof file.size !== "number" || file.size <= 0) {
    return "That file is empty.";
  }

  if (file.size > MAX_FILE_BYTES) {
    return `That file is ${formatBytes(file.size)}. The limit is ${formatBytes(MAX_FILE_BYTES)} per file.`;
  }

  return null;
}

/**
 * Confirms the bytes really are a PDF, rather than something renamed to .pdf.
 * Catches honest mistakes before a pointless upload; it is NOT a security
 * control, because anything running in the browser can be bypassed. The server
 * side of that argument is documented in firebase/storage.rules.
 */
export async function hasPdfSignature(file) {
  const slice = file.slice(0, PDF_SIGNATURE.length);

  // Blob.arrayBuffer() where it exists, FileReader everywhere else. The fallback
  // is not hypothetical: Safari only gained Blob.arrayBuffer() in 14, and jsdom's
  // Blob.slice() still returns an object without it, so the direct call throws
  // under the component tests.
  const buffer = typeof slice.arrayBuffer === "function"
    ? await slice.arrayBuffer()
    : await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsArrayBuffer(slice);
    });

  const bytes = new Uint8Array(buffer);
  return PDF_SIGNATURE.every((byte, index) => bytes[index] === byte);
}

async function blobArrayBuffer(blob) {
  if (typeof blob.arrayBuffer === "function") return blob.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

/** Returns the lowercase SHA-256 digest that is committed in proposal anchors. */
export async function sha256Blob(blob) {
  return sha256(new Uint8Array(await blobArrayBuffer(blob)));
}

export async function validateFile(file, options = {}) {
  const metadataError = validateFileMetadata(file, options);
  if (metadataError) return metadataError;

  const looksLikePdf = await hasPdfSignature(file);
  if (!looksLikePdf) {
    return "That file is named .pdf but its contents are not a PDF. Re-export it and try again.";
  }
  return null;
}

function requireStorage() {
  if (!isStorageConfigured || !storage) {
    throw new Error(
      "Firebase Storage is not configured. Set VITE_FIREBASE_STORAGE_BUCKET in frontend/.env.local.",
    );
  }
  // Fails here with a message that names the fix, rather than a few milliseconds
  // later with a bare CORS error that does not. See storageNeedsEmulator.
  if (storageNeedsEmulator) {
    throw new Error(
      "Attachments need the Storage emulator when running on localhost. Set "
      + "VITE_FIREBASE_USE_EMULATORS=true in frontend/.env.local and start the emulators "
      + "(cd firebase && npx firebase emulators:start --only functions,firestore,auth,storage). "
      + "The production bucket does not accept localhost origins.",
    );
  }
}

/**
 * Uploads one PDF and reports progress.
 *
 * Returns { attachment, cancel, done }:
 *   attachment  the record to store on the posting, available immediately so the
 *               UI can render a row while the bytes are still in flight
 *   cancel()    aborts the transfer (scope item: cancel)
 *   done        resolves with the attachment, or rejects with "storage/canceled"
 */
export function uploadAttachment({ file, ownerId, problemId, sha256: contentDigest, onProgress, scope = "problems" }) {
  requireStorage();
  if (!/^0x[0-9a-f]{64}$/.test(contentDigest ?? "")) {
    throw new Error("The attachment digest is missing or invalid. Select the file again.");
  }

  const attachmentId = newAttachmentId();
  const path = attachmentPath({ ownerId, problemId, attachmentId, scope });

  const attachment = {
    id: attachmentId,
    name: safeDisplayName(file.name),
    size: file.size,
    contentType: ACCEPTED_MIME,
    path,
    sha256: contentDigest,
  };

  let task;
  let cancelled = false;
  const done = (async () => {
    let reserved = false;
    try {
      await httpsCallable(functions, "reserveAttachment")({ scope, recordId: problemId,
        attachmentId, size: file.size, sha256: contentDigest });
      reserved = true;
      if (cancelled) {
        const error = new Error("Upload cancelled."); error.code = "storage/canceled"; throw error;
      }
      task = uploadBytesResumable(storageRef(storage, path), file, {
        contentType: ACCEPTED_MIME,
        customMetadata: { uploadedBy: String(ownerId).toLowerCase(), problemId: String(problemId),
          originalName: attachment.name, sha256: contentDigest },
      });
      return await new Promise((resolve, reject) => {
        task.on("state_changed", (snapshot) => {
          if (typeof onProgress === "function" && snapshot.totalBytes) {
            onProgress(Math.round(snapshot.bytesTransferred / snapshot.totalBytes * 100));
          }
        }, reject, () => resolve(attachment));
      });
    } catch (error) {
      if (reserved) {
        // The callable deletes any partial object and releases the exact reserved
        // quota. If cleanup itself is unavailable, the sweeper remains the fallback.
        try {
          await httpsCallable(functions, "removeAttachment")({ scope, recordId: problemId, attachmentId });
        } catch { /* Preserve the upload error; scheduled cleanup retries later. */ }
      }
      throw error;
    }
  })();
  return { attachment, cancel: () => { cancelled = true; task?.cancel(); }, done };

}

/**
 * Deletes the stored object. Used for remove-before-publish on drafts.
 * Published marketplace files must stay in the bucket: storage.rules refuse
 * owner delete once the posting leaves draft, so the same {id}.pdf cannot be
 * recreated with different bytes behind an unchanged opportunity hash.
 *
 * A missing object is treated as success: the goal is "this file is gone", and a
 * cancelled upload can leave a path that was never completed. Failing there would
 * strand a row in the UI that the user cannot clear.
 */
export async function deleteAttachment({ attachment, ownerId, problemId, scope = "problems" }) {
  requireStorage();
  await httpsCallable(functions, "removeAttachment")({ scope, recordId: problemId, attachmentId: attachment.id });
}

function downloadError(code, message) {
  const error = new Error(message); error.code = code; return error;
}

async function downloadProposalBlob({ proposalId, attachmentId }) {
  const user = auth?.currentUser;
  if (!user) throw downloadError("storage/unauthenticated", "Sign in to download this PDF.");
  const projectId = functions?.app?.options?.projectId;
  if (!projectId) throw new Error("Firebase Functions is not configured for PDF downloads.");
  const headers = { Authorization: `Bearer ${await user.getIdToken()}` };
  if (!isUsingEmulators) {
    if (!appCheck) throw downloadError("storage/unauthorized", "App verification is unavailable. Refresh the page and retry.");
    headers["X-Firebase-AppCheck"] = (await getAppCheckToken(appCheck)).token;
  }
  const base = isUsingEmulators
    ? `http://127.0.0.1:5001/${projectId}/${FUNCTIONS_REGION}`
    : `https://${FUNCTIONS_REGION}-${projectId}.cloudfunctions.net`;
  const query = new URLSearchParams({ proposalId, attachmentId });
  const response = await fetch(`${base}/downloadProposalAttachment?${query}`, {
    method: "GET", headers, cache: "no-store", credentials: "omit", redirect: "error",
  });
  if (!response.ok) {
    const code = response.status === 401 ? "storage/unauthenticated"
      : response.status === 403 ? "storage/unauthorized"
        : response.status === 404 ? "storage/object-not-found" : "storage/download-failed";
    throw downloadError(code, "The PDF download failed. Please try again.");
  }
  const blob = await response.blob();
  if (blob.size <= 0 || blob.size > MAX_FILE_BYTES) throw downloadError("storage/download-failed", "The PDF has an invalid size.");
  return blob;
}

/**
 * Proposal readers use the live authorization proxy; an author keeps direct
 * authenticated Storage access for pre-save draft previews. Posting downloads
 * continue through getBlob. Neither path returns a permanent download URL.
 */
export async function downloadAttachment({ attachment, ownerId, problemId, scope = "problems" }) {
  requireStorage();
  const path = attachmentPath({ ownerId, problemId, attachmentId: attachment.id, scope });
  const useProxy = scope === "proposals" && auth?.currentUser?.uid !== String(ownerId).toLowerCase();
  const blob = useProxy
    ? await downloadProposalBlob({ proposalId: problemId, attachmentId: attachment.id })
    : await getBlob(storageRef(storage, path));
  if (attachment.sha256 && await sha256Blob(blob) !== attachment.sha256) {
    const error = new Error("The downloaded file does not match its recorded digest.");
    error.code = "storage/integrity-check-failed";
    throw error;
  }
  return blob;
}

/** Hands the downloaded blob to the browser as a save action. */
export function saveBlobAs(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = safeDisplayName(filename);
  document.body.appendChild(link);
  link.click();
  link.remove();
  // Revoked on the next tick: revoking synchronously can beat the browser to the
  // navigation in Safari and silently produce an empty file.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

/**
 * The subset of an attachment that belongs on the posting record.
 *
 * No `path`: it is derivable from the owner, the posting and this id, so storing
 * it duplicated data the client had to be trusted not to forge. Callers rebuild it
 * with attachmentPath().
 */
export function toPostingRecord(attachment) {
  return {
    id: attachment.id,
    name: attachment.name,
    size: attachment.size,
    contentType: attachment.contentType,
    ...(attachment.sha256 ? { sha256: attachment.sha256 } : {}),
  };
}

const STORAGE_MESSAGES = {
  // storage.rules denies a revoked session exactly as it denies a stranger, so
  // this cannot blame ownership alone without misdiagnosing the common case.
  // Covers upload, download and delete, so it cannot say "download" - an upload
  // that is refused would otherwise report the wrong operation.
  "storage/unauthorized":
    "You do not have permission to use this file. Sign out, sign in with your wallet, and try again. Signed-in members can download attachments on any posting.",
  "storage/canceled": "Upload cancelled.",
  "storage/quota-exceeded":
    "The project's storage quota is full. Contact the platform team.",
  "storage/unauthenticated": "Your session expired. Sign in again and retry the upload.",
  "storage/retry-limit-exceeded":
    "The upload kept failing. Check your connection and try again.",
  "storage/object-not-found": "That file is no longer stored. Refresh the page.",
  "storage/invalid-checksum": "The file was corrupted in transit. Try uploading it again.",
  "storage/integrity-check-failed": "The downloaded file failed its integrity check. Do not open it; contact the platform team.",
};

export function messageForStorageError(error) {
  const code = String(error?.code ?? "");
  if (STORAGE_MESSAGES[code]) return STORAGE_MESSAGES[code];
  return error?.message || "The file transfer failed. Please try again.";
}
