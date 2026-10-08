import { useMemo } from "react";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useAuth } from "../context/AuthContext.jsx";
import { listPublishedPostings } from "./postings.js";
import { toOpportunityListItem } from "./opportunityPresentation.js";

// Home and Discover use the same wallet-scoped pages. Brief navigation reuses
// them; older results remain visible while refreshing. Transaction checks never
// use this presentation cache.
export function usePublishedPostings() {
  const { user, isAuthenticated } = useAuth();
  const wallet = user?.id?.toLowerCase();
  const enabled = Boolean(isAuthenticated && wallet);
  const query = useInfiniteQuery({
    queryKey: ["publishedPostings", enabled ? wallet : null],
    queryFn: ({ pageParam }) => listPublishedPostings({ cursor: pageParam }),
    initialPageParam: null,
    getNextPageParam: (lastPage) => lastPage.hasMore ? lastPage.cursor : undefined,
    enabled,
    staleTime: 30_000,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  });
  const postings = useMemo(() => {
    if (!enabled) return [];
    const seen = new Set();
    return (query.data?.pages ?? []).flatMap((page) => page.items)
      .filter((item) => {
        if (seen.has(item.id)) return false;
        seen.add(item.id);
        return true;
      }).map(toOpportunityListItem);
  }, [enabled, query.data]);

  return {
    postings,
    loading: enabled && query.isPending,
    fetching: enabled && query.isFetching,
    loadError: enabled ? query.error : null,
    isAuthenticated,
    hasMore: enabled && Boolean(query.hasNextPage),
    loadMore: () => {
      if (enabled && query.hasNextPage && !query.isFetching) {
        return query.fetchNextPage({ cancelRefetch: false });
      }
    },
    refresh: () => {
      if (enabled && !query.isFetching) return query.refetch({ cancelRefetch: false });
    },
  };
}
