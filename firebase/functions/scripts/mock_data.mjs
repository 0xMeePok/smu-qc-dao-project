/**
 * Sample funded business problem statements (QCDAO-48) with their supporting
 * documents (QCDAO-58).
 *
 * The app ships with no seed content, so a fresh Firestore leaves Discover empty
 * and there is nothing to demonstrate the posting detail page or an attachment
 * download against. This writes three realistic postings and uploads their PDFs.
 *
 * Idempotent: posting ids are fixed, so re-running updates the same three
 * documents rather than adding more.
 *
 *   cd firebase/functions
 *   npm run seed                 # against the emulators
 *   MOCK_TARGET=production npm run seed
 *
 * The PDFs live in scripts/fixtures/ and are NOT committed - see the README note
 * in that directory. Supply your own, or the script tells you what is missing.
 */
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { initializeApp, cert, applicationDefault } from "firebase-admin/app";
import { getFirestore, FieldValue, Timestamp } from "firebase-admin/firestore";
import { getStorage } from "firebase-admin/storage";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES = path.join(HERE, "fixtures");

const PROJECT_ID = process.env.MOCK_PROJECT_ID ?? "qcdao-a0c7a";
const STORAGE_BUCKET = process.env.MOCK_STORAGE_BUCKET ?? `${PROJECT_ID}.firebasestorage.app`;

/**
 * Who owns the sample postings. Set this to your own wallet address to see them
 * under "My Problems"; otherwise they belong to a demo address nobody can sign in
 * as, which is fine for browsing Discover and the detail page.
 */
const OWNER = (process.env.MOCK_OWNER_ADDRESS ?? `0x${"d".repeat(40)}`).toLowerCase();

const DAY_MS = 24 * 60 * 60 * 1000;

/** Expiry as a whole-second instant, matching what the form writes. */
function expiresInDays(days) {
  const expiry = new Date(Date.now() + days * DAY_MS);
  expiry.setMilliseconds(0);
  return Timestamp.fromDate(expiry);
}

// The PDFs each posting carries. Filenames are looked up in scripts/fixtures/.
const SCRUM_PDF = "scrum-status-report.pdf";
const SUPERVISOR_PDF = "supervisor-meeting-notes.pdf";

/**
 * Three postings across different technology areas, so Discover shows more than
 * one kind of problem and the category filter has something to filter.
 */
export const SAMPLE_POSTINGS = [
  {
    id: "sample-coldchain-001",
    attachments: [SCRUM_PDF, SUPERVISOR_PDF],
    doc: {
      organisation: "Meridian Logistics",
      title: "Cold-chain delivery routing under demand spikes",
      businessContext:
        "We deliver temperature-controlled pharmaceuticals to 380 clinics across "
        + "the island. Demand is stable most weeks and then triples with no notice "
        + "when a public health campaign starts.",
      summary:
        "Our vehicle routing degrades badly above roughly 400 stops. Routes get "
        + "planned overnight, so a spike discovered in the morning cannot be "
        + "replanned before the vehicles leave.",
      currentApproach:
        "A nightly heuristic solver runs against the previous day's demand and "
        + "produces a fixed route sheet per vehicle.",
      currentLimitations:
        "Runtime grows past the six hour planning window above 400 stops, so we "
        + "fall back to last week's routes. Cold-chain excursions rise roughly "
        + "fourfold on those days.",
      expectedOutcome:
        "A routing plan produced inside thirty minutes, so we can replan in the "
        + "morning rather than committing the night before.",
      successCriteria:
        "Ten percent reduction in total distance at equal or better service "
        + "level, measured over a four week pilot against our current planner.",
      dataAvailability:
        "Two years of anonymised delivery telemetry, roughly 4 GB of CSV: stop "
        + "locations, time windows, vehicle capacities and temperature logs. "
        + "Available under NDA.",
      categories: ["optimisation", "ai", "quantum"],
      amount: 120000,
      currency: "XSGD",
      expiresAt: expiresInDays(90),
    },
  },
  {
    id: "sample-gridforecast-002",
    attachments: [SUPERVISOR_PDF],
    doc: {
      organisation: "Northpoint Energy",
      title: "Short-horizon demand forecasting for a district cooling grid",
      businessContext:
        "We operate district cooling for eleven commercial buildings. Chiller "
        + "start-up takes forty minutes, so we commit capacity well before we know "
        + "what demand will actually be.",
      summary:
        "Forecast error in the two to six hour horizon drives either over-cooling "
        + "or a comfort breach. Weather alone does not explain the variance we see.",
      currentApproach:
        "A gradient boosted model trained monthly on weather and historical load, "
        + "with a manual override by the duty engineer.",
      currentLimitations:
        "Mean absolute error roughly doubles on days with irregular occupancy, "
        + "which the model has no signal for. Retraining monthly is too slow to "
        + "adapt to tenancy changes.",
      expectedOutcome:
        "A forecast the duty engineer can commit chillers against without manual "
        + "override on ordinary days.",
      successCriteria:
        "Twenty percent lower mean absolute error in the two to six hour horizon, "
        + "held over a full quarter including a monsoon period.",
      dataAvailability:
        "Five years of half-hourly load, on-site weather, and anonymised access "
        + "control counts as a proxy for occupancy. Roughly 900 MB.",
      categories: ["ai", "data", "sustainability"],
      amount: 85000,
      currency: "USDC",
      expiresAt: expiresInDays(60),
    },
  },
  {
    id: "sample-provenance-003",
    attachments: [SCRUM_PDF],
    doc: {
      organisation: "Harborline Trade Services",
      title: "Verifiable provenance for multi-party shipping documents",
      businessContext:
        "A single shipment involves six parties exchanging bills of lading and "
        + "certificates by email. Disputes over which version was current cost us "
        + "roughly forty working days a year.",
      summary:
        "We need a tamper-evident record of which document version each party "
        + "held at each point, without putting commercially sensitive contents "
        + "into a shared system.",
      currentApproach:
        "Documents circulate as email attachments. A shared spreadsheet records "
        + "which version was sent to whom, maintained by hand.",
      currentLimitations:
        "The spreadsheet is updated after the fact and disagrees with the email "
        + "record often enough that it is not usable as evidence in a dispute.",
      expectedOutcome:
        "Any party can prove which version they held and when, without revealing "
        + "document contents to parties outside that exchange.",
      successCriteria:
        "A dispute can be resolved from the record alone in under one working "
        + "day, demonstrated against five historical disputes we will supply.",
      dataAvailability:
        "Redacted samples of 200 historical document exchanges, with the parties "
        + "and timings intact and commercial terms removed.",
      categories: ["web3", "security", "data"],
      amount: 95000,
      currency: "USDT",
      expiresAt: expiresInDays(120),
    },
  },
];

