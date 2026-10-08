/** Refresh stored financial summaries only after the transaction has been synchronized. */
export function invalidateFundingDashboardSummaries(queryClient) {
  if (!queryClient) return;
  void queryClient.invalidateQueries({ queryKey: ["funderDashboard"] });
  void queryClient.invalidateQueries({ queryKey: ["escrowFundingSummary"] });
}
