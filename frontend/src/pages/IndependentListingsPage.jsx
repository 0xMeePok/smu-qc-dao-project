import { useCallback, useEffect, useMemo, useState } from "react";
import { useAuth } from "../context/AuthContext.jsx";
import { listIndependentListings } from "../lib/proposals.js";
import { queueError } from "../lib/proposalQueues.js";
import { PROPOSAL_CATEGORIES, PROPOSAL_MATURITY_LEVELS } from "../config/proposal.js";
import { formatInstantDate } from "../lib/datetime.js";
import {
  DEFAULT_LISTING_FILTERS,
  DISCOVERY_TIME_OPTIONS,
  discoverListings,
  hasActiveListingFilters,
  listingFilterCount,
  listingParams,
  parseListingParams,
} from "../lib/opportunityDiscovery.js";
import {
  DiscoveryFilterPanel,
  DiscoveryFundingRange,
  DiscoveryPagination,
  DiscoverySearchRow,
  DiscoverySelectField,
  DiscoveryTable,
  OpportunityListSkeleton,
} from "../components/DiscoveryControls.jsx";

const categoryLabel = (value) => PROPOSAL_CATEGORIES.find((item) => item.value === value)?.label ?? value ?? "—";
const readinessLabel = (value) => PROPOSAL_MATURITY_LEVELS.find((item) => item.value === value)?.label ?? value ?? "—";

function fundingLabel(item) {
  const amount = Number(item.amount);
  if (!Number.isFinite(amount)) return "—";
  const formatted = amount.toLocaleString();
  return item.currency ? `${item.currency} ${formatted}` : formatted;
}

function syncSolutionsUrl(filters) {
  const query = listingParams(filters).toString();
  const hash = `#/solutions${query ? `?${query}` : ""}`;
  if (window.location.hash !== hash) {
    window.history.replaceState(window.history.state, "", hash);
  }
}

