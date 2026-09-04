import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'

const read = (relative: string) =>
  readFileSync(new URL(relative, import.meta.url), 'utf8')

const wizard = read('../app/create/steps/ReviewStep.tsx')
const page = read('../app/networks/[id]/subnetworks/component.tsx')
const header = read('../components/NetworkHeader.tsx')
const settings = read('../app/networks/[id]/settings/component.tsx')
const nav = read('./network-nav.ts')
const route = read('../app/networks/[id]/subnetworks/page.tsx')
const buildGuide = read('../../../docs/build/sub-networks.md')

test('sub-network creation is a parent proposal with an explicit authority tier', () => {
  assert.match(wizard, /functionName: 'createGovernedSubnetwork'/)
  assert.match(wizard, /const tiers = \{ admin: 0, guardian: 1, label: 2 \}/)
  assert.match(
    wizard,
    /args:\s*\[\s*args,\s*initialPolicy,\s*signerSync,\s*parentInstanceId,\s*tiers\[data\.subnetworkTier\]/
  )
  assert.match(wizard, /saveGovernancePrefill/)
  assert.match(wizard, /parentNetworkId \?\? parentInstanceId/)
})

test('adoption requires child claim and parent acceptance and supports every governed tier', () => {
  assert.match(page, /adoptionTiers/)
  assert.match(page, /functionName: 'deploy'/)
  assert.match(page, /functionName: 'enableModule'/)
  assert.match(page, /functionName: 'setProposer'/)
  assert.match(page, /functionName: 'claimParent'/)
  assert.match(page, /functionName: 'acceptChild'/)
  assert.match(page, /functionName: 'release'/)
  assert.match(page, /functionName: 'renounce'/)
  assert.match(page, /permissionless\s+and\s+inert/)
})

test('hierarchy is deployment-gated and visible on parent and child surfaces', () => {
  assert.match(nav, /subnetworksAvailable/)
  assert.match(nav, /label: 'Sub-networks'/)
  assert.match(nav, /instance\.governance && subnetworksAvailable/)
  assert.match(route, /compositionAsNetwork/)
  assert.match(header, /Part of \{activeParent\.name\}/)
  assert.match(settings, /Parent network/)
  assert.match(settings, /Power verified/)
})

test('build guide carries a cold-stack browser walkthrough', () => {
  assert.match(buildGuide, /## Cold-stack walkthrough/)
  assert.match(buildGuide, /task demo/)
  assert.match(buildGuide, /Power verified/)
  assert.match(buildGuide, /not verified/)
})
