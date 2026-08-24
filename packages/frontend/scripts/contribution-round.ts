/**
 * Contribution-round seed driver (GOAL.md M5) — the 6-persona worked example
 * (`crates/contributions-core/src/testutil.rs::fixture()`) reproduced on a local anvil
 * through the EXACT code paths the frontend screens use:
 *
 *   - every user action (vouch / claim / respond / rate) is `SchemaManager.encode` +
 *     `EAS.attest` — the same seam `useAttestation.createAttestation` drives from the
 *     contribute / respond / rate screens;
 *   - the operator's funding step (`fund`) is the payout page's seam: ERC-20 `approve` +
 *     `MerkleFundDistributor.distribute` with the round's proven root pinned as
 *     `expectedRoot` (read from the `/contributions` round API, exactly like the page);
 *   - payout claims (`claim`) consume the indexer's per-account proof bundle
 *     (`/contributions/:snapshot/payout/:account`) and call `distributor.claim` — the
 *     payout page's claim seam.
 *
 * Orchestrated by `task contributions:*` (taskfile/contributions.yml); see
 * research/operations/contributions/local-testing.md for the full round walkthrough.
 *
 * Persona map (deterministic anvil accounts):
 *   SEED  = account 0 (the trusted seed in params.contributions.json)
 *   ALICE = 1, BOB = 2, CAROL = 3, DAVE = 4, EVE = 5
 *
 * Usage: npx tsx scripts/contribution-round.ts <phase> [--flags]
 *   graph                 the fixture's six vouches through the trust resolver
 *   claim-out-of-window   C4: BOB self-claim (attested BEFORE the round window opens)
 *   round1                C1/C2/C3/C5 + responses + all 12 fixture valuations
 *   round2                round-2 mini-fixture: CAROL+BOB co-claim, accept, two ratings
 *   fund                  --amount <base units> [--deadline <unix ts>] (operator; FUNDED_KEY)
 *   claim                 --index <distribution index> [--as SEED,ALICE,…] (default: all)
 *   status                print personas + recorded claim uids
 */
import * as fs from 'fs'
import * as path from 'path'

import {
  type Hex,
  createPublicClient,
  createWalletClient,
  erc20Abi,
  http,
  keccak256,
  parseEventLogs,
  toHex,
  zeroAddress,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { foundry } from 'viem/chains'

import { SEED_NETWORKS } from '../lib/config'
import { easAbi, merkleFundDistributorAbi } from '../lib/contract-abis'
import { easAddress } from '../lib/contracts'
import {
  fetchContributionsPayout,
  fetchContributionsRound,
} from '../lib/contributions-api'
import {
  type ContributionsInstanceRow,
  fetchContributionsInstances,
  toContributionsNetwork,
} from '../lib/contributions-catalog'
import {
  distributeArgs as buildDistributeArgs,
  fundingTermsAbi,
  latestMerkleStateAbi,
} from '../lib/funding-terms'
import { SchemaManager, registerSchemas } from '../lib/schemas'
import type { ContributionsNetwork, Network } from '../lib/types'

const RPC = process.env.RPC_URL ?? 'http://127.0.0.1:8545'
const STATE_FILE = path.resolve(
  __dirname,
  '../../../.docker/contribution_round_dev_state.json'
)

// The canonical anvil mnemonic accounts 0..5 — the fixture's six personas.
const PERSONAS = {
  SEED: '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80',
  ALICE: '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d',
  BOB: '0x5de4111afa1a4b94908f83103eb1f1706367c2e68ca870fc3fb9a804cdab365a',
  CAROL: '0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6',
  DAVE: '0x47e179ec197488593b187f80a00eb0da91f1b9d0b13f8733639f19c30a34926a',
  EVE: '0x8b3a350cf5c34c9194ca85829a2df0ec3153be0318b5e2d3348e872092edffba',
} as const
type Persona = keyof typeof PERSONAS

type State = {
  claims: Record<string, Hex>
}

const loadState = (): State => {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as State
  } catch {
    return { claims: {} }
  }
}
const saveState = (state: State) =>
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2) + '\n')

const flag = (name: string): string | undefined => {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 ? process.argv[i + 1] : undefined
}

