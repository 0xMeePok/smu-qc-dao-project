import assert from "node:assert/strict";
import fs from "node:fs";
import { after, before, describe, it } from "node:test";
import {
  assertFails,
  assertSucceeds,
  initializeTestEnvironment,
} from "@firebase/rules-unit-testing";
import { deleteObject, getBytes, ref, uploadBytes } from "firebase/storage";
import { doc, setDoc } from "firebase/firestore";

/**
 * QCDAO-58 - storage.rules.
 *
 * These are the checks that actually protect the bucket. The equivalent
 * client-side validation in frontend/src/lib/attachments.js is a courtesy that
 * gives the user a fast, specific error; everything below runs on Google's
 * servers, where a modified client cannot reach it. Each test therefore drives
 * the Storage API directly rather than going through the app's helpers.
 */

// Deliberately 4/5/1 rather than the a/b/c used elsewhere. `node --test` runs test
// FILES concurrently against one shared emulator project, so these fixtures share a
// Firestore namespace with firestore.rules.test.mjs. Reusing its addresses meant
// this suite seeded a stub users/{0xaaa...} document that made its "create your own
// profile" test fail whenever the two happened to interleave - a real flake that
// only showed up on some runs. Keep these distinct from every address there.
const OWNER = `0x${"4".repeat(40)}`;
const OTHER = `0x${"5".repeat(40)}`;
const SUSPENDED = `0x${"1".repeat(40)}`;
const POSTING = "posting123";

// A real, if minimal, PDF: the rules do not read bytes, but using genuine content
// keeps the fixtures honest about what is being stored.
const PDF_BYTES = new TextEncoder().encode("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n");

let env;

function pdfMetadata(overrides = {}) {
  return {
    contentType: "application/pdf",
    customMetadata: {
      uploadedBy: OWNER,
      problemId: POSTING,
      originalName: "spec.pdf",
      ...overrides.customMetadata,
    },
    ...(overrides.contentType ? { contentType: overrides.contentType } : {}),
  };
}

function objectPath(owner = OWNER, posting = POSTING, name = "abc123xy.pdf") {
  return `problems/${owner}/${posting}/${name}`;
}

/** Seeds an object with the rules bypassed, so read/delete tests have a target. */
async function seedObject(path = objectPath(), metadata = pdfMetadata()) {
  await env.withSecurityRulesDisabled(async (context) => {
    await uploadBytes(ref(context.storage(), path), PDF_BYTES, metadata);
  });
}

before(async () => {
  env = await initializeTestEnvironment({
    projectId: "qc-dao-rules-test",
    storage: {
      rules: fs.readFileSync(new URL("../storage.rules", import.meta.url), "utf8"),
    },
    firestore: {
      rules: fs.readFileSync(new URL("../firestore.rules", import.meta.url), "utf8"),
    },
  });

  // storage.rules reads /users/{uid} across services to honour the same
  // suspension state Firestore enforces, so those documents have to exist.
  await env.withSecurityRulesDisabled(async (context) => {
    const db = context.firestore();
    await setDoc(doc(db, "users", OWNER), { address: OWNER, role: 0, suspended: false });
    await setDoc(doc(db, "users", OTHER), { address: OTHER, role: 0, suspended: false });
    await setDoc(doc(db, "users", SUSPENDED), { address: SUSPENDED, role: 0, suspended: true });
  });
});

after(async () => {
  await env?.cleanup();
});

