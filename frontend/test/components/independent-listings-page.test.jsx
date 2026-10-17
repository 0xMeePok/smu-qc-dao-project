import React from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ list: vi.fn() }));
vi.mock("../../src/context/AuthContext.jsx", () => ({ useAuth: () => ({ isAuthenticated: true }) }));
vi.mock("../../src/lib/proposals.js", () => ({ listIndependentListings: (...args) => mocks.list(...args) }));

import IndependentListingsPage from "../../src/pages/IndependentListingsPage.jsx";

const listing = { id: "l1", title: "Quantum routing pilot", summary: "Routing", category: "quantum-annealing", maturity: "",
  amount: 1000, currency: "USDC", expiresAt: "2099-01-01T00:00:00.000Z", organisation: "Lab", status: "submitted" };

beforeEach(() => { mocks.list.mockReset(); window.location.hash = "#/solutions"; });
afterEach(() => { cleanup(); window.location.hash = ""; });

it("shows a skeleton while the catalog loads and lets a failed load be retried", async () => {
  let fail;
  mocks.list.mockImplementationOnce(() => new Promise((_, reject) => { fail = reject; }));
  render(<IndependentListingsPage onNavigate={() => {}} />);
  expect(screen.getByLabelText("Loading listings")).toBeTruthy();
  fail(Object.assign(new Error("unavailable"), { code: "functions/unavailable" }));
  expect(await screen.findByRole("alert")).toBeTruthy();
  mocks.list.mockResolvedValue({ items: [listing], nextCursor: null });
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(await screen.findByRole("button", { name: "Quantum routing pilot" })).toBeTruthy();
  expect(mocks.list).toHaveBeenCalledTimes(2);
});
