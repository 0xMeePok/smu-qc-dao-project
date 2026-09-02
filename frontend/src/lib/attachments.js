import {
  deleteObject,
  getBlob,
  ref as storageRef,
  uploadBytesResumable,
} from "firebase/storage";
import { storage, isStorageConfigured, storageNeedsEmulator } from "./firebase.js";

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

export function attachmentPath({ ownerId, problemId, attachmentId }) {
  return `problems/${String(ownerId).toLowerCase()}/${problemId}/${attachmentId}${ACCEPTED_EXTENSION}`;
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
export function uploadAttachment({ file, ownerId, problemId, onProgress }) {
  requireStorage();

  const attachmentId = newAttachmentId();
  const path = attachmentPath({ ownerId, problemId, attachmentId });

  const attachment = {
    id: attachmentId,
    name: safeDisplayName(file.name),
    size: file.size,
    contentType: ACCEPTED_MIME,
    path,
  };

  const task = uploadBytesResumable(storageRef(storage, path), file, {
    contentType: ACCEPTED_MIME,
    // storage.rules refuses an upload whose metadata disagrees with the path it is
    // being written to, so these are not decoration.
    customMetadata: {
      uploadedBy: String(ownerId).toLowerCase(),
      problemId: String(problemId),
      originalName: attachment.name,
    },
  });

  const done = new Promise((resolve, reject) => {
    task.on(
      "state_changed",
      (snapshot) => {
        if (typeof onProgress !== "function" || !snapshot.totalBytes) return;
        onProgress(Math.round((snapshot.bytesTransferred / snapshot.totalBytes) * 100));
      },
      reject,
      () => resolve(attachment),
    );
  });

  return { attachment, cancel: () => task.cancel(), done };
}

/**
 * Deletes the stored object. Used both for remove-before-publish and for removing
 * an attachment from a saved posting.
 *
 * A missing object is treated as success: the goal is "this file is gone", and a
 * cancelled upload can leave a path that was never completed. Failing there would
 * strand a row in the UI that the user cannot clear.
 */
export async function deleteAttachment({ attachment, ownerId, problemId }) {
  requireStorage();
  try {
    await deleteObject(storageRef(storage, attachmentPath({
      ownerId, problemId, attachmentId: attachment.id,
    })));
  } catch (error) {
    if (error?.code !== "storage/object-not-found") throw error;
  }
}

/**
 * Downloads through the authenticated SDK path rather than getDownloadURL().
 *
 * This is a security decision, not a style one. getDownloadURL() mints a URL
 * carrying a permanent access token that works for ANYONE who has the link, with
 * no sign-in and no rules evaluation - which would quietly defeat the
 * requirement that attachments follow the posting's access rules. getBlob()
 * sends the user's ID token and is evaluated against firebase/storage.rules on
 * every request, so a user who cannot read the posting cannot read its files.
 */
export async function downloadAttachment({ attachment, ownerId, problemId }) {
  requireStorage();
  return getBlob(storageRef(storage, attachmentPath({
    ownerId, problemId, attachmentId: attachment.id,
  })));
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
  };
}

const STORAGE_MESSAGES = {
  "storage/unauthorized":
    "You do not have permission to use this file. Only the owner of a posting can attach or open its documents.",
  "storage/canceled": "Upload cancelled.",
  "storage/quota-exceeded":
    "The project's storage quota is full. Contact the platform team.",
  "storage/unauthenticated": "Your session expired. Sign in again and retry the upload.",
  "storage/retry-limit-exceeded":
    "The upload kept failing. Check your connection and try again.",
  "storage/object-not-found": "That file is no longer stored. Refresh the page.",
  "storage/invalid-checksum": "The file was corrupted in transit. Try uploading it again.",
};

export function messageForStorageError(error) {
  const code = String(error?.code ?? "");
  if (STORAGE_MESSAGES[code]) return STORAGE_MESSAGES[code];
  return error?.message || "The file transfer failed. Please try again.";
}
