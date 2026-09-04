import { CATEGORY_VALUES } from "../config/postingCategories.js";
import { OPEN_FUNDING_TYPE } from "../config/fundingOpportunity.js";
import { toDate } from "./datetime.js";

export const DISCOVERY_PAGE_SIZE = 6;

export const DISCOVERY_SORT_OPTIONS = Object.freeze([
  { value: "newest", label: "Newest" },
  { value: "closing", label: "Closing soonest" },
  { value: "amount-desc", label: "Funding: high to low" },
  { value: "amount-asc", label: "Funding: low to high" },
]);

export const DISCOVERY_TIME_OPTIONS = Object.freeze([
  { value: "7", label: "Closing within 7 days" },
  { value: "30", label: "Closing within 30 days" },
  { value: "90", label: "Closing within 90 days" },
  { value: "over-90", label: "More than 90 days" },
]);

export const DEFAULT_DISCOVERY_FILTERS = Object.freeze({
  query: "",
  type: "",
  category: "",
  status: "",
  minimumFunding: "",
  maximumFunding: "",
  organisation: "",
  timeRemaining: "",
  sort: "newest",
  page: 1,
});

const VALID_TYPES = new Set(["business-problem", OPEN_FUNDING_TYPE]);
const VALID_SORTS = new Set(DISCOVERY_SORT_OPTIONS.map(({ value }) => value));
const VALID_TIMES = new Set(DISCOVERY_TIME_OPTIONS.map(({ value }) => value));

function clean(value) {
  return String(value ?? "").normalize("NFC").trim();
}

function numericFilter(value) {
  const candidate = clean(value);
  if (candidate === "") return "";
  const number = Number(candidate);
  return Number.isFinite(number) && number >= 0 ? candidate : "";
}

function positivePage(value) {
  const page = Number.parseInt(value, 10);
  return Number.isInteger(page) && page > 0 ? page : 1;
}

/** Parse and constrain a shareable Discover query string. */
export function parseDiscoveryParams(input) {
  const params = input instanceof URLSearchParams
    ? input
    : new URLSearchParams(String(input ?? ""));
  const type = clean(params.get("type"));
  const category = clean(params.get("category"));
  const sort = clean(params.get("sort"));
  const timeRemaining = clean(params.get("closing"));

  return {
    query: clean(params.get("q")),
    type: VALID_TYPES.has(type) ? type : "",
    category: CATEGORY_VALUES.includes(category) ? category : "",
    status: clean(params.get("status")).toLowerCase(),
    minimumFunding: numericFilter(params.get("min")),
    maximumFunding: numericFilter(params.get("max")),
    organisation: clean(params.get("org")),
    timeRemaining: VALID_TIMES.has(timeRemaining) ? timeRemaining : "",
    sort: VALID_SORTS.has(sort) ? sort : DEFAULT_DISCOVERY_FILTERS.sort,
    page: positivePage(params.get("page")),
  };
}

/** Omit defaults so copied links stay readable. */
export function discoveryParams(filters) {
  const params = new URLSearchParams();
  const values = { ...DEFAULT_DISCOVERY_FILTERS, ...filters };

  if (clean(values.query)) params.set("q", clean(values.query));
  if (VALID_TYPES.has(values.type)) params.set("type", values.type);
  if (CATEGORY_VALUES.includes(values.category)) params.set("category", values.category);
  if (clean(values.status)) params.set("status", clean(values.status).toLowerCase());
  if (numericFilter(values.minimumFunding)) params.set("min", numericFilter(values.minimumFunding));
  if (numericFilter(values.maximumFunding)) params.set("max", numericFilter(values.maximumFunding));
  if (clean(values.organisation)) params.set("org", clean(values.organisation));
  if (VALID_TIMES.has(values.timeRemaining)) params.set("closing", values.timeRemaining);
  if (VALID_SORTS.has(values.sort) && values.sort !== DEFAULT_DISCOVERY_FILTERS.sort) {
    params.set("sort", values.sort);
  }
  if (positivePage(values.page) > 1) params.set("page", String(positivePage(values.page)));

  return params;
}

