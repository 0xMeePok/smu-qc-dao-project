import { useEffect, useId, useRef, useState } from "react";

const TOKEN_DETAILS = {
  USDC: { name: "USD Coin", mark: "$", tone: "usdc" },
  USDT: { name: "Tether USD", mark: "₮", tone: "usdt" },
  XSGD: { name: "Singapore Dollar", mark: "S$", tone: "xsgd" },
};

function TokenIdentity({ value, label, description, detail = false }) {
  const token = TOKEN_DETAILS[value];
  return <span className="token-select-identity">
    {token && <span className={`token-select-mark token-select-mark--${token.tone}`} aria-hidden="true">{token.mark}</span>}
    <span className="token-select-copy"><span>{label}</span>{detail && (description || token) && <small>{description || token.name}</small>}</span>
  </span>;
}

/** The same controlled values as a native select, with a consistent token picker. */
export function TokenSelect({ id, name, value, onChange, options, disabled = false, required = false,
  "aria-label": ariaLabel, "aria-invalid": invalid, "aria-describedby": describedBy }) {
  const generatedId = useId();
  const controlId = id || `token-${generatedId}`;
  const listId = `${controlId}-options`;
  const root = useRef(null);
  const trigger = useRef(null);
  const search = useRef({ text: "", at: 0 });
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const selected = options.findIndex((option) => option.value === value);
  const expanded = open && !disabled;
  const activeIndex = Math.max(0, Math.min(options.length - 1, active));
  const selectedOption = options[selected];

  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);

  useEffect(() => {
    if (!expanded) return;
    const dismiss = (event) => { if (!root.current?.contains(event.target)) setOpen(false); };
    document.addEventListener("pointerdown", dismiss);
    return () => document.removeEventListener("pointerdown", dismiss);
  }, [expanded]);
  useEffect(() => {
    if (expanded) document.getElementById(`${listId}-${activeIndex}`)?.scrollIntoView?.({ block: "nearest" });
  }, [expanded, activeIndex, listId]);

  const choose = (index) => {
    if (disabled || trigger.current?.matches(":disabled") || !options[index]) return;
    onChange({ target: { id: controlId, name, value: options[index].value } });
    setOpen(false);
    trigger.current?.focus();
  };
  const keyDown = (event) => {
    if (event.key === "Tab") { setOpen(false); return; }
    if (event.key === "Escape") {
      if (expanded) { event.preventDefault(); event.stopPropagation(); }
      setOpen(false); return;
    }
    if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
      event.preventDefault();
      setActive(event.key === "Home" ? 0 : event.key === "End" ? options.length - 1
        : !expanded ? Math.max(0, selected) : Math.max(0, Math.min(options.length - 1, activeIndex + (event.key === "ArrowDown" ? 1 : -1))));
      setOpen(true);
    } else if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      if (expanded) choose(activeIndex);
      else { setActive(Math.max(0, selected)); setOpen(true); }
    } else if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
      event.preventDefault();
      const now = Date.now();
      search.current = { text: (now - search.current.at < 700 ? search.current.text : "") + event.key.toLowerCase(), at: now };
      const match = options.findIndex((option) => `${option.label} ${TOKEN_DETAILS[option.value]?.name || ""}`.toLowerCase().startsWith(search.current.text));
      if (match >= 0) { setActive(match); setOpen(true); }
    }
  };

  return <div className="token-select" ref={root} onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
    <button id={controlId} name={name} value={value} ref={trigger} type="button" role="combobox" className="token-select-trigger"
      disabled={disabled || !options.length} aria-label={ariaLabel} aria-expanded={expanded} aria-controls={listId} aria-haspopup="listbox"
      aria-required={required || undefined} aria-invalid={invalid} aria-describedby={describedBy}
      aria-activedescendant={expanded ? `${listId}-${activeIndex}` : undefined}
      onKeyDown={keyDown} onClick={() => { setActive(Math.max(0, selected)); setOpen(!expanded); }}>
      <TokenIdentity value={value} label={selectedOption?.label || "Choose a token"} />
      <svg viewBox="0 0 20 20" width="18" height="18" fill="none" aria-hidden="true"><path d="m5 7.5 5 5 5-5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>
    </button>
    {expanded && <ul id={listId} role="listbox" aria-label={ariaLabel || "Available tokens"} className="token-select-options">
      {options.map((option, index) => <li key={option.value} id={`${listId}-${index}`} role="option" aria-label={option.label} aria-selected={index === selected}
        className={index === activeIndex ? "is-active" : undefined} onPointerMove={() => setActive(index)}
        onMouseDown={(event) => event.preventDefault()} onClick={() => choose(index)}>
        <TokenIdentity value={option.value} label={option.label} description={option.description} detail />
        <svg className="token-select-check" viewBox="0 0 20 20" width="18" height="18" fill="none" aria-hidden="true" style={{ visibility: index === selected ? "visible" : "hidden" }}><path d="m4 10 4 4 8-8" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" /></svg>
      </li>)}
    </ul>}
  </div>;
}
