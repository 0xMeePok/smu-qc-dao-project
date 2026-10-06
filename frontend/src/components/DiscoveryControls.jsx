import { StatusBadge } from "./StatusBadge.jsx";
import { VerifiedBadge } from "./VerifiedBadge.jsx";
import { opportunityWorkflowStatus } from "../config/workflowStatus.js";

export function DiscoverySearchRow({
  query,
  onQueryChange,
  searchLabel,
  placeholder,
  filtersOpen,
  onToggleFilters,
  filterCount,
  panelId,
  sort,
  onSortChange,
  sortOptions,
}) {
  return (
    <div className="discover-search-row">
      <label className="discover-search">
        <span className="sr-only">{searchLabel}</span>
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <circle cx="11" cy="11" r="8" />
          <path d="m21 21-4.3-4.3" />
        </svg>
        <input
          type="search"
          value={query}
          placeholder={placeholder}
          onChange={(event) => onQueryChange(event.target.value)}
        />
      </label>
      <button
        className={`filter-toggle${filtersOpen ? " is-open" : ""}`}
        type="button"
        aria-expanded={filtersOpen}
        aria-controls={panelId}
        onClick={onToggleFilters}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M21 4h-7M10 4H3M21 12h-9M8 12H3M21 20h-5M12 20H3M14 2v4M8 10v4M16 18v4" />
        </svg>
        Filters{filterCount > 0 ? ` · ${filterCount}` : ""}
      </button>
      {sortOptions && (
        <label className="discover-sort">
          <span className="sr-only">Sort by</span>
          <select value={sort} onChange={(event) => onSortChange(event.target.value)}>
            {sortOptions.map((option) => (
              <option value={option.value} key={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
      )}
    </div>
  );
}

export function DiscoveryFilterPanel({ id, label, showClear, onClear, children }) {
  return (
    <div id={id} className="discover-filter-panel" aria-label={label}>
      {children}
      {showClear && (
        <button className="text-button discover-clear" type="button" onClick={onClear}>Clear filters</button>
      )}
    </div>
  );
}

export function DiscoverySelectField({ label, value, onChange, emptyLabel, options }) {
  return (
    <label>
      <span>{label}</span>
      <select value={value} onChange={(event) => onChange(event.target.value)}>
        <option value="">{emptyLabel}</option>
        {options.map((option) => (
          <option value={option.value} key={option.value}>{option.label}</option>
        ))}
      </select>
    </label>
  );
}

export function DiscoveryFundingRange({ minimum, maximum, onMinimumChange, onMaximumChange }) {
  return (
    <fieldset className="funding-range">
      <legend>Funding</legend>
      <label>
        <span className="sr-only">Minimum funding</span>
        <input
          min="0"
          inputMode="decimal"
          type="number"
          value={minimum}
          placeholder="Min"
          onChange={(event) => onMinimumChange(event.target.value)}
        />
      </label>
      <label>
        <span className="sr-only">Maximum funding</span>
        <input
          min="0"
          inputMode="decimal"
          type="number"
          value={maximum}
          placeholder="Max"
          onChange={(event) => onMaximumChange(event.target.value)}
        />
      </label>
    </fieldset>
  );
}

export function DiscoveryPagination({ label, page, totalPages, onPrevious, onNext }) {
  if (totalPages <= 1) return null;
  return (
    <nav className="discover-pagination" aria-label={label}>
      <button className="secondary small" type="button" disabled={page === 1} onClick={onPrevious}>
        Previous
      </button>
      <span>Page {page} of {totalPages}</span>
      <button className="secondary small" type="button" disabled={page === totalPages} onClick={onNext}>
        Next
      </button>
    </nav>
  );
}

export function DiscoveryTable({ columns, rows }) {
  return (
    <div className="opportunity-table-scroll">
      <table className="opportunity-table">
        <thead>
          <tr>
            {columns.map((column) => (
              <th scope="col" className={column.numeric ? "numeric" : undefined} key={column.key}>{column.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id}>
              {columns.map((column) => (
                <td className={column.numeric ? "numeric" : undefined} key={column.key}>{column.render(row)}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function OpportunityTrust({ item }) {
  return (
    <span className="trust-status-row">
      <StatusBadge status={opportunityWorkflowStatus(item)} />
      <VerifiedBadge audit={item.audit} recordStatus={item.status} hidePending />
    </span>
  );
}

export function OpportunityTable({ items, onOpen }) {
  return (
    <DiscoveryTable
      rows={items}
      columns={[
        {
          key: "title",
          label: "Title",
          render: (item) => (item.removed ? (
            <>
              <button className="opportunity-table-link" type="button" onClick={() => onOpen(item)}>{item.title}</button>
              <small>Removed due to: {item.reasonLabel}{item.details ? ` — ${item.details}` : ""}</small>
            </>
          ) : (
            <>
              <button className="opportunity-table-link" type="button" onClick={() => onOpen(item)}>{item.title}</button>
              <small>{item.type}</small>
            </>
          )),
        },
        { key: "organisation", label: "Organisation", render: (item) => (item.removed ? "—" : item.owner) },
        { key: "status", label: "Status", render: (item) => (item.removed ? "—" : <OpportunityTrust item={item} />) },
        { key: "funding", label: "Funding", numeric: true, render: (item) => (item.removed ? "—" : item.amount) },
        { key: "proposals", label: "Proposals", numeric: true, render: (item) => (item.removed ? "—" : item.proposalCount) },
        { key: "closes", label: "Closes", numeric: true, render: (item) => (item.removed ? "—" : item.deadline) },
      ]}
    />
  );
}

export function OpportunityListSkeleton({ label = "Loading opportunities" }) {
  return (
    <div className="opportunity-list opportunity-list-skeleton" aria-label={label} aria-busy="true">
      {[0, 1, 2, 3].map((row) => (
        <div className="opportunity-skeleton-row" key={row}>
          <span className="skeleton-lines"><i /><i /></span>
          <span className="skeleton-block" />
        </div>
      ))}
    </div>
  );
}
