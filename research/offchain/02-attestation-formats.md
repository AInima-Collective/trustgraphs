# Offchain Attestation Formats & Ecosystems — Technical Dossier

**Status:** Source dossier (substrate for [`../OFFCHAIN_ATTESTATIONS_ZK.md`](../OFFCHAIN_ATTESTATIONS_ZK.md); realized — see [`../../docs/PROGRAMS.md`](../../docs/PROGRAMS.md)).

> Source research for [`../OFFCHAIN_ATTESTATIONS_ZK.md`](../OFFCHAIN_ATTESTATIONS_ZK.md). Compiled 2026-07-10; all claims web-checked; uncertainty flagged inline.

---

## 1. EAS Offchain Attestations

### 1.1 EIP-712 structure & versioning

An EAS offchain attestation is an EIP-712 signature over an `Attest` struct. Three format generations exist (source: [eas-sdk `src/offchain/offchain.ts`](https://github.com/ethereum-attestation-service/eas-sdk), [offchain docs](https://docs.attest.org/docs/easscan/offchain)):

- **Legacy (v0):** primary type `Attestation` (later `Attest`); fields: `schema bytes32, recipient address, time uint64, expirationTime uint64, revocable bool, refUID bytes32, data bytes`. No `version` field.
- **Version 1:** adds `version uint16` as the first field; primary type `Attest`.
- **Version 2 (current):** v1 fields plus **`salt bytes32`** appended. If no salt is supplied the SDK generates 32 random bytes (`hexlify(randomBytes(32))`). Salt exists so identical attestations don't collide to the same UID and to blunt brute-forcing of private/undisclosed attestations.

**Domain:** `name: "EAS Attestation"`, `chainId`, `verifyingContract` = the EAS deployment; `version` = the EAS *contract* version string (legacy easscan-era attestations used `"0.26"`; newer ones track the deployed contract, e.g. 1.x — the SDK reads it from the contract, so verifiers must accept multiple domain versions). The signer of the typed data is the **attester** — note the attester is *not* a struct field; it's recovered from the signature.

The serialized artifact ("offchain attestation package") = `{domain, primaryType, types, message, signature{v,r,s}, uid, version}`.

### 1.2 Offchain UID computation

`Offchain.getOffchainUID` = `solidityPackedKeccak256` (i.e. keccak over `abi.encodePacked`) with version-dependent layout:

- **Legacy:** types `['bytes','address','address','uint64','uint64','bool','bytes32','bytes','uint32']` = (schema-UID *as UTF-8 bytes of the hex string*, recipient, **attester slot hardcoded to `ZERO_ADDRESS`**, time, expirationTime, revocable, refUID, data, bump=`0`).
- **v1:** prepends `uint16 version`.
- **v2:** v1 layout plus `bytes32 salt` inserted before the final `uint32 0`.

Two consequences for TrustGraph: **(a)** the offchain UID does *not* bind the attester — attester identity comes only from signature recovery, so UIDs from different attesters can theoretically collide (pre-v2, trivially); **(b)** this differs from the *onchain* UID formula (which packs the real attester and a bump counter), so onchain and offchain UIDs of "the same" attestation differ.

### 1.3 Revocation of offchain attestations

Onchain registry in [`EAS.sol`](https://github.com/ethereum-attestation-service/eas-contracts/blob/master/contracts/EAS.sol): `revokeOffchain(bytes32 data)` / `multiRevokeOffchain(bytes32[])` write to a mapping `revoker => uid => timestamp` (readable via `getRevokeOffchain(revoker, uid)`), emitting `RevokedOffchain`. Key properties:

- Revocation is **per-revoker**: a verifier must check `getRevokeOffchain(attester, uid)` — anyone can "revoke" any bytes32, so only the attester's entry is meaningful.
- It costs gas (one small tx), i.e., revocation is on-chain even when attestation is off-chain. For TrustGraph this is convenient: the SP1 prover already reads chain state, so it can consume the revocation mapping/events as a deletion set with completeness guaranteed by the chain.

### 1.4 Timestamping & batch merkle timestamping

Offchain attestations carry a self-declared `time` field with no network guarantee. EAS provides `timestamp(bytes32)` / `multiTimestamp(bytes32[])` on the same contract (event `Timestamped`), giving proof-of-existence-before-block-time for a UID. The documented **batch pattern** ([Batch Timestamping](https://docs.attest.org/docs/developer-tools/verify-timestamp), [tutorial](https://github.com/ethereum-attestation-service/eas-docs-site/blob/main/docs/tutorials/timestamping-attestations.md)): build a merkle tree of many offchain-attestation UIDs, call `timestamp(root)` once; each UID inherits the timestamp via a merkle proof against the root. This is exactly the primitive TrustGraph would want for epoch-batched offchain edges — it's also, notably, almost the same shape as the existing score-root commitment.

### 1.5 Private-data attestations (merkle-ized fields)

[EAS "private data" attestations](https://mirror.xyz/0xeee68aECeB4A9e9f328a46c39F50d83fA0239cDF/BiFUEFJKo6ZsIvPwsP9WPC2UZX0-x_9BdtrvmQo1FwY): fields are leaves in an OpenZeppelin merkle tree; what's attested (on- or offchain, via a canonical `bytes32 privateData` schema) is only the root. The SDK's `PrivateData` class builds the tree and generates **multiproofs** for selective disclosure (`generateMultiProof(indexes)` / `PrivateData.verifyMultiProof(root, proof)`). Explicitly merkle-proof-based, not ZK — disclosed values are revealed in the clear, and disclosures are linkable. For TrustGraph: a ready-made pattern for "confidence value private, edge public" style edges, and merkle multiproof verification is cheap inside an SP1 guest.

### 1.6 Storage, indexing, tooling maturity (2026)

- Storage is explicitly BYO ([Storing Offchain Attestations](https://docs.attest.org/docs/tutorials/storing-offchain-data)): easscan encodes the whole package in the **URL fragment** (private by default, gzip'd into QR codes), with optional **IPFS pinning** which also makes it publicly indexed on easscan. There is **no attestation network** — completeness is entirely your problem. EAS open-sources its [indexing service](https://github.com/ethereum-attestation-service) (Postgres + GraphQL, powers easscan) which you can self-host.
- Maturity: healthy. [eas-contracts](https://github.com/ethereum-attestation-service/eas-contracts) updated May 2026, eas-sdk updated May 29 2026; ~9.5M attestations / 450k+ attesters as of May 2026; EAS predeploy on all OP Stack chains; an "Attestation Fellowship" ran in 2026 ([attest.org/fellowship](https://attest.org/fellowship)). EAS remains tokenless/permissionless, which de-risks it as a dependency.

**Fit assessment:** EAS offchain gives a precise, EVM-native, secp256k1-ECDSA (SP1-precompile-friendly) signed envelope, plus on-chain revocation + batch timestamping registries that solve the *deletion* and *ordering* halves of completeness. What it lacks is any decentralized availability/enumeration layer — pair the format with a store (IPFS, ATProto repo, your own DA) and treat the timestamped merkle roots as the canonical enumeration commitment.

---

## 2. Sign Protocol, Verax, other attestation protocols

### 2.1 Sign Protocol (EthSign)

- Omni-chain attestation protocol with an explicit **offchain mode**: schemas/attestations stored on **Arweave or IPFS** (`dataLocation: ONCHAIN | ARWEAVE | IPFS`), signed, claimed ~1000× cheaper than onchain ([docs](https://docs.sign.global/for-builders/getting-started/definitions-and-notes), [launch post](https://medium.com/ethsign/sign-protocol-attest-with-no-limits-today-2688fdd8dede)).
- **Indexing story:** a hosted [indexing service](https://docs.sign.global/for-builders/index/index/indexing-service) queries attestations across modes (`mode: "offchain" | "onchain"`, filter by schema, attester, indexing values) + SignScan explorer. This is a *centralized* completeness story: Arweave gives permanence and tag-based GraphQL enumeration, but the canonical index is Sign's API.
- **Status flag:** the company has pivoted hard toward the SIGN token, TokenTable, and "sovereign infrastructure for nations" ([docs product page](https://docs.sign.global/products-sign-ecosystem/products), Series A led by YZi Labs). The attestation protocol is still documented and live (e.g., 1.9M "EthSign Completed Contracts" attestations on Arweave) but attestation-protocol development energy appears secondary. Treat as prior art for the "signed attestation + permanent store + indexer" pattern rather than a dependency. *Confidence: medium on the maintenance judgment; the pivot itself is well documented.*

### 2.2 Verax (Consensys / Linea Attestation Registry)

- Shared **onchain** registry (portals → modules → schemas architecture) on Linea + Base mainnets (attestations also cited on Arbitrum/BSC), ~6M attestations, 1.5M+ unique users; major Proof-of-Humanity attestation venue ([repo](https://github.com/Consensys/linea-attestation-registry), [docs](https://docs.ver.ax/), [ver.ax](https://www.ver.ax/)). Indexing via subgraphs/SDK.
- **Offchain mode: not shipped.** Off-chain attestations and ZK are listed as "future extensibility" ([Linea blog](https://linea.build/blog/introducing-verax-an-on-chain-attestation-registry)). No concrete offchain format spec found as of mid-2026. Relevant mainly as an EAS-alternative registry and because Karma3 Labs (OpenRank) is a design collaborator.

### 2.3 Others

- **Intuition** ($TRUST): "token-curated knowledge graph" — Atoms + subject-predicate-object Triples with token staking as the credibility signal; 244k users / 5M+ transactions in Base beta, then mainnet + token on its own chain (late 2025) ([docs](https://www.docs.intuition.systems/docs), [raise/mainnet coverage](https://www.cointribune.com/en/intuition-raises-8-5m-and-launches-mainnet-to-become-the-trust-layer-for-the-internet-and-ai/)). Onchain, token-weighted — philosophically adjacent (trust graph!) but not an offchain attestation format, and its scores are stake-weighted rather than graph-computed.
- **Optimism AttestationStation**: deprecated in favor of the EAS predeploy — evidence of ecosystem consolidation on EAS. *(From background knowledge; consistent with EAS being the OP Stack predeploy, but not re-verified this session.)*

---

## 3. W3C Verifiable Credentials 2.0 (2026 status)

**Standardization is done.** The VC 2.0 family became W3C Recommendations on **15 May 2025** ([W3C announcement](https://www.w3.org/news/2025/the-verifiable-credentials-2-0-family-of-specifications-is-now-a-w3c-recommendation/)): [VC Data Model 2.0](https://www.w3.org/TR/vc-data-model-2.0/), [Data Integrity 1.0](https://w3c.github.io/vc-data-integrity/transitions/2024/CR2/), **EdDSA cryptosuites 1.0** (`eddsa-rdfc-2022`, `eddsa-jcs-2022`; ed25519), **ECDSA cryptosuites 1.0** (`ecdsa-rdfc-2019`, `ecdsa-jcs-2019`, plus `ecdsa-sd-2023` hash-based selective disclosure; **P-256/P-384 only — no secp256k1**), VC-JOSE-COSE, Controlled Identifiers 1.0, Bitstring Status List 1.0 (revocation via hosted bitstrings). In progress: [Data Integrity 1.1](https://www.w3.org/TR/vc-data-integrity-1.1/), a [2026 WG re-charter](https://w3c.github.io/vc-charter-2026/), and quantum-resistant cryptosuites (FPWD 16 June 2026, [CADE note](https://cadeproject.org/updates/w3c-publishes-first-draft-of-quantum-resistant-cryptosuites-for-verifiable-credentials/)).

**BBS+ / selective disclosure:** [`bbs-2023`](https://www.w3.org/TR/vc-di-bbs/) (BBS signatures over BLS12-381, unlinkable derived proofs) is still a **Candidate Recommendation draft**, not a Rec, as of mid-2026.

**Sanity check as a ZK-consumed envelope — assessment: overweight, with one carve-out.**
- The `-rdfc` suites require **RDF Dataset Canonicalization** (JSON-LD expansion + URDNA2015-style canonicalization) *before hashing*. Implementing that inside an SP1 guest is a large, adversarial-input-parsing liability; the `-jcs` suites (JSON Canonicalization Scheme) are far more tractable but less used.
- Curve mismatch: standardized suites are ed25519/P-256/P-384; **secp256k1 is absent**, so Ethereum-key-signed VCs need the old CCG `EthereumEip712Signature2021` suite (community-maintained, not a Rec). BBS needs BLS12-381 pairings in-circuit — expensive, and its unlinkability is mostly redundant when the output is an aggregate PageRank score rather than per-credential presentations.
- Revocation (Bitstring Status List) assumes an online fetch of an issuer-hosted bitstring — worse for the completeness/determinism story than EAS's on-chain revocation mapping.
- Carve-out: if TrustGraph ever needs to *ingest external identity claims* (eIDAS 2.0 wallets, Human Passport-style stamps), accept VCs at the boundary and re-issue as the native edge format. Don't make VC the native edge envelope: a trust edge is ~4 fields; VC's JSON-LD context machinery buys interop you don't need at ~10× the parsing surface.

---

## 4. AT Protocol as an attestation store

Facts from the [repository spec](https://atproto.com/specs/repository) and [sync v1.1](https://atproto.com/blog/relay-updates-sync-v1-1):

- Each account has a **repo**: key→record map (records = DAG-CBOR, typed by lexicon NSID, e.g. a custom `graph.trust.vouch` collection), stored in a **Merkle Search Tree**; every commit signs the MST root with the account's **atproto signing key** (did:key, **k256 or p256** — secp256k1 is a first-class option, convenient for SP1's secp256k1 precompile).
- **Verifiability:** any third party can fetch a full repo as a CAR file (`com.atproto.sync.getRepo`) and verify: commit sig → MST root → merkle path → record. Firehose commit events carry a proof chain ("operation inversion") so streaming consumers verify diffs without full state; full-repo verification works by induction from a verified initial state.
- **Enumerability/completeness:** *per-account completeness is cryptographic* — the signed MST root commits to the complete record set of that repo, so a prover can prove it processed *all* of user X's vouches (and that none were hidden) from one CAR + one signature. *Network-wide* completeness (did you see every account?) is social: relays (Bluesky's, or self-run ones — sync v1.1 explicitly cheapened non-archiving relays) plus the did:plc directory enumerate accounts, but nothing cryptographically commits to "the set of all repos."
- This is a genuinely better completeness primitive than Nostr (no per-user commitment) and roughly comparable to Farcaster-post-Snapchain (see §5), with the advantage of custom lexicons and self-hostable PDSes. Main gaps: key custody (§8) and no native revocation semantics beyond "delete the record from the repo" (which *is* reflected in the signed MST — tombstoning is provable via the new root not containing the key).

---

## 5. Farcaster

- **Message format** ([protocol spec](https://github.com/farcasterxyz/protocol/blob/main/docs/SPECIFICATION.md)): protobuf `MessageData{fid, timestamp (secs since Farcaster epoch 2021-01-01), network, type, body}`; hash = **first 20 bytes of blake3**; signature = **ed25519** by an app/signer key. Signer keys are registered on-chain in the **KeyRegistry** (`0x00000000Fc1237824fb747aBDE0FF18990E59b7e`, OP Mainnet); fid ownership in the IdRegistry (custody address). So a Farcaster message is verifiable by a third party given (message bytes, ed25519 sig, KeyRegistry inclusion of that signer for that fid) — there are even Solidity verifiers ([farcaster-solidity](https://github.com/pavlovdog/farcaster-solidity)) and an audited **FarcasterAttestation** project bridging verified messages into EAS on Optimism ([Cantina competition](https://cantina.xyz/competitions/f9326d2b-bb99-45a9-88c5-94c54aa1823a)).
- **Completeness:** the old hub model was eventually-consistent CRDT gossip where detecting missing messages required pairwise full sync — acknowledged as unscalable ([FIP discussion #193](https://github.com/farcasterxyz/protocol/discussions/193)). **Snapchain** (mainnet 16 Apr 2025; [FIP #207](https://github.com/farcasterxyz/protocol/discussions/207), [repo](https://github.com/farcasterxyz/snapchain)) replaced it with Malachite BFT consensus producing a totally-ordered, sharded chain (~780 ms finality, 10k+ TPS claimed; ~200 GB snapshots, 2–4 h sync). Post-Snapchain, completeness is strong: run a node (or trust one) and you can enumerate *all* messages per fid, with storage bounded by paid **storage units** (messages get evicted when over quota — an important caveat for long-lived attestations).
- **Enumerable/verifiable by third parties?** Yes: individually (ed25519 + on-chain KeyRegistry) and in aggregate (Snapchain state). But: attestations would be shoehorned into casts or a custom message type (no extensible lexicon system); ed25519 signer keys are typically *app-custodied* (Warpcast holds most users' signers); storage-rent eviction; and **Neynar acquired the Farcaster protocol, app, and Clanker from Merkle Manufactory on 21 Jan 2026** (~$1B; Merkle returning $180M to investors) — Neynar now operates the protocol and most validators/infra ([Neynar blog](https://neynar.com/blog/neynar-is-acquiring-farcaster), [The Block](https://www.theblock.co/post/386549/haun-backed-neynar-acquires-farcaster-after-founders-pivot-to-wallet-app)). Single-operator concentration is now the dominant risk.

---

## 6. Nostr

- **Event format** ([NIP-01](https://nips.nostr.com/1)): `{id, pubkey, created_at, kind, tags, content, sig}`; `id` = sha256 of the canonical JSON array `[0, pubkey, created_at, kind, tags, content]`; `sig` = **BIP-340 Schnorr over secp256k1** (x-only pubkeys). Trivially verifiable standalone; secp256k1 again SP1-friendly (schnorr verify is cheap given the secp precompile).
- **As attestation carrier:** [NIP-32 Labeling](https://nips.nostr.com/32) (kind 1985) is essentially a generic attestation event — label namespaces (`L`/`l` tags) applied to pubkeys/events/relays/topics via `p`/`e`/`r`/`t` tags; a "vouch with weight w" maps cleanly onto it. Addressable/replaceable event kinds give crude update/revoke semantics (later event replaces earlier per relay — but only per relay).
- **Completeness: effectively none.** Relays are independent; there is no global event set, no per-user commitment, no proof of non-omission, and revocation-by-replacement can't be proven complete. Mitigations, not solutions: [NIP-65](https://nips.nostr.com/) outbox model (declares where a user publishes), [NIP-77 Negentropy syncing](https://github.com/nostr-protocol/nips/blob/master/77.md) (range-based set reconciliation for efficient relay↔relay/client sync — makes *convergence* cheap, guarantees nothing), and a draft "EOSE completeness hint" (NIP-67 per one index — *low confidence on the number*). A malicious relay set can always hide edges.
- **WoT activity is real but score-completeness-naive:** WoT-scoring modules in client toolkits, WoT-filtering relays (admit events only from pubkeys within a follow-graph pagerank radius), relay trust assertions ([NIP issue #2195](https://github.com/nostr-protocol/nips/issues/2195) building on NIP-66 monitoring), Vertex-style "social graph as a service" ranking DVMs *(medium confidence on Vertex specifics — not re-verified this session)*, and a "[WoT-a-thon](https://nostr.com/naddr1qq3hwmm594sj6argdahz6argv5khwetzdan8gun4wd6z66rpvd4kzargdahqzqqzyzl8haw7q6xpmppw6d98cfc9qlkfgr6755t8rn7sv254a8gfggxs5qcyqqq823cjudz4t)" hackathon running to 15 Apr 2026. None of these are adversarially complete; they'd be prior art, not substrate.

---

## 7. Ceramic / ComposeDB / OrbisDB

**Effectively dead as a platform — do not build on it.** On 17 Apr 2025 the Ceramic team (3Box Labs) announced the pivot to **Recall** ("cryptoeconomic platform for AI agents"): **js-ceramic and ComposeDB deprecated immediately; the Ceramic Anchor Service (CAS) — the component that did Ethereum anchoring — shut down** (~mid-2025, ≥1 month after Recall mainnet), after which un-migrated ComposeDB apps break ([The Future of Ceramic: Focusing on Recall](https://blog.ceramic.network/the-future-of-ceramic-focusing-on-recall/)). What remains: **ceramic-one**, the Rust node with the [Recon set-reconciliation protocol (CIP-124)](https://cips.ceramic.network/CIPs/cip-124), MIT-licensed, "critical bug fixes" only, with Ethereum L1 anchoring replaced by planned "self-anchoring to Recall." **OrbisDB** (independent team) rebuilt on ceramic-one's data-feed API and continues as the main surviving dev surface ([overview](https://developers.ceramic.network/docs/introduction/orbisdb-overview)) — *no strong 2026 signals of OrbisDB momentum found; treat as low-activity, low confidence*. Verdict for TrustGraph: the one thing you'd have wanted from Ceramic (neutral event streams + Ethereum anchoring) is precisely what was decommissioned. Irrelevant except as a cautionary tale about venture-backed data-layer dependencies — which also applies to Farcaster/Neynar and Bluesky.

---

## 8. Identity binding: Ethereum address ↔ DID ↔ other keys

**Standards toolbox:**
- **CAIP-10** chain-agnostic account IDs (`eip155:1:0xab…`); **[CAIP-122 "Sign in With X" (SIWx)](https://standards.chainagnostic.org/CAIPs/caip-122)** generalizes SIWE (EIP-4361) to any chain/key; a signed SIWx payload serializes as a **CACAO** (CAIP-74 chain-agnostic capability object). **did:pkh** wraps a CAIP-10 account as a DID. Together these are the closest thing to a standard "this key controls this account and consents to binding X" envelope.
- **EIP-712 bidirectional binding pattern** (what most bridges actually do): Ethereum key signs a typed claim naming the foreign identifier; the foreign identity publishes (or signs) the counter-direction. Farcaster bakes this in as its **verification message type** (fid signer wraps an eth-key signature → fid↔address binding enumerable from protocol state, [guide](https://docs.farcaster.xyz/developers/guides/writing/verify-address)) — the best-shipped model to copy.
- VC-world equivalents exist (VCs asserting key control, Controlled Identifiers v1.0) but add little over SIWx for this use.

**What Bluesky users actually have** ([did:plc spec](https://web.plc.directory/spec/v0.1/did-plc), [atproto discussions #2151](https://github.com/bluesky-social/atproto/discussions/2151)/[#3366](https://github.com/bluesky-social/atproto/discussions/3366)):
- A `did:plc` is controlled by **rotation keys** (k256 or p256 only), which sign identity-mutation ops in the plc.directory log (each op hashes its predecessor; DID = hash of genesis op). The **atproto signing key** (in `verificationMethod`) signs repo commits and has *no* identity control unless also a rotation key.
- **Typical accounts are fully PDS-custodied:** Bluesky's PDS holds the repo signing key *and* uses shared, Bluesky-operated rotation keys across its accounts. Per-user rotation keys are technically possible via API at signup but "difficult and undocumented and only a handful of accounts have ever done this." So: a typical Bluesky user does **not** control any secp256k1 key themselves; self-custody requires self-hosting a PDS or manually adding a personal rotation key. plc.directory itself is Bluesky-operated (an auditable but centralized log — [risk analysis](https://agent.io/posts/risks-of-did-plc/)). Implication: an atproto-stored vouch is signed by the *PDS*, on behalf of the DID — the trust model must accept "PDS-attested, DID-bound" rather than "user-key-signed," unless you require power users.
- **Existing atproto↔Ethereum bridge:** [stephancill/atproto-address-verifications](https://github.com/stephancill/atproto-address-verifications) — atproto OAuth + wagmi; wallet signs an EIP-712 `VerificationClaim`; proof (signature, address in **ERC-7930** chain-agnostic binary format, block hash) stored as records in the user's repo under an `org.chainagnostic.verification` collection. Small/experimental, but it's exactly the bidirectional pattern (eth-sig inside a DID-signed repo record) and the lexicon namespace suggests intent to standardize. No larger production atproto↔EVM bridge found.

---

## 9. Prior art: web-of-trust / vouching / reputation on these substrates (2026)

| Project | Substrate | Notes |
|---|---|---|
| **Coinbase Verifications** | EAS **onchain**, Base | "Verified account" / "verified country" attestations bound to self-custodial addresses; used for app-gating and Verified Pools ([repo](https://github.com/coinbase/verifications), [help](https://help.coinbase.com/en/coinbase/getting-started/verify-my-account/onchain-verification)). Institutional-issuer pattern, not a graph. |
| **Gitcoin Passport → Human Passport** | Signed stamps (VC-style) offchain; optional onchain mint via **EAS** (multi-chain) and **Verax** (Linea) | Now under human.tech (docs migrated to passport.human.tech — acquired by Holonym, *medium confidence on corporate detail*); weighted-stamp score, threshold ≈20 ([contract docs](https://docs.passport.xyz/building-with-passport/smart-contracts/overview)). The clearest shipped "offchain credentials, onchain summary attestation" architecture — structurally TrustGraph's cousin. |
| **Karma3 Labs / OpenRank** | Offchain compute over Farcaster/Lens graphs | **EigenTrust**-based "verifiable ranking/reputation" protocol; ranking APIs used across Farcaster ecosystem; $4.5M seed (Galaxy/IDEO); Verax collaborator ([openrank.com](https://openrank.com/), [docs](https://docs.openrank.com/)). Closest algorithmic competitor — but their verifiability is a decentralized-compute/optimistic story, **not a succinct ZK proof**; no evidence they ship ZK-proven scores. |
| **Icebreaker** | **EAS offchain** attestations (e.g., Memberships schema visible on [easscan offchain view](https://easscan.org/offchain/attestation/view/0xca9c6d7b8c4b4794bdc8b1b053948573c8cb110b231f4692d9b45ecfb160b180)) | Open professional graph, $5M CoinFund (2024); marketing mentions "attestations with zero-knowledge proofs" and "recursive attestations" — *specifics unverified, treat ZK claim skeptically* ([icebreaker.xyz](https://www.icebreaker.xyz/about)). Proof that EAS-offchain-as-social-graph works in production. |
| **Intuition** | Own chain, token staking | Stake-weighted triples (§2.3); trust-graph adjacent, no ZK, no offchain format. |
| **Sismo** | — | ZK badges over aggregated accounts; **shut down (~2023)** — search results citing it as current are stale. Prior art for ZK-over-credentials UX only. |
| **Farcaster-native** | Snapchain | OpenRank rankings; FarcasterAttestation (message→EAS bridge, §5); follow-graph itself is the attestation set most reputation projects mine. |
| **Nostr WoT** | Relays | §6 — scoring toolkits, WoT relays, ranking DVMs; nothing adversarially complete, nothing ZK. |

**ZK-over-offchain-attestations specifically:** **no shipping system found that ZK-proves a graph computation over offchain attestations** — the space is split between offchain-attestation systems with trusted indexers (EAS/easscan, Sign, Passport) and ZK systems proving *individual* facts (zkTLS/Reclaim, zkEmail, Semaphore membership, EAS merkle private-data — which is merkle proofs, not ZK). TrustGraph's "SP1 proof over the full edge set" appears to be genuinely unoccupied ground; the binding constraint everywhere is the same: **no offchain substrate gives a cryptographic commitment to the *complete* attestation set except (a) per-account atproto repo roots, (b) Snapchain consensus state, and (c) your own EAS-style timestamped merkle roots.**

---

## Synthesis

1. **Envelope:** EAS offchain v2 is the strongest native format — secp256k1 ECDSA (SP1 precompile), exact UID rules, salt, and *on-chain* revocation + batch merkle timestamping that convert "offchain data" into "chain-committed set." Caveat: UID doesn't bind attester; bind `(attester, uid)` in the leaf format.
2. **Completeness ladder:** chain-anchored merkle batches (strongest, self-operated) > atproto per-repo signed MST roots (per-user complete, network-social) > Snapchain (complete but single-operator Neynar + storage eviction) > IPFS/Arweave (permanent, not enumerable) > Nostr relays (none). Ceramic is decommissioned.
3. **Identity:** SIWx/CAIP-122-style EIP-712 bidirectional bindings; copy Farcaster's verification-message pattern; on Bluesky expect PDS-custodied keys, so model atproto edges as "DID-bound, PDS-signed" and verify via did:plc log + commit signature (k256 helps in SP1).
4. **VCs:** accept at the boundary, don't adopt as native envelope (RDF canonicalization in-guest, no secp256k1 suite, BBS still CR).

Key sources: [docs.attest.org offchain](https://docs.attest.org/docs/easscan/offchain) · [eas-sdk](https://github.com/ethereum-attestation-service/eas-sdk) · [EAS batch timestamping](https://docs.attest.org/docs/developer-tools/verify-timestamp) · [EAS private data](https://mirror.xyz/0xeee68aECeB4A9e9f328a46c39F50d83fA0239cDF/BiFUEFJKo6ZsIvPwsP9WPC2UZX0-x_9BdtrvmQo1FwY) · [Sign docs](https://docs.sign.global/) · [Verax](https://docs.ver.ax/) · [W3C VC 2.0 Rec](https://www.w3.org/news/2025/the-verifiable-credentials-2-0-family-of-specifications-is-now-a-w3c-recommendation/) · [vc-di-bbs](https://www.w3.org/TR/vc-di-bbs/) · [atproto repository spec](https://atproto.com/specs/repository) · [Snapchain FIP](https://github.com/farcasterxyz/protocol/discussions/207) · [Neynar acquisition](https://neynar.com/blog/neynar-is-acquiring-farcaster) · [Farcaster spec](https://github.com/farcasterxyz/protocol/blob/main/docs/SPECIFICATION.md) · [NIP-77](https://github.com/nostr-protocol/nips/blob/master/77.md) · [NIP-32](https://nips.nostr.com/32) · [Ceramic→Recall](https://blog.ceramic.network/the-future-of-ceramic-focusing-on-recall/) · [CAIP-122](https://standards.chainagnostic.org/CAIPs/caip-122) · [did:plc spec](https://web.plc.directory/spec/v0.1/did-plc) · [atproto-address-verifications](https://github.com/stephancill/atproto-address-verifications) · [Coinbase verifications](https://github.com/coinbase/verifications) · [Passport contracts](https://docs.passport.xyz/building-with-passport/smart-contracts/overview) · [OpenRank](https://openrank.com/) · [Icebreaker](https://www.icebreaker.xyz/about) · [Intuition](https://www.docs.intuition.systems/docs)
