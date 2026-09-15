import { VERIFIED_BADGE_HINT } from "../config/verifiedBadge.js";

const ON_CHAIN = [
  "Content and attachment hashes",
  "Anchor timestamp",
  "Submitting wallet",
];

const OFF_CHAIN = [
  "Record body",
  "File attachments",
  "Evaluations",
  "Workflow status",
];

/**
 * Static on-chain vs off-chain key. Used on the architecture help screen and
 * admin audit tabs so the verification split is visible in the product.
 */
export function OnChainOffChainLegend({
  compact = false,
  headingLevel = "h2",
  architectureLink = false,
  onNavigate,
}) {
  const Heading = headingLevel === "h3" ? "h3" : "h2";
  const PanelHeading = headingLevel === "h3" ? "h4" : "h3";

  return (
    <section
      className={`chain-legend${compact ? " chain-legend-compact" : ""}`}
      aria-labelledby="chain-legend-heading"
    >
      <Heading id="chain-legend-heading">On-chain versus off-chain</Heading>
      <p>{VERIFIED_BADGE_HINT}</p>
      <div className="chain-legend-grid">
        <div className="chain-legend-panel chain-legend-on">
          <PanelHeading>On-chain</PanelHeading>
          <p>Arbitrum Sepolia</p>
          <ul>
            {ON_CHAIN.map((item) => <li key={item}>{item}</li>)}
          </ul>
        </div>
        <div className="chain-legend-panel chain-legend-off">
          <PanelHeading>Off-chain</PanelHeading>
          <p>Firestore</p>
          <ul>
            {OFF_CHAIN.map((item) => <li key={item}>{item}</li>)}
          </ul>
        </div>
      </div>
      {architectureLink && onNavigate ? (
        <button className="text-button" type="button" onClick={() => onNavigate("architecture")}>
          Architecture help
        </button>
      ) : null}
    </section>
  );
}