function attachmentId(postingId, index) {
  return `${postingId}-doc${index + 1}`;
}

function storagePath(postingId, index) {
  return `problems/${OWNER}/${postingId}/${attachmentId(postingId, index)}.pdf`;
}

function missingFixtures() {
  const needed = [...new Set(SAMPLE_POSTINGS.flatMap((posting) => posting.attachments))];
  return needed.filter((name) => !existsSync(path.join(FIXTURES, name)));
}

export async function seed({ db, bucket, logger = console }) {
  for (const posting of SAMPLE_POSTINGS) {
    const attachments = [];

    for (const [index, fixture] of posting.attachments.entries()) {
      const objectPath = storagePath(posting.id, index);
      const bytes = readFileSync(path.join(FIXTURES, fixture));

      await bucket.file(objectPath).save(bytes, {
        contentType: "application/pdf",
        // Simple upload, not resumable. The Storage emulator drops the Admin
        // SDK's resumable handshake with a socket hang up, and these fixtures are
        // small enough that resumability buys nothing either way.
        resumable: false,
        // The same custom metadata storage.rules requires of a real upload, so
        // seeded objects are indistinguishable from ones the app produced.
        metadata: {
          metadata: {
            uploadedBy: OWNER,
            problemId: posting.id,
            originalName: fixture,
          },
        },
      });

      attachments.push({
        id: attachmentId(posting.id, index),
        name: fixture,
        size: bytes.length,
        contentType: "application/pdf",
        path: objectPath,
      });
      logger.info(`  uploaded ${objectPath} (${bytes.length} bytes)`);
    }

    await db.collection("problems").doc(posting.id).set({
      ownerId: OWNER,
      ...posting.doc,
      attachments,
      status: "submitted",
      createdAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
    logger.info(`seeded problems/${posting.id} — ${posting.doc.title}`);
  }

  return SAMPLE_POSTINGS.length;
}

async function main() {
  const missing = missingFixtures();
  if (missing.length > 0) {
    console.error(
      `Missing PDF fixture(s) in ${FIXTURES}:\n`
      + missing.map((name) => `  - ${name}`).join("\n")
      + "\n\nThese are deliberately not committed. Drop any PDF in with these "
      + "names and re-run.",
    );
    process.exit(1);
  }

  const target = process.env.MOCK_TARGET ?? "emulator";
  if (target === "emulator") {
    // Point the Admin SDK at the local emulators. Set before initializeApp.
    process.env.FIRESTORE_EMULATOR_HOST ??= "127.0.0.1:8080";
    process.env.FIREBASE_STORAGE_EMULATOR_HOST ??= "127.0.0.1:9199";
    console.log("Seeding the EMULATORS. Start them first, in another terminal.");
  } else {
    console.log(`Seeding PRODUCTION project ${PROJECT_ID}.`);
  }

  initializeApp({
    projectId: PROJECT_ID,
    storageBucket: STORAGE_BUCKET,
    ...(process.env.GOOGLE_APPLICATION_CREDENTIALS ? { credential: applicationDefault() } : {}),
  });

  const count = await seed({
    db: getFirestore(),
    bucket: getStorage().bucket(),
  });

  console.log(`\nDone. ${count} sample postings owned by ${OWNER}.`);
  console.log("Set MOCK_OWNER_ADDRESS to your wallet to see them under My Problems.");
}

// Only runs when invoked directly, so the sample data can be imported by tests.
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
