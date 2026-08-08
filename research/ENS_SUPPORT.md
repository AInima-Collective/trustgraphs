# ENS support: research and design spike

**Status:** milestone 1 implemented; production RPC and gated integration validation required  
**Date:** 2026-08-07  
**Scope:** frontend address input and presentation; no consensus, contract, ZK, or indexer changes

## Implementation note

Milestone 1 now uses the shared parser, preview field, and uncached write-boundary resolver across
attestations, network seeds, contribution participants, and governance ETH recipients. Account
links are address-canonical, the account-name entry route redirects, and network-page presentation
has one bounded reverse-resolution owner with no avatar or localStorage work.

Deployments must configure `RPC_URL_1`. The deterministic parser/normalization/coin-type tests and
the existing frontend golden suites pass. The mainnet CCIP-Read integration cases and synthetic
1,000-account performance harness below remain gated follow-up because this environment has no
`RPC_URL_1` configured.

## Outcome

TrustGraph should ship ENS support, but it should finish and replace parts of the existing ENS
path rather than add another resolver.

The central design rule is:

> An Ethereum address is the account's canonical identity. An ENS name is a mutable,
> chain-specific input and presentation alias.

This keeps every attestation, graph edge, score, proof, route target, and query key bound to the
same 20-byte account that the protocol already uses. ENS resolution happens only at the UI
boundary.

The repository already has a substantial prototype: forward resolution in the attestation form,
reverse names in `Address`, account-name routes, a mainnet client, and batched graph lookups. The
current path is not ready to call complete, chiefly because it:

- recognizes only `.eth` inputs even though ENS supports imported DNS names;
- resolves Ethereum-mainnet records rather than OP Mainnet's ENSIP-11 coin type;
- may submit an attestation using a five-minute persisted result without resolving again;
- performs duplicate graph-wide queries and fetches avatars the graph never renders; and
- collapses "not found" and "the resolver/RPC failed" into the same state.

No new dependency is needed. The lockfile currently resolves viem 2.38.2 and wagmi 2.18.1.
ENS's readiness guide requires viem 2.35.0 or later for the new Universal Resolver and ENSv2
compatibility, so the installed viem version already has the required protocol support.

## Product boundary

### Milestone 1

1. Display a verified OP Mainnet primary name, when one exists, anywhere TrustGraph displays an
   account.
2. Accept an address or ENS name in account-identity fields:
   - attestation recipients;
   - starting accounts in the network-creation wizard;
   - contribution participants;
   - governance ETH recipients; and
   - `/account/[identifier]` navigation.
3. Always retain an address fallback and copy action.
4. Resolve again immediately before encoding any name-derived address into a transaction.

### Later, through the same shared field

Token addresses, distribution-token addresses, and arbitrary governance call targets can also
accept ENS names. They are deferred because the consequence of resolving the wrong contract is
higher and the confirmation UI needs to show contract-specific context, not because ENS cannot
represent them.

### Explicitly out of scope

- Storing names in EAS data, contracts, the Ponder schema, PageRank inputs, or ZK journals.
- Treating ownership of a name as proof of personhood, uniqueness, or trust.
- ENS avatars or profile text records. No current TrustGraph screen consumes the avatar data it
  requests.
- Registering names, setting reverse records, or issuing TrustGraph subnames.
- Other naming systems. The API below can be generalized later, but the first implementation is
  ENS-specific and should say so.

## Protocol findings that affect the design

### Resolution starts on Ethereum mainnet, even for an L2 account

TrustGraph runs on OP Mainnet. ENS resolution must use an Ethereum-mainnet public client, but both
forward and reverse lookups must ask for OP Mainnet's ENSIP-11 coin type:

```ts
import { toCoinType } from 'viem/ens'

const registryChainId = 1
const accountCoinType = toCoinType(10) // 2147483658n, OP Mainnet
```

Passing only wagmi's `chainId: 1` selects where resolution starts; it does **not** select the
address record TrustGraph wants. The `coinType` selects that record. The Universal Resolver also
supports the default reverse record as a fallback when a chain-specific primary name is absent.

For local/review fixtures, keep ENS network calls disabled as they are today. If a developer
explicitly enables live ENS while connected to Anvil, use coin type 60 as a development fallback;
an Anvil-specific ENSIP-11 record will not normally exist.

### Display names must be verified primary names

A raw reverse record is not enough: the returned name must forward-resolve to the address on the
same chain. Otherwise anybody could make their address claim somebody else's name. The current
viem `getEnsName` path uses the Universal Resolver's reverse operation, which performs this
verification. Keep using the library operation; do not recreate registry/resolver traversal or
hardcode a resolver address.

