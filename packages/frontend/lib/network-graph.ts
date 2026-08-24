/**
 * Network membership comes from the accepted score tree, not from the edge list. The agent lens is
 * the sole view that deliberately induces a smaller vertex set; its isolated agent wallets still
 * remain visible when none of their vouches survive the edge filter.
 */
export const includeNetworkGraphNode = ({
  agentsOnly,
  agentCount,
  focused,
  connectedToVisibleEdge,
}: {
  agentsOnly: boolean
  agentCount: number
  focused: boolean
  connectedToVisibleEdge: boolean
}): boolean =>
  (!agentsOnly || agentCount > 0) && (!focused || connectedToVisibleEdge)
