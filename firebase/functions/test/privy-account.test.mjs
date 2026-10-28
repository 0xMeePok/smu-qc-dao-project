import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PRIVY_IDENTITIES,
  PrivySessionError,
  accountEmail,
  accountPrivyId,
  bindPrivyAccount,
  bootstrapAdminEmails,
  normalizeEmail,
  stampUserFromIdentity,
} from "../privyAccount.js";
import { memoryDb } from "./memoryDb.mjs";

const ADDRESS = `0x${"ab".repeat(20)}`;
const OTHER = `0x${"cd".repeat(20)}`;
const EMAIL = "member@example.com";
const PRIVY_ID = "did:privy:member";
const Timestamp = { now: () => ({ toMillis: () => 1_700_000_000_000 }) };

function privyUser(extra = {}) {
  return {
    id: PRIVY_ID,
    linked_accounts: [{ type: "email", address: "Member@Example.com" }],
    ...extra,
  };
}

describe("email identity", () => {
  it("normalises one email and reads the Privy id", () => {
    assert.equal(normalizeEmail("  Member@Example.com "), EMAIL);
    assert.equal(normalizeEmail("not an email"), null);
    assert.equal(accountEmail(privyUser()), EMAIL);
    assert.equal(accountPrivyId(privyUser()), PRIVY_ID);
    assert.deepEqual([...bootstrapAdminEmails({ ADMIN_BOOTSTRAP_EMAILS: " Admin@Example.com , no" })], ["admin@example.com"]);
  });

  it("refuses a missing email, two emails, or a Privy id that is not an id", () => {
    assert.throws(() => accountEmail({ linked_accounts: [] }), /email address/);
    assert.throws(() => accountEmail({
      linked_accounts: [
        { type: "email", address: "one@example.com" },
        { type: "email", address: "two@example.com" },
      ],
    }), /more than one/);
    assert.throws(() => accountPrivyId({ id: "user-1" }), PrivySessionError);
  });
});