export function hasActiveDiscoveryFilters(filters) {
  const values = { ...DEFAULT_DISCOVERY_FILTERS, ...filters };
  return Boolean(
    clean(values.query)
    || values.type
    || values.category
    || values.status
    || numericFilter(values.minimumFunding)
    || numericFilter(values.maximumFunding)
    || values.organisation
    || values.timeRemaining,
  );
}

function opportunityTypeValue(item) {
  if (item.opportunityType === OPEN_FUNDING_TYPE || item.type === "Open funding") {
    return OPEN_FUNDING_TYPE;
  }
  return "business-problem";
}

function instantMs(value, fallback) {
  return toDate(value)?.getTime() ?? fallback;
}

function searchableText(item) {
  return [
    item.title,
    item.description,
    item.summary,
    item.fundingThesis,
    ...(Array.isArray(item.tags) ? item.tags : []),
  ].map(clean).join(" ").toLocaleLowerCase();
}

function fundingAmount(item) {
  const amount = Number(item.amountValue ?? item.amount);
  return Number.isFinite(amount) ? amount : null;
}

function filterByTime(item, timeRemaining, now) {
  if (!timeRemaining) return true;
  const expiresAt = instantMs(item.expiresAt, Number.NaN);
  if (!Number.isFinite(expiresAt)) return false;
  const daysRemaining = (expiresAt - now.getTime()) / (24 * 60 * 60 * 1000);
  if (daysRemaining < 0) return false;
  if (timeRemaining === "over-90") return daysRemaining > 90;
  return daysRemaining <= Number(timeRemaining);
}

export function filterOpportunities(items, filters, now = new Date()) {
  const query = clean(filters.query).toLocaleLowerCase();
  const minimum = numericFilter(filters.minimumFunding) === ""
    ? null
    : Number(filters.minimumFunding);
  const maximum = numericFilter(filters.maximumFunding) === ""
    ? null
    : Number(filters.maximumFunding);

  return items.filter((item) => {
    const categories = Array.isArray(item.categories) ? item.categories : [];
    const amount = fundingAmount(item);
    return (!query || searchableText(item).includes(query))
      && (!filters.type || opportunityTypeValue(item) === filters.type)
      && (!filters.category || categories.includes(filters.category))
      && (!filters.status || clean(item.status).toLowerCase() === filters.status)
      && (minimum === null || (amount !== null && amount >= minimum))
      && (maximum === null || (amount !== null && amount <= maximum))
      && (!filters.organisation || clean(item.organisation ?? item.owner) === filters.organisation)
      && filterByTime(item, filters.timeRemaining, now);
  });
}

export function sortOpportunities(items, sort = DEFAULT_DISCOVERY_FILTERS.sort) {
  return [...items].sort((left, right) => {
    if (sort === "closing") {
      return instantMs(left.expiresAt, Number.POSITIVE_INFINITY)
        - instantMs(right.expiresAt, Number.POSITIVE_INFINITY);
    }
    if (sort === "amount-desc") return (fundingAmount(right) ?? 0) - (fundingAmount(left) ?? 0);
    if (sort === "amount-asc") return (fundingAmount(left) ?? 0) - (fundingAmount(right) ?? 0);
    return instantMs(right.createdAt, 0) - instantMs(left.createdAt, 0);
  });
}

export function discoverOpportunities(items, filters, { now = new Date(), pageSize = DISCOVERY_PAGE_SIZE } = {}) {
  const filtered = sortOpportunities(filterOpportunities(items, filters, now), filters.sort);
  const totalResults = filtered.length;
  const totalPages = Math.max(1, Math.ceil(totalResults / pageSize));
  const page = Math.min(positivePage(filters.page), totalPages);
  const start = (page - 1) * pageSize;

  return {
    items: filtered.slice(start, start + pageSize),
    page,
    pageSize,
    totalPages,
    totalResults,
    firstResult: totalResults === 0 ? 0 : start + 1,
    lastResult: Math.min(start + pageSize, totalResults),
  };
}