describe("storage rules: uploading a posting attachment", () => {
  it("[BIT-OPD-116] lets the owner upload a PDF into their own posting folder", async () => {
    const storage = env.authenticatedContext(OWNER).storage();
    await assertSucceeds(
      uploadBytes(ref(storage, objectPath()), PDF_BYTES, pdfMetadata()),
    );
  });

  it("[BIT-OPD-117] refuses an unauthenticated upload", async () => {
    const storage = env.unauthenticatedContext().storage();
    await assertFails(
      uploadBytes(ref(storage, objectPath()), PDF_BYTES, pdfMetadata()),
    );
  });

  it("[BIT-OPD-118] refuses an upload into another wallet's folder", async () => {
    // The whole point of putting the owner in the path: OTHER is signed in
    // legitimately, but the path it is writing to is not its own.
    const storage = env.authenticatedContext(OTHER).storage();
    await assertFails(
      uploadBytes(ref(storage, objectPath(OWNER)), PDF_BYTES, pdfMetadata()),
    );
  });

  it("[BIT-OPD-119] refuses a non-PDF content type", async () => {
    const storage = env.authenticatedContext(OWNER).storage();
    await assertFails(
      uploadBytes(
        ref(storage, objectPath()),
        PDF_BYTES,
        pdfMetadata({ contentType: "text/html" }),
      ),
    );
  });

  it("[BIT-OPD-120] refuses an object name that is not .pdf, even with a PDF content type", async () => {
    // Guards the case where a caller declares application/pdf but stores
    // payload.html, which a download URL would then serve back as HTML.
    const storage = env.authenticatedContext(OWNER).storage();
    await assertFails(
      uploadBytes(
        ref(storage, objectPath(OWNER, POSTING, "payload.html")),
        PDF_BYTES,
        pdfMetadata(),
      ),
    );
  });

  it("[BIT-OPD-121] refuses a file over the 10 MB cap", async () => {
    const storage = env.authenticatedContext(OWNER).storage();
    const oversize = new Uint8Array(10 * 1024 * 1024 + 1);
    oversize.set(PDF_BYTES);
    await assertFails(
      uploadBytes(ref(storage, objectPath()), oversize, pdfMetadata()),
    );
  });

  it("[BIT-OPD-122] refuses an empty file", async () => {
    const storage = env.authenticatedContext(OWNER).storage();
    await assertFails(
      uploadBytes(ref(storage, objectPath()), new Uint8Array(0), pdfMetadata()),
    );
  });

  it("[BIT-OPD-123] refuses metadata claiming a different uploader than the path", async () => {
    const storage = env.authenticatedContext(OWNER).storage();
    await assertFails(
      uploadBytes(
        ref(storage, objectPath()),
        PDF_BYTES,
        pdfMetadata({ customMetadata: { uploadedBy: OTHER } }),
      ),
    );
  });

  it("[BIT-OPD-124] refuses metadata claiming a different posting than the path", async () => {
    const storage = env.authenticatedContext(OWNER).storage();
    await assertFails(
      uploadBytes(
        ref(storage, objectPath()),
        PDF_BYTES,
        pdfMetadata({ customMetadata: { problemId: "someOtherPosting" } }),
      ),
    );
  });

  it("[BIT-OPD-125] refuses an upload from a suspended account", async () => {
    const storage = env.authenticatedContext(SUSPENDED).storage();
    await assertFails(
      uploadBytes(
        ref(storage, objectPath(SUSPENDED)),
        PDF_BYTES,
        pdfMetadata({ customMetadata: { uploadedBy: SUSPENDED } }),
      ),
    );
  });

  it("[BIT-OPD-126] refuses writes outside the postings tree entirely", async () => {
    const storage = env.authenticatedContext(OWNER).storage();
    await assertFails(
      uploadBytes(ref(storage, `uploads/${OWNER}/anything.pdf`), PDF_BYTES, pdfMetadata()),
    );
  });

  it("[BIT-OPD-127] refuses to overwrite an attachment that already exists", async () => {
    // Stored attachments are immutable. With overwrites allowed, an owner could
    // swap the bytes behind a reference after a reviewer had read it, and neither
    // the posting record nor Storage would show that anything changed.
    const path = objectPath(OWNER, POSTING, "immutable.pdf");
    const storage = env.authenticatedContext(OWNER).storage();

    await assertSucceeds(uploadBytes(ref(storage, path), PDF_BYTES, pdfMetadata()));
    await assertFails(
      uploadBytes(ref(storage, path), new TextEncoder().encode("%PDF- swapped"), pdfMetadata()),
    );
  });

  it("[BIT-OPD-128] allows delete-then-upload, so replacing a file is still possible", async () => {
    // Immutability must not become "you can never fix a wrong upload". The
    // supported path is removal followed by a new attachment, which changes the
    // posting record visibly.
    const path = objectPath(OWNER, POSTING, "replaceme.pdf");
    const storage = env.authenticatedContext(OWNER).storage();

    await assertSucceeds(uploadBytes(ref(storage, path), PDF_BYTES, pdfMetadata()));
    await assertSucceeds(deleteObject(ref(storage, path)));
    await assertSucceeds(uploadBytes(ref(storage, path), PDF_BYTES, pdfMetadata()));
  });

  it("[BIT-OPD-129] refuses a posting id that is not a document-id shape", async () => {
    // Stops the posting segment being used as an arbitrary scratch namespace.
    const storage = env.authenticatedContext(OWNER).storage();
    const longId = "x".repeat(300);
    await assertFails(
      uploadBytes(
        ref(storage, objectPath(OWNER, longId, "abc123xy.pdf")),
        PDF_BYTES,
        pdfMetadata({ customMetadata: { problemId: longId } }),
      ),
    );
  });
});

