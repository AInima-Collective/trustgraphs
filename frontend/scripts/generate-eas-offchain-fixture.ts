/**
 * Generate the normative Envelope0PayloadV1 compatibility corpus.
 *
 * EAS typed data, signatures, and UIDs come from the pinned official SDK. The Trustgraphs
 * payload and head encoding are deliberately small independent reference implementations whose
 * bytes are consumed by Rust, guest, and Solidity tests. This script never handles a real key;
 * FIXTURE_PRIVATE_KEY is public deterministic test material.
 */
import {
  EAS,
  Offchain,
  OffchainAttestationVersion,
  SchemaEncoder,
  type SignedOffchainAttestation,
} from '@ethereum-attestation-service/eas-sdk'
import {
  encodeAbiParameters,
  encodePacked,
  hashTypedData,
  keccak256,
  sha256,
  type Address,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const SDK_VERSION = '2.9.0'
const SDK_INTEGRITY =
  'sha512-jEtBlhfm0HFkl64jAa4rxOXjEQkblTHqSmLFhttPf9y+ALEOk4qgJzV9knnJ7Yh+jFs1jxbTrVeUGap03Fwy9g=='
const FIXTURE_PRIVATE_KEY =
  '0x4242424242424242424242424242424242424242424242424242424242424242' as const
const EAS_ADDRESS = '0xc2679fbd37d54388ce493f1db75320d236e1815e' as Address
const EAS_VERSION = '1.3.0'
const CHAIN_ID = 11_155_111n
const REGISTRY = '0x1111111111111111111111111111111111111111' as Address
const WRONG_REGISTRY = '0x9999999999999999999999999999999999999999' as Address
const SCHEMA_UID = `0x${'ab'.repeat(32)}` as Hex
const WRONG_SCHEMA_UID = `0x${'cd'.repeat(32)}` as Hex
const ZERO32 = `0x${'00'.repeat(32)}` as Hex
const OWNER = privateKeyToAccount(FIXTURE_PRIVATE_KEY)
const ANCHOR_1_TIME = 1_770_000_060n
const ANCHOR_2_TIME = 1_770_000_120n
const SECP256K1_N = BigInt(
  '0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141'
)

const PAYLOAD_MAGIC = Buffer.from('TGEAS0PL', 'ascii')
const HEAD_TYPES = {
  Anchor: [
    { name: 'nodeId', type: 'bytes32' },
    { name: 'envelopeKind', type: 'uint8' },
    { name: 'schemaUid', type: 'bytes32' },
    { name: 'previousHead', type: 'bytes32' },
    { name: 'head', type: 'bytes32' },
    { name: 'count', type: 'uint64' },
    { name: 'dataCommitment', type: 'bytes32' },
  ],
} as const

type EasConfig = {
  address: Address
  version: string
  chainId: bigint
}

type AttestationRecord = {
  version: number
  schema: Hex
  recipient: Address
  time: bigint
  expirationTime: bigint
  revocable: boolean
  refUID: Hex
  data: Hex
  salt: Hex
  signature: Hex
  uid: Hex
  sdk: SignedOffchainAttestation
  typedDigest: Hex
  domainSeparator: Hex
}

type LogEntry = { kind: 0 | 1; uid: Hex }

type HeadAuthorization = {
  domain: {
    name: 'Trustgraphs Offchain Head'
    version: '2'
    chainId: bigint
    verifyingContract: Address
  }
  message: {
    nodeId: Hex
    envelopeKind: 0
    schemaUid: Hex
    previousHead: Hex
    head: Hex
    count: bigint
    dataCommitment: Hex
  }
  typedDigest: Hex
  signature: Hex
}

const bytes = (value: Hex) => Buffer.from(value.slice(2), 'hex')
const hex = (value: Uint8Array): Hex =>
  `0x${Buffer.from(value).toString('hex')}`

const uintBe = (value: bigint | number, width: number) => {
  let n = BigInt(value)
  const out = Buffer.alloc(width)
  for (let i = width - 1; i >= 0; i -= 1) {
    out[i] = Number(n & 0xffn)
    n >>= 8n
  }
  if (n !== 0n)
    throw new Error(`integer ${value} does not fit in ${width} bytes`)
  return out
}

const flipLastByte = (value: Hex): Hex => {
  const out = bytes(value)
  out[out.length - 1] ^= 1
  return hex(out)
}

const base32LowerNoPadding = (value: Uint8Array) => {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz234567'
  let accumulator = 0
  let bits = 0
  let out = ''
  for (const byte of value) {
    accumulator = (accumulator << 8) | byte
    bits += 8
    while (bits >= 5) {
      bits -= 5
      out += alphabet[(accumulator >>> bits) & 31]
    }
  }
  if (bits > 0) out += alphabet[(accumulator << (5 - bits)) & 31]
  return out
}

const rawCid = (digest: Hex) =>
  `b${base32LowerNoPadding(Buffer.concat([Buffer.from([0x01, 0x55, 0x12, 0x20]), bytes(digest)]))}`

const domainSeparator = (domain: {
  name: string
  version: string
  chainId: bigint
  verifyingContract: Address
}) =>
  keccak256(
    encodeAbiParameters(
      [
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'bytes32' },
        { type: 'uint256' },
        { type: 'address' },
      ],
      [
        keccak256(
          Buffer.from(
            'EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)'
          )
        ),
        keccak256(Buffer.from(domain.name)),
        keccak256(Buffer.from(domain.version)),
        domain.chainId,
        domain.verifyingContract,
      ]
    )
  )

