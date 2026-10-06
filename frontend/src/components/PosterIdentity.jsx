import { shortenAddress } from "../lib/chain.js";

/** Public name and organisation, linking to the member's profile. */
export function PosterIdentity({ ownerId, organisation, poster, onNavigate, label = "Posted by" }) {
  if (!ownerId) return null;
  const name = String(poster?.fullName ?? "").trim();
  const org = String(poster?.organisation ?? organisation ?? "").trim();
  const primary = name || org || shortenAddress(ownerId);
  const secondary = name ? org : org ? shortenAddress(ownerId) : "";
  return (
    <div>
      <dt>{label}</dt>
      <dd>
        <button
          className="profile-link poster-identity"
          type="button"
          onClick={() => onNavigate(`profile/${ownerId}`)}
        >
          <span>{primary}</span>
          {secondary ? <small>{secondary}</small> : null}
        </button>
      </dd>
    </div>
  );
}
