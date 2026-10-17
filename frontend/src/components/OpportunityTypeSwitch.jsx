const TYPES = [
  {
    value: "business-problem",
    label: "Business problem",
    note: "Start with a defined challenge.",
    route: "create",
  },
  {
    value: "open-funding",
    label: "Open funding",
    note: "Invite researchers to propose the problem and solution.",
    route: "create/open-funding",
  },
];

export function OpportunityTypeSwitch({ activeType, onNavigate, disabled = false }) {
  return (
    <div className="brief-type-switch" role="group" aria-label="Opportunity type">
      {TYPES.map((type) => {
        const selected = activeType === type.value;
        const id = `brief-type-${type.value}`;
        return (
          <button
            key={type.value}
            className={selected ? "selected" : ""}
            type="button"
            disabled={disabled}
            aria-labelledby={`${id}-label`}
            aria-describedby={`${id}-note`}
            aria-pressed={selected}
            onClick={() => onNavigate(type.route)}
          >
            <strong id={`${id}-label`}>{type.label}</strong>
            <span id={`${id}-note`}>{type.note}</span>
          </button>
        );
      })}
    </div>
  );
}
