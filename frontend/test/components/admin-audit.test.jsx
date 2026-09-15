import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ pages: [], calls: [] }));

vi.mock("firebase/firestore", () => ({
  collection: (_db, name) => ({ kind: "collection", name }),
  query: (ref, ...constraints) => ({ ref, constraints }),
  where: (field, op, value) => ({ kind: "where", field, op, value }),
  orderBy: (field, direction) => ({ kind: "orderBy", field, direction }),
  startAfter: (cursor) => ({ kind: "startAfter", cursor }),
  limit: (count) => ({ kind: "limit", count }),
  getDocs: async (built) => {
    mocks.calls.push(built);
    return { docs: mocks.pages.shift() ?? [] };
  },
}));
vi.mock("../../src/lib/firebase.js", () => ({ db: {} }));
vi.mock("../../src/context/AuthContext.jsx", () => ({ useAuth: () => ({ user: { id: "0xadmin" } }) }));
vi.mock("../../src/components/ProposalList.jsx", () => ({ ProposalList: () => null }));
vi.mock("../../src/lib/postings.js", () => ({
  POSTING_STATUS_DRAFT: "draft",
  deletePosting: vi.fn(),
  listOwnPostings: vi.fn(),
}));

import { AdminAudit } from "../../src/components/RoleViews.jsx";

const at = (iso) => ({ toDate: () => new Date(iso) });
const record = (id, data) => ({ id, data: () => data });
const expiryEvent = (id, overrides = {}) => record(id, {
  type: "opportunity_expired",
  action: "OPPORTUNITY_EXPIRED",
  source: "scheduled",
  reason: "funding_requirement_not_met",
  actor: "system",
  actorName: "System scheduler",
  targetId: "problem-1",
  targetName: "Cold-chain routing",
  timestamp: at("2026-09-12T12:00:00Z"),
  ...overrides,
});

beforeEach(() => {
  mocks.pages = [];
  mocks.calls = [];
});
afterEach(cleanup);

describe("[QCDAO-56] admin audit trail", () => {
  it("shows each lapse with its posting and a readable reason, not the raw code", async () => {
    mocks.pages = [[
      expiryEvent("a1"),
      expiryEvent("a2", {
        action: "OPPORTUNITY_FORCE_EXPIRED", source: "manual", actor: "0xadmin",
        actorName: "Ada Admin", reason: "evaluation_not_completed",
      }),
    ]];
    render(<AdminAudit />);

    expect(await screen.findByText("OPPORTUNITY LAPSED")).toBeTruthy();
    expect(screen.getByText("OPPORTUNITY FORCE-EXPIRED")).toBeTruthy();
    expect(screen.getAllByText("Cold-chain routing")).toHaveLength(2);
    expect(screen.getByText("Lapse reason: Funding requirement was not met.")).toBeTruthy();
    expect(screen.getByText("Lapse reason: Evaluation was not completed.")).toBeTruthy();
    expect(screen.queryByText(/funding_requirement_not_met/)).toBeNull();
    expect(screen.getAllByText("problems/problem-1")).toHaveLength(2);
  });

  it("pages through older events instead of loading the whole collection", async () => {
    mocks.pages = [
      Array.from({ length: 50 }, (_, index) => expiryEvent(`page1-${index}`)),
      [expiryEvent("page2-0", { targetName: "Oldest posting" })],
    ];
    render(<AdminAudit />);

    const more = await screen.findByRole("button", { name: "Load older events" });
    expect(mocks.calls[0].constraints.map((constraint) => constraint.kind)).toEqual(["orderBy", "limit"]);
    fireEvent.click(more);

    expect(await screen.findByText("Oldest posting")).toBeTruthy();
    const cursor = mocks.calls[1].constraints.find((constraint) => constraint.kind === "startAfter");
    expect(cursor.cursor.id).toBe("page1-49");
    expect(screen.queryByRole("button", { name: "Load older events" })).toBeNull();
  });

  it("filters on the server, so the expiry filter covers every event", async () => {
    mocks.pages = [[expiryEvent("a1")], [expiryEvent("b1", { targetName: "Filtered posting" })]];
    render(<AdminAudit />);
    await screen.findByText("OPPORTUNITY LAPSED");

    fireEvent.change(screen.getByLabelText("Filter audit log entries"), { target: { value: "opportunity_expired" } });

    expect(await screen.findByText("Filtered posting")).toBeTruthy();
    const filtered = mocks.calls[1].constraints;
    expect(filtered[0]).toEqual({ kind: "where", field: "type", op: "in", value: ["opportunity_expired"] });
    expect(filtered.find((constraint) => constraint.kind === "orderBy"))
      .toEqual({ kind: "orderBy", field: "timestamp", direction: "desc" });
  });
});
