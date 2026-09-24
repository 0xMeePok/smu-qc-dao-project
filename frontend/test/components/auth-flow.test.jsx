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

const { exchangeSignatureForSession, requestSignInMessage } = await import("../../src/lib/authFlow.js");

describe("wallet authentication flow", () => {
  beforeEach(() => {
    mocks.callable.mockReset();
    mocks.invoke.mockReset();
    mocks.invoke.mockResolvedValue({ data: { message: "Sign this message", challengeId: "a".repeat(32) } });
    mocks.callable.mockReturnValue(mocks.invoke);
  });

  it("uses the cached App Check token for nonce requests", async () => {
    await expect(requestSignInMessage(`0x${"a".repeat(40)}`)).resolves.toEqual({
      message: "Sign this message", challengeId: "a".repeat(32),
    });
    expect(mocks.callable).toHaveBeenCalledWith({}, "getSiweNonce");
  });

  it("sends the challenge id back so verification uses this attempt's own record", async () => {
    mocks.invoke.mockResolvedValue({ data: { token: "custom-token", address: `0x${"a".repeat(40)}` } });
    await exchangeSignatureForSession({
      address: `0x${"a".repeat(40)}`, signature: `0x${"11".repeat(65)}`, challengeId: "b".repeat(32),
    });
    expect(mocks.callable).toHaveBeenCalledWith({}, "verifySiweSignature");
    expect(mocks.invoke).toHaveBeenCalledWith(expect.objectContaining({ challengeId: "b".repeat(32) }));
  });
});
