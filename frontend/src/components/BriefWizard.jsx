import { useState } from "react";

/**
 * The step-by-step frame shared by the two brief forms (business problem and
 * open funding).
 *
 * Every step stays mounted and inactive ones are only hidden with CSS. The form is
 * still one <form>: a submit from any step validates every field, and in-flight
 * attachment uploads are not cancelled by moving between steps (unmounting the
 * uploader cancels its transfers).
 */
export function useWizard(steps) {
  const [current, setCurrent] = useState(0);
  const last = steps.length - 1;
  const goTo = (index) => {
    setCurrent(Math.max(0, Math.min(last, index)));
    if (typeof window !== "undefined" && typeof window.scrollTo === "function") {
      try { window.scrollTo({ top: 0, behavior: "smooth" }); } catch { /* jsdom */ }
    }
  };

  // The first step holding one of these field errors, so a failed submit lands
  // the owner on the field that needs attention.
  // Cleared errors stay in state as `undefined`, so only count ones with a message.
  const errorKeys = (errors) => Object.keys(errors ?? {}).filter((key) => errors[key]);

  const stepWithError = (errors) => {
    const keys = errorKeys(errors);
    const index = steps.findIndex((step) => (step.fields ?? []).some((field) => keys.includes(field)));
    return index === -1 ? null : index;
  };

  const errorSteps = (errors) => {
    const keys = errorKeys(errors);
    return new Set(steps
      .map((step, index) => ((step.fields ?? []).some((field) => keys.includes(field)) ? index : null))
      .filter((index) => index !== null));
  };

  return {
    current,
    isFirst: current === 0,
    isLast: current === last,
    goTo,
    next: () => goTo(current + 1),
    back: () => goTo(current - 1),
    stepWithError,
    errorSteps,
  };
}

// `lockForward` holds the owner on the current step or earlier, e.g. while an
// attachment is still uploading; going back stays open.
export function WizardSteps({ steps, current, onSelect, errorSteps = new Set(), lockForward = false }) {
  return (
    <ol className="wizard-steps" aria-label="Brief steps">
      {steps.map((step, index) => {
        const active = index === current;
        const done = index < current;
        const invalid = errorSteps.has(index);
        return (
          <li key={step.label}>
            <button
              type="button"
              className={`wizard-step-pill${active ? " is-active" : ""}${done ? " is-done" : ""}${invalid ? " is-invalid" : ""}`}
              aria-current={active ? "step" : undefined}
              disabled={lockForward && index > current}
              onClick={() => onSelect(index)}
            >
              <span className="wizard-step-number" aria-hidden="true">{invalid ? "!" : done ? "✓" : index + 1}</span>
              {step.label}
              {invalid && <span className="sr-only"> (needs attention)</span>}
            </button>
          </li>
        );
      })}
    </ol>
  );
}

export function WizardPanel({ index, current, children }) {
  return (
    <div className={`wizard-panel${index === current ? " is-active" : ""}`} data-step={index + 1}>
      {children}
    </div>
  );
}

export function ReviewRows({ rows, onEdit }) {
  return (
    <dl className="wizard-review">
      {rows.map((row) => (
        <div key={row.label}>
          <dt>{row.label}</dt>
          <dd className={row.value ? "" : "is-empty"}>{row.value || row.empty || "Not added"}</dd>
          <button type="button" className="text-button" onClick={() => onEdit(row.step)}>
            Edit<span className="sr-only"> {row.label}</span>
          </button>
        </div>
      ))}
    </dl>
  );
}

export function BriefPreview({ kind, organisation, title, titleFallback, description, descriptionFallback, fundingLabel, funding, until, tags }) {
  return (
    <aside className="preview-panel" aria-label="Live preview">
      <div className="preview-label">Preview</div>
      <div className="preview-sticky">
        <small className="preview-kicker">{kind} · {organisation || "Your organisation"}</small>
        <h3 className={title ? "" : "is-placeholder"}>{title || titleFallback}</h3>
        <p>{description || descriptionFallback}</p>
        {tags?.length > 0 && (
          <div className="tag-list">
            {tags.map((tag) => <span className="tag-chip static" key={tag}>{tag}</span>)}
          </div>
        )}
        <div className="preview-meta">
          <div>
            <small>{fundingLabel}</small>
            <strong>{funding || "—"}</strong>
          </div>
          <div>
            <small>Open until</small>
            <strong>{until || "—"}</strong>
          </div>
        </div>
      </div>
    </aside>
  );
}
