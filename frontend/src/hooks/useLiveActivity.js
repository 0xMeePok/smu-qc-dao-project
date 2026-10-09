import { useEffect, useRef } from "react";
import { subscribeToActivity } from "../lib/liveActivity.js";

const visible = () => document.visibilityState !== "hidden" && navigator.onLine !== false;

/** Coalesce push events, retain one blocked refresh and never poll hidden tabs. */
export function useLiveActivity({ proposalId, problemId, identity = "", channel, onRefresh,
  enabled = true, blocked = false, intervalMs = 60_000 }) {
  const latest = useRef({ onRefresh, blocked });
  latest.current = { onRefresh, blocked };
  const wake = useRef(null);
  useEffect(() => {
    if (!enabled || !(proposalId || problemId)) return undefined;
    let disposed = false, dirty = false, running = false, scheduled = null, stop = null;
    let lastRun = -Infinity, activityOnly = false, activitySnapshots = [];
    const schedule = () => {
      if (disposed || !dirty || running || scheduled || latest.current.blocked || !visible()) return;
      scheduled = setTimeout(run, Math.max(250, 2000 - (Date.now() - lastRun)));
    };
    const run = async () => {
      scheduled = null;
      if (disposed || running || latest.current.blocked || !visible()) return;
      const refreshReason = { activityOnly, activitySnapshots };
      dirty = false; activityOnly = false; activitySnapshots = []; running = true; lastRun = Date.now();
      try { await latest.current.onRefresh?.(refreshReason); }
      catch { /* Readers retain their own existing retry/error UI. */ }
      finally { running = false; if (!disposed) schedule(); }
    };
    const changed = (fromActivity = false, snapshot = null) => {
      activityOnly = dirty ? activityOnly && fromActivity : fromActivity;
      // Bound bursts. If any event lacks a trustworthy snapshot, the reader
      // must refresh; do not let a later event overwrite that requirement.
      if (!fromActivity || activitySnapshots.length >= 8) activityOnly = false;
      if (fromActivity && activitySnapshots.length < 8) activitySnapshots.push(snapshot);
      dirty = true; schedule();
    };
    const connect = () => {
      if (visible() && !stop) stop = subscribeToActivity({ proposalId, problemId, identity }, channel, event => changed(true, event?.fundingSnapshot ?? null));
    };
    const visibility = () => {
      if (visible()) { connect(); changed(); }
      else { stop?.(); stop = null; clearTimeout(scheduled); scheduled = null; }
    };
    wake.current = schedule;
    connect();
    const timer = setInterval(() => { if (visible()) changed(); }, Math.max(60_000, intervalMs));
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("online", visibility);
    window.addEventListener("offline", visibility);
    window.addEventListener("focus", visibility);
    return () => {
      disposed = true; wake.current = null; stop?.(); clearTimeout(scheduled); clearInterval(timer);
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("online", visibility);
      window.removeEventListener("offline", visibility);
      window.removeEventListener("focus", visibility);
    };
  }, [proposalId, problemId, identity, channel, enabled, intervalMs]);
  useEffect(() => { if (!blocked) wake.current?.(); }, [blocked]);
}
