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
    <div className="brief-type-switch" aria-label="Opportunity type">
      {TYPES.map((type) => (
        <button
          key={type.value}
          className={activeType === type.value ? "selected" : ""}
          type="button"
          disabled={disabled}
          aria-pressed={activeType === type.value}
          onClick={() => onNavigate(type.route)}
        >
          <strong>{type.label}</strong>
          <span>{type.note}</span>
        </button>
      ))}
    </div>
  );
}
