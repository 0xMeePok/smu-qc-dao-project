import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  callable: vi.fn(),
  invoke: vi.fn(),
}));

vi.mock("firebase/functions", () => ({
  httpsCallable: mocks.callable,
}));
vi.mock("firebase/auth", () => ({
  signInWithCustomToken: vi.fn(),
}));
vi.mock("../../src/lib/firebase.js", () => ({
  auth: {},
  functions: {},
  isFirebaseConfigured: true,
  missingFirebaseConfig: [],
}));

const { requestSignInMessage } = await import("../../src/lib/authFlow.js");

describe("wallet authentication flow", () => {
  beforeEach(() => {
    mocks.callable.mockReset();
    mocks.invoke.mockReset();
    mocks.invoke.mockResolvedValue({ data: { message: "Sign this message" } });
    mocks.callable.mockReturnValue(mocks.invoke);
  });

  it("uses the cached App Check token for nonce requests", async () => {
    await expect(requestSignInMessage(`0x${"a".repeat(40)}`)).resolves.toBe("Sign this message");
    expect(mocks.callable).toHaveBeenCalledWith({}, "getSiweNonce");
  });
});
