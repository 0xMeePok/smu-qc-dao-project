import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ getDocs: vi.fn(), getDoc: vi.fn(), session: { isSignedIn: true, isChecking: false,
  address: "0xowner", profile: { fullName: "Grant Owner", organisation: "Research Fund", role: 0, expertise: [] } } }));
vi.mock("../../src/lib/firebase.js", () => ({ db: {}, auth: null, functions: null }));
vi.mock("../../src/lib/authFlow.js", () => ({ requireFirebase: vi.fn() }));
vi.mock("../../src/context/SessionContext.jsx", () => ({ useSession: () => mocks.session }));
vi.mock("../../src/components/ModerationNotifications.jsx", () => ({ ModerationNotifications: () => null }));
vi.mock("firebase/firestore", async importOriginal => ({ ...await importOriginal(),
  collection: (_db, name) => ({ name }), doc: (_db, collection, id) => ({ collection, id }),
  query: (collection, ...constraints) => ({ collection, constraints }), where: (...args) => ({ where: args }),
  orderBy: (...args) => ({ orderBy: args }), limit: value => ({ limit: value }), startAfter: cursor => ({ cursor }),
  getDocs: (...args) => mocks.getDocs(...args), getDoc: (...args) => mocks.getDoc(...args),
}));
import ProfilePage from "../../src/pages/ProfilePage.jsx";
import { listOwnPostings } from "../../src/lib/postings.js";
const brief = { id: "problem1", data: () => ({ title: "Quantum routing problem", ownerId: "0xowner", status: "submitted",
  expiresAt: "2099-01-01T00:00:00.000Z" }) };
beforeEach(() => {
  mocks.getDocs.mockReset().mockResolvedValue({ docs: [brief], size: 1 });
  mocks.getDoc.mockReset().mockResolvedValue({ exists: () => true, data: () => ({ version: 2, proposalCount: 2 }) });
});
afterEach(cleanup);

it("shows the server's proposal count on My briefs when the problem document has no counter", async () => {
  render(<ProfilePage onNavigate={() => {}} />);
  fireEvent.click(screen.getByRole("tab", { name: "My briefs" }));
  expect(await screen.findByText(/2 proposals/)).toBeTruthy();
  expect(screen.queryByText(/0 proposals/)).toBeNull();
  expect(mocks.getDoc).toHaveBeenCalledWith({ collection: "opportunityMetrics", id: "problem1" });
});

it("hydrates only the bounded owner page and preserves its cursor", async () => {
  const cursor = { id: "previous-page" };
  const page = await listOwnPostings("0xOWNER", { cursor });
  expect(page.items[0]).toMatchObject({ id: "problem1", proposalCount: 2, categories: [], attachments: [] });
  expect(page.cursor).toBe(brief);
  expect(page.hasMore).toBe(false);
  expect(mocks.getDocs).toHaveBeenCalledWith({ collection: { name: "problems" }, constraints: [
    { where: ["ownerId", "==", "0xowner"] }, { orderBy: ["updatedAt", "desc"] }, { cursor }, { limit: 50 },
  ] });
  expect(mocks.getDoc).toHaveBeenCalledTimes(1);
});
