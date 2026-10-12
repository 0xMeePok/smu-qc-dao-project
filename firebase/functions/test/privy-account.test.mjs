import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  EMAIL_ACCOUNTS,
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
  it("records the binding before a profile exists and refuses a second wallet", async () => {
    const db = memoryDb();
    const adminEmails = new Set();
    const first = await bindPrivyAccount({
      db, Timestamp, address: ADDRESS, email: EMAIL, privyUserId: PRIVY_ID, adminEmails,
    });
    assert.equal(first.profileReady, false);
    assert.equal(db.records.get(`${EMAIL_ACCOUNTS}/${EMAIL}`).address, ADDRESS);
    assert.equal(db.records.get(`${PRIVY_IDENTITIES}/${ADDRESS}`).email, EMAIL);
    assert.equal(db.records.has(`users/${ADDRESS}`), false);

    await assert.rejects(
      bindPrivyAccount({
        db, Timestamp, address: OTHER, email: EMAIL, privyUserId: "did:privy:other", adminEmails,
      }),
      (error) => error instanceof PrivySessionError && error.code === "already-exists",
    );
    assert.equal(db.records.get(`${EMAIL_ACCOUNTS}/${EMAIL}`).address, ADDRESS);
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
      [`${EMAIL_ACCOUNTS}/${EMAIL}`]: { address: ADDRESS, privyUserId: PRIVY_ID },
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

  it("copies the binding onto a client-created profile and grants the bootstrap role", async () => {
    const db = memoryDb({
      [`${PRIVY_IDENTITIES}/${ADDRESS}`]: { address: ADDRESS, email: EMAIL, privyUserId: PRIVY_ID },
      [`users/${ADDRESS}`]: { address: ADDRESS, role: 0, fullName: "Ada" },
    });
    const stamped = await stampUserFromIdentity({
      db, Timestamp, address: ADDRESS, userData: db.records.get(`users/${ADDRESS}`), adminEmails: new Set([EMAIL]),
    });
    assert.equal(stamped.stamped, true);
    assert.equal(stamped.role, 1);
    assert.equal(db.records.get(`users/${ADDRESS}`).email, EMAIL);
    const again = await stampUserFromIdentity({
      db, Timestamp, address: ADDRESS, userData: db.records.get(`users/${ADDRESS}`), adminEmails: new Set([EMAIL]),
    });
    assert.equal(again.stamped, false);
  });
});
