import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  saveProfile: vi.fn(),
  session: {},
  batch: { update: vi.fn(), commit: vi.fn() },
  getDoc: vi.fn(),
}));
vi.mock("../../src/lib/firebase.js", () => ({ db: {}, auth: null, functions: null }));
vi.mock("../../src/lib/authFlow.js", () => ({ requireFirebase: vi.fn() }));
vi.mock("../../src/context/SessionContext.jsx", () => ({ useSession: () => mocks.session }));
vi.mock("../../src/components/ModerationNotifications.jsx", () => ({ ModerationNotifications: () => null }));
vi.mock("../../src/components/CurrencyAmount.jsx", () => ({ CurrencyAmount: ({ currency, amount }) => <span>{currency} {amount}</span> }));
vi.mock("firebase/firestore", async importOriginal => ({ ...await importOriginal(),
  doc: (_db, collection, id) => ({ collection, id }),
  writeBatch: () => mocks.batch,
  getDoc: (...args) => mocks.getDoc(...args),
  serverTimestamp: () => "server-time",
}));

import ProfilePage from "../../src/pages/ProfilePage.jsx";
import { updateProfile } from "../../src/lib/profile.js";

const address = `0x${"a".repeat(40)}`;
const profile = { address, fullName: "Ashley Chung", organisation: "SMU", role: 0, biography: "", expertise: [],
  localCurrency: "JPY", showLocalCurrency: true };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.batch.commit.mockResolvedValue(undefined);
  mocks.getDoc.mockResolvedValue({ data: () => profile });
  mocks.saveProfile.mockResolvedValue(profile);
  mocks.session = { isSignedIn: true, isChecking: false, address, profile, saveProfile: mocks.saveProfile, signOut: vi.fn() };
});
afterEach(cleanup);

it("loads the saved currency preference and saves a new currency with the display toggle", async () => {
  render(<ProfilePage />);
  fireEvent.click(screen.getByRole("button", { name: "Edit profile" }));
  expect(screen.getByLabelText("Local currency").value).toBe("JPY");
  expect(screen.getByLabelText("Show local currency estimates").checked).toBe(true);
  fireEvent.change(screen.getByLabelText("Local currency"), { target: { value: "SGD" } });
  fireEvent.click(screen.getByLabelText("Show local currency estimates"));
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() => expect(mocks.saveProfile).toHaveBeenCalledWith({
    fullName: profile.fullName, organisation: profile.organisation, biography: "", expertise: [],
    localCurrency: "SGD", showLocalCurrency: false,
  }));
  expect(await screen.findByText("Profile updated.")).toBeTruthy();
});

it("uses token-only defaults for a legacy profile and discards an unsaved preference", () => {
  mocks.session.profile = { ...profile, localCurrency: undefined, showLocalCurrency: undefined };
  render(<ProfilePage />);
  fireEvent.click(screen.getByRole("button", { name: "Edit profile" }));
  expect(screen.getByLabelText("Local currency").value).toBe("SGD");
  expect(screen.getByLabelText("Show local currency estimates").checked).toBe(false);
  fireEvent.change(screen.getByLabelText("Local currency"), { target: { value: "EUR" } });
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.click(screen.getByRole("button", { name: "Edit profile" }));
  expect(screen.getByLabelText("Local currency").value).toBe("SGD");
  expect(mocks.saveProfile).not.toHaveBeenCalled();
});

it("persists FX preferences only in the private profile", async () => {
  await updateProfile({ address, form: { ...profile, localCurrency: "EUR", showLocalCurrency: true } });
  expect(mocks.batch.update).toHaveBeenNthCalledWith(1, { collection: "users", id: address }, {
    fullName: "Ashley Chung", organisation: "SMU", biography: "", expertise: [], updatedAt: "server-time",
    localCurrency: "EUR", showLocalCurrency: true,
  });
  expect(mocks.batch.update).toHaveBeenNthCalledWith(2, { collection: "publicProfiles", id: address }, {
    fullName: "Ashley Chung", organisation: "SMU", biography: "", expertise: [],
  });
});

it("preserves saved FX preferences when an older editor omits them", async () => {
  await updateProfile({ address, form: { fullName: "Ashley Chung", organisation: "SMU", biography: "", expertise: [] } });
  const privateUpdate = mocks.batch.update.mock.calls[0][1];
  expect(Object.hasOwn(privateUpdate, "localCurrency")).toBe(false);
  expect(Object.hasOwn(privateUpdate, "showLocalCurrency")).toBe(false);
});