describe("storage rules: reading and removing an attachment", () => {
  const READ_PATH = objectPath(OWNER, POSTING, "readable.pdf");

  before(async () => {
    await seedObject(READ_PATH);
  });

  it("[BIT-OPD-130] lets the posting owner read their attachment", async () => {
    const storage = env.authenticatedContext(OWNER).storage();
    await assertSucceeds(getBytes(ref(storage, READ_PATH)));
  });

  // No problems/{POSTING} document exists, so nothing proves this attachment
  // belongs to a published posting. Non-owners are refused by default; the
  // published case is covered against real fixtures in BIT-OPD-138.
  it("[BIT-OPD-131] refuses another wallet an attachment with no published posting", async () => {
    const storage = env.authenticatedContext(OTHER).storage();
    await assertFails(getBytes(ref(storage, READ_PATH)));
  });

  it("[BIT-OPD-132] refuses a read by a suspended account", async () => {
    const suspendedPath = objectPath(SUSPENDED, POSTING, "readable.pdf");
    await seedObject(suspendedPath, {
      contentType: "application/pdf",
      customMetadata: { uploadedBy: SUSPENDED, problemId: POSTING },
    });
    const storage = env.authenticatedContext(SUSPENDED).storage();
    await assertFails(getBytes(ref(storage, suspendedPath)));
  });

  it("[BIT-OPD-133] lets the owner delete their own attachment (remove-before-publish)", async () => {
    const path = objectPath(OWNER, POSTING, "deletable.pdf");
    await seedObject(path);
    const storage = env.authenticatedContext(OWNER).storage();
    await assertSucceeds(deleteObject(ref(storage, path)));
  });

  it("[BIT-OPD-134] refuses a delete by another wallet", async () => {
    const path = objectPath(OWNER, POSTING, "protected.pdf");
    await seedObject(path);
    const storage = env.authenticatedContext(OTHER).storage();
    await assertFails(deleteObject(ref(storage, path)));
  });
});