### `.eth` is not the ENS namespace boundary

ENS can resolve DNS names imported through DNSSEC, including names such as `.xyz`, `.com`, and
their subnames. Name detection should therefore treat a string with a non-empty label on each
side of a dot as a *candidate*, then use ENSIP-15 normalization as the validity check.

The spike adds this pure boundary in `frontend/lib/ens.ts` and moves the existing attestation and
account-route prototype onto it. This is classification, not validation: a candidate still has to
normalize and successfully resolve.

### CCIP Read is required

Wildcard, offchain, L2, and gasless-DNS resolvers can answer through EIP-3668 CCIP Read. The
Universal Resolver is the canonical entry point and viem 2.38 handles both CCIP Read and the ENS
batch-gateway protocol. Do not replace this with direct calls to the ENS registry or Public
Resolver; doing so would silently break valid names and make ENSv2 migration harder.

When resolution runs on a TrustGraph server, do not let arbitrary resolver-supplied URLs become a
general server-side fetch primitive. Use the Universal Resolver's ENS-operated batch gateway (the
response remains cryptographically verified) or apply an explicit outbound policy. Client-side
resolution does not create server SSRF, but it does reveal lookups to RPC and CCIP gateway
operators.

## Current implementation audit

| Area | What is already good | Gap to close |
| --- | --- | --- |
| `frontend/lib/wagmi.ts` | Mainnet is included alongside the application chain. | Mainnet uses a default public RPC and all ENS calls omit the OP coin type. Add a production `RPC_URL_1` path and keep resolution on L1. |
| `frontend/hooks/useEns.ts` | Uses wagmi/viem, bounded concurrency of ten, and TanStack Query. | It layers an outer query cache, inner wagmi query cache, and custom `localStorage` cache; invokes a side effect from `useMemo`; does not distinguish failures; and fetches unused avatars. |
| `frontend/components/Address.tsx` | Falls back to the address and makes the full address copyable/available in a tooltip. | Links use a mutable ENS alias instead of the canonical address. Very long names need the same deliberate truncation treatment as addresses. |
| `CreateAttestationModal` | Shows the resolved address beside the entered name. | The classifier was `.eth`-only and submission can reuse cached resolution. A changed result is silently accepted rather than requiring review. |
| `NetworkContext` + `NetworkGraph` | Names hydrate progressively and do not block graph data. | Both layers launch batch resolution. Differently ordered address arrays can produce different outer query keys, so the work can run twice. The graph should consume names already attached by the context. |
| Account and attestation server pages | Prefetch small reverse-name sets for hydration. | Account-name paths are cached as mutable aliases and non-`.eth` names were cast to `Hex` after detection failed. Use canonical address links and redirect resolved aliases. |

## Proposed architecture

There are two resolution lanes with intentionally different freshness rules.

```text
Read-only presentation
canonical address -> cached verified reverse lookup -> ENS label or address fallback

Transaction input
raw input -> classify -> ENSIP-15 normalize -> preview lookup -> show name + address
                                                    |
submit -> uncached live lookup ---------------------+-> compare -> encode address
                                                        mismatch: stop and review
```

### 1. Pure input boundary

Keep `frontend/lib/ens.ts` independent of React and wagmi:

```ts
isPotentialEnsName(input: string): boolean
normalizeEnsName(input: string): string | null
```

Address validation remains viem's `isAddress`. The shared account-field parser should return a
discriminated union rather than truthy strings:

```ts
type AccountIdentifier =
  | { kind: 'empty' }
  | { kind: 'address'; address: Address }
  | { kind: 'ens'; name: string }
  | { kind: 'invalid'; reason: string }
```

This prevents an invalid name from falling through as `Hex`, which the current account route can
do after a failed lookup.

### 2. One query definition per operation

Add a non-React `frontend/lib/ens-query.ts` that owns:

- registry chain ID `1`;
- the target coin type;
- canonical query keys;
- positive/negative display-cache policy; and
- `resolveNameNow`, the explicitly uncached write-boundary operation.

Suggested result type:

```ts
type EnsResult =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'resolved'; address: Address; name: string; resolvedAt: number }
  | { status: 'not-found' }
  | { status: 'invalid'; message: string }
  | { status: 'error'; error: Error }
```

`not-found` and `error` must remain different. An RPC outage must never tell somebody that a valid
name does not exist, and it must never fall through to a transaction.

