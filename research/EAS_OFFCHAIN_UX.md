# Gasless vouching UX: the offchain EAS lane for people who never think about lanes

**Status:** proposed UX design, 2026-08-28

**Scope:** the user-facing experience of creating, publishing, tracking, and revoking vouches on
the offchain EAS lane specified in [`EAS_OFFCHAIN_SUPPORT.md`](./EAS_OFFCHAIN_SUPPORT.md)
(envelope 0). The consensus protocol is fixed; this note designs only what people see and do.
The private profile has its own note: [`PRIVATE_ATTESTATION_UX.md`](./PRIVATE_ATTESTATION_UX.md).

## The opportunity

The offchain lane makes vouching free and instant: sign a message, done. That is the single
biggest usability unlock the platform has, because gas is the first wall every new community
member hits. The protocol work is designed; the remaining work is presentation, and the current
implementation shows exactly the gap. `CreateAttestationModal.tsx` today renders the *auditor's*
view: a lane picker ("Gasless off-chain" / "On-chain EAS"), raw EIP-712 field tables
(`nodeId`, `previousHead`, `dataCommitment`, raw CID), phase strings like
"anchored-awaiting-finality", and a signed-bundle export button. All of it is correct, and none
of it belongs in the default path.

The thesis of this note: **users already have every mental model this lane needs.** Gasless
signing is mainstream Ethereum UX (every Snapshot vote and OpenSea listing works this way), and
batched delivery with status is mainstream messaging UX (sent, delivered, read). The design job
is to map our machinery onto those two models and hide everything else behind a receipt.

## What the user actually must do (fixed by the protocol)

1. **Sign the vouch**: one EIP-712 signature over the EAS offchain attestation. Free, instant,
   no transaction.
2. **Sign to publish**: one EIP-712 signature over the new log head. One head signature covers
   *every* not-yet-published entry, because it commits the whole log from the registry's current
   head to the newest local one. An admitted relay then pins the payload and pays gas to anchor
   it on-chain.
3. **Wait for the epoch**: the vouch affects scores at the next proven score update, not
   immediately.

Nothing below removes a signature or an epoch; it re-narrates them.

## Design

### 1. No lane choice

Do not ask "Where to record it". When the network supports the offchain lane, gasless is the
default; "record on-chain instead" lives behind an advanced toggle for users who know why they
want it (immediate on-chain finality, contract-wallet signers, no relay dependency). Users
cannot evaluate "appends a public retained EAS v2 log through an admitted relay", and should
never be asked to. The entire concept surface at the point of action is one sentence:

> **Vouching is free. You sign it, we file it.**

### 2. Two signatures, one story

Present the two signatures as steps of a single action, with progress dots:

- "Step 1 of 2: sign your vouch."
- "Step 2 of 2: sign to publish."

Because one head signature covers all pending entries, batch naturally: a user who vouches
several times in a row signs each vouch as they go, and the publish step consolidates into
"Publish 3 vouches (1 signature)". Default behavior should prompt publish immediately after a
single vouch (predictability beats cleverness), and hold the prompt only when another vouch
begins within a short window.

Directly above each wallet prompt, one plain sentence about what the signature does and cannot
do, extending the reassurance pattern already in the relay copy:

- Step 1: "This signs your vouch for {name}. It cannot move funds."
- Step 2: "This publishes your pending vouches. It cannot move funds and cannot change what you
  signed."

The second wallet popup will show hex the user cannot read (heads, commitments). That is fixed
by the consensus format; the sentence above the popup is the mitigation.

### 3. A three-state status ladder

Collapse the implementation phases (`relay-storage`, `anchored-awaiting-finality`,
`anchored-unverified`, `verified`) into three words a person can act on:

| State | Plain meaning | Backing condition |
| --- | --- | --- |
| **Signed** | Saved. We'll record it. | Attestation signed; head not yet anchored (or relay retrying) |
| **Recorded** | Locked in. Counts at the next score update. | Anchor accepted; any finality/verification sub-state |
| **Counted** | In scores since update N. | Included in a proven checkpoint |

Show the ladder on the vouch card as a quiet indicator (the messaging-app check-mark idiom, in
the ink-only design language, no color-coded alarm). Pair "Recorded" with the next-score-update
countdown that the score-update surface already has, so epoch latency reads as a schedule, not a
delay.

