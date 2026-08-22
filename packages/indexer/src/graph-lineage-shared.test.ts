import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

import { type Address, type Hex } from 'viem'

import {
  type ConfigurationHead,
  type EndorsementRecord,
  type EndorsementStatus,
  type ReferralConfiguration,
  buildReferralAdjacency,
  classifyEndorsement,
  graphEndorsementId,
  graphLineageId,
  registryTupleLive,
} from './graph-lineage-shared'

type Fixture = {
  now: string
  scopes: { governance: Hex; grants: Hex }
  lineages: Array<{ id: Hex } & ConfigurationHead>
  configurations: ReferralConfiguration[]
  endorsements: EndorsementRecord[]
}

const fixture = JSON.parse(
  readFileSync(
    new URL('../../../tests/fixtures/graph-lineage.json', import.meta.url),
    'utf8'
  )
) as Fixture
const heads = new Map(fixture.lineages.map((lineage) => [lineage.id, lineage]))
const configurations = new Map(
  fixture.configurations.map((configuration) => [
    configuration.id,
    configuration,
  ])
)
const statuses = () =>
  new Map(
    fixture.endorsements.map((endorsement) => [
      endorsement.id,
      classifyEndorsement(
        endorsement,
        BigInt(fixture.now),
        heads.get(endorsement.issuerLineageId)!,
        heads.get(endorsement.subjectLineageId)!,
        endorsement.scopeHash,
        endorsement.subjectConfigurationId
      ),
    ])
  )

test('qualified lineage and endorsement identities are stable and collision resistant', () => {
  const instance = `0x${'11'.repeat(32)}` as Hex
  const registryA = `0x${'aa'.repeat(20)}` as Address
  const registryB = `0x${'bb'.repeat(20)}` as Address
  const lineageA = graphLineageId(10n, registryA, instance)
  assert.equal(lineageA, graphLineageId(10n, registryA, instance))
  assert.notEqual(lineageA, graphLineageId(10n, registryB, instance))
  assert.notEqual(lineageA, graphLineageId(31337n, registryA, instance))

  const scope = fixture.scopes.governance
  const graphRegistry = `0x${'cc'.repeat(20)}` as Address
  assert.notEqual(
    graphEndorsementId(10n, graphRegistry, lineageA, scope, 1n),
    graphEndorsementId(10n, graphRegistry, lineageA, scope, 2n)
  )
})

test('fixture covers cycles, expiry, revocation, rotation, and multiple scopes', () => {
  const result = statuses()
  assert.deepEqual(
    fixture.endorsements.map((endorsement) => result.get(endorsement.id)),
    [
      'active',
      'active',
      'revoked',
      'active',
      'active',
      'expired',
      'issuer-configuration-rotated',
    ] satisfies EndorsementStatus[]
  )

  const historicReferralPairs = fixture.endorsements
    .filter(
      (endorsement) =>
        endorsement.kind === 2 &&
        endorsement.scopeHash === fixture.scopes.governance
    )
    .slice(0, 3)
    .map(
      (endorsement) =>
        `${endorsement.issuerLineageId}->${endorsement.subjectLineageId}`
    )
  assert.equal(historicReferralPairs.length, 3, 'fixture contains A→B→C→A')
  assert.equal(
    fixture.endorsements.filter(
      (endorsement) => endorsement.scopeHash === fixture.scopes.grants
    ).length,
    1
  )
})

test('only active referrals enter adjacency and unused mass stays explicit', () => {
  const { edges, budgets } = buildReferralAdjacency(
    fixture.endorsements,
    statuses(),
    configurations
  )
  assert.equal(edges.length, 3)
  assert.ok(edges.every((edge) => edge.weight !== '900000000000000000'))
  assert.deepEqual(
    budgets.find(
      (budget) =>
        budget.issuerLineageId === fixture.lineages[0]!.id &&
        budget.scopeHash === fixture.scopes.governance
    ),
    {
      issuerLineageId: fixture.lineages[0]!.id,
      scopeHash: fixture.scopes.governance,
      spent: '400000000000000000',
      unused: '600000000000000000',
    }
  )
  assert.equal(
    budgets.find((budget) => budget.scopeHash === fixture.scopes.grants)!
      .unused,
    '0'
  )
  assert.deepEqual(
    budgets.find(
      (budget) => budget.issuerLineageId === fixture.lineages[2]!.id
    ),
    {
      issuerLineageId: fixture.lineages[2]!.id,
      scopeHash: fixture.scopes.governance,
      spent: '0',
      unused: '1000000000000000000',
    }
  )
})

