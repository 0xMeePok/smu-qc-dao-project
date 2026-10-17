import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import {
  NOTIFICATION_REFRESH_MS,
  markAllNotificationsRead,
  markNotificationRead,
  notificationSnapshot,
  refreshNotifications,
  setNotificationUser,
  subscribeNotifications,
} from "../lib/notifications.js";
import { formatInstant } from "../lib/datetime.js";
import { go } from "../lib/router.js";
import { noticeWorkflowStatus } from "../config/workflowStatus.js";
import { StatusBadge } from "./StatusBadge.jsx";

function useModerationNotifications(userId) {
  const snapshot = useSyncExternalStore(subscribeNotifications, notificationSnapshot, notificationSnapshot);
  useEffect(() => {
    setNotificationUser(userId);
    if (!userId) return undefined;
    refreshNotifications();
    // The bell stays mounted for the whole session, so it must keep up with
    // notices written after sign-in: refresh on return to the tab and on a slow timer.
    const refresh = () => { if (document.visibilityState !== "hidden") refreshNotifications(); };
    const timer = setInterval(refresh, NOTIFICATION_REFRESH_MS);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [userId]);
  // Never render another account's feed, even for the render before the effect switches it.
  const current = userId && snapshot.userId === userId ? snapshot : null;
  return {
    items: current?.items ?? [],
    error: current?.error ?? "",
    busy: current?.busy ?? null,
    loading: Boolean(userId) && !current?.loaded && !current?.error,
    markRead: markNotificationRead,
    markAllRead: markAllNotificationsRead,
    refresh: () => refreshNotifications({ force: true }),
  };
}

function MarkAllReadButton({ unread, busy, onMarkAllRead }) {
  if (!unread) return null;
  return <button type="button" className="secondary" disabled={Boolean(busy)} onClick={onMarkAllRead}>Mark all read</button>;
}

const RECORD_TARGET = /^(posting|proposal)\/[A-Za-z0-9_-]{1,128}$/;
function recordTarget(item) {
  return RECORD_TARGET.test(item?.navigationTarget || "") ? item.navigationTarget : null;
}
function recordLabel(item, target) {
  if (item.kind === "escrow") return "View escrow payment";
  if (item.kind === "matching" || item.kind === "approval_nearing_expiry") return "View matching status";
  return target.startsWith("proposal/") ? "View proposal" : "View posting";
}

function NotificationFeed({ items, error, busy, loading, onMarkRead, onRetry, onNavigate }) {
  const openRecord = (target) => { onNavigate?.(); go(target); };
  return <>
    {error && <p role="alert" className="error-banner">{error}{onRetry && <> <button type="button" className="text-button" onClick={onRetry}>Retry</button></>}</p>}
    {loading && !items.length ? <p className="table-empty" role="status">Loading notices…</p> : items.length ? items.map((item) => {
      const target = recordTarget(item);
      const body = <>
        {noticeWorkflowStatus(item) && <StatusBadge status={noticeWorkflowStatus(item)} interactive={false} />}
        <strong>{item.message || "A moderation decision was recorded on your content."}</strong>
        <p>{item.reason?.replaceAll("_", " ")}</p>
        {item.details && <p>{item.details}</p>}
        <small>{item.contentType} · {item.contentId} · {formatInstant(item.createdAt)}</small>
        {target && <span className="notification-record-action">{recordLabel(item, target)}</span>}
      </>;
      return <div className={`table-row${item.read ? "" : " is-unread"}`} key={item.id}>
        {target
          ? <button type="button" className="notification-record" onClick={() => openRecord(target)}>{body}</button>
          : <div>{body}</div>}
        {!item.read && <button type="button" className="secondary" disabled={Boolean(busy)} onClick={() => onMarkRead(item.id)}>Mark read</button>}
      </div>;
    }) : <p className="table-empty">No content notices.</p>}
  </>;
}

export function ModerationNotifications({ userId }) {
  const { items, error, busy, loading, markRead, markAllRead, refresh } = useModerationNotifications(userId);
  const unread = items.filter((item) => !item.read).length;
  return <section className="card-table moderation-notifications">
    <div className="table-header">
      <h2>Content, matching & payment notices</h2>
      <MarkAllReadButton unread={unread} busy={busy} onMarkAllRead={markAllRead} />
    </div>
    <NotificationFeed items={items} error={error} busy={busy} loading={loading} onMarkRead={markRead} onRetry={refresh} />
  </section>;
}

export function NotificationCentre({ userId }) {
  const { items, error, busy, loading, markRead, markAllRead, refresh } = useModerationNotifications(userId);
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
      onClick={() => {
        // Opening the bell re-reads the shared feed, so it matches the Profile page.
        if (!open) refreshNotifications();
        setOpen((current) => !current);
      }}
    >
      <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M6 9a6 6 0 0 1 12 0c0 7 3 7 3 9H3c0-2 3-2 3-9" />
        <path d="M10 20a2 2 0 0 0 4 0" />
      </svg>
      {unread > 0 && <span className="notification-unread-count" aria-hidden="true">{unread}</span>}
    </button>
    {open && <div id="notification-centre-panel" className="notification-centre-panel nav-dropdown-menu" role="region" aria-label="Notifications">
      <div className="nav-dropdown-header notification-centre-heading">
        <span className="eyebrow">Notifications</span>
        <MarkAllReadButton unread={unread} busy={busy} onMarkAllRead={markAllRead} />
      </div>
      <div className="notification-centre-feed">
        <NotificationFeed items={items} error={error} busy={busy} loading={loading} onMarkRead={markRead} onRetry={refresh} onNavigate={() => setOpen(false)} />
      </div>
    </div>}
  </div>;
}
