// Long-form record fields grouped a few at a time under one heading, instead
// of one card per field. Shared by the posting and proposal detail pages.

export function DetailItem({ heading, children }) {
  const text = String(children ?? "").trim();
  if (!text) return null;
  return (
    <div className="detail-item">
      <h3>{heading}</h3>
      <p>{text}</p>
    </div>
  );
}

// Renders nothing when every field in it is empty.
export function DetailGroup({ title, children }) {
  const items = (Array.isArray(children) ? children : [children])
    .filter((child) => String(child?.props?.children ?? "").trim());
  if (!items.length) return null;
  return (
    <section className="detail-section detail-group">
      <h2>{title}</h2>
      {items}
    </section>
  );
}
