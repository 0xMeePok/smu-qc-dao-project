import { useEffect, useRef, useState } from "react";
import { listModerationNotifications, markModerationNotificationRead, moderationError } from "../lib/moderation.js";
import { formatInstant } from "../lib/datetime.js";
import { go } from "../lib/router.js";

export function ModerationNotifications({ userId }) {
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
  return <section className="card-table moderation-notifications"><div className="table-header"><h2>Content & matching notices</h2></div>{error && <p role="alert" className="error-banner">{error}</p>}{items.length ? items.map((item) => <div className="table-row" key={item.id}><div><strong>{item.message || "A moderation decision was recorded on your content."}</strong><p>{item.reason?.replaceAll("_", " ")}</p>{item.details && <p>{item.details}</p>}<small>{item.contentType} · {item.contentId} · {formatInstant(item.createdAt)}</small>{item.navigationTarget && /^posting\/[A-Za-z0-9_-]+$/.test(item.navigationTarget) && <button type="button" className="text-button" onClick={() => go(item.navigationTarget)}>View matching status</button>}</div>{!item.read && <button type="button" className="secondary" disabled={Boolean(busy)} onClick={() => markRead(item.id)}>Mark read</button>}</div>) : <p className="table-empty">No content notices.</p>}</section>;
}
