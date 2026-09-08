import { useEffect, useRef, useState } from "react";

/**
 * QCDAO-50/57 - the unsaved-work guard shared by every form that saves drafts.
 *
 * Hash routing means a nav click mutates location.hash directly, so leaving is
 * intercepted here rather than by a router guard: revert the hash, then ask.
 * `beforeunload` covers the browser's own back button and tab close, which no
 * amount of in-app interception can see.
 *
 * Extracted from CreatePostingPage rather than copied into the other two forms.
 * A prompt that only some forms show is worse than none: the user learns it will
 * catch them, and then loses work on the one screen that never had it.
 */
export function useDraftGuard({ isDirty, ownHashes = [], onNavigate, active = true }) {
  const [leaveTarget, setLeaveTarget] = useState(null);
  const allowNavigation = useRef(false);
  const currentHash = useRef(typeof window === "undefined" ? "" : window.location.hash);
  // Joined so the effect keys on the contents rather than the array identity,
  // which a caller building the list inline would change on every render.
  const ownKey = ownHashes.filter(Boolean).join("\n");

  useEffect(() => {
    if (!isDirty || !active) return undefined;
    const own = ownKey.split("\n").filter(Boolean);

    const warnOnUnload = (event) => {
      event.preventDefault();
      event.returnValue = "";
    };

    const interceptHash = () => {
      const next = window.location.hash;
      if (allowNavigation.current) {
        allowNavigation.current = false;
        currentHash.current = next;
        return;
      }
      // Only a URL for THIS record is a no-op. Waving through everything that
      // merely starts the same way let a switch to another draft skip the prompt
      // and discard whatever was unsaved here.
      if (next === currentHash.current || own.includes(next)) {
        currentHash.current = next;
        return;
      }
      allowNavigation.current = true;
      window.location.hash = currentHash.current;
      setLeaveTarget(next);
    };

    window.addEventListener("beforeunload", warnOnUnload);
    window.addEventListener("hashchange", interceptHash);
    return () => {
      window.removeEventListener("beforeunload", warnOnUnload);
      window.removeEventListener("hashchange", interceptHash);
    };
  }, [isDirty, active, ownKey]);

  /** Leaves for real, without re-triggering the interception above. */
  const goTo = (target) => {
    allowNavigation.current = true;
    if (typeof target === "string" && target.startsWith("#")) {
      window.location.hash = target;
      return;
    }
    onNavigate(target ?? "discover");
  };

  return { leaveTarget, setLeaveTarget, goTo };
}
