// Hypercerts atproto fixture generator (GOAL.md M4 exit — TWO-SIDED, multi-repo).
//
// Stands up an in-process atproto network (@atproto/dev-env TestNetworkNoAppView:
// a real did:plc PLC server + a SQLite PDS), creates two accounts (alice + bob),
// and writes real records so that the two-sided semantics (§3/§5) are exercised
// ACROSS repos — the counterparty facts (badge.response, acknowledgement) live in
// the COUNTERPARTY's own signed repo, exactly as the derive rules require.
//
// It signs a REAL EIP-712 app.certified.link.evm proof with a freshly generated EVM
// key (alice's binding), then exports BOTH repos: CAR + PLC audit log + commit
// metadata + a ground-truth {key -> valueCID} table per repo into ../fixtures/.
//
// Repo contents (GOAL M4):
//   alice.test (primary, BOUND actor via link.evm):
//     - graph.follow(bob)
//     - badge.award(subject=bob)                      -> alice→bob badge (bob accepts in HIS repo)
//     - claim.activity "reforestation-amazon-2024"    contributors [bob 0.6, carol 0.4]
//     - context.evaluation of BOB's activity (87.5)   -> a clean cross-repo E3 edge
//     - context.evaluation of HER OWN activity (90)   -> self-edge, inert (anti-gaming fixture)
//     - link.evm (real EIP-712)                        -> alice is a bound actor
//   bob.test (peer, SATELLITE actor):
//     - badge.definition (the endorsement badge alice's award references)
//     - claim.activity "bob-mangrove-2024"            contributors [alice 1.0]  -> alice gets an E4
//     - badge.response(accepted, 0.85) to ALICE's award   -> two-sided badge accept
//     - context.acknowledgement(true) of ALICE's activity -> two-sided ack (boosts bob's E4 share)
//   carol: a purely-referenced contributor DID with NO repo (named-but-no-node path).
//
// Run:  node gen.mjs

import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { TestNetworkNoAppView } from '@atproto/dev-env'
import { AtpAgent } from '@atproto/api'
import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts'
import { getAddress, recoverTypedDataAddress } from 'viem'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const OUT = path.resolve(__dirname, '..', 'fixtures')

// ---- EIP-712 domain + types, copied verbatim from the lexicon's own
// ---- tests/validate-link-evm.test.ts (@hypercerts-org/lexicon v1.1.0).
const EIP712_DOMAIN = { name: 'IdentityLink', version: '1' }
const EIP712_TYPES = {
  LinkAttestation: [
    { name: 'did', type: 'string' },
    { name: 'evmAddress', type: 'address' },
    { name: 'chainId', type: 'uint256' },
    { name: 'timestamp', type: 'uint256' },
    { name: 'nonce', type: 'uint256' },
  ],
}

const strongRef = (uri, cid) => ({ uri, cid })

// Fixed rkeys so the downstream Rust tests can reference the artifact node ids by
// name (artifactNodeId = keccak256("at://did/collection/rkey")).
const ALICE_ACTIVITY_RKEY = 'reforestation-amazon-2024'
const BOB_ACTIVITY_RKEY = 'bob-mangrove-2024'

// The seven §2 collections plus the supporting badge.definition — used to list the
// ground-truth table for EACH repo (a repo only surfaces the collections it holds).
const LIST_COLLECTIONS = [
  'app.certified.badge.definition',
  'app.certified.graph.follow',
  'app.certified.badge.award',
  'app.certified.badge.response',
  'org.hypercerts.context.evaluation',
  'org.hypercerts.claim.activity',
  'org.hypercerts.context.acknowledgement',
  'app.certified.link.evm',
]

