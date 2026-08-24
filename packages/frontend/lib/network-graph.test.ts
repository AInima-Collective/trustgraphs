import assert from 'node:assert/strict'

import { includeNetworkGraphNode } from './network-graph'

assert.equal(
  includeNetworkGraphNode({
    agentsOnly: false,
    agentCount: 0,
    focused: false,
    connectedToVisibleEdge: false,
  }),
  true,
  'an accepted network member remains a vertex without any attestations'
)
assert.equal(
  includeNetworkGraphNode({
    agentsOnly: true,
    agentCount: 0,
    focused: false,
    connectedToVisibleEdge: false,
  }),
  false
)
assert.equal(
  includeNetworkGraphNode({
    agentsOnly: true,
    agentCount: 1,
    focused: false,
    connectedToVisibleEdge: false,
  }),
  true,
  'the agent lens retains isolated verified-agent vertices'
)
assert.equal(
  includeNetworkGraphNode({
    agentsOnly: false,
    agentCount: 0,
    focused: true,
    connectedToVisibleEdge: false,
  }),
  false,
  'a focused account view does not expand into the entire disconnected roster'
)