### 3. Presentation cache

Use TanStack Query as the only application cache:

- key reverse lookups by lowercased address and coin type;
- key forward lookups by normalized name and coin type;
- use a five-minute `staleTime` and a thirty-minute `gcTime` for browsing;
- cache `null` results too, so accounts without names do not cause a lookup on every render;
- do not persist ENS data in `localStorage`; and
- hydrate server-prefetched and client queries with exactly the same key.

The fixed five-minute policy is intentionally conservative. ENS registry TTL values are hints and
are not sufficient for every offchain resolver. Supporting per-record TTL can be a later
optimization. Transactions never rely on this cache.

### 4. Bulk graph lookup

There should be one `useEnsNames` call in `NetworkContext`. It should:

1. lowercase, deduplicate, and sort addresses before constructing a key;
2. resolve reverse names only (no avatar/text lookups);
3. prioritize the connected account and the top 100 scored accounts;
4. use at most eight concurrent workers;
5. feed each address through the same per-address TanStack query used elsewhere; and
6. expose incremental results so graph and table labels update without delaying their first paint.

Nodes after the eager limit keep their shortened address label. Resolve one of those on demand
when its inspector opens. This makes initial resolution `O(min(accounts, 100))`, not
`O(accounts)`, while the graph remains complete.

JSON-RPC batching (`http(url, { batch: { batchSize: 10, wait: 10 } })`) can reduce HTTP overhead,
but it is an optimization after correctness. Do not enable viem's Multicall aggregation for ENS
until CCIP-Read names are tested through it; changing the calling contract can interfere with the
EIP-3668 callback model. Plain JSON-RPC batching preserves each Universal Resolver call.

### 5. A shared account identifier field

Create one `AccountIdentifierField` used by the attestation, seed, contribution, and governance
forms. It should:

- debounce candidate names by 250–350 ms;
- leave the user's normalized name in the input rather than replacing it with an address;
- show the full resolved address and the target chain (`OP Mainnet`);
- make the address copyable;
- show invalid, not-found, and unavailable states distinctly; and
- expose both the normalized name and preview address to the parent form.

Lists such as starting accounts and contributors resolve candidates with bounded concurrency,
then store only addresses in form state. A name can be retained as non-authoritative display
metadata for the current form session.

### 6. Transaction boundary

Immediately before constructing or sending a transaction derived from a name:

1. resolve the normalized name directly against the mainnet client with the OP coin type, bypassing
   TanStack and `localStorage`;
2. fail closed on timeout, RPC/CCIP error, invalid name, `null`, or zero address;
3. compare the live address with the preview address;
4. if it changed, replace the preview, show both values, and require a second explicit submit; and
5. only then pass the address to `createAttestation`/the relevant transaction builder.

This follows ENS's guidance that cached results are suitable for browsing but risky interactions
need a direct live resolution. It also prevents a name update between preview and click from
silently retargeting the action.

### 7. Canonical routing

All generated account links should be `/account/{address}`. `/account/{ens-name}` remains a useful
entry point, but the server should:

1. normalize and resolve the name;
2. redirect to the canonical address URL; or
3. render an explicit invalid/not-found/unavailable state.

This avoids duplicate cached profile pages and keeps shared links bound to an account if the ENS
record later changes. The profile heading may still display the verified primary name.

### 8. RPC transport and abuse boundary

Production needs a configured mainnet RPC, not viem's unauthenticated public default. Reuse the
existing `/api/rpc/[chainId]` proxy with `RPC_URL_1`, then harden it before increasing traffic:

- allow only configured chain IDs;
- cap raw body size and JSON-RPC batch length;
- apply request/rate limits appropriate to the deployment;
- preserve upstream JSON-RPC status/errors; and
- never expose the upstream credential to the browser.

Server components can use `RPC_URL_1` directly. Browser clients use `/api/rpc/1`. A public mainnet
fallback is acceptable for development, not as the production capacity plan.

## Security and UX rules

- Normalize with ENSIP-15 before every forward lookup. Do not lowercase or otherwise transform a
  raw Unicode name by hand.
- Display names only through verified reverse resolution. A successful forward lookup is enough
  for an input name, but not enough to choose a display name for an arbitrary address.
- Show and copy the full address wherever a name influences a transaction.
- Never use an ENS name in equality, graph membership, score lookup, deduplication, or authorization.
- Treat a name as mutable and chain-specific. The UI should say which chain was resolved.
- Do not render remote avatars in milestone 1. Besides the extra lookup/fetch cost, avatars add a
  separate remote-content and privacy surface.