describe("one email per account", () => {
  it("records the binding before a profile exists, with no email lock of its own", async () => {
    const db = memoryDb();
    const adminEmails = new Set();
    const first = await bindPrivyAccount({
      db, Timestamp, address: ADDRESS, email: EMAIL, privyUserId: PRIVY_ID, adminEmails,
    });
    assert.equal(first.profileReady, false);
    assert.equal(db.records.get(`${PRIVY_IDENTITIES}/${ADDRESS}`).email, EMAIL);
    assert.equal(db.records.has(`users/${ADDRESS}`), false);
    assert.equal([...db.records.keys()].some((key) => key.startsWith("emailAccounts/")), false);
  });

  it("lets a Privy user recreated for the same email sign in with its new wallet", async () => {
    const db = memoryDb({
      [`users/${ADDRESS}`]: { address: ADDRESS, role: 0, email: EMAIL, privyUserId: PRIVY_ID },
      [`${PRIVY_IDENTITIES}/${ADDRESS}`]: { address: ADDRESS, email: EMAIL, privyUserId: PRIVY_ID },
    });
    const recreated = await bindPrivyAccount({
      db, Timestamp, address: OTHER, email: EMAIL, privyUserId: "did:privy:recreated", adminEmails: new Set(),
    });
    assert.equal(recreated.profileReady, false);
    assert.equal(db.records.get(`${PRIVY_IDENTITIES}/${OTHER}`).privyUserId, "did:privy:recreated");
    // The old wallet's account is left exactly as it was.
    assert.equal(db.records.get(`users/${ADDRESS}`).privyUserId, PRIVY_ID);
  });

  it("never promotes a second wallet that presents an administrator's email", async () => {
    const adminEmails = new Set([EMAIL]);
    const admin = { address: ADDRESS, role: 1, email: EMAIL, privyUserId: PRIVY_ID };

    // Sign-in of a second wallet that already has a profile.
    const db = memoryDb({
      [`users/${ADDRESS}`]: admin,
      [`users/${OTHER}`]: { address: OTHER, role: 0, fullName: "Second" },
    });
    const bound = await bindPrivyAccount({
      db, Timestamp, address: OTHER, email: EMAIL, privyUserId: "did:privy:recreated", adminEmails,
    });
    assert.equal(bound.role, 0);
    assert.equal(db.records.get(`users/${OTHER}`).role, 0);

    // Onboarding of a second wallet: the stamp copies the email but not the role.
    const fresh = memoryDb({
      [`users/${ADDRESS}`]: admin,
      [`${PRIVY_IDENTITIES}/${OTHER}`]: { address: OTHER, email: EMAIL, privyUserId: "did:privy:recreated" },
      [`users/${OTHER}`]: { address: OTHER, role: 0, fullName: "Second" },
    });
    const stamped = await stampUserFromIdentity({
      db: fresh, Timestamp, address: OTHER, adminEmails,
    });
    assert.equal(stamped.stamped, true);
    assert.equal(stamped.role, undefined);
    assert.equal(fresh.records.get(`users/${OTHER}`).role, 0);
    assert.equal(fresh.records.get(`users/${OTHER}`).email, EMAIL);
  });

  it("promotes only one of two wallets onboarding at once with a bootstrap email", async () => {
    const db = memoryDb({
      [`${PRIVY_IDENTITIES}/${ADDRESS}`]: { address: ADDRESS, email: EMAIL, privyUserId: PRIVY_ID },
      [`${PRIVY_IDENTITIES}/${OTHER}`]: { address: OTHER, email: EMAIL, privyUserId: "did:privy:second" },
      [`users/${ADDRESS}`]: { address: ADDRESS, role: 0, fullName: "First" },
      [`users/${OTHER}`]: { address: OTHER, role: 0, fullName: "Second" },
    });
    const adminEmails = new Set([EMAIL]);
    // Started together, as two onboarding triggers firing at the same moment.
    const results = await Promise.all([ADDRESS, OTHER].map((address) =>
      stampUserFromIdentity({ db, Timestamp, address, adminEmails })));
    assert.deepEqual(results.map((result) => result.stamped), [true, true]);
    const roles = [ADDRESS, OTHER].map((address) => db.records.get(`users/${address}`).role);
    assert.equal(roles.filter((role) => role === 1).length, 1);
    assert.equal(db.records.get(`users/${OTHER}`).email, EMAIL);
  });

  it("does nothing once the profile it was asked to stamp is gone", async () => {
    const db = memoryDb({
      [`${PRIVY_IDENTITIES}/${ADDRESS}`]: { address: ADDRESS, email: EMAIL, privyUserId: PRIVY_ID },
    });
    assert.deepEqual(await stampUserFromIdentity({ db, Timestamp, address: ADDRESS, adminEmails: new Set([EMAIL]) }), { stamped: false });
    assert.equal(db.records.has(`users/${ADDRESS}`), false);
  });

  it("stamps an existing profile and grants admin once for a bootstrap email", async () => {
    const db = memoryDb({
      [`users/${ADDRESS}`]: { address: ADDRESS, role: 0, fullName: "Ada" },
    });
    const adminEmails = new Set([EMAIL]);
    const bound = await bindPrivyAccount({
      db, Timestamp, address: ADDRESS, email: EMAIL, privyUserId: PRIVY_ID, adminEmails,
    });
    assert.equal(bound.role, 1);
    assert.equal(db.records.get(`users/${ADDRESS}`).email, EMAIL);
    assert.equal(db.records.get(`users/${ADDRESS}`).privyUserId, PRIVY_ID);
    assert.equal(db.records.get(`users/${ADDRESS}`).fullName, "Ada");

    db.records.set(`users/${ADDRESS}`, { ...db.records.get(`users/${ADDRESS}`), role: 0 });
    await bindPrivyAccount({
      db, Timestamp, address: ADDRESS, email: EMAIL, privyUserId: PRIVY_ID, adminEmails,
    });
    assert.equal(db.records.get(`users/${ADDRESS}`).role, 1);
  });

  it("refuses to move a wallet onto a different email or Privy id", async () => {
    const db = memoryDb({
      [`users/${ADDRESS}`]: { address: ADDRESS, role: 0, email: EMAIL, privyUserId: PRIVY_ID },
    });
    const adminEmails = new Set();
    await assert.rejects(
      bindPrivyAccount({
        db, Timestamp, address: ADDRESS, email: "other@example.com", privyUserId: PRIVY_ID, adminEmails,
      }),
      /different email/,
    );
    await assert.rejects(
      bindPrivyAccount({
        db, Timestamp, address: ADDRESS, email: EMAIL, privyUserId: "did:privy:other", adminEmails,
      }),
      /different sign-in/,
    );
  });

  it("[BUT-OPD-185] keeps a hand-granted administrator role across the next Privy sign-in", async () => {
    const adminEmails = new Set();
    const profile = { address: ADDRESS, role: 1, fullName: "Ada" };

    const boundDb = memoryDb({ [`users/${ADDRESS}`]: { ...profile } });
    const bound = await bindPrivyAccount({
      db: boundDb, Timestamp, address: ADDRESS, email: EMAIL, privyUserId: PRIVY_ID, adminEmails,
    });
    assert.equal(bound.role, 1);
    assert.equal(boundDb.records.get(`users/${ADDRESS}`).role, 1);
    assert.equal(boundDb.records.get(`users/${ADDRESS}`).email, EMAIL);

    const stampDb = memoryDb({
      [`users/${ADDRESS}`]: { ...profile },
      [`${PRIVY_IDENTITIES}/${ADDRESS}`]: { address: ADDRESS, email: EMAIL, privyUserId: PRIVY_ID },
    });
    const stamped = await stampUserFromIdentity({
      db: stampDb, Timestamp, address: ADDRESS, adminEmails,
    });
    assert.equal(stamped.stamped, true);
    assert.equal(stamped.role, undefined);
    assert.equal(stampDb.records.get(`users/${ADDRESS}`).role, 1);
    assert.equal(stampDb.records.get(`users/${ADDRESS}`).email, EMAIL);
  });

  it("[BUT-OPD-186] keeps a hand-granted evaluator role when the email is on the bootstrap list", async () => {
    const adminEmails = new Set([EMAIL]);
    const profile = { address: ADDRESS, role: 2, fullName: "Ada" };

    const boundDb = memoryDb({ [`users/${ADDRESS}`]: { ...profile } });
    const bound = await bindPrivyAccount({
      db: boundDb, Timestamp, address: ADDRESS, email: EMAIL, privyUserId: PRIVY_ID, adminEmails,
    });
    assert.equal(bound.role, 2);
    assert.equal(boundDb.records.get(`users/${ADDRESS}`).role, 2);
    assert.equal(boundDb.records.get(`users/${ADDRESS}`).email, EMAIL);

    const stampDb = memoryDb({
      [`users/${ADDRESS}`]: { ...profile },
      [`${PRIVY_IDENTITIES}/${ADDRESS}`]: { address: ADDRESS, email: EMAIL, privyUserId: PRIVY_ID },
    });
    const stamped = await stampUserFromIdentity({
      db: stampDb, Timestamp, address: ADDRESS, adminEmails,
    });
    assert.equal(stamped.stamped, true);
    assert.equal(stamped.role, undefined);
    assert.equal(stampDb.records.get(`users/${ADDRESS}`).role, 2);
    assert.equal(stampDb.records.get(`users/${ADDRESS}`).email, EMAIL);
  });

  it("copies the binding onto a client-created profile and grants the bootstrap role", async () => {
    const db = memoryDb({
      [`${PRIVY_IDENTITIES}/${ADDRESS}`]: { address: ADDRESS, email: EMAIL, privyUserId: PRIVY_ID },
      [`users/${ADDRESS}`]: { address: ADDRESS, role: 0, fullName: "Ada" },
    });
    const stamped = await stampUserFromIdentity({
      db, Timestamp, address: ADDRESS, adminEmails: new Set([EMAIL]),
    });
    assert.equal(stamped.stamped, true);
    assert.equal(stamped.role, 1);
    assert.equal(db.records.get(`users/${ADDRESS}`).email, EMAIL);
    const again = await stampUserFromIdentity({
      db, Timestamp, address: ADDRESS, adminEmails: new Set([EMAIL]),
    });
    assert.equal(again.stamped, false);
  });
});
