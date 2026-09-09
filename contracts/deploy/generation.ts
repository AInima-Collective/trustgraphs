import fs from 'node:fs'
import path from 'node:path'

import {
  CURRENT_SP1_CIRCUIT_VERSION,
  CURRENT_SP1_VERSION,
  RELEASE_PROGRAMS,
  type ReleaseManifest,
  validateReleaseManifest,
} from './release-manifest'

export const generationManifestPath = (name: string): string => {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(name)) {
    throw new Error(
      'Generation name must be 1–80 letters, digits, dots, underscores or hyphens'
    )
  }
  return `deployments/generations/${name}/sepolia.json`
}

/** Only canonical external contracts survive a replacement deployment. */
export const planGeneration = (
  active: ReleaseManifest,
  guestManifest: unknown,
  commit: string
): ReleaseManifest => {
  validateReleaseManifest(active, { requireComplete: true })
  const guest = guestManifest as {
    commit?: string
    sp1?: string
    programs?: { program: string; vkey: string; elf_sha256: string }[]
  } | null
  if (!guest || guest.commit !== commit || !/^[0-9a-f]{40}$/.test(commit)) {
    throw new Error('Generation guest manifest must match DEPLOYMENT_COMMIT')
  }
  // The manifest's `sp1` is the circuit version the guests were proven for, not the SDK version;
  // the generation records the SDK version pinned in zk/prover alongside each program.
  if (guest.sp1 !== CURRENT_SP1_CIRCUIT_VERSION) {
    throw new Error(
      `Generation requires SP1 circuit ${CURRENT_SP1_CIRCUIT_VERSION} (manifest says ${guest.sp1 ?? '<none>'})`
    )
  }
  if (
    !Array.isArray(guest.programs) ||
    guest.programs.length !== RELEASE_PROGRAMS.length
  ) {
    throw new Error(
      'Generation requires the complete seven-program guest manifest'
    )
  }
  const plan = structuredClone(active)
  plan.$schema = '../../schema.json'
  plan.status = 'planned'
  plan.deploymentCommit = commit
  plan.firstDeploymentBlock = null
  plan.instances = []
  for (const key of Object.keys(
    plan.contracts
  ) as (keyof ReleaseManifest['contracts'])[]) {
    if (key === 'safeSingleton' || key === 'safeProxyFactory') continue
    plan.contracts[key] = { address: null, block: null, txHash: null }
  }
  for (const [key, program] of RELEASE_PROGRAMS) {
    const entries = guest.programs.filter((entry) => entry.program === program)
    const entry = entries[0]
    if (
      entries.length !== 1 ||
      !entry ||
      !/^0x[0-9a-f]{64}$/i.test(entry.vkey) ||
      /^0x0{64}$/i.test(entry.vkey) ||
      !/^[0-9a-f]{64}$/i.test(entry.elf_sha256) ||
      /^0{64}$/.test(entry.elf_sha256)
    ) {
      throw new Error(`Generation has no unique valid identity for ${program}`)
    }
    plan.programs[key] = {
      sp1Version: CURRENT_SP1_VERSION,
      vkey: entry.vkey as `0x${string}`,
      elfSha256: `0x${entry.elf_sha256}`,
    }
  }
  return validateReleaseManifest(plan)
}

/** Reserve a new generation before any broadcast. Never overwrite a prior attempt. */
export const beginGeneration = (
  name: string,
  plan: ReleaseManifest,
  activeBytes: string,
  guestBytes: string,
  root = '.'
) => {
  const archivedPlan = planGeneration(
    JSON.parse(activeBytes),
    JSON.parse(guestBytes),
    plan.deploymentCommit ?? ''
  )
  if (JSON.stringify(archivedPlan) !== JSON.stringify(plan)) {
    throw new Error(
      'Generation archive inputs changed after the candidate was planned'
    )
  }
  if (
    fs.readFileSync(path.join(root, 'deployments/sepolia.json'), 'utf8') !==
    activeBytes
  ) {
    throw new Error(
      'Active Sepolia manifest changed while preparing the generation'
    )
  }
  const scratch = path.join(root, '.docker')
  if (
    fs.existsSync(scratch) &&
    fs.readdirSync(scratch).some((file) => file.endsWith('_deploy.json'))
  ) {
    throw new Error(
      'New generation requires a clean deployment checkout without .docker/*_deploy.json receipts; preserve existing receipts and use a fresh checkout'
    )
  }
  const file = path.join(root, generationManifestPath(name))
  fs.mkdirSync(path.dirname(path.dirname(file)), { recursive: true })
  // Non-recursive mkdir reserves the whole directory exclusively, including failed attempts.
  fs.mkdirSync(path.dirname(file))
  fs.writeFileSync(
    path.join(path.dirname(file), 'previous-sepolia.json'),
    activeBytes,
    { flag: 'wx' }
  )
  fs.writeFileSync(
    path.join(path.dirname(file), 'guest-manifest.json'),
    guestBytes,
    { flag: 'wx' }
  )
  fs.writeFileSync(file, `${JSON.stringify(plan, null, 2)}\n`, { flag: 'wx' })
  fs.mkdirSync(scratch, { recursive: true })
}

export const assertGenerationComplete = (
  plan: ReleaseManifest,
  deployed: ReleaseManifest
) => {
  validateReleaseManifest(deployed, { requireComplete: true })
  if (
    deployed.deploymentCommit !== plan.deploymentCommit ||
    JSON.stringify(deployed.programs) !== JSON.stringify(plan.programs)
  ) {
    throw new Error(
      'Deployed generation does not match the candidate source and guest identities'
    )
  }
  // All hosted families must be present, not merely the four minimum core records.
  for (const key of [
    'schemaRegistrar',
    'rootVerifier',
    'instanceRegistry',
    'provingVault',
    'trustgraphsFactory',
    'importedTrustgraphsFactory',
    'signerVerifier',
    'governedTrustgraphsFactory',
    'governedImportedTrustgraphsFactory',
    'signerSyncModuleDeployer',
    'parentAuthorityModuleDeployer',
    'subnetworkRegistry',
    'weightedVerifier',
    'weightedTrustgraphsFactory',
    'governedWeightedTrustgraphsFactory',
    'compositionVerifier',
    'trustComposeFactory',
    'governedTrustComposeFactory',
    'contributionsVerifier',
    'contributionsFactory',
  ] as const) {
    const record = deployed.contracts[key]
    if (!record?.address || record.block === null || record.txHash === null) {
      throw new Error(`Generation is missing deployment receipt for ${key}`)
    }
  }
}