// Resolved at startup (rounds are factory-minted; the static config entry is gone). The catalog
// of record is the indexer's /contributions/instances route, but `task demo` runs without an
// indexer by design (taskfile/demo.yml) — and even with one up, the round this deploy just minted
// sits behind Ponder's finality window at seed time. So the deploy artifact written by
// CreateDevContributionsRound.s.sol both identifies WHICH round to seed (never "newest row") and
// stands in for the catalog when the indexer cannot answer. `main` populates both before
// dispatching.
let network!: ContributionsNetwork
let trustNetwork: Network | undefined

const ROUND_ARTIFACT = path.resolve(
  __dirname,
  '../../../.docker/contributions_round_dev_deploy.json'
)

/** Shape written by `contracts/script/CreateDevContributionsRound.s.sol`. The uid/accumulator fields are
 * optional because an artifact from before they were recorded may still be on disk. */
type RoundArtifact = {
  name?: string
  instance_id: Hex
  parent_instance_id: Hex
  merkle_snapshot: Hex
  contribution_resolver: Hex
  trust_accumulator_mirror: Hex
  fund_distributor: Hex
  params_controller?: Hex
  trust_accumulator?: Hex
  pool_token?: Hex | ''
  claim_schema_uid?: Hex
  response_schema_uid?: Hex
  valuation_schema_uid?: Hex
}

const loadRoundArtifact = (): RoundArtifact | undefined => {
  try {
    return JSON.parse(fs.readFileSync(ROUND_ARTIFACT, 'utf8')) as RoundArtifact
  } catch {
    return undefined
  }
}

/** The artifact reshaped as a catalog row, or undefined when it predates the enriched fields.
 * Only what the seeding phases read is real; the round window and pool figures live on chain and
 * on the indexer, not here. */
const artifactRow = (
  a: RoundArtifact
): ContributionsInstanceRow | undefined => {
  if (
    !a.trust_accumulator ||
    !a.claim_schema_uid ||
    !a.response_schema_uid ||
    !a.valuation_schema_uid
  ) {
    return undefined
  }
  return {
    id: a.instance_id,
    chainId: String(foundry.id),
    factory: zeroAddress,
    parentInstanceId: a.parent_instance_id,
    creator: zeroAddress,
    admin: zeroAddress,
    name: a.name ?? 'Contribution round',
    metadataURI: '',
    metadata: null,
    contracts: {
      merkleSnapshot: a.merkle_snapshot,
      contributionResolver: a.contribution_resolver,
      trustAccumulatorMirror: a.trust_accumulator_mirror,
      trustAccumulator: a.trust_accumulator,
      merkleFundDistributor: a.fund_distributor,
      distributorToken: a.pool_token || null,
    },
    schemaUids: {
      claim: a.claim_schema_uid,
      response: a.response_schema_uid,
      valuation: a.valuation_schema_uid,
    },
    epochLength: '0',
    paramsHash: `0x${'0'.repeat(64)}`,
    roundStart: '0',
    roundEnd: '0',
    totalPool: '0',
    createdTimestamp: '0',
  }
}

const resolveRound = async () => {
  const artifact = loadRoundArtifact()
  let row: ContributionsInstanceRow | undefined
  try {
    const rows = await fetchContributionsInstances()
    row =
      // The round THIS deploy minted, when the catalog has caught up to it…
      rows.find(
        (r) => r.id.toLowerCase() === artifact?.instance_id?.toLowerCase()
      ) ??
      // …the artifact when it has not (or the catalog holds a previous chain's rounds)…
      (artifact ? artifactRow(artifact) : undefined) ??
      // …and the newest row for a hand-run driver with no local deploy at all.
      rows[0]
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    row = artifact ? artifactRow(artifact) : undefined
    if (row) {
      console.log(`(no indexer — ${reason}; using ${ROUND_ARTIFACT})`)
    }
  }
  if (!row) {
    console.error(
      'no contributions round found: the indexer has no rounds (or is unreachable) and ' +
        `${ROUND_ARTIFACT} is missing or predates the enriched artifact — ` +
        'run pnpm deploy:contracts (Contributions Round step) first'
    )
    process.exit(1)
  }
  network = toContributionsNetwork(row)
  // What `useContributionsData` does when a round loads in the app: rounds are factory-minted, so
  // their claim/response/valuation schemas are not in the static seed the registry boots from.
  registerSchemas(network.schemas)
  // Display-only back-link for `status`; the seed entries carry no instanceId, so the demo keeps
  // matching by the accumulator address here.
  trustNetwork = SEED_NETWORKS.find(
    (n) =>
      n.contracts.easIndexerResolver?.toLowerCase() ===
      network.contracts.trustAccumulator?.toLowerCase()
  )
}

