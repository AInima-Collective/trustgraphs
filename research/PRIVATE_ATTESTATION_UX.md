# Private attestation UX: making a sealed circle feel natural

**Status:** proposed UX design, 2026-08-28

**Scope:** the user-facing experience of the private network profile accepted in
[`PRIVACY_ARCHITECTURE.md`](./PRIVACY_ARCHITECTURE.md): enrolling, vouching, receiving standing,
and using it, under the pilot's actual guarantees. The protocol decisions are normative and this
note does not reopen them; it designs what people see, do, and are told. The public gasless lane
has its own note: [`EAS_OFFCHAIN_UX.md`](./EAS_OFFCHAIN_UX.md).

## The opportunity

Private vouching is the version of this product many communities actually need. Public trust
graphs self-censor: people won't record a low rating, won't visibly decline to vouch for a
colleague, and won't publish who they trust when the graph doubles as a social ledger. A sealed
circle removes that pressure. Members vouch honestly because nobody, including other members,
can see the edges; the community still gets a provable, Sybil-bounded standing signal it can
govern and reward with. Communities already live this pattern: a funding collective keeping its
membership deliberations in a private repo to avoid self-censorship is expressing exactly this
need. Nothing shipped today offers private vouch edges with a provable aggregate score, so
getting the experience right is as much the product as the cryptography is.

The UX challenge is real, though, and it is unusual: **most privacy UX failures are honesty
failures.** The design below leans on one governing mental model, the secret ballot, because it
is the one institution where ordinary people already understand sealed inputs, visible
aggregates, and no receipts, and consider all three features rather than bugs.

## What is fixed by the accepted architecture (UX consequences in bold)

- A private network is a **separate profile**, not a switch on a public one. **Never render a
  "make this private" checkbox on a public vouch.**
- Enrollment uses blind issuance from the community's eligibility issuer; the issuer knows *that*
  you enrolled, never your later activity. Members hold a member secret. **There is a real
  onboarding ceremony and real key custody, unlike the public lanes' zero setup.**
- There is no public member directory and no public lookup. A vouch target privately hands the
  voucher a one-epoch "target card". **You cannot browse people; the social flow inverts.**
- One positive rating (1..1,000,000) per voucher/target pair, replaceable and revocable. No free
  text exists in the protocol. **No comment box, ever.**
- Nobody sees an exact score, including the member. Standing arrives as an epoch-scoped band:
  ineligible / member / established / steward. **The product's only feedback signal is coarse
  and slow, by design.**
- The pilot claims coercion *minimization* and receipt *ambiguity*, not anonymity or coercion
  resistance; the scorer runs in attested enclaves the user must trust. **The consent and
  marketing copy must carry these limits in plain words.**
- Everything moves on a fixed epoch cadence with padded batches, and a governance poll below 16
  real ballots publishes only "insufficient cohort". **Waiting and suppression are designed
  states needing first-class UI.**

## Design

### 1. The vocabulary: sealed, standing, circle

Product words carry the mental model. Proposed vocabulary, applying the plain-reader rule:

| Protocol concept | Product word |
| --- | --- |
| Private network profile | a **sealed circle** |
| Encrypted vouch admission | your vouch is **sealed** |
| Band credential | your **standing** |
| Epoch | **round** (with a visible countdown) |
| Target card | **vouch invitation** |

"Sealed" does the heavy lifting: it says private, deliberate, and irreversible-until-you-change-it
without claiming "anonymous" or "untraceable", claims the architecture explicitly forbids.

### 2. Enrollment is a ceremony; treat it like one

This is the one place slowing users down is correct. The flow: eligibility check with the
community's issuer, key generation, backup, first-round orientation. Three UX rules:

- **Custody is the product.** The member secret cannot be recovered by the issuer, the
  operators, or us; losing it means re-enrolling as a new hidden node and losing accumulated
  standing. Say exactly that at backup time, once, in one sentence, and require an actual backup
  action (passkey/secure enclave where available, recovery phrase where not).
- **Consent is informed, not clicked-through.** The first-consumer decision already requires an
  informed-consent UI. One screen, human sentences, the three honest limits: "Your vouches are
  hidden from everyone, including other members. The operators' sealed hardware is what keeps
  them hidden; we and they cannot read them, but you are trusting that hardware. Nothing here
  protects you if someone controls your device or you show them your screen."
- **Orientation sets the rhythm.** "This circle runs in rounds. Everything you do is sealed into
  the next round. Your standing updates when the round closes." Show the countdown immediately.

### 3. Vouching without a directory: the invitation flow

With no public lookup, the target initiates. The natural container is a link or QR code, the
idiom of payment requests and calendar invites:

- A member taps **"Ask for vouches"** and gets a vouch invitation: a link/QR wrapping their
  current target card. Share it in person, in DMs, wherever the community already talks.
- The voucher opens it, sees only "Someone in {circle} asked for your vouch" plus the display
  hint the target chose to embed (the protocol's card is opaque; any name shown is
  target-supplied and unverified, and the UI must say so), picks a rating, seals it.