### 4. The receipt drawer

Everything the current strict flow shows becomes a disclosure on the vouch card: "Verify the
details". Inside: the exact signed fields, the log position, the anchor transaction, the payload
CID, and the signed-bundle export. This reframes verifiability as a feature you can open instead
of homework you must pass, and it keeps the full auditor path alive unchanged for the users the
strict mode was built for. Strict mode itself (review every field before signing) remains as a
settings-level preference, off by default.

### 5. One honest sentence at write time

Near the comment field, always visible, no modal:

> **Vouches are public and permanent. Free doesn't mean private.**

The spec is explicit that "off-chain" means gasless creation, not privacy or erasure; users will
assume the opposite unless told at the moment of writing. This is the one disclosure that must
not move into a drawer. (Truly private vouching is a separate network profile; see
[`PRIVATE_ATTESTATION_UX.md`](./PRIVATE_ATTESTATION_UX.md).)

### 6. Never lose a signature

A signed attestation is durable, so relay failure is never an error state. Copy for the stuck
case: "Saved. We couldn't record it yet; we'll keep retrying." Auto-retry in the background,
keep the bundle export as the paranoid fallback in the receipt drawer, and only escalate to the
user if the vouch has been Signed-but-not-Recorded past a clear threshold (say, one hour), with
a retry button. The existing `anchored-unverified` recheck machinery supports this; it needs
calmer clothes.

### 7. Same verbs everywhere

"Vouch" and "Remove vouch" behave identically from the user's seat on both lanes. On this lane,
removal is a new signed log entry plus a publish step (the protocol's revocation); the UI must
never route users toward EAS's own `revokeOffchain`, which does nothing here. Replacement
(re-vouching with a new rating) is likewise the same edit flow on both lanes.

### 8. Zero setup, and keep it that way

First use registers the user's log atomically with their first anchor. There is no "create your
log" step and none should ever be invented for onboarding theater.

## Product edges to keep in view (not in the UI)

- **The 2,048-entry lifetime cap.** Every vouch, edit, and removal consumes a log entry forever;
  v1 has no reset or compaction. Show nothing until roughly 1,500 entries, then a quiet meter.
  At the cap, gasless vouching stops and the on-chain lane still works. The eventual
  rotation/reset story needs design before any heavy-use community gets close.
- **The relay is a chokepoint.** Only an admitted relayer may anchor, so "free" depends on a
  third party being up and willing. This is precisely why the Signed/Recorded distinction must
  stay honest, and why multiple admitted relays are worth operational priority.
- **Epoch latency is the product's heartbeat.** Everything user-facing that says "Recorded"
  should link to when the next update lands. If the countdown is wrong or missing, the lane
  feels broken even when it is healthy.

## Copy inventory (proposed)

| Surface | Copy |
| --- | --- |
| Action explainer | Vouching is free. You sign it, we file it. |
| Step 1 prompt | This signs your vouch for {name}. It cannot move funds. |
| Step 2 prompt | This publishes your pending vouches. It cannot move funds and cannot change what you signed. |
| Batched publish | Publish {n} vouches (1 signature) |
| Permanence line | Vouches are public and permanent. Free doesn't mean private. |
| Stuck state | Saved. We couldn't record it yet; we'll keep retrying. |
| Status states | Signed · Recorded · Counted |
| Receipt drawer | Verify the details |

All copy follows the plain-reader rule: no lane names, no envelope numbers, no protocol nouns
(head, anchor, CID, relayer) outside the receipt drawer.

## Open questions

1. **Publish timing default:** prompt the head signature immediately after every vouch, or
   default to session-end batching once a user has vouched more than once? (Recommendation:
   immediate, with the short hold window; revisit with usage data.)
2. **Strict mode placement:** settings-level preference, per-network operator policy, or both?
   Some networks may want strict review mandatory for their members.
3. **Contract-wallet users:** the lane is EOA-only by consensus (EIP-1271 fails closed). Detect
   smart-contract wallets and steer them to the on-chain lane before they sign something the
   guest will reject, rather than after.
4. **Cap story:** when a log approaches 2,048 entries, what do we actually offer? "Continue
   on-chain" is the v1 answer; is a v2 log-rotation protocol worth specifying before any
   community is within range?