const nodeId = (owner: Address) =>
  keccak256(encodeAbiParameters([{ type: 'address' }], [owner]))

const entryLeaf = (entry: LogEntry) =>
  keccak256(
    encodeAbiParameters(
      [{ type: 'uint8' }, { type: 'bytes32' }],
      [entry.kind, entry.uid]
    )
  )

const prefixHeads = (entries: LogEntry[]) => {
  const heads: Hex[] = []
  let head = ZERO32
  for (const entry of entries) {
    head = keccak256(
      encodeAbiParameters(
        [{ type: 'bytes32' }, { type: 'bytes32' }],
        [head, entryLeaf(entry)]
      )
    )
    heads.push(head)
  }
  return heads
}

const signatureHex = (signed: SignedOffchainAttestation): Hex => {
  const v = signed.signature.v
  if (v !== 27 && v !== 28)
    throw new Error(`official SDK returned non-canonical v ${v}`)
  return hex(
    Buffer.concat([
      bytes(signed.signature.r as Hex),
      bytes(signed.signature.s as Hex),
      uintBe(v, 1),
    ])
  )
}

const offchainUidV2 = ({
  schema,
  recipient,
  time,
  expirationTime,
  revocable,
  refUID,
  data,
  salt,
}: {
  schema: Hex
  recipient: Address
  time: bigint
  expirationTime: bigint
  revocable: boolean
  refUID: Hex
  data: Hex
  salt: Hex
}) =>
  keccak256(
    encodePacked(
      [
        'uint16',
        'bytes',
        'address',
        'address',
        'uint64',
        'uint64',
        'bool',
        'bytes32',
        'bytes',
        'bytes32',
        'uint32',
      ],
      [
        2,
        hex(Buffer.from(schema.toLowerCase(), 'utf8')),
        recipient,
        '0x0000000000000000000000000000000000000000',
        time,
        expirationTime,
        revocable,
        refUID,
        data,
        salt,
        0,
      ]
    )
  )

const sdkSigner = {
  signTypedData: async (domain: any, types: any, message: any) =>
    OWNER.signTypedData({ domain, types, primaryType: 'Attest', message }),
}

const signAttestation = async ({
  sdkVersion = OffchainAttestationVersion.Version2,
  config = { address: EAS_ADDRESS, version: EAS_VERSION, chainId: CHAIN_ID },
  schema = SCHEMA_UID,
  recipient = '0x2222222222222222222222222222222222222222' as Address,
  time = 1_770_000_000n,
  expirationTime = 0n,
  revocable = true,
  refUID = ZERO32,
  data,
  salt = `0x${'01'.repeat(32)}` as Hex,
}: {
  sdkVersion?: OffchainAttestationVersion
  config?: EasConfig
  schema?: Hex
  recipient?: Address
  time?: bigint
  expirationTime?: bigint
  revocable?: boolean
  refUID?: Hex
  data: Hex
  salt?: Hex
}): Promise<AttestationRecord> => {
  const eas = new EAS(config.address)
  const offchain = new Offchain(config, sdkVersion, eas)
  const signed = await offchain.signOffchainAttestation(
    { schema, recipient, time, expirationTime, revocable, refUID, data, salt },
    sdkSigner as any
  )
  const typedDigest = hashTypedData({
    domain: signed.domain as any,
    types: signed.types as any,
    primaryType: signed.primaryType as any,
    message: signed.message as any,
  })
  if (sdkVersion === OffchainAttestationVersion.Version2) {
    const independentUid = offchainUidV2({
      schema,
      recipient,
      time,
      expirationTime,
      revocable,
      refUID,
      data,
      salt,
    })
    if (independentUid !== signed.uid) {
      throw new Error(
        `official SDK UID mismatch: ${signed.uid} != ${independentUid}`
      )
    }
  }
  return {
    version: sdkVersion,
    schema,
    recipient,
    time,
    expirationTime,
    revocable,
    refUID,
    data,
    salt,
    signature: signatureHex(signed),
    uid: signed.uid as Hex,
    sdk: signed,
    typedDigest,
    domainSeparator: domainSeparator({
      name: 'EAS Attestation',
      version: config.version,
      chainId: config.chainId,
      verifyingContract: config.address,
    }),
  }
}