- Keep resolution failure non-fatal on read-only pages: show the address. Keep it fatal when a
  transaction input cannot be resolved live.
- Bound length in UI containers and provide the full value in a tooltip/details view. ENS names
  can contain long labels and many subdomains.

## Performance acceptance criteria

- ENS never blocks graph data, account data, or the first interactive paint.
- Zero avatar/text-record requests in milestone 1.
- One reverse-resolution owner per network page; no context/graph duplicate batch.
- At most 100 eager graph names and eight concurrent misses.
- Duplicate addresses on a page produce one underlying query.
- Accounts without a name are negatively cached for the display TTL.
- Transaction confirmation performs exactly one live forward resolution per distinct entered name.
- RPC and CCIP timeouts are bounded and surface a retryable state rather than an indefinite spinner.

These are budgets that can be asserted with a mocked transport; latency percentiles should be set
after measuring the chosen production RPC rather than guessed in this document.

## Test plan

### Unit

- Candidate detection for `.eth`, imported DNS names, nested/emoji names, raw addresses, empty
  labels, and incomplete input.
- ENSIP-15 normalization and invalid Unicode/name shapes.
- Chain ID to coin-type mapping: mainnet `60`, OP Mainnet `2147483658`.
- Canonical query keys: case-insensitive addresses, normalized names, deduped/sorted bulk input.
- State mapping for null result versus network error.
- Live-resolution comparison: unchanged, changed, missing, zero address, and error.

### Component

- Debounce does not resolve `ens.` and resolves `ens.e` once.
- The field never overwrites the name with the address.
- Resolved name and full address are visible together.
- Submit is blocked during resolution and on failure.
- A changed live result requires a second confirmation.
- Address-only input performs no ENS request.

### Mainnet integration (gated by `RPC_URL_1`)

- `ur.integration-tests.eth` resolves to
  `0x2222222222222222222222222222222222222222` (Universal Resolver readiness).
- `test.offchaindemo.eth` resolves to
  `0x779981590E7Ccc0CFAe8040Ce7151324747cDb97` (CCIP Read readiness).
- A controlled imported DNS name resolves.
- A controlled OP-specific address and primary name resolve with coin type `2147483658`.
- A reverse/forward mismatch returns no display name.

Do not make mutable public names such as `vitalik.eth` golden-vector assertions. They are useful
manual smoke tests, not stable fixtures.

### Performance

With a fake delayed transport and 1,000 graph accounts, assert that:

- no more than 100 start eagerly;
- no more than eight are in flight;
- duplicates are fetched once;
- the graph receives address-only data before any resolver completes; and
- an on-demand account outside the first 100 is subsequently cached and displayed.

## Delivery sequence

1. **Foundation:** add mainnet RPC configuration, coin type, typed result states, and the live
   resolver. Add official Universal Resolver/CCIP integration tests.
2. **Safe transaction input:** replace the bespoke attestation recipient logic with the shared
   field and live revalidation. This closes the highest-risk current gap first.
3. **Canonical presentation:** simplify `useEns`, remove `localStorage` and avatars, make account
   links address-based, and remove the duplicate `NetworkGraph` batch.
4. **Identity inputs:** adopt the field for seeds, contribution participants, and ETH recipients.
5. **Scale check:** add the 1,000-account transport test and tune eager/concurrency limits from
   production RPC measurements.
6. **Optional contract inputs:** extend the field to token/custom-call targets with contract-aware
   confirmation copy.

The changes are frontend-only and can be rolled out behind the existing address fallback. A
resolver outage therefore degrades read-only pages to the current address UI without affecting
TrustGraph's protocol or score availability.

## Sources

Primary sources, checked 2026-08-07:

- [ENS: preparing for ENSv2](https://docs.ens.domains/web/ensv2-readiness/)
- [ENS: Universal Resolver](https://docs.ens.domains/resolvers/universal/)
- [ENS: address lookup and multichain addresses](https://docs.ens.domains/web/resolution/)
- [ENS: primary names and L2 reverse resolution](https://docs.ens.domains/web/reverse/)
- [ENSIP-19: multichain primary names](https://docs.ens.domains/ensip/19/)
- [ENSIP-15: name normalization](https://docs.ens.domains/ensip/15/)
- [ENS: design guidelines](https://docs.ens.domains/web/design/)
- [ENS: DNS names](https://docs.ens.domains/learn/dns/)
- [viem: `getEnsAddress`](https://viem.sh/docs/ens/actions/getEnsAddress)
