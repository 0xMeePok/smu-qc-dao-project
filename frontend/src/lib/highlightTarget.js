const timers = new WeakMap();

/** Scroll a record into view and flash it so the jump has a visible target. */
export function highlightElement(id) {
  const element = typeof document === "undefined" ? null : document.getElementById(id);
  if (!element) return false;
  if ("open" in element) element.open = true;
  element.classList.add("is-referenced");
  element.scrollIntoView?.({ behavior: "smooth", block: "center" });
  window.clearTimeout(timers.get(element));
  timers.set(element, window.setTimeout(() => element.classList.remove("is-referenced"), 2200));
  return true;
}

/** Comments and receipts mount after the tab switch. Retry briefly. */
export function highlightWhenPresent(id, attempts = 20) {
  if (highlightElement(id) || attempts <= 1) return;
  window.setTimeout(() => highlightWhenPresent(id, attempts - 1), 150);
}