// QCDAO-58 scope: "Download from the posting detail page, with access controlled by
// the same role rules as the posting." Since QCDAO-48, a posting in submitted/open
// is readable by anyone - it is the public marketplace Discover queries. These
// tests hold the attachment rules to that same audience.
describe("storage rules: attachments follow the posting's visibility", () => {
  const PUBLIC_POSTING = "publicPosting1";
  const DRAFT_POSTING = "draftPosting1";

  before(async () => {
    await env.withSecurityRulesDisabled(async (context) => {
      const db = context.firestore();
      await setDoc(doc(db, "problems", PUBLIC_POSTING), {
        ownerId: OWNER, status: "submitted", title: "Public", summary: "Public posting",
      });
      await setDoc(doc(db, "problems", DRAFT_POSTING), {
        ownerId: OWNER, status: "draft", title: "Draft", summary: "Draft posting",
      });
    });
    await seedObject(objectPath(OWNER, PUBLIC_POSTING, "public.pdf"), {
      contentType: "application/pdf",
      customMetadata: { uploadedBy: OWNER, problemId: PUBLIC_POSTING },
    });
    await seedObject(objectPath(OWNER, DRAFT_POSTING, "draft.pdf"), {
      contentType: "application/pdf",
      customMetadata: { uploadedBy: OWNER, problemId: DRAFT_POSTING },
    });
  });

  it("[BIT-OPD-135] refuses an unauthenticated download of a published attachment", async () => {
    // The marketplace is open to members, not the open internet. These PDFs carry
    // the sponsor's business context and budget.
    const storage = env.unauthenticatedContext().storage();
    await assertFails(getBytes(ref(storage, objectPath(OWNER, PUBLIC_POSTING, "public.pdf"))));
  });

  it("[BIT-OPD-136] refuses a suspended member downloading a published attachment", async () => {
    const storage = env.authenticatedContext(SUSPENDED).storage();
    await assertFails(getBytes(ref(storage, objectPath(OWNER, PUBLIC_POSTING, "public.pdf"))));
  });

  it("[BIT-OPD-137] refuses a signed-in wallet with no profile from downloading", async () => {
    // Membership gate: a SIWE token alone is not enough, a /users profile is.
    const NO_PROFILE = `0x${"2".repeat(40)}`;
    const storage = env.authenticatedContext(NO_PROFILE).storage();
    await assertFails(getBytes(ref(storage, objectPath(OWNER, PUBLIC_POSTING, "public.pdf"))));
  });

  // THE case this story exists for, and the one that broke in production: a
  // signed-in member downloading the PDF on a posting somebody else published.
  it("[BIT-OPD-138] lets another wallet download an attachment on a published posting", async () => {
    // The whole point of QCDAO-58: a solution developer in another organisation
    // reads the posting on Discover and needs its technical context to respond.
    const storage = env.authenticatedContext(OTHER).storage();
    await assertSucceeds(getBytes(ref(storage, objectPath(OWNER, PUBLIC_POSTING, "public.pdf"))));
  });

  // The emulator does NOT enforce production's limit of TWO Firestore reads per
  // Storage rule evaluation, so a third read passes every test in this file and
  // then denies every real request with a bare 403. That is exactly how the
  // bucket stayed empty for so long. Counted statically because it cannot be
  // observed from behaviour here.
  it("[BIT-OPD-178] keeps storage.rules within the two cross-service reads production allows", () => {
    const source = fs.readFileSync(new URL("../storage.rules", import.meta.url), "utf8");
    const code = source
      .split("\n")
      .filter((line) => !line.trim().startsWith("//"))
      .join("\n");
    const reads = code.match(/firestore\.(get|exists)\(/g) ?? [];
    assert.ok(
      reads.length <= 2,
      `storage.rules performs ${reads.length} cross-service reads; production denies above 2`,
    );
  });

  // An unpublished draft's PDFs are the sponsor's competitive detail. Only the
  // owner may read them; publication is what opens them to the marketplace.
  it("[BIT-OPD-139] refuses another wallet an attachment on a draft posting", async () => {
    const storage = env.authenticatedContext(OTHER).storage();
    await assertFails(getBytes(ref(storage, objectPath(OWNER, DRAFT_POSTING, "draft.pdf"))));
  });

  it("[BIT-OPD-179] still lets the owner read their own draft's attachment", async () => {
    const storage = env.authenticatedContext(OWNER).storage();
    await assertSucceeds(getBytes(ref(storage, objectPath(OWNER, DRAFT_POSTING, "draft.pdf"))));
  });

  it("[BIT-OPD-140] still refuses another wallet from WRITING to a published posting", async () => {
    // Readable by everyone does not mean writable by everyone.
    const storage = env.authenticatedContext(OTHER).storage();
    await assertFails(uploadBytes(
      ref(storage, objectPath(OWNER, PUBLIC_POSTING, "intruder.pdf")),
      PDF_BYTES,
      { contentType: "application/pdf", customMetadata: { uploadedBy: OTHER, problemId: PUBLIC_POSTING } },
    ));
  });

  it("[BIT-OPD-141] still refuses another wallet from DELETING from a published posting", async () => {
    const storage = env.authenticatedContext(OTHER).storage();
    await assertFails(deleteObject(ref(storage, objectPath(OWNER, PUBLIC_POSTING, "public.pdf"))));
  });
});