test('family, method, controller, authority, and mutable evidence overlap remain visible', () => {
  const { edges } = buildReferralAdjacency(
    fixture.endorsements,
    statuses(),
    configurations
  )
  const correlated = edges.find(
    (edge) => edge.endorsementId === fixture.endorsements[0]!.id
  )!
  assert.deepEqual(correlated.overlap, {
    family: true,
    method: true,
    controller: true,
    authority: false,
  })
  const mutable = edges.find(
    (edge) => edge.endorsementId === fixture.endorsements[1]!.id
  )!
  assert.equal(mutable.evidenceMutable, true)
  assert.equal(mutable.overlap.family, false)
  assert.equal(mutable.overlap.method, false)
})

test('status fold distinguishes scope/version/future/supersession and rejects overflow', () => {
  const base = fixture.endorsements[0]!
  const issuer = heads.get(base.issuerLineageId)!
  const subject = heads.get(base.subjectLineageId)!
  assert.equal(
    classifyEndorsement(
      base,
      2_000n,
      issuer,
      subject,
      fixture.scopes.grants,
      base.subjectConfigurationId
    ),
    'wrong-scope'
  )
  assert.equal(
    classifyEndorsement(
      base,
      2_000n,
      issuer,
      subject,
      base.scopeHash,
      `0x${'ff'.repeat(32)}`
    ),
    'wrong-subject-configuration'
  )
  assert.equal(
    classifyEndorsement(
      { ...base, validFrom: '2500' },
      2_000n,
      issuer,
      subject
    ),
    'not-started'
  )
  assert.equal(
    classifyEndorsement(
      { ...base, supersededBy: `0x${'ee'.repeat(32)}` },
      2_000n,
      issuer,
      subject
    ),
    'superseded'
  )

  const overflow = {
    ...base,
    id: `0x${'f9'.repeat(32)}` as Hex,
    subjectLineageId: fixture.lineages[2]!.id,
    subjectConfigurationId: fixture.lineages[2]!.currentConfigurationId!,
    weight: '700000000000000000',
  }
  const overflowStatuses = statuses()
  overflowStatuses.set(overflow.id, 'active')
  assert.throws(
    () =>
      buildReferralAdjacency(
        [...fixture.endorsements, overflow],
        overflowStatuses,
        configurations
      ),
    /referral budget exceeded/
  )
})

test('registry tuple liveness fails closed on every program/config binding field', () => {
  const lineage = {
    instanceRegistry: `0x${'12'.repeat(20)}` as Hex,
    instanceId: `0x${'13'.repeat(32)}` as Hex,
    currentConfigurationId: `0x${'14'.repeat(32)}` as Hex,
  }
  const configuration = {
    id: lineage.currentConfigurationId,
    programId: `0x${'15'.repeat(32)}` as Hex,
    snapshot: `0x${'16'.repeat(20)}` as Hex,
    verifier: `0x${'17'.repeat(20)}` as Hex,
    registryOrAccumulator: `0x${'18'.repeat(20)}` as Hex,
    paramsHash: `0x${'19'.repeat(32)}` as Hex,
  }
  const binding = {
    sourceRegistry: lineage.instanceRegistry,
    instanceId: lineage.instanceId,
    ...configuration,
    conflict: false,
  }
  assert.equal(registryTupleLive(lineage, configuration, binding), true)
  assert.equal(
    registryTupleLive(lineage, configuration, {
      ...binding,
      paramsHash: `0x${'20'.repeat(32)}`,
    }),
    false
  )
  assert.equal(
    registryTupleLive(lineage, configuration, { ...binding, conflict: true }),
    false
  )
})
