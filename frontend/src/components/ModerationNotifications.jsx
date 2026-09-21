import { useEffect, useRef, useState } from "react";
import { listModerationNotifications, markModerationNotificationRead, moderationError } from "../lib/moderation.js";
import { formatInstant } from "../lib/datetime.js";
import { go } from "../lib/router.js";

function useModerationNotifications(userId) {
  const [items, setItems] = useState([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(null);
  const generation = useRef(0);
  useEffect(() => {
    let active = true;
    generation.current++;
    setItems([]); setError(""); setBusy(null);
    if (!userId) return undefined;
    listModerationNotifications().then((data) => { if (active) setItems(data.items ?? []); })
      .catch((err) => { if (active) setError(moderationError(err)); });
    return () => { active = false; generation.current++; };
  }, [userId]);
  const markRead = async (id) => {
    const version = generation.current;
    setBusy(id); setError("");
    try { await markModerationNotificationRead(id); if (version === generation.current) setItems((current) => current.map((item) => item.id === id ? { ...item, read: true } : item)); }
    catch (err) { if (version === generation.current) setError(moderationError(err)); }
    finally { if (version === generation.current) setBusy(null); }
  };
  return { items, error, busy, markRead };
}

function NotificationFeed({ items, error, busy, onMarkRead, onNavigate }) {
  return <>
    {error && <p role="alert" className="error-banner">{error}</p>}
    {items.length ? items.map((item) => <div className={`table-row${item.read ? "" : " is-unread"}`} key={item.id}>
      <div>
        <strong>{item.message || "A moderation decision was recorded on your content."}</strong>
        <p>{item.reason?.replaceAll("_", " ")}</p>
        {item.details && <p>{item.details}</p>}
        <small>{item.contentType} · {item.contentId} · {formatInstant(item.createdAt)}</small>
        {item.navigationTarget && /^posting\/[A-Za-z0-9_-]+$/.test(item.navigationTarget) && <button type="button" className="text-button" onClick={() => { onNavigate?.(); go(item.navigationTarget); }}>View matching status</button>}
      </div>
      {!item.read && <button type="button" className="secondary" disabled={Boolean(busy)} onClick={() => onMarkRead(item.id)}>Mark read</button>}
    </div>) : <p className="table-empty">No content notices.</p>}
  </>;
}

export function ModerationNotifications({ userId }) {
  const { items, error, busy, markRead } = useModerationNotifications(userId);
  return <section className="card-table moderation-notifications">
    <div className="table-header"><h2>Content & matching notices</h2></div>
    <NotificationFeed items={items} error={error} busy={busy} onMarkRead={markRead} />
  </section>;
}

export function NotificationCentre({ userId }) {
  const { items, error, busy, markRead } = useModerationNotifications(userId);
  const [open, setOpen] = useState(false);
  const panel = useRef(null);
  const unread = items.filter((item) => !item.read).length;
  useEffect(() => {
    if (!open) return undefined;
    const dismiss = (event) => { if (!panel.current?.contains(event.target)) setOpen(false); };
    const escape = (event) => { if (event.key === "Escape") setOpen(false); };
    document.addEventListener("mousedown", dismiss);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("mousedown", dismiss);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  return <div className="notification-centre nav-dropdown-wrapper" ref={panel}>
    <button
      type="button"
      className={`notification-centre-trigger${open ? " is-open" : ""}`}
      aria-expanded={open}
      aria-haspopup="true"
      aria-controls="notification-centre-panel"
      aria-label={unread ? `Notifications, ${unread} unread` : "Notifications"}
      onClick={() => setOpen((current) => !current)}
    >
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M6 9a6 6 0 0 1 12 0c0 7 3 7 3 9H3c0-2 3-2 3-9" />
        <path d="M10 20a2 2 0 0 0 4 0" />
      </svg>
      {unread > 0 && <span className="notification-unread-count" aria-hidden="true">{unread}</span>}
    </button>
    {open && <div id="notification-centre-panel" className="notification-centre-panel nav-dropdown-menu" role="region" aria-label="Notifications">
      <div className="nav-dropdown-header"><span className="eyebrow">Notifications</span></div>
      <div className="notification-centre-feed">
        <NotificationFeed items={items} error={error} busy={busy} onMarkRead={markRead} onNavigate={() => setOpen(false)} />
      </div>
    </div>}
  </div>;
}
