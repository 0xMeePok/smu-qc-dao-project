import { useQuery } from "@tanstack/react-query";
import { ACTION_ITEMS_KEY, listActionItems } from "./proposalQueues.js";
import { useAuth } from "../context/AuthContext.jsx";

/**
 * QCDAO-91. The member's open actions, shared by the workspace tab count, the
 * Action Needed page and the QCDAO-92/93 dashboard attention panels.
 *
 * One query key for all of them on purpose: the payload costs a confirmed-block
 * escrow read per proposal, and two copies could show a different count in the
 * tab from the one on the page.
 */
export function useActionItems() {
  const { user } = useAuth();
  return useQuery({ queryKey: [...ACTION_ITEMS_KEY, user?.id], queryFn: listActionItems,
    enabled: Boolean(user?.id), staleTime: 30_000, refetchInterval: 30_000 });
}
