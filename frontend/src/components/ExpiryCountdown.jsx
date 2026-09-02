import { useEffect, useState } from "react";
import { countdownParts, formatCountdown, formatInstant } from "../lib/datetime.js";

/**
 * QCDAO-48 - live time remaining on a posting.
 *
 * A funded problem statement is only answerable until it expires, so the closing
 * time is a decision input for anyone reading it, not decoration. Shown as a
 * ticking countdown next to the absolute UTC instant: the countdown answers "do I
 * have time to respond", the instant answers "by exactly when", unambiguously
 * across time zones.
 *
 * The interval stops once the posting has expired - there is nothing left to count
 * down, and a timer running forever on a dead posting is a leak.
 */
export function ExpiryCountdown({ expiresAt, showInstant = true }) {
  const [now, setNow] = useState(() => new Date());

  const parts = countdownParts(expiresAt, now);
  const expired = parts?.expired ?? false;

  useEffect(() => {
    if (!expiresAt || expired) return undefined;
    // One second, because the display has second resolution. Reading the clock
    // fresh each tick rather than adding 1000 keeps it accurate if the tab is
    // throttled or the machine sleeps.
    const timer = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(timer);
  }, [expiresAt, expired]);

  if (!parts) return <span className="expiry-countdown">—</span>;

  return (
    <span className={`expiry-countdown ${expired ? "expired" : ""}`}>
      <strong
        // Announced on a timer, so screen readers are not interrupted every second.
        aria-live="off"
        title={formatInstant(expiresAt)}
      >
        {expired ? "Expired" : formatCountdown(expiresAt, now)}
      </strong>
      {showInstant && <small>{formatInstant(expiresAt)}</small>}
    </span>
  );
}

export default ExpiryCountdown;
