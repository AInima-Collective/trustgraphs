import {
  type Address,
  type Hex,
  encodeAbiParameters,
  hexToBytes,
  keccak256,
  sha256,
  stringToHex,
} from 'viem'

import { type ScoreRow, buildTree, leafSet } from './api/hypercerts-tree'

const HEX32 = /^0x[0-9a-f]{64}$/i
const PUBKEY = /^0x[0-9a-f]{64}$/i
const ADDRESS = /^0x[0-9a-f]{40}$/i
const ZERO32 = `0x${'00'.repeat(32)}` as Hex

export type NostrArchiveVariant = 'BuzzAuditV1' | 'SelfLogV1'

export type NostrIndexerSidecar = {
  format: 'trustgraphs.nostr.indexer-sidecar.v1'
  roster: { pubkey: Hex; nodeId: Hex }[]
  agents: {
    agentPubkey: Hex
    agentNodeId: Hex
    ownerPubkey: Hex
    ownerNodeId: Hex
  }[]
  bindings: Record<string, Address>
  skips: { node_id: Hex; reason: number; epoch_observed: number | string }[]
}

export type NostrIndexerScoreRow = ScoreRow & {
  nostrPubkey: Hex
  actorKind: 'member' | 'agent'
  ownerNodeId: Hex | null
}

/** Match the Rust `CommitmentVariant` serde wire spelling exactly. */
export const nostrEpochTrustClass = (variants: readonly string[]) => {
  if (variants.length === 0)
    throw new Error('Nostr assembly selected no archives')
  if (
    variants.some(
      (variant) => variant !== 'BuzzAuditV1' && variant !== 'SelfLogV1'
    )
  ) {
    throw new Error(
      'Nostr archive manifest uses an unsupported commitment variant'
    )
  }
  return variants.includes('SelfLogV1')
    ? ('relay-exporter-attested+member-self-committed' as const)
    : ('relay-exporter-attested' as const)
}

const rawSha256Cid = (digest: Hex) => {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567'
  const bytes = Uint8Array.from([0x01, 0x55, 0x12, 0x20, ...hexToBytes(digest)])
  let accumulator = 0
  let bits = 0
  let output = ''
  for (const byte of bytes) {
    accumulator = ((accumulator << 8) | byte) >>> 0
    bits += 8
    while (bits >= 5) {
      bits -= 5
      output += alphabet[(accumulator >>> bits) & 31]
    }
  }
  if (bits > 0) output += alphabet[(accumulator << (5 - bits)) & 31]
  return `b${output}`
}

/** Exact score-blob/journal binding, isolated from database/runtime imports for adversarial tests. */
export const validateNostrScoreCommitment = (
  scores: Record<string, string>,
  outputBytes: Uint8Array,
  expectedSha256: Hex,
  expectedCid: string,
  expectedTotal: bigint
) => {
  const sorted = Object.entries(scores).sort(([left], [right]) =>
    left.localeCompare(right)
  )
  const canonical = `{${sorted
    .map(([nodeId, value]) => `"${nodeId.toLowerCase()}":"${value}"`)
    .join(',')}}`
  const encoded = new TextEncoder().encode(canonical)
  if (
    encoded.length !== outputBytes.length ||
    encoded.some((byte, index) => byte !== outputBytes[index])
  ) {
    throw new Error('Nostr score blob is not the canonical committed encoding')
  }
  const digest = sha256(outputBytes)
  if (digest.toLowerCase() !== expectedSha256.toLowerCase()) {
    throw new Error('Nostr score blob does not match the proven ipfsHash')
  }
  if (rawSha256Cid(digest) !== expectedCid) {
    throw new Error('Nostr score blob CID is not canonical raw-sha256')
  }
  const total = sorted.reduce((sum, [, value]) => sum + BigInt(value), 0n)
  if (total !== expectedTotal) {
    throw new Error(
      'Nostr score blob total does not match the proven totalValue'
    )
  }
}

export const nostrNodeId = (pubkey: Hex): Hex => {
  if (!PUBKEY.test(pubkey)) throw new Error(`invalid Nostr pubkey ${pubkey}`)
  return keccak256(stringToHex(`did:nostr:${pubkey.slice(2).toLowerCase()}`))
}

