const DISTRIBUTION_WINDOW_MS = 60 * 60 * 1_000;
const MAX_TRACKED_WALLETS = 10_000;

type WalletEntry = {
  reservationId: symbol;
  reset: number;
};

export type WalletReservation = {
  key: string;
  reservationId: symbol;
};

export type WalletRateLimitDecision =
  | { allowed: true; reservation: WalletReservation }
  | { allowed: false; reset?: number; capacityExceeded?: boolean };

export function createWalletRateLimiter() {
  const entries = new Map<string, WalletEntry>();

  function removeExpired(now: number) {
    for (const [key, entry] of entries) {
      if (entry.reset <= now) entries.delete(key);
    }
  }

  function reserve(
    recipient: string,
    token: string,
    now = Date.now(),
  ): WalletRateLimitDecision {
    const key = `${recipient.toLowerCase()}:${token.toUpperCase()}`;
    const current = entries.get(key);
    if (current && current.reset > now) {
      return { allowed: false, reset: current.reset };
    }
    if (current) entries.delete(key);

    if (entries.size >= MAX_TRACKED_WALLETS) {
      removeExpired(now);
      if (entries.size >= MAX_TRACKED_WALLETS) {
        return { allowed: false, capacityExceeded: true };
      }
    }

    const reservationId = Symbol(key);
    entries.set(key, {
      reservationId,
      reset: now + DISTRIBUTION_WINDOW_MS,
    });
    return {
      allowed: true,
      reservation: { key, reservationId },
    };
  }

  function complete(
    reservation: WalletReservation,
    distributed: boolean,
    now = Date.now(),
  ) {
    const current = entries.get(reservation.key);
    if (current?.reservationId !== reservation.reservationId) return;

    if (!distributed) {
      entries.delete(reservation.key);
      return;
    }
    current.reset = now + DISTRIBUTION_WINDOW_MS;
  }

  return { reserve, complete };
}

const walletRateLimiter = createWalletRateLimiter();

export const reserveWalletDistribution = walletRateLimiter.reserve;
export const completeWalletDistribution = walletRateLimiter.complete;