const schemaUid = (key: string): Hex => {
  const schema = network.schemas.find((s) => s.key === key)
  if (!schema) throw new Error(`schema ${key} missing from the network config`)
  return schema.uid as Hex
}

const publicClient = createPublicClient({
  chain: foundry,
  transport: http(RPC),
})
const wallets = Object.fromEntries(
  (Object.keys(PERSONAS) as Persona[]).map((p) => [
    p,
    createWalletClient({
      account: privateKeyToAccount(PERSONAS[p]),
      chain: foundry,
      transport: http(RPC),
    }),
  ])
)
const address = (p: Persona) => wallets[p].account!.address

/** The exact payload path of `useAttestation.createAttestation`: SchemaManager.encode →
 * EAS.attest. Returns the new attestation uid (from the Attested event). */
const attest = async (
  as: Persona,
  schema: Hex,
  data: Record<string, string | boolean | string[] | number[]>,
  recipient: Hex = zeroAddress
): Promise<Hex> => {
  const encodedData = SchemaManager.encode(schema, data)
  const hash = await wallets[as].writeContract({
    address: easAddress,
    abi: easAbi,
    functionName: 'attest',
    args: [
      {
        schema,
        data: {
          recipient,
          expirationTime: 0n,
          revocable: true,
          refUID: `0x${'00'.repeat(32)}` as Hex,
          data: encodedData,
          value: 0n,
        },
      },
    ],
  })
  const receipt = await publicClient.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new Error(`attest reverted: ${hash}`)
  const attested = parseEventLogs({
    abi: easAbi,
    logs: receipt.logs,
    eventName: 'Attested',
  })[0] as any
  const uid = attested.args.uid as Hex
  const block = await publicClient.getBlock({ blockHash: receipt.blockHash })
  console.log(`  ${as} attested ${uid.slice(0, 10)}… at t=${block.timestamp}`)
  return uid
}

const vouch = (as: Persona, to: Persona, confidence: number) => {
  if (!trustNetwork)
    throw new Error('trust network for slot A not found in config')
  const uid = trustNetwork.schemas.find((s) => s.key === 'vouching')!.uid as Hex
  console.log(`vouch ${as} → ${to} (${confidence})`)
  return attest(
    as,
    uid,
    { comment: `${as} vouches ${to}`, confidence: String(confidence) },
    address(to)
  )
}