export const nostrSkippedDigest = (
  skips: NostrIndexerSidecar['skips']
): Hex => {
  const canonical = skips.map((skip) => ({
    nodeId: skip.node_id.toLowerCase() as Hex,
    reason: skip.reason,
    epoch: BigInt(skip.epoch_observed),
  }))
  for (const skip of canonical) {
    if (!HEX32.test(skip.nodeId)) throw new Error('malformed skipped node id')
    if (
      !Number.isSafeInteger(skip.reason) ||
      skip.reason < 0 ||
      skip.reason > 255
    ) {
      throw new Error('malformed skipped reason')
    }
  }
  const sorted = [...canonical].sort((a, b) => {
    const node = a.nodeId.localeCompare(b.nodeId)
    if (node !== 0) return node
    if (a.reason !== b.reason) return a.reason - b.reason
    return a.epoch < b.epoch ? -1 : a.epoch > b.epoch ? 1 : 0
  })
  if (sorted.some((value, index) => value !== canonical[index])) {
    throw new Error('Nostr skip sidecar is not canonically sorted')
  }
  let acc = ZERO32
  for (const skip of canonical) {
    const leaf = keccak256(
      encodeAbiParameters(
        [{ type: 'bytes32' }, { type: 'uint8' }, { type: 'uint64' }],
        [skip.nodeId, skip.reason, skip.epoch]
      )
    )
    acc = keccak256(
      encodeAbiParameters(
        [{ type: 'bytes32' }, { type: 'bytes32' }],
        [acc, leaf]
      )
    )
  }
  return acc
}

/**
 * Validate the scoped guest sidecar before any database write. This is the production ingestion
 * boundary: actor identities are derived, OA owner links and bindings are checked, the complete
 * node/address leaf set must reproduce the proven root, and the skip preimage must reproduce the
 * journal digest.
 */
export const validateNostrWorkspaceSidecar = (
  scores: Record<string, string>,
  sidecar: NostrIndexerSidecar,
  expectedRoot: Hex,
  expectedSkippedDigest: Hex
) => {
  if (sidecar.format !== 'trustgraphs.nostr.indexer-sidecar.v1') {
    throw new Error(
      `unsupported Nostr workspace sidecar format ${sidecar.format}`
    )
  }
  const actualSkippedDigest = nostrSkippedDigest(sidecar.skips)
  if (
    actualSkippedDigest.toLowerCase() !== expectedSkippedDigest.toLowerCase()
  ) {
    throw new Error(
      'Nostr skip sidecar does not reproduce the proven skippedDigest'
    )
  }

  const pubkeys = new Map<string, Hex>()
  const owners = new Map<string, Hex>()
  for (const member of sidecar.roster) {
    const derived = nostrNodeId(member.pubkey)
    if (derived.toLowerCase() !== member.nodeId.toLowerCase()) {
      throw new Error('Nostr roster pubkey/nodeId mismatch')
    }
    if (pubkeys.has(derived.toLowerCase())) {
      throw new Error('duplicate Nostr roster actor')
    }
    pubkeys.set(derived.toLowerCase(), member.pubkey)
  }
  for (const agent of sidecar.agents) {
    if (
      nostrNodeId(agent.agentPubkey).toLowerCase() !==
        agent.agentNodeId.toLowerCase() ||
      nostrNodeId(agent.ownerPubkey).toLowerCase() !==
        agent.ownerNodeId.toLowerCase() ||
      !pubkeys.has(agent.ownerNodeId.toLowerCase())
    ) {
      throw new Error('Nostr OA agent/owner provenance mismatch')
    }
    if (pubkeys.has(agent.agentNodeId.toLowerCase())) {
      throw new Error('Nostr agent collides with another eligible actor')
    }
    pubkeys.set(agent.agentNodeId.toLowerCase(), agent.agentPubkey)
    owners.set(agent.agentNodeId.toLowerCase(), agent.ownerNodeId)
  }

  const bindings = new Map<string, Address>()
  for (const [nodeId, address] of Object.entries(sidecar.bindings)) {
    if (!HEX32.test(nodeId) || !ADDRESS.test(address)) {
      throw new Error('malformed Nostr binding sidecar row')
    }
    if (!pubkeys.has(nodeId.toLowerCase())) {
      throw new Error('Nostr binding belongs to no verified member or agent')
    }
    bindings.set(nodeId.toLowerCase(), address.toLowerCase() as Address)
  }

  const rows: NostrIndexerScoreRow[] = Object.entries(scores).map(
    ([nodeId, value]) => {
      const normalized = nodeId.toLowerCase()
      const pubkey = pubkeys.get(normalized)
      if (!pubkey) {
        throw new Error(
          `scored Nostr node ${nodeId} lacks verified member/agent provenance`
        )
      }
      const ownerNodeId = owners.get(normalized) ?? null
      return {
        nodeId: normalized as Hex,
        value: BigInt(value),
        boundAddress: bindings.get(normalized) ?? null,
        nostrPubkey: pubkey,
        actorKind: ownerNodeId ? 'agent' : 'member',
        ownerNodeId,
      }
    }
  )
  const tree = buildTree(leafSet(rows))
  if (
    tree.length === 0 ||
    tree[0]?.toLowerCase() !== expectedRoot.toLowerCase()
  ) {
    throw new Error(
      `Nostr score/binding sidecar recomputes ${tree[0] ?? ZERO32}, not proven root ${expectedRoot}`
    )
  }

  const skipSummary = sidecar.skips.reduce<Record<string, number>>(
    (out, skip) => {
      out[String(skip.reason)] = (out[String(skip.reason)] ?? 0) + 1
      return out
    },
    {}
  )
  return { rows, tree, skipSummary }
}
