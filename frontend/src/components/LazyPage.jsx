import { lazy } from "react";

export function PageLoading() {
  return <section className="page" role="status" aria-live="polite"><p>Loading page…</p></section>;
}

export function PageLoadFailure({ reload = () => window.location.reload() }) {
  return <section className="page">
    <div className="notice notice-error" role="alert">
      <h2>This page could not be loaded</h2>
      <p>Check your connection and reload to get the latest version. If a wallet transaction is pending, finish it before reloading.</p>
      <button type="button" className="secondary" onClick={reload}>Reload page</button>
    </div>
  </section>;
}

// A Hosting release can remove an older tab's unvisited page chunk. Recovery
// must be explicit: automatic reloads can interrupt wallet actions or drafts.
// Catch import failures only, not exceptions from the page's application logic.
export function lazyPage(load, name = "default") {
  return lazy(async () => {
    try { return { default: (await load())[name] }; }
    catch { return { default: PageLoadFailure }; }
  });
}
