import { buildFixture } from './fixture'
import { CHECKPOINT_DOMAIN, EVENT_DOMAIN, EVENT_SET_VERSION } from './reference'

const stringify = (value: unknown) =>
  `${JSON.stringify(
    value,
    (_key, item) => (typeof item === 'bigint' ? item.toString() : item),
    2
  )}\n`.replace(/^(\s*"agentIds":) \[\n\s*"([^"\n]+)"\n\s*\]$/gm, '$1 ["$2"]')

export const buildGolden = () => {
  const fixture = buildFixture()
  return stringify({
    schema: 'trustgraphs-erc8004-completeness-v1',
    constants: {
      eventDomain: EVENT_DOMAIN,
      checkpointDomain: CHECKPOINT_DOMAIN,
      eventSetVersion: EVENT_SET_VERSION,
    },
    policy: {
      chainId: fixture.policy.chainId,
      accumulator: fixture.policy.accumulator,
      identityRegistry: fixture.policy.identityRegistry,
      reputationRegistry: fixture.policy.reputationRegistry,
      activationBlock: fixture.policy.activationBlock,
      eventSetVersion: fixture.policy.eventSetVersion,
      approvedImplementationCodeHashes: [
        ...fixture.policy.approvedImplementationCodeHashes,
      ].sort(),
      finalizedEndBlockHash: fixture.policy.finalizedEndBlockHash,
    },
    events: fixture.vectors,
    checkpoint: fixture.checkpoint,
    attribution: fixture.attribution,
  })
}