async function main() {
  await fs.mkdir(OUT, { recursive: true })
  const net = await TestNetworkNoAppView.create({})
  const pdsUrl = net.pds.url
  const plcUrl = net.plc.url
  console.log('PDS:', pdsUrl, ' PLC:', plcUrl)

  // ---- two accounts: alice (bound, primary) + bob (satellite, counterparty) ----
  const alice = new AtpAgent({ service: pdsUrl })
  const bob = new AtpAgent({ service: pdsUrl })

  await alice.createAccount({
    handle: 'alice.test',
    email: 'alice@example.com',
    password: 'hunter2hunter2',
  })
  await bob.createAccount({
    handle: 'bob.test',
    email: 'bob@example.com',
    password: 'hunter2hunter2',
  })
  const aliceDid = alice.session.did
  const bobDid = bob.session.did
  // a third, purely-referenced contributor DID (no repo — self-asserted identity)
  const carolDid = 'did:plc:carol0000000000000000000'
  console.log('alice:', aliceDid)
  console.log('bob:  ', bobDid)
  console.log('carol:', carolDid, '(no repo)')

  const put = async (agent, collection, value, rkey, validate = false) => {
    const writes = [
      {
        $type: 'com.atproto.repo.applyWrites#create',
        collection,
        ...(rkey ? { rkey } : {}),
        value,
      },
    ]
    const res = await agent.com.atproto.repo.applyWrites({
      repo: agent.session.did,
      validate,
      writes,
    })
    const r = res.data.results[0]
    return { uri: r.uri, cid: r.cid }
  }

  const now = () => new Date().toISOString()

  // ---------- LEXICON VALIDATION PROBE ----------
  // Ask the PDS to validate an unknown-lexicon record (validate:true). Record whether
  // the PDS knows the hypercerts lexicons at all. (Historically REJECTED — unknown
  // lexicon — so nothing persists into bob's repo.)
  let validationBehavior
  try {
    await bob.com.atproto.repo.applyWrites({
      repo: bobDid,
      validate: true,
      writes: [
        {
          $type: 'com.atproto.repo.applyWrites#create',
          collection: 'app.certified.graph.follow',
          value: { subject: aliceDid, createdAt: now() },
        },
      ],
    })
    validationBehavior = 'validate:true ACCEPTED (PDS treated unknown lexicon as valid / skipped)'
  } catch (e) {
    validationBehavior = `validate:true REJECTED: ${e.message}`
  }
  console.log('validation probe:', validationBehavior)

  // ================= record writes (dependency-ordered) =================

  // 1. bob defines the endorsement badge (alice's award references it by strongRef).
  const badgeDef = await put(bob, 'app.certified.badge.definition', {
    badgeType: 'endorsement',
    title: 'Verified Impact Contributor',
    description: 'Awarded to accounts whose contributions have been verified.',
    createdAt: now(),
  })

  // 2. alice's activity (the artifact bob & carol contribute to; bob acks it in HIS repo,
  //    alice self-evaluates it in HER repo → self-edge).
  const aliceActivity = await put(
    alice,
    'org.hypercerts.claim.activity',
    {
      title: 'Reforestation in Amazon Basin 2024',
      shortDescription:
        'Planting and monitoring 12,000 native trees across three degraded parcels.',
      description: {
        $type: 'org.hypercerts.defs#descriptionString',
        description:
          'Full methodology, GPS parcels, species mix and survival monitoring cadence.',
      },
      contributors: [
        {
          contributorIdentity: {
            $type: 'org.hypercerts.claim.activity#contributorIdentity',
            identity: bobDid,
          },
          contributionWeight: '0.6',
          contributionDetails: {
            $type: 'org.hypercerts.claim.activity#contributorRole',
            role: 'Field lead & monitoring',
          },
        },
        {
          contributorIdentity: {
            $type: 'org.hypercerts.claim.activity#contributorIdentity',
            identity: carolDid,
          },
          contributionWeight: '0.4',
          contributionDetails: {
            $type: 'org.hypercerts.claim.activity#contributorRole',
            role: 'Nursery & logistics',
          },
        },
      ],
      workScope: {
        $type: 'org.hypercerts.claim.activity#workScopeString',
        scope: 'reforestation, biodiversity monitoring',
      },
      startDate: '2024-01-15T00:00:00.000Z',
      endDate: '2024-12-20T00:00:00.000Z',
      createdAt: now(),
    },
    ALICE_ACTIVITY_RKEY,
  )

  // 3. alice awards bob a badge (subject = DID). bob accepts it in HIS own repo (step 6).
  const award = await put(alice, 'app.certified.badge.award', {
    badge: strongRef(badgeDef.uri, badgeDef.cid),
    subject: { $type: 'app.certified.defs#did', did: bobDid },
    note: 'Reliable field partner.',
    createdAt: now(),
  })

  // 4. bob's own activity, with alice as a 1.0 contributor. This makes bob an activity
  //    author (target of alice's cross-repo E3 eval) and gives alice an E4 in-edge.
  const bobActivity = await put(
    bob,
    'org.hypercerts.claim.activity',
    {
      title: 'Mangrove restoration, Gulf of Guinea 2024',
      shortDescription: 'Replanting and monitoring 8,000 mangrove propagules across tidal flats.',
      description: {
        $type: 'org.hypercerts.defs#descriptionString',
        description: 'Tidal-zone survival monitoring with alice as verification lead.',
      },
      contributors: [
        {
          contributorIdentity: {
            $type: 'org.hypercerts.claim.activity#contributorIdentity',
            identity: aliceDid,
          },
          contributionWeight: '1.0',
          contributionDetails: {
            $type: 'org.hypercerts.claim.activity#contributorRole',
            role: 'Verification lead',
          },
        },
      ],
      workScope: {
        $type: 'org.hypercerts.claim.activity#workScopeString',
        scope: 'mangrove restoration, coastal monitoring',
      },
      startDate: '2024-02-01T00:00:00.000Z',
      endDate: '2024-11-30T00:00:00.000Z',
      createdAt: now(),
    },
    BOB_ACTIVITY_RKEY,
  )

  // 5. bob ACCEPTS alice's award, in HIS OWN repo, with a decimal weight (two-sided fact:
  //    the response keys on the SUBJECT's own DID → alice's award → bob edge is boosted).
  const response = await put(bob, 'app.certified.badge.response', {
    badgeAward: strongRef(award.uri, award.cid),
    response: 'accepted',
    weight: '0.85',
    createdAt: now(),
  })

  // 6. bob ACKNOWLEDGES alice's activity attribution, in HIS OWN repo (two-sided ack →
  //    bob's E4 share from alice's activity is boosted vs carol's unacked share).
  const ack = await put(bob, 'org.hypercerts.context.acknowledgement', {
    subject: strongRef(aliceActivity.uri, aliceActivity.cid),
    acknowledged: true,
    comment: 'Confirming my contribution to this activity.',
    createdAt: now(),
  })

  // 7. alice follows bob.
  const follow = await put(alice, 'app.certified.graph.follow', {
    subject: bobDid,
    createdAt: now(),
  })

  // 8. alice EVALUATES BOB's activity (cross-repo E3, subject in bob's repo, score 87.5/100).
  const evaluation = await put(alice, 'org.hypercerts.context.evaluation', {
    subject: strongRef(bobActivity.uri, bobActivity.cid),
    evaluators: [{ $type: 'app.certified.defs#did', did: aliceDid }],
    summary:
      'Strong survival rate (87.5%) verified against monitoring photos; methodology sound.',
    score: { min: '0', max: '100', value: '87.5' },
    createdAt: now(),
  })

  // 9. alice EVALUATES HER OWN activity (self-edge — must be inert but recorded; the
  //    anti-gaming fixture).
  const selfEvaluation = await put(alice, 'org.hypercerts.context.evaluation', {
    subject: strongRef(aliceActivity.uri, aliceActivity.cid),
    evaluators: [{ $type: 'app.certified.defs#did', did: aliceDid }],
    summary: 'Self-assessment: consistent survival across all three parcels.',
    score: { min: '0', max: '100', value: '90' },
    createdAt: now(),
  })

  // 10. alice's link.evm — REAL EIP-712 signature over {did,evmAddress,chainId,timestamp,nonce}.
  const evmPriv = generatePrivateKey()
  const evmAccount = privateKeyToAccount(evmPriv)
  const evmAddress = getAddress(evmAccount.address)
  const chainId = 10 // Optimism (plan §6)
  const timestamp = String(Math.floor(Date.now() / 1000))
  const nonce = '1'
  const message = {
    did: aliceDid,
    evmAddress,
    chainId: BigInt(chainId),
    timestamp: BigInt(timestamp),
    nonce: BigInt(nonce),
  }
  const signature = await evmAccount.signTypedData({
    domain: { ...EIP712_DOMAIN, chainId: BigInt(chainId) },
    types: EIP712_TYPES,
    primaryType: 'LinkAttestation',
    message,
  })
  // sanity: viem self-recover
  const recovered = await recoverTypedDataAddress({
    domain: { ...EIP712_DOMAIN, chainId: BigInt(chainId) },
    types: EIP712_TYPES,
    primaryType: 'LinkAttestation',
    message,
    signature,
  })
  if (getAddress(recovered) !== evmAddress) throw new Error('viem self-recover mismatch')
  console.log('EIP-712 signed; viem self-recover OK ->', evmAddress)

  const linkEvm = await put(
    alice,
    'app.certified.link.evm',
    {
      address: evmAddress,
      proof: {
        $type: 'app.certified.link.evm#eip712Proof',
        signature,
        message: {
          $type: 'app.certified.link.evm#eip712Message',
          did: aliceDid,
          evmAddress,
          chainId: String(chainId),
          timestamp,
          nonce,
        },
      },
      createdAt: now(),
    },
    'self', // key: "any"
  )

  await net.processAll()

  // ---------- per-repo export helper ----------
  const listRecords = async (agent, did) => {
    const rows = []
    for (const col of LIST_COLLECTIONS) {
      let cursor
      do {
        const lr = await agent.com.atproto.repo.listRecords({
          repo: did,
          collection: col,
          limit: 100,
          cursor,
        })
        for (const rec of lr.data.records) {
          const rkey = rec.uri.split('/').pop()
          rows.push(`${col}/${rkey}\t${rec.cid}`)
        }
        cursor = lr.data.cursor
      } while (cursor)
    }
    rows.sort() // LC_ALL=C-ish byte sort (keys are ascii)
    return rows
  }

  const exportRepo = async (agent, did, carName, plcName, tsvName) => {
    const carRes = await agent.com.atproto.sync.getRepo({ did })
    const carBytes = Buffer.from(carRes.data)
    await fs.writeFile(path.join(OUT, carName), carBytes)

    const auditRes = await fetch(`${plcUrl}/${did}/log/audit`)
    const audit = await auditRes.json()
    await fs.writeFile(path.join(OUT, plcName), JSON.stringify(audit, null, 2))

    const didDocRes = await fetch(`${plcUrl}/${did}`)
    const didDoc = await didDocRes.json()

    const status = await agent.com.atproto.sync.getLatestCommit({ did })
    const rows = await listRecords(agent, did)
    await fs.writeFile(path.join(OUT, tsvName), rows.join('\n') + '\n')

    return {
      did,
      rev: status.data.rev,
      headCid: status.data.cid,
      carBytes: carBytes.length,
      recordCount: rows.length,
      atprotoVerificationMethod: didDoc.verificationMethod?.find((v) => v.id.endsWith('#atproto')),
      records: rows,
    }
  }

  // alice keeps the historic file names; bob is the new export.
  const aliceExport = await exportRepo(
    alice,
    aliceDid,
    'hypercerts.car',
    'hypercerts.plc.json',
    'hypercerts.records.tsv',
  )
  const bobExport = await exportRepo(bob, bobDid, 'bob.car', 'bob.plc.json', 'bob.records.tsv')

  // ---------- meta.json ----------
  const meta = {
    generatedAt: now(),
    pdsVersion: JSON.parse(
      await fs.readFile(
        path.resolve(__dirname, 'node_modules/@atproto/pds/package.json'),
        'utf8',
      ),
    ).version,
    devEnvVersion: JSON.parse(
      await fs.readFile(
        path.resolve(__dirname, 'node_modules/@atproto/dev-env/package.json'),
        'utf8',
      ),
    ).version,
    lexiconVersion: '1.1.0',
    twoSided: true,
    aliceDid,
    bobDid,
    carolDid,
    aliceActivityRkey: ALICE_ACTIVITY_RKEY,
    bobActivityRkey: BOB_ACTIVITY_RKEY,
    alice: {
      did: aliceExport.did,
      rev: aliceExport.rev,
      headCid: aliceExport.headCid,
      carBytes: aliceExport.carBytes,
      recordCount: aliceExport.recordCount,
      atprotoVerificationMethod: aliceExport.atprotoVerificationMethod,
      records: aliceExport.records,
    },
    bob: {
      did: bobExport.did,
      rev: bobExport.rev,
      headCid: bobExport.headCid,
      carBytes: bobExport.carBytes,
      recordCount: bobExport.recordCount,
      atprotoVerificationMethod: bobExport.atprotoVerificationMethod,
      records: bobExport.records,
    },
    validationBehavior,
    evm: {
      privateKey: evmPriv, // throwaway test key
      address: evmAddress,
      chainId: String(chainId),
      timestamp,
      nonce,
      signature,
      eip712: {
        domain: { ...EIP712_DOMAIN, chainId },
        primaryType: 'LinkAttestation',
        types: EIP712_TYPES,
        message: {
          did: aliceDid,
          evmAddress,
          chainId: String(chainId),
          timestamp,
          nonce,
        },
      },
    },
    strongRefs: {
      badgeDefinition: badgeDef, // in bob's repo
      aliceActivity,
      bobActivity,
      award, // alice -> bob
      response, // bob accepts (bob's repo)
      acknowledgement: ack, // bob acks (bob's repo)
      follow,
      evaluation, // alice -> bob's activity (E3)
      selfEvaluation, // alice -> alice's activity (self-edge)
      linkEvm,
    },
  }
  await fs.writeFile(path.join(OUT, 'meta.json'), JSON.stringify(meta, null, 2))

  console.log('alice records:', aliceExport.recordCount, ' rev:', aliceExport.rev)
  console.log('bob records:  ', bobExport.recordCount, ' rev:', bobExport.rev)
  console.log('alice CAR bytes:', aliceExport.carBytes, ' bob CAR bytes:', bobExport.carBytes)
  console.log('#atproto vm (alice):', JSON.stringify(aliceExport.atprotoVerificationMethod))

  await net.close()
  console.log('DONE')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
