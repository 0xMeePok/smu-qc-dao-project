import { useEffect, useRef, useState } from "react";

export function BrandMark({ size = 28 }) {
  return <svg className="brand-mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden="true">
    <defs><linearGradient id="qc-brand-gradient" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stopColor="#3b9bff" /><stop offset="1" stopColor="#0060df" /></linearGradient></defs>
    <rect width="32" height="32" rx="8" fill="url(#qc-brand-gradient)" />
    <circle cx="14.5" cy="14.5" r="7" fill="none" stroke="#fff" strokeWidth="2.4" />
    <circle cx="14.5" cy="14.5" r="2.1" fill="#fff" />
    <path d="M19.6 19.6 23 23" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" />
    <circle cx="23.6" cy="23.6" r="2" fill="#fff" />
  </svg>;
}

export function ResponsiveHeader({ route, primaryRoutes, workspaceRoutes, desktopWorkspaces, accountControls, onNavigate }) {
  const [open, setOpen] = useState(false);
  const header = useRef(null);
  const toggle = useRef(null);

  useEffect(() => { setOpen(false); }, [route]);
  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 901px)");
    const closeOnDesktop = () => { if (desktop.matches) setOpen(false); };
    desktop.addEventListener("change", closeOnDesktop);
    return () => desktop.removeEventListener("change", closeOnDesktop);
  }, []);
  useEffect(() => {
    if (!open) return;
    const dismiss = (event) => { if (!header.current?.contains(event.target)) setOpen(false); };
    const escape = (event) => {
      if (event.key === "Escape") { setOpen(false); toggle.current?.focus(); }
    };
    document.addEventListener("pointerdown", dismiss);
    document.addEventListener("keydown", escape);
    return () => { document.removeEventListener("pointerdown", dismiss); document.removeEventListener("keydown", escape); };
  }, [open]);

  const navigate = (key) => { setOpen(false); onNavigate(key); };
  const navButton = ({ key, label }) => <button key={key} type="button" className={route === key ? "active" : ""}
    aria-current={route === key ? "page" : undefined} onClick={() => navigate(key)}>{label}</button>;

  return <header className="topbar" ref={header} onBlur={(event) => {
    if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  }}>
    <div className="topbar-left">
      <button className="brand" type="button" onClick={() => navigate("home")} aria-label="QC DAO home"><BrandMark />QC DAO</button>
      <button ref={toggle} className="mobile-menu-toggle" type="button" aria-label={open ? "Close navigation menu" : "Open navigation menu"}
        aria-expanded={open} aria-controls="header-navigation" onClick={() => setOpen((previous) => !previous)}>
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
          {open ? <path d="m6 6 12 12M6 18 18 6" /> : <path d="M4 6h16M4 12h16M4 18h16" />}
        </svg>
      </button>
    </div>
    <div id="header-navigation" className={`topbar-panel${open ? " is-open" : ""}`}>
      <nav aria-label="Primary navigation">
        <div className="primary-nav-links">{primaryRoutes.map(navButton)}</div>
        {workspaceRoutes.length > 0 && <>
          <div className="desktop-workspaces">{desktopWorkspaces}</div>
          <div className="mobile-workspaces"><span className="eyebrow">Workspaces</span><div>{workspaceRoutes.map(navButton)}</div></div>
        </>}
      </nav>
      <div className="topbar-right">{accountControls}</div>
    </div>
  </header>;
}
