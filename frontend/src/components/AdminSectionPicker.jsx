import { useEffect, useRef, useState } from "react";
import { ADMIN_SECTION_GROUPS, getAdminSection } from "../config/adminSections.js";

const SECTIONS = ADMIN_SECTION_GROUPS.flatMap(group => group.sections);

/** Grouped navigation with a contained, keyboard-accessible mobile menu. */
export function AdminSectionPicker({ value, onChange, countFor }) {
  const root = useRef(null), trigger = useRef(null), search = useRef({ text: "", at: 0 });
  const [open, setOpen] = useState(false), [active, setActive] = useState(0);
  const selected = Math.max(0, SECTIONS.findIndex(section => section.key === value));
  const listId = "admin-section-options";

  useEffect(() => {
    if (!open) return undefined;
    const dismiss = event => { if (!root.current?.contains(event.target)) setOpen(false); };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [open]);
  useEffect(() => {
    if (open) document.getElementById(`${listId}-${active}`)?.scrollIntoView?.({ block: "nearest" });
  }, [open, active]);

  const choose = index => {
    if (!SECTIONS[index]) return;
    setOpen(false);
    onChange(SECTIONS[index].key);
    trigger.current?.focus({ preventScroll: true });
  };
  const keyDown = event => {
    if (event.key === "Tab") { setOpen(false); return; }
    if (event.key === "Escape") {
      if (open) { event.preventDefault(); event.stopPropagation(); }
      setOpen(false); return;
    }
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      setActive(event.key === "Home" ? 0 : event.key === "End" ? SECTIONS.length - 1 : !open ? selected
        : Math.max(0, Math.min(SECTIONS.length - 1, active + (event.key === "ArrowDown" ? 1 : -1))));
      setOpen(true);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (open) choose(active);
      else { setActive(selected); setOpen(true); }
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      const now = Date.now();
      search.current = { text: (now - search.current.at < 700 ? search.current.text : "") + event.key.toLowerCase(), at: now };
      const match = SECTIONS.findIndex(section => section.label.toLowerCase().startsWith(search.current.text));
      if (match >= 0) { setActive(match); setOpen(true); }
    }
  };

  return <div className="admin-section-picker" ref={root} onBlur={event => {
    if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false);
  }}>
    <button id="admin-section-select" type="button" role="combobox" className="admin-picker-trigger" ref={trigger} value={value}
      aria-label="Admin section" aria-haspopup="listbox" aria-expanded={open} aria-controls={listId}
      aria-activedescendant={open ? `${listId}-${active}` : undefined} onKeyDown={keyDown}
      onClick={() => { setActive(selected); setOpen(!open); }}>
      <span>{getAdminSection(value)?.label ?? "Overview"}</span>
      <svg viewBox="0 0 20 20" width="18" height="18" fill="none" aria-hidden="true"><path d="m5 7.5 5 5 5-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
    </button>
    {open && <div id={listId} role="listbox" aria-label="Admin sections" className="admin-picker-options">
      {ADMIN_SECTION_GROUPS.map(group => <div role="group" aria-label={group.label} key={group.label}>
        <div className="admin-picker-group-label" aria-hidden="true">{group.label}</div>
        {group.sections.map(section => {
          const index = SECTIONS.findIndex(item => item.key === section.key), count = countFor?.(section.key);
          return <div id={`${listId}-${index}`} role="option" aria-label={section.label} aria-selected={value === section.key}
            className={`admin-picker-option${active === index ? " is-active" : ""}`} key={section.key}
            onPointerMove={() => setActive(index)} onMouseDown={event => event.preventDefault()} onClick={() => choose(index)}>
            <span>{section.label}</span>
            {count != null && <span className="admin-nav-count" aria-hidden="true">{count}</span>}
            <span className="admin-picker-check" aria-hidden="true">{value === section.key ? "✓" : ""}</span>
          </div>;
        })}
      </div>)}
    </div>}
  </div>;
}