const claim = (
  as: Persona,
  title: string,
  contributors: [Persona, number][]
) => {
  console.log(
    `claim "${title}" by ${as} [${contributors.map(([p, s]) => `${p}:${s}`).join(', ')}]`
  )
  return attest(as, schemaUid('contribution-claim'), {
    title,
    contentHash: keccak256(toHex(title)),
    uri: `ipfs://dev/${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
    contributors: contributors.map(([p]) => address(p)),
    shares: contributors.map(([, s]) => s),
  })
}

const respond = (as: Persona, claimUid: Hex, response: 1 | 2) => {
  console.log(
    `respond ${as} → ${claimUid.slice(0, 10)}… (${response === 1 ? 'accept' : 'reject'})`
  )
  return attest(as, schemaUid('contribution-response'), {
    claimUID: claimUid,
    response: String(response),
  })
}

const rate = (as: Persona, claimUid: Hex, score: number) => {
  console.log(`rate ${as} → ${claimUid.slice(0, 10)}… = ${score}`)
  return attest(as, schemaUid('contribution-valuation'), {
    claimUID: claimUid,
    score: String(score),
  })
}

const main = async () => {
  const phase = process.argv[2]
  const state = loadState()
  await resolveRound()

  switch (phase) {
    // The fixture's trust lane: SEED→ALICE 100, SEED→BOB 80, SEED→CAROL 60, SEED→DAVE 90,
    // ALICE→BOB 50, DAVE→CAROL 40. EVE receives no vouch (dust rep — minRaterRep filters her).
    case 'graph': {
      await vouch('SEED', 'ALICE', 100)
      await vouch('SEED', 'BOB', 80)
      await vouch('SEED', 'CAROL', 60)
      await vouch('SEED', 'DAVE', 90)
      await vouch('ALICE', 'BOB', 50)
      await vouch('DAVE', 'CAROL', 40)
      break
    }

    // C4 — BOB's self-claim, attested BEFORE the round window opens so the guest's round-window
    // rule provably drops it (and DAVE's later valuation of it is inert).
    case 'claim-out-of-window': {
      state.claims.C4 = await claim('BOB', 'Out-of-window write-up', [
        ['BOB', 100],
      ])
      saveState(state)
      const ts = (await publicClient.getBlock()).timestamp
      console.log(
        `C4 attested at t=${ts}; open the round window AFTER this timestamp`
      )
      break
    }

    // The in-window fixture sequence: claims C1/C2/C3/C5, both responses, all 12 valuations
    // (incl. DAVE's LWW re-rate of C1 and the inert rating of C4).
    case 'round1': {
      const { C4 } = state.claims
      if (!C4) throw new Error('run claim-out-of-window first')

      state.claims.C1 = await claim('ALICE', 'Indexer contribution lane', [
        ['ALICE', 100],
      ])
      state.claims.C2 = await claim('BOB', 'Joint protocol research', [
        ['BOB', 60],
        ['CAROL', 40],
      ])
      state.claims.C3 = await claim('ALICE', 'Community-call facilitation', [
        ['EVE', 50],
        ['DAVE', 50],
      ])
      state.claims.C5 = await claim('BOB', 'Deployment tooling', [['BOB', 100]])
      saveState(state)
      const { C1, C2, C3, C5 } = state.claims

      await respond('CAROL', C2, 1) // CAROL accepts her share of C2
      await respond('EVE', C3, 2) // EVE rejects the nomination

      await rate('DAVE', C1, 80) // superseded below (LWW)
      await rate('DAVE', C2, 60)
      await rate('CAROL', C1, 50)
      await rate('CAROL', C5, 90) // collaborator-discounted (CAROL co-claims C2 with BOB)
      await rate('BOB', C1, 70)
      await rate('ALICE', C1, 100) // self-valuation — filtered in-guest
      await rate('EVE', C1, 100) // dust rep — filtered by minRaterRep
      await rate('SEED', C1, 40)
      await rate('SEED', C5, 60)
      await rate('DAVE', C4, 50) // rates the out-of-window claim — provably inert
      await rate('DAVE', C1, 90) // LWW: 90 supersedes the earlier 80
      await rate('CAROL', C3, 30)
      break
    }

    // Round 2 (repeatability): one co-claim, one accept, two ratings — a minimal round over
    // the same instance after the window params rotate.
    case 'round2': {
      state.claims.R2 = await claim('CAROL', 'Round-2 retrospective', [
        ['CAROL', 60],
        ['BOB', 40],
      ])
      saveState(state)
      await respond('BOB', state.claims.R2, 1)
      await rate('SEED', state.claims.R2, 80)
      await rate('DAVE', state.claims.R2, 40)
      break
    }

    // Operator: fund the round through the payout page's exact seam — approve, then
    // distribute(token, amount, expectedRoot[, claimDeadline]) with the proven root pinned.
    case 'fund': {
      const amount = BigInt(flag('amount') ?? '0')
      if (amount <= 0n) throw new Error('--amount <base units> required')
      const deadline = flag('deadline') ? BigInt(flag('deadline')!) : undefined
      const funderKey = (process.env.FUNDED_KEY ?? '') as Hex
      if (!funderKey)
        throw new Error('FUNDED_KEY env required (the operator/deployer key)')
      const funder = createWalletClient({
        account: privateKeyToAccount(funderKey),
        chain: foundry,
        transport: http(RPC),
      })

      const snapshot = network.contracts.merkleSnapshot as Hex
      const distributor = network.contracts.merkleFundDistributor as Hex
      const poolToken = network.contracts.poolToken as Hex

      // The page pins the round API's root as expectedRoot; require a verified round.
      const round = await fetchContributionsRound(snapshot)
      if (!round?.root)
        throw new Error(
          'round API has no proven root yet — submit the proof first'
        )
      const expectedRoot = round.root as Hex

      // `distribute` pins every term. Read them from the chain so the script agrees with what the
      // contract will see, and fails loudly if the round moved under it.
      const [feePercentage, feeRange, feeRecipient, latestState] =
        (await Promise.all([
          publicClient.readContract({
            address: distributor,
            abi: fundingTermsAbi,
            functionName: 'feePercentage',
          }),
          publicClient.readContract({
            address: distributor,
            abi: fundingTermsAbi,
            functionName: 'FEE_RANGE',
          }),
          publicClient.readContract({
            address: distributor,
            abi: fundingTermsAbi,
            functionName: 'feeRecipient',
          }),
          publicClient.readContract({
            address: snapshot,
            abi: latestMerkleStateAbi,
            functionName: 'getLatestState',
          }),
        ])) as [bigint, bigint, Hex, { totalValue: bigint }]
      const distributeArgs = buildDistributeArgs({
        token: poolToken,
        amount,
        expectedRoot,
        expectedTotalMerkleValue: latestState.totalValue,
        claimDeadline: deadline ?? 0n,
        feePercentage,
        feeRange,
        feeRecipient,
      })

      const approveHash = await funder.writeContract({
        address: poolToken,
        abi: erc20Abi,
        functionName: 'approve',
        args: [distributor, amount],
      })
      await publicClient.waitForTransactionReceipt({ hash: approveHash })

      const distributeHash = await funder.writeContract({
        address: distributor,
        abi: merkleFundDistributorAbi,
        functionName: 'distribute',
        args: distributeArgs,
      })
      const receipt = await publicClient.waitForTransactionReceipt({
        hash: distributeHash,
      })
      if (receipt.status !== 'success') throw new Error('distribute reverted')
      const event = parseEventLogs({
        abi: merkleFundDistributorAbi,
        logs: receipt.logs,
        eventName: 'Distributed',
      })[0] as any
      console.log(
        `distributed: index=${event.args.distributionIndex} amount=${event.args.amount} fee=${event.args.feeAmount} expectedRoot=${expectedRoot}${deadline ? ` claimDeadline=${deadline}` : ''}`
      )
      break
    }

    // Claim payouts through the proof-bundle API (the payout page's claim seam). Personas
    // with no leaf (EVE) are reported, not errors.
    case 'claim': {
      const index = BigInt(flag('index') ?? '0')
      const who = (flag('as')?.split(',') ?? Object.keys(PERSONAS)) as Persona[]
      const snapshot = network.contracts.merkleSnapshot as Hex
      const distributor = network.contracts.merkleFundDistributor as Hex
      for (const p of who) {
        const account = address(p)
        const bundle = await fetchContributionsPayout(snapshot, account)
        if (!bundle || BigInt(bundle.value) === 0n) {
          console.log(`  ${p} (${account}): no payout leaf — nothing to claim`)
          continue
        }
        const hash = await wallets[p].writeContract({
          address: distributor,
          abi: merkleFundDistributorAbi,
          functionName: 'claim',
          args: [index, account, BigInt(bundle.value), bundle.proof as Hex[]],
        })
        const receipt = await publicClient.waitForTransactionReceipt({ hash })
        if (receipt.status !== 'success')
          throw new Error(`claim reverted for ${p}`)
        const event = parseEventLogs({
          abi: merkleFundDistributorAbi,
          logs: receipt.logs,
          eventName: 'Claimed',
        })[0] as any
        console.log(
          `  ${p} claimed ${event.args.amount} (merkle value ${bundle.value})`
        )
      }
      break
    }

    case 'status': {
      console.log('personas:')
      for (const p of Object.keys(PERSONAS) as Persona[])
        console.log(`  ${p}: ${address(p)}`)
      console.log('claims:', state.claims)
      console.log('contributions network:', network.name)
      console.log('trust network (slot A):', trustNetwork?.name)
      break
    }

    default:
      console.error(
        'usage: contribution-round.ts <graph|claim-out-of-window|round1|round2|fund|claim|status>'
      )
      process.exit(1)
  }
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
