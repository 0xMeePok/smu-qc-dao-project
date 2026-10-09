// Dashboard readers use saved summaries; verified detail/action reads remain
// separate. TanStack Query pauses this interval in hidden/offline browsers and
// shares requests for identical wallet-scoped keys.
export const LIVE_DASHBOARD_OPTIONS = Object.freeze({
  refetchInterval: 60_000,
  refetchIntervalInBackground: false,
  refetchOnWindowFocus: true,
  refetchOnReconnect: true,
});
