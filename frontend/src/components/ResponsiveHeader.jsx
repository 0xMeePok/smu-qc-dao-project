import { useEffect, useRef, useState } from "react";

export function ResponsiveHeader({ route, primaryRoutes, workspaceRoutes, desktopWorkspaces, accountControls, onNavigate }) {
  const [open, setOpen] = useState(false);
  const header = useRef(null);
  const toggle = useRef(null);

  useEffect(() => { setOpen(false); }, [route]);
  useEffect(() => {
    const desktop = window.matchMedia("(min-width: 1201px)");
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
      <button className="brand" type="button" onClick={() => navigate("home")} aria-label="QC DAO home"><span aria-hidden="true">Q</span>QC DAO</button>
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
