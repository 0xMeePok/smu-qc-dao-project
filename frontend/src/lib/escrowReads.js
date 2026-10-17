import { useQuery } from "@tanstack/react-query";
import { AUDIT_REGISTRY_CONFIG } from "../config/auditRegistry.js";
import { prepareStoredProposal } from "../../../firebase/functions/proposalAuditPayload.js";
import { readEscrow } from "./escrow.js";
import { requestDisplayAudit } from "./escrowDisplay.js";

export const ESCROW_STALE_MS = 60_000;

export function escrowSnapshotQueryKey(proposal, account, config = AUDIT_REGISTRY_CONFIG) {
  return ["escrowSnapshot", config.chainId, String(config.address).toLowerCase(), proposal?.id ?? null, account?.toLowerCase?.() ?? account ?? null];
}

export function auditQueryKey(record, config = AUDIT_REGISTRY_CONFIG) {
  return ["proposalAudit", config.chainId, String(config.address).toLowerCase(), record?.id ?? null, record?.audit?.transactionHash ?? null];
}

const chainQuery = (queryKey, queryFn, enabled) => ({
  queryKey, queryFn, enabled, staleTime: ESCROW_STALE_MS, refetchOnWindowFocus: true, refetchInterval: false,
});

/** One escrow snapshot per chain, deployment, proposal and account. */
export function useEscrowSnapshot(proposal, account, { enabled = true } = {}) {
  return useQuery(chainQuery(
    escrowSnapshotQueryKey(proposal, account),
    () => readEscrow({ proposal, account, allowImmutableCache: true }),
    enabled && Boolean(proposal?.id && proposal?.fundingTerms),
  ));
}

/** One audit verification per chain, deployment, record and transaction hash. */
export function useAuditVerification(record, read, { enabled = true } = {}) {
  return useQuery(chainQuery(
    auditQueryKey(record),
    () => {
      // Arm before the server re-read, so getProposal joins the escrow linkage
      // wave instead of waiting until that re-read returns.
      if (record?.fundingTerms) {
        try { requestDisplayAudit(prepareStoredProposal(record).entityId); }
        catch { /* A record that cannot prepare has no shared escrow read. */ }
      }
      return read(record, { allowImmutableCache: true });
    },
    enabled && Boolean(record?.id && record?.audit),
  ));
}

export function fetchEscrowSnapshot(queryClient, proposal, account) {
  return queryClient.fetchQuery({
    queryKey: escrowSnapshotQueryKey(proposal, account),
    queryFn: () => readEscrow({ proposal, account, allowImmutableCache: true }),
    staleTime: 0,
  });
}

export function fetchAuditVerification(queryClient, record, read) {
  return queryClient.fetchQuery({
    queryKey: auditQueryKey(record),
    queryFn: () => read(record, { allowImmutableCache: true }),
    staleTime: ESCROW_STALE_MS,
  });
}