export default function IndependentListingsPage({ onNavigate, params = new URLSearchParams() }) {
  const { isAuthenticated } = useAuth();
  const [items, setItems] = useState([]);
  const [cursor, setCursor] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const paramsKey = params.toString();
  const [filters, setFilters] = useState(() => parseListingParams(params));
  const activeFilters = hasActiveListingFilters(filters);
  const panelFilterCount = listingFilterCount(filters);
  const [filtersOpen, setFiltersOpen] = useState(panelFilterCount > 0);

  useEffect(() => {
    setFilters(parseListingParams(params));
  }, [paramsKey]);

  const load = useCallback(async (append = false, nextCursor = null) => {
    setLoading(true); setError("");
    try {
      const page = await listIndependentListings({ cursor: append ? nextCursor : null });
      const rows = page?.items ?? [];
      setItems((current) => append
        ? [...current, ...rows.filter((item) => !current.some((old) => old.id === item.id))]
        : rows);
      setCursor(page?.nextCursor ?? null);
    } catch (err) {
      setError(queueError(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { if (isAuthenticated) load(); }, [isAuthenticated, load]);

  const organisations = useMemo(() => (
    [...new Set(items.map((item) => item.organisation).filter(Boolean))]
      .sort((left, right) => left.localeCompare(right))
  ), [items]);
  const results = useMemo(() => discoverListings(items, filters), [items, filters]);

  const updateFilters = (changes) => {
    setFilters((current) => {
      const next = { ...current, ...changes, page: changes.page ?? 1 };
      syncSolutionsUrl(next);
      return next;
    });
  };

  const clearFilters = () => {
    setFilters(DEFAULT_LISTING_FILTERS);
    syncSolutionsUrl(DEFAULT_LISTING_FILTERS);
  };

  const openListing = (item) => onNavigate(`proposal/${item.id}`);

  return (
    <section className="page discover-page">
      <div className="page-heading">
        <h1>Independent solutions.</h1>
        <p>Published listings that are not attached to an existing problem statement. Funders and clients can approach the author with funding while the listing window is open.</p>
      </div>

      <DiscoverySearchRow
        query={filters.query}
        onQueryChange={(query) => updateFilters({ query })}
        searchLabel="Search listings"
        placeholder="Search title, summary or organisation"
        filtersOpen={filtersOpen}
        onToggleFilters={() => setFiltersOpen((open) => !open)}
        filterCount={panelFilterCount}
        panelId="solutions-filter-panel"
      />

      {filtersOpen && (
        <DiscoveryFilterPanel id="solutions-filter-panel" label="Listing filters" showClear={activeFilters} onClear={clearFilters}>
          <DiscoverySelectField
            label="Quantum category"
            value={filters.category}
            onChange={(category) => updateFilters({ category })}
            emptyLabel="All categories"
            options={PROPOSAL_CATEGORIES}
          />
          <DiscoverySelectField
            label="Readiness level"
            value={filters.readiness}
            onChange={(readiness) => updateFilters({ readiness })}
            emptyLabel="All readiness levels"
            options={PROPOSAL_MATURITY_LEVELS}
          />
          <DiscoverySelectField
            label="Organisation"
            value={filters.organisation}
            onChange={(organisation) => updateFilters({ organisation })}
            emptyLabel="All organisations"
            options={organisations.map((organisation) => ({ value: organisation, label: organisation }))}
          />
          <DiscoverySelectField
            label="Closes within"
            value={filters.timeRemaining}
            onChange={(timeRemaining) => updateFilters({ timeRemaining })}
            emptyLabel="Any closing date"
            options={DISCOVERY_TIME_OPTIONS}
          />
          <DiscoveryFundingRange
            minimum={filters.minimumFunding}
            maximum={filters.maximumFunding}
            onMinimumChange={(minimumFunding) => updateFilters({ minimumFunding })}
            onMaximumChange={(maximumFunding) => updateFilters({ maximumFunding })}
          />
        </DiscoveryFilterPanel>
      )}

      <div className="discover-toolbar">
        <div className="discover-toolbar-end">
          {!loading && !error && items.length > 0 && (
            <span className="discover-results-summary" aria-live="polite">
              {results.totalResults} {results.totalResults === 1 ? "listing" : "listings"}
              {results.totalPages > 1 && ` · showing ${results.firstResult}–${results.lastResult}`}
            </span>
          )}
        </div>
      </div>

      {cursor && <p className="notice">Filters apply to the listings loaded so far. Load more to search further.</p>}
      {error && <p className="notice notice-error" role="alert">{error}</p>}
      {loading && items.length === 0 && <OpportunityListSkeleton label="Loading listings" />}
      {!loading && !error && items.length === 0 && (
        <div className="discover-empty" role="status">
          <h2>No independent listings yet</h2>
          <p>Published, unexpired solutions will appear here. Open opportunities stay on Discover.</p>
          <button className="secondary" type="button" onClick={() => onNavigate("discover")}>Browse opportunities</button>
        </div>
      )}
      {items.length > 0 && (
        results.totalResults === 0 ? (
          <div className="discover-empty discover-no-results" role="status">
            <h2>No matches</h2>
            <p>Try a different search or clear your filters.</p>
            <button className="secondary" type="button" onClick={clearFilters}>Clear all filters</button>
          </div>
        ) : (
          <>
            <DiscoveryTable
              rows={results.items}
              columns={[
                {
                  key: "title",
                  label: "Title",
                  render: (item) => (
                    <>
                      <button className="opportunity-table-link" type="button" onClick={() => openListing(item)}>{item.title || "Untitled listing"}</button>
                      <small>{categoryLabel(item.category)}</small>
                    </>
                  ),
                },
                { key: "organisation", label: "Organisation", render: (item) => item.organisation || "—" },
                { key: "readiness", label: "Readiness", render: (item) => readinessLabel(item.maturity) },
                { key: "funding", label: "Funding sought", numeric: true, render: (item) => fundingLabel(item) },
                { key: "closes", label: "Closes", numeric: true, render: (item) => formatInstantDate(item.expiresAt) },
              ]}
            />
            <DiscoveryPagination
              label="Listing pages"
              page={results.page}
              totalPages={results.totalPages}
              onPrevious={() => updateFilters({ page: results.page - 1 })}
              onNext={() => updateFilters({ page: results.page + 1 })}
            />
          </>
        )
      )}
      {cursor && (
        <div className="discover-load-more">
          <button type="button" className="secondary" disabled={loading} onClick={() => load(true, cursor)}>
            {loading ? "Loading…" : "Load more listings"}
          </button>
        </div>
      )}
    </section>
  );
}
