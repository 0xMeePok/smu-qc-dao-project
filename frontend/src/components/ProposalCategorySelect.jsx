import { useEffect, useRef, useState } from "react";
import { PROPOSAL_CATEGORIES } from "../config/proposal.js";

export function ProposalCategorySelect({ id, value, onChange, disabled, invalid, describedBy }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const root = useRef(null);
  const trigger = useRef(null);
  const search = useRef({ text: "", at: 0 });
  const selected = PROPOSAL_CATEGORIES.findIndex((option) => option.value === value);
  const expanded = open && !disabled;
  const listId = `${id}-options`;

  useEffect(() => {
    if (!expanded) return;
    const dismiss = (event) => { if (!root.current?.contains(event.target)) setOpen(false); };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [expanded]);

  useEffect(() => {
    if (expanded) document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: "nearest" });
  }, [expanded, active, listId]);

  const choose = (index) => {
    onChange(PROPOSAL_CATEGORIES[index].value);
    setOpen(false);
    trigger.current?.focus();
  };
  const keyDown = (event) => {
    if (event.key === "Tab") { setOpen(false); return; }
    if (event.key === "Escape") { if (expanded) event.preventDefault(); setOpen(false); return; }
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      const last = PROPOSAL_CATEGORIES.length - 1;
      setActive(event.key === "Home" ? 0 : event.key === "End" ? last : !expanded ? Math.max(0, selected) : Math.max(0, Math.min(last, active + (event.key === "ArrowDown" ? 1 : -1))));
      setOpen(true);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (expanded) choose(active);
      else { setActive(Math.max(0, selected)); setOpen(true); }
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      const now = Date.now();
      search.current = { text: (now - search.current.at < 700 ? search.current.text : "") + event.key.toLowerCase(), at: now };
      const match = PROPOSAL_CATEGORIES.findIndex((option) => option.label.toLowerCase().startsWith(search.current.text));
      if (match >= 0) { setActive(match); setOpen(true); }
    }
  };

  return <div className="proposal-category" ref={root} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
    <button id={id} ref={trigger} type="button" role="combobox" className="proposal-category-trigger"
      disabled={disabled} aria-expanded={expanded} aria-controls={listId} aria-haspopup="listbox"
      aria-required="true" aria-invalid={invalid} aria-describedby={describedBy}
      aria-activedescendant={expanded ? `${listId}-${active}` : undefined}
      onKeyDown={keyDown} onClick={() => { setActive(Math.max(0, selected)); setOpen(!expanded); }}>
      <span className={selected < 0 ? "proposal-category-placeholder" : undefined}>{selected < 0 ? "Choose an approach" : PROPOSAL_CATEGORIES[selected].label}</span>
      <svg viewBox="0 0 20 20" width="20" height="20" fill="none" aria-hidden="true"><path d="m5 7.5 5 5 5-5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" /></svg>
    </button>
    {expanded && <ul id={listId} role="listbox" aria-label="Quantum or quantum-adjacent category" className="proposal-category-options">
      {PROPOSAL_CATEGORIES.map((option, index) => <li key={option.value} id={`${listId}-${index}`} role="option" aria-selected={index === selected}
        className={index === active ? "is-active" : undefined} onPointerMove={() => setActive(index)}
        onMouseDown={(event) => event.preventDefault()} onClick={() => choose(index)}>
        <span>{option.label}</span><span className="proposal-category-check" aria-hidden="true">{index === selected ? "✓" : ""}</span>
      </li>)}
    </ul>}
  </div>;
}
