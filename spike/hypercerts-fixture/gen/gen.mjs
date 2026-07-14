// Hypercerts atproto fixture generator (GOAL.md M1, last fixture).
//
// Stands up an in-process atproto network (@atproto/dev-env TestNetworkNoAppView:
// a real did:plc PLC server + a SQLite PDS), creates two accounts, writes real
// records for all seven HYPERCERTS_ATPROTO_PLAN §2 collections (plus a supporting
// badge.definition), signs a REAL EIP-712 app.certified.link.evm proof with a
// freshly generated EVM key, then exports the primary repo CAR + PLC audit log +
// commit metadata + a ground-truth {key -> valueCID} table into ../fixtures/.
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

async function main() {
  await fs.mkdir(OUT, { recursive: true })
  const net = await TestNetworkNoAppView.create({})
  const pdsUrl = net.pds.url
  const plcUrl = net.plc.url
  console.log('PDS:', pdsUrl, ' PLC:', plcUrl)

  // ---- two accounts: primary (exported) + peer (referenced) ----
  const primary = net.pds.getClient
    ? new AtpAgent({ service: pdsUrl })
    : new AtpAgent({ service: pdsUrl })
  const peer = new AtpAgent({ service: pdsUrl })

  await primary.createAccount({
    handle: 'alice.test',
    email: 'alice@example.com',
    password: 'hunter2hunter2',
  })
  await peer.createAccount({
    handle: 'bob.test',
    email: 'bob@example.com',
    password: 'hunter2hunter2',
  })
  const primaryDid = primary.session.did
  const peerDid = peer.session.did
  // a third, purely-referenced contributor DID (no repo — self-asserted identity)
  const ghostDid = 'did:plc:zzzzzzzzzzzzzzzzzzzzzzzz'
  console.log('primary(alice):', primaryDid)
  console.log('peer(bob):     ', peerDid)

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
  // Ask the PDS to validate an unknown-lexicon record (validate:true). Record
  // whether the PDS knows the hypercerts lexicons at all.
  let validationBehavior
  try {
    await peer.com.atproto.repo.applyWrites({
      repo: peerDid,
      validate: true,
      writes: [
        {
          $type: 'com.atproto.repo.applyWrites#create',
          collection: 'app.certified.graph.follow',
          value: { subject: primaryDid, createdAt: now() },
        },
      ],
    })
    validationBehavior = 'validate:true ACCEPTED (PDS treated unknown lexicon as valid / skipped)'
  } catch (e) {
    validationBehavior = `validate:true REJECTED: ${e.message}`
  }
  console.log('validation probe:', validationBehavior)

  // ---------- Stage A: peer writes supporting records ----------
  const badgeDef = await put(peer, 'app.certified.badge.definition', {
    badgeType: 'endorsement',
    title: 'Verified Impact Contributor',
    description: 'Awarded to accounts whose contributions have been verified.',
    createdAt: now(),
  })
  // peer awards a badge to primary (inbound award primary will respond to)
  const inboundAward = await put(peer, 'app.certified.badge.award', {
    badge: strongRef(badgeDef.uri, badgeDef.cid),
    subject: { $type: 'app.certified.defs#did', did: primaryDid },
    note: 'Consistent, well-evidenced contributions across 2024.',
    createdAt: now(),
  })

  // ---------- Stage B: primary writes the activity (referenced by 3,6) ----------
  const activity = await put(
    primary,
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
            identity: peerDid,
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
            identity: ghostDid,
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
    'reforestation-amazon-2024', // key: "any"
  )

  // ---------- Stage C: primary writes the remaining six §2 collections ----------
  // 1. graph.follow
  const follow = await put(primary, 'app.certified.graph.follow', {
    subject: peerDid,
    createdAt: now(),
  })

  // 2. badge.award (primary -> peer, subject = DID)
  const award = await put(primary, 'app.certified.badge.award', {
    badge: strongRef(badgeDef.uri, badgeDef.cid),
    subject: { $type: 'app.certified.defs#did', did: peerDid },
    note: 'Reliable field partner.',
    createdAt: now(),
  })

  // 3. badge.response (primary accepts peer's inbound award, with a decimal weight)
  const response = await put(primary, 'app.certified.badge.response', {
    badgeAward: strongRef(inboundAward.uri, inboundAward.cid),
    response: 'accepted',
    weight: '0.85',
    createdAt: now(),
  })

  // 4. context.evaluation (primary -> activity, with numeric-string score)
  const evaluation = await put(primary, 'org.hypercerts.context.evaluation', {
    subject: strongRef(activity.uri, activity.cid),
    evaluators: [{ $type: 'app.certified.defs#did', did: primaryDid }],
    summary:
      'Strong survival rate (87%) verified against monitoring photos; methodology sound.',
    score: { min: '0', max: '100', value: '87.5' },
    createdAt: now(),
  })

  // 5. context.acknowledgement (primary acknowledges the activity attribution)
  const ack = await put(primary, 'org.hypercerts.context.acknowledgement', {
    subject: strongRef(activity.uri, activity.cid),
    acknowledged: true,
    comment: 'Confirming my contribution to this activity.',
    createdAt: now(),
  })

  // 6. link.evm — REAL EIP-712 signature over eip712Message{did,evmAddress,chainId,timestamp,nonce}
  const evmPriv = generatePrivateKey()
  const evmAccount = privateKeyToAccount(evmPriv)
  const evmAddress = getAddress(evmAccount.address)
  const chainId = 10 // Optimism (plan §6)
  const timestamp = String(Math.floor(Date.now() / 1000))
  const nonce = '1'
  const message = {
    did: primaryDid,
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
    primary,
    'app.certified.link.evm',
    {
      address: evmAddress,
      proof: {
        $type: 'app.certified.link.evm#eip712Proof',
        signature,
        message: {
          $type: 'app.certified.link.evm#eip712Message',
          did: primaryDid,
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

  // ---------- export CAR (com.atproto.sync.getRepo against the local PDS) ----------
  const carRes = await primary.com.atproto.sync.getRepo({ did: primaryDid })
  const carBytes = Buffer.from(carRes.data)
  await fs.writeFile(path.join(OUT, 'hypercerts.car'), carBytes)

  // ---------- PLC audit log (real, from the local PLC server) ----------
  const auditRes = await fetch(`${plcUrl}/${primaryDid}/log/audit`)
  const audit = await auditRes.json()
  await fs.writeFile(path.join(OUT, 'hypercerts.plc.json'), JSON.stringify(audit, null, 2))

  // did doc (for the #atproto key, independent of the audit log)
  const didDocRes = await fetch(`${plcUrl}/${primaryDid}`)
  const didDoc = await didDocRes.json()

  // ---------- commit metadata ----------
  const status = await primary.com.atproto.sync.getLatestCommit({ did: primaryDid })
  const rev = status.data.rev
  const headCid = status.data.cid

  // ---------- ground-truth key -> valueCID table (PDS is the source of truth) ----------
  // list every record via com.atproto.repo.listRecords across the seven collections
  const collections = [
    'app.certified.graph.follow',
    'app.certified.badge.award',
    'app.certified.badge.response',
    'org.hypercerts.context.evaluation',
    'org.hypercerts.claim.activity',
    'org.hypercerts.context.acknowledgement',
    'app.certified.link.evm',
  ]
  const rows = []
  for (const col of collections) {
    let cursor
    do {
      const lr = await primary.com.atproto.repo.listRecords({
        repo: primaryDid,
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
  await fs.writeFile(path.join(OUT, 'hypercerts.records.tsv'), rows.join('\n') + '\n')

  // ---------- signing-key material + EIP-712 derivation, for the walker & host verifier ----------
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
    primaryDid,
    peerDid,
    ghostDid,
    rev,
    headCid,
    dataRoot: null, // filled from commit.txt below by the walker; recorded here for convenience
    atprotoVerificationMethod: didDoc.verificationMethod?.find((v) =>
      v.id.endsWith('#atproto'),
    ),
    recordCount: rows.length,
    collections,
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
          did: primaryDid,
          evmAddress,
          chainId: String(chainId),
          timestamp,
          nonce,
        },
      },
    },
    strongRefs: {
      badgeDefinition: badgeDef,
      inboundAward,
      activity,
      follow,
      award,
      response,
      evaluation,
      acknowledgement: ack,
      linkEvm,
    },
  }
  await fs.writeFile(path.join(OUT, 'meta.json'), JSON.stringify(meta, null, 2))

  console.log('records written:', rows.length)
  console.log('rev:', rev, ' head:', headCid)
  console.log('CAR bytes:', carBytes.length)
  console.log('#atproto vm:', JSON.stringify(meta.atprotoVerificationMethod))

  await net.close()
  console.log('DONE')
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