const encodePayload = (
  owner: Address,
  entries: LogEntry[],
  attestations: AttestationRecord[]
) => {
  const chunks: Buffer[] = [
    PAYLOAD_MAGIC,
    uintBe(1, 2),
    bytes(owner),
    uintBe(entries.length, 4),
    uintBe(attestations.length, 4),
  ]
  for (const entry of entries)
    chunks.push(uintBe(entry.kind, 1), bytes(entry.uid))
  for (const attestation of attestations) {
    chunks.push(
      uintBe(attestation.version, 2),
      bytes(attestation.schema),
      bytes(attestation.recipient),
      uintBe(attestation.time, 8),
      uintBe(attestation.expirationTime, 8),
      uintBe(attestation.revocable ? 1 : 0, 1),
      bytes(attestation.refUID),
      uintBe(bytes(attestation.data).length, 4),
      bytes(attestation.data),
      bytes(attestation.salt),
      bytes(attestation.signature)
    )
  }
  return Buffer.concat(chunks)
}

const signHead = async ({
  previousHead,
  head,
  count,
  dataCommitment,
  registry = REGISTRY,
}: {
  previousHead: Hex
  head: Hex
  count: bigint
  dataCommitment: Hex
  registry?: Address
}): Promise<HeadAuthorization> => {
  const domain = {
    name: 'Trustgraphs Offchain Head',
    version: '2',
    chainId: CHAIN_ID,
    verifyingContract: registry,
  } as const
  const message = {
    nodeId: nodeId(OWNER.address),
    envelopeKind: 0 as const,
    schemaUid: SCHEMA_UID,
    previousHead,
    head,
    count,
    dataCommitment,
  }
  return {
    domain,
    message,
    typedDigest: hashTypedData({
      domain,
      types: HEAD_TYPES,
      primaryType: 'Anchor',
      message,
    }),
    signature: await OWNER.signTypedData({
      domain,
      types: HEAD_TYPES,
      primaryType: 'Anchor',
      message,
    }),
  }
}

const jsonValue = (_key: string, value: unknown) =>
  typeof value === 'bigint' ? value.toString() : value

const publicAttestation = (attestation: AttestationRecord) => ({
  version: attestation.version,
  schema: attestation.schema,
  recipient: attestation.recipient,
  time: attestation.time,
  expirationTime: attestation.expirationTime,
  revocable: attestation.revocable,
  refUID: attestation.refUID,
  data: attestation.data,
  salt: attestation.salt,
  signature: attestation.signature,
  uid: attestation.uid,
  typedDigest: attestation.typedDigest,
  domainSeparator: attestation.domainSeparator,
  sdkResponse: attestation.sdk,
})

const highSSignature = (signature: Hex): Hex => {
  const value = bytes(signature)
  const r = value.subarray(0, 32)
  const s = BigInt(`0x${value.subarray(32, 64).toString('hex')}`)
  const v = value[64]
  return hex(
    Buffer.concat([
      r,
      uintBe(SECP256K1_N - s, 32),
      uintBe(v === 27 ? 28 : 27, 1),
    ])
  )
}

