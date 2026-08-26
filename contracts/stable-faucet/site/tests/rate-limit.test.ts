import { describe, expect, it } from "vitest";
import { createWalletRateLimiter } from "../lib/rate-limit";

const WALLET = "0x1111111111111111111111111111111111111111";
const HOUR_MS = 60 * 60 * 1_000;

describe("wallet and token distribution cooldown", () => {
  it("blocks the same token for one hour after distribution", () => {
    const limiter = createWalletRateLimiter();
    const startedAt = 1_000_000;
    const first = limiter.reserve(WALLET, "XSGD", startedAt);
    expect(first.allowed).toBe(true);
    if (!first.allowed) return;

    limiter.complete(first.reservation, true, startedAt + 500);
    expect(limiter.reserve(WALLET, "XSGD", startedAt + HOUR_MS)).toEqual({
      allowed: false,
      reset: startedAt + 500 + HOUR_MS,
    });
    expect(
      limiter.reserve(WALLET, "XSGD", startedAt + 500 + HOUR_MS).allowed,
    ).toBe(true);
  });

  it("allows the same wallet to receive different tokens", () => {
    const limiter = createWalletRateLimiter();
    const first = limiter.reserve(WALLET, "XSGD", 1_000_000);
    expect(first.allowed).toBe(true);
    if (!first.allowed) return;
    limiter.complete(first.reservation, true, 1_000_500);

    expect(limiter.reserve(WALLET, "USDT", 1_000_501).allowed).toBe(true);
    expect(limiter.reserve(WALLET, "USDC", 1_000_501).allowed).toBe(true);
  });

  it("releases a reservation when distribution fails", () => {
    const limiter = createWalletRateLimiter();
    const first = limiter.reserve(WALLET, "USDT", 1_000_000);
    expect(first.allowed).toBe(true);
    if (!first.allowed) return;

    limiter.complete(first.reservation, false, 1_000_100);
    expect(limiter.reserve(WALLET, "USDT", 1_000_101).allowed).toBe(true);
  });

  it("normalizes wallet addresses and token symbols", () => {
    const limiter = createWalletRateLimiter();
    const first = limiter.reserve(WALLET.toUpperCase(), "xsgd", 1_000_000);
    expect(first.allowed).toBe(true);
    expect(limiter.reserve(WALLET, "XSGD", 1_000_001).allowed).toBe(false);
  });
});
