import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  callable: vi.fn(),
  invoke: vi.fn(),
  signIn: vi.fn(),
}));

vi.mock("firebase/functions", () => ({
  httpsCallable: mocks.callable,
}));
vi.mock("firebase/auth", () => ({
  signInWithCustomToken: (...args) => mocks.signIn(...args),
}));
vi.mock("../../src/lib/firebase.js", () => ({
  auth: {},
  functions: {},
  isFirebaseConfigured: true,
  missingFirebaseConfig: [],
}));

const { exchangePrivySession } = await import("../../src/lib/authFlow.js");

describe("Privy session exchange", () => {
  beforeEach(() => {
    mocks.callable.mockReset();
    mocks.invoke.mockReset();
    mocks.signIn.mockReset();
    mocks.callable.mockReturnValue(mocks.invoke);
  });

  it("sends only the Privy access token and signs in with the token the server returns", async () => {
    const address = `0x${"a".repeat(40)}`;
    mocks.invoke.mockResolvedValue({ data: { token: "custom-token", address } });
    await expect(exchangePrivySession("header.payload.signature")).resolves.toBe(address);
    expect(mocks.callable).toHaveBeenCalledWith({}, "exchangePrivySession");
    expect(mocks.invoke).toHaveBeenCalledWith({ accessToken: "header.payload.signature" });
    expect(mocks.signIn).toHaveBeenCalledWith({}, "custom-token");
  });

  it("does not call the server with an address the browser named", async () => {
    await expect(exchangePrivySession("not-a-jwt")).rejects.toThrow(/did not return a session/);
    expect(mocks.callable).not.toHaveBeenCalled();
  });
});