- **Invitations expire with the round.** Show that on the invitation itself ("valid until the
  round closes, {countdown}") and make re-requesting one tap for the target, since cards are
  one-epoch by consensus.

This inversion needs teaching once: "In a sealed circle, you vouch for people who ask. Nobody
can look anyone up; that is what keeps the circle sealed."

### 4. Assurance without receipts

The voucher needs to know it worked; a coercer must not be able to make them prove what they
did. The architecture's answer is receipt ambiguity plus replacement, and the UX must deliver
both halves:

- **Private assurance, ambiguous artifact.** After sealing: "Sealed into this round." The vouch
  list shows *that* you vouched for someone and what you last entered, on your device, from
  local state. It is deliberately just local state: anything the app can display, a coercer
  looking over your shoulder can also see, so the display must never be backed by a
  protocol-level proof of content. The honest framing, stated in the consent screen and again in
  help copy: what your screen shows is not evidence, because you can change it.
- **Replacement is the escape hatch, so make it prominent.** "You can change or withdraw any
  vouch until the round closes, and later rounds replace earlier ones. Nobody can ever prove
  what your final answer was." This is the secret-ballot feature users already trust; say it
  with that confidence, not as fine print.
- **Status ladder, sealed edition:** Sealed (in this round) → Counted (round closed; reflected
  in the next standing). Two states, not three; there is no public "Recorded" to observe, and
  inventing one would leak.

### 5. Living with coarse feedback

There are no scores, no rankings, no graphs, and no "why". The band is the interface:

- Show standing as a quiet credential card: "{Circle}: Established · round 12". History as a
  simple band timeline, nothing numeric.
- **Never explain a band change.** Any "because" narrative is either fabricated or a leak. The
  honest help answer, written once: "Standing reflects the whole circle's sealed vouches and
  updates each round. We cannot see why it changed, and that is what keeps vouches private."
  Expectation-set this at orientation so the first band drop is not a support ticket.
- Resist product pressure to add teasers ("you're close to Established!"). Threshold proximity
  is exactly the arbitrary score query the architecture forbids.

### 6. Using standing: purpose-bound proofs

Consumers (a poll, later perhaps access gates) accept band proofs, not identities. The UX idiom
is the credential wallet: "Prove your standing to {consumer}" with an explicit purpose line
("This proves only: Established or better, for this poll, this round"). One tap, no identity
attached, and the UI never offers a general "share my standing" that would train users to leak.
For the pilot's non-binding poll, two more designed states: masked participation (the client may
submit cover ballots; participation UI must not distinguish them) and **"insufficient cohort"**,
shown as a normal outcome with its reason: "Fewer than 16 members voted, so no result is
published. This protects individual ballots."

### 7. The frontend is part of the privacy boundary

A non-obvious engineering constraint: the public-trace failure oracle applies to the app itself.
A frontend that fetches a member-specific package on login, renders a band the moment it is
delivered, or phones analytics home links member to package by timing and address, and the
privacy claim fails at the UI layer with the cryptography intact. Concretely: fixed-schedule
padded retrieval (fetch on the round boundary like everyone else, not on login), no
member-scoped analytics events inside sealed circles, and local-only caches for anything the
protocol classifies as hidden. This belongs in the implementation issues' exit gates, not just
in copy.

### 8. Visual separation

Sealed circles should *look* like a different room within the ink-only design language: the
inverted surface (the existing dark-first tokens make this cheap), the chord mark closed rather
than open, and no cross-navigation that carries public-profile furniture (leaderboards, graphs,
activity feeds) into a place none of it can exist. The user should never wonder which kind of
network they are in.

## Honest limits (displayed, not buried)

The architecture's displayed non-guarantees, in the words users see:

- "Sealed" means hidden from observers, members, and operators' ordinary access; it rests on
  attested sealed hardware (and later, a committee where no majority colludes). It is not "nobody
  could ever".
- Nothing protects a supervised device or a voluntarily shared screen.
- Standing bands and final poll aggregates are public outputs; with very small circles, coarse
  outputs still narrow things down, which is why cohort suppression exists.
- We never claim anonymity, receipt-freeness, or coercion resistance. The words we may use:
  private, sealed, no receipts anyone can demand.

## Open questions

1. **Invitation transport:** links/QR only, or also an in-app "requests" inbox? An inbox is
   better UX but creates a server-visible request graph unless it rides the padded channel;
   needs a leakage review before it is promised.
2. **Display hints on invitations:** target-supplied names are unverifiable by design. Is an
   unverified-name warning enough, or should circles be able to require verified hints via the
   issuer at enrollment (a protocol question, so likely v2)?
3. **Key recovery posture:** is "lose the secret, lose the standing" acceptable for the pilot's
   communities, or does social/threshold recovery need designing before any community of
   meaningful size enrolls? (It changes the trust story and must be reflected in consent copy.)
4. **How much local vouch history to keep:** convenience (see and edit what you entered) versus
   shoulder-surf exposure. A lock-behind-biometric view is the likely middle; decide before
   pilot.
5. **Naming:** "sealed circle" is this note's proposal; test it against "private circle" and
   plain "private network" with real users before it hardens into product copy.