const main = async () => {
  const schemaEncoder = new SchemaEncoder('string comment,uint256 confidence')
  const data1 = schemaEncoder.encodeData([
    { name: 'comment', type: 'string', value: 'trust grows 🌱' },
    { name: 'confidence', type: 'uint256', value: 73n },
  ]) as Hex
  const data2 = schemaEncoder.encodeData([
    { name: 'comment', type: 'string', value: 'second edge' },
    { name: 'confidence', type: 'uint256', value: 91n },
  ]) as Hex

  const attestation1 = await signAttestation({ data: data1 })
  const attestation2 = await signAttestation({
    data: data2,
    recipient: '0x3333333333333333333333333333333333333333',
    time: 1_770_000_001n,
    salt: `0x${'02'.repeat(32)}`,
  })
  const entries: LogEntry[] = [
    { kind: 0, uid: attestation1.uid },
    { kind: 0, uid: attestation2.uid },
    { kind: 1, uid: attestation1.uid },
  ]
  const heads = prefixHeads(entries)
  const payload1 = encodePayload(OWNER.address, entries.slice(0, 1), [
    attestation1,
  ])
  const payload = encodePayload(OWNER.address, entries, [
    attestation1,
    attestation2,
  ])
  const commitment1 = sha256(payload1)
  const commitment = sha256(payload)
  const authorization1 = await signHead({
    previousHead: ZERO32,
    head: heads[0],
    count: 1n,
    dataCommitment: commitment1,
  })
  const authorization2 = await signHead({
    previousHead: heads[0],
    head: heads[2],
    count: 3n,
    dataCommitment: commitment,
  })

  const negativeInputs: Array<{
    name: string
    expected: string
    attestation?: AttestationRecord
    payload?: Buffer
    claimedCommitment?: Hex
    headRegistry?: Address
  }> = []
  negativeInputs.push({
    name: 'eas-v1',
    expected: 'E0_PROFILE_VERSION',
    attestation: await signAttestation({
      sdkVersion: OffchainAttestationVersion.Version1,
      data: data1,
      salt: ZERO32,
    }),
  })
  negativeInputs.push({
    name: 'wrong-eas-address',
    expected: 'E0_EAS_SIGNATURE',
    attestation: await signAttestation({
      config: {
        address: '0x8888888888888888888888888888888888888888',
        version: EAS_VERSION,
        chainId: CHAIN_ID,
      },
      data: data1,
    }),
  })
  negativeInputs.push({
    name: 'wrong-chain',
    expected: 'E0_EAS_SIGNATURE',
    attestation: await signAttestation({
      config: { address: EAS_ADDRESS, version: EAS_VERSION, chainId: 1n },
      data: data1,
    }),
  })
  negativeInputs.push({
    name: 'wrong-schema',
    expected: 'E0_SCHEMA',
    attestation: await signAttestation({
      data: data1,
      schema: WRONG_SCHEMA_UID,
    }),
  })
  negativeInputs.push({
    name: 'future-time',
    expected: 'E0_FUTURE_TIME',
    attestation: await signAttestation({
      data: data1,
      time: ANCHOR_1_TIME + 1n,
    }),
  })
  negativeInputs.push({
    name: 'nonzero-expiration',
    expected: 'E0_EXPIRATION',
    attestation: await signAttestation({
      data: data1,
      expirationTime: ANCHOR_2_TIME + 1_000n,
    }),
  })
  negativeInputs.push({
    name: 'nonzero-ref-uid',
    expected: 'E0_REF_UID',
    attestation: await signAttestation({
      data: data1,
      refUID: `0x${'77'.repeat(32)}`,
    }),
  })
  negativeInputs.push({
    name: 'zero-salt',
    expected: 'E0_ZERO_SALT',
    attestation: await signAttestation({ data: data1, salt: ZERO32 }),
  })
  negativeInputs.push({
    name: 'high-s',
    expected: 'E0_SIGNATURE_FORM',
    attestation: {
      ...attestation1,
      signature: highSSignature(attestation1.signature),
    },
  })
  negativeInputs.push({
    name: 'bad-head-domain',
    expected: 'E0_HEAD_SIGNATURE',
    attestation: attestation1,
    headRegistry: WRONG_REGISTRY,
  })

  const changedCommitment = flipLastByte(commitment1)
  negativeInputs.push({
    name: 'changed-data-commitment',
    expected: 'E0_COMMITMENT',
    attestation: attestation1,
    claimedCommitment: changedCommitment,
  })
  negativeInputs.push({
    name: 'trailing-payload-byte',
    expected: 'E0_TRAILING_BYTES',
    payload: Buffer.concat([payload1, Buffer.from([0])]),
    attestation: attestation1,
  })

  const negatives = []
  for (const input of negativeInputs) {
    const negativeAttestation = input.attestation ?? attestation1
    const negativeEntries: LogEntry[] = [
      { kind: 0, uid: negativeAttestation.uid },
    ]
    const negativePayload =
      input.payload ??
      encodePayload(OWNER.address, negativeEntries, [negativeAttestation])
    const negativeHead = prefixHeads(negativeEntries)[0]
    const actualCommitment = sha256(negativePayload)
    const claimedCommitment = input.claimedCommitment ?? actualCommitment
    const authorization = await signHead({
      previousHead: ZERO32,
      head: negativeHead,
      count: 1n,
      dataCommitment: claimedCommitment,
      registry: input.headRegistry,
    })
    negatives.push({
      name: input.name,
      expectedReason: input.expected,
      payloadFile: `negative/${input.name}.bin`,
      payloadHex: hex(negativePayload),
      actualCommitment,
      claimedCommitment,
      cid: rawCid(actualCommitment),
      head: negativeHead,
      anchorTimestamp: ANCHOR_1_TIME,
      attestation: publicAttestation(negativeAttestation),
      authorization,
    })
  }

  const manifest = {
    protocol: 'Envelope0PayloadV1',
    generator: 'pnpm --dir frontend fixture:eas-offchain',
    sdk: {
      package: '@ethereum-attestation-service/eas-sdk',
      version: SDK_VERSION,
      lockfileIntegrity: SDK_INTEGRITY,
    },
    fixtureKeyWarning:
      'Public deterministic fixture key; never use for funds or deployment.',
    fixturePrivateKey: FIXTURE_PRIVATE_KEY,
    owner: OWNER.address,
    nodeId: nodeId(OWNER.address),
    schema: 'string comment,uint256 confidence',
    schemaUid: SCHEMA_UID,
    easDomain: {
      name: 'EAS Attestation',
      version: EAS_VERSION,
      chainId: CHAIN_ID,
      verifyingContract: EAS_ADDRESS,
      separator: attestation1.domainSeparator,
    },
    headDomain: {
      name: 'Trustgraphs Offchain Head',
      version: '2',
      chainId: CHAIN_ID,
      verifyingContract: REGISTRY,
      separator: domainSeparator({
        name: 'Trustgraphs Offchain Head',
        version: '2',
        chainId: CHAIN_ID,
        verifyingContract: REGISTRY,
      }),
    },
    positive: {
      payloadFile: 'payload.bin',
      payloadHex: hex(payload),
      payloadLength: payload.length,
      dataCommitment: commitment,
      cid: rawCid(commitment),
      entries,
      prefixHeads: heads,
      attestations: [
        publicAttestation(attestation1),
        publicAttestation(attestation2),
      ],
      anchorHistory: [
        {
          foldIndex: 0,
          blockTimestamp: ANCHOR_1_TIME,
          payloadFile: 'payload-count-1.bin',
          payloadHex: hex(payload1),
          payloadLength: payload1.length,
          dataCommitment: commitment1,
          cid: rawCid(commitment1),
          authorization: authorization1,
        },
        {
          foldIndex: 1,
          blockTimestamp: ANCHOR_2_TIME,
          payloadFile: 'payload.bin',
          payloadHex: hex(payload),
          payloadLength: payload.length,
          dataCommitment: commitment,
          cid: rawCid(commitment),
          authorization: authorization2,
        },
      ],
      expectedMutations: [
        {
          kind: 'attest',
          uid: attestation1.uid,
          recipient: attestation1.recipient,
          effectiveTimestamp: attestation1.time,
          firstCommitAnchorIndex: 0,
          logEntryIndex: 0,
        },
        {
          kind: 'attest',
          uid: attestation2.uid,
          recipient: attestation2.recipient,
          effectiveTimestamp: attestation2.time,
          firstCommitAnchorIndex: 1,
          logEntryIndex: 1,
        },
        {
          kind: 'revoke',
          uid: attestation1.uid,
          recipient: attestation1.recipient,
          effectiveTimestamp: ANCHOR_2_TIME,
          firstCommitAnchorIndex: 1,
          logEntryIndex: 2,
        },
      ],
    },
    negatives,
  }

  const outputDir = resolve(
    dirname(fileURLToPath(import.meta.url)),
    '../../test/fixtures/eas-offchain/v1'
  )
  const expectedFiles = new Map<string, Buffer>()
  expectedFiles.set(
    'manifest.json',
    Buffer.from(`${JSON.stringify(manifest, jsonValue, 2)}\n`)
  )
  expectedFiles.set('payload.bin', payload)
  expectedFiles.set('payload-count-1.bin', payload1)
  for (let index = 0; index < negatives.length; index += 1) {
    expectedFiles.set(
      negatives[index].payloadFile,
      bytes(negatives[index].payloadHex)
    )
  }

  const check = process.argv.includes('--check')
  for (const [relativePath, contents] of expectedFiles) {
    const path = resolve(outputDir, relativePath)
    if (check) {
      const existing = await readFile(path)
      if (!existing.equals(contents))
        throw new Error(`fixture drift: ${relativePath}`)
    } else {
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, contents)
    }
  }
  console.log(
    `${check ? 'verified' : 'wrote'} ${expectedFiles.size} Envelope0PayloadV1 fixture files`
  )
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
