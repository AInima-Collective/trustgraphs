# Sub-networks: organizational hierarchy for trust networks

Status: design accepted 2026-08-28 (issue #112). M1 and M2 are implemented; indexer and product
integration are in progress.

A **sub-network** is a network with a parent: another network whose authority holds real, on-chain
power over it, with the relationship recorded on both sides' consent and rendered by the app. The
pattern is inspired by DAO DAO's SubDAO system, where every DAO carries an optional admin and a
protocol DAO can sit above a family of team DAOs.

## 1. What this unlocks

A protocol community runs a top-level trust network. Its engineering guild, its regional chapters,
and its grants program each want their own network: their own attestation graph, their own scoring
parameters, their own treasury and rewards. Today each of those would be a disconnected island. With
sub-networks, the parent creates them in one proposal, retains the power to repair or reclaim them,
and the app shows the whole organization as one tree.

The everyday uses fall out directly:

- **Bootstrap, then graduate.** A parent spins up a young network fully under its wing, loosens its
  grip as the community matures, and finally releases it as an independent peer. Every step of that
  maturation is a single observable on-chain action.
- **Repair captured children.** Trust graphs are attack surfaces: a small team network whose graph
  gets captured by a sybil bloc can pass anything. A parent with admin power fixes it immediately,
  which is exactly the protection DAO DAO admins provide to young SubDAOs.
- **Scores that roll up.** Hierarchy composes with the existing trust-compose program: a parent can
  be a composite network whose sources are its own sub-networks, an org chart where team scores
  aggregate upward. Admin hierarchy and score composition stay orthogonal axes; using them together
  is the interesting product.
- **Shared operations.** Vault deposits are open, so a parent treasury can sponsor its sub-networks'
  proving costs today, with no new code. Contributions rounds already work this way: a round is
  created by its parent network's constitutional authority. Sub-networks generalize that
  parent-child shape from rounds to full networks.

## 2. The design in brief

Two small new contracts, no frozen interfaces touched:

1. **`SubnetworkRegistry`** records the relationship: one parent per child, established by a
   two-step claim-and-accept handshake between the two networks' authorities (or atomically by a
   factory when the parent is the creator), dissolved only by the parent.
2. **`ParentAuthorityModule`** carries the power: a Zodiac module on the child's Safe, sibling to
   the member governance module and the recovery module, through which the parent's authority can
   execute transactions as the child, either instantly or after an immutable delay.

The child's own governance can always vote to eject the parent's module. We keep that property
("soft admin") rather than fighting it, and the parent module's execution delay becomes the
sovereignty dial: an instant module makes the parent an admin in practice, a long-delayed module
makes it a vetoable guardian. Section 6 works through the race arithmetic.

## 3. Background: who holds power over a network today

Every network created by a factory ends creation with a single authority. For a wallet-owned
("ungoverned") network that authority is the creator's address: it holds `CONSTITUTIONAL_ROLE` on
the `MerkleSnapshot`, owns the params controller, and owns the fund distributor if one exists. For a
governed network the authority is a module-only Safe assembled by `GovernedTrustgraphsFactory` (see
`research/GOVERNED_SAFE_AUTHORITY.md`): owner signatures are permanently sealed by
`SafeExecutionGuard`, and the Safe acts only through two delayed modules, `MerkleGovModule` (member
proposals weighted by the network's own proven score root) and `DelayedRecoveryModule` (a named
proposer may queue any call behind a 14-day public window).

Four existing mechanisms shaped this design:

- **Parent-created governed children already receive guardianship.** The governed factory sets the
  child's recovery proposer to `msg.sender`. When a parent network's Safe executes
  `createGovernedInstance` through one of its own proposals, the parent becomes the child's recovery
  proposer: it can queue any transaction on the child's Safe behind the 14-day window. The power
  wiring for the guardian tier exists today; it has simply never been named or surfaced.
- **A tested "only the parent's authority may create a child" gate.** `ContributionsFactory`
  requires the round creator to hold `CONSTITUTIONAL_ROLE` on the parent network's snapshot and
  emits `parentInstanceId` in its creation event; the indexer stores and indexes it. That is the
  template for the sub-network creation gate and for keeping parent linkage out of frozen events.
- **A two-step authority handshake.** `MerkleSnapshot.proposeConstitutionalTransfer` and
  `acceptConstitutionalTransfer` already model consent-based handoff, and the constitutional role is
  multi-holder with a never-reaches-zero invariant, so authorities can be added alongside rather
  than only replaced.
- **A canonical answer to "who is the authority of network X".** `GraphLineageRegistry` resolves it
  on-chain as the params authority's controller owner, with a fallback to the controller itself, and
  demonstrates the fail-closed pattern for cross-network relations whose endpoints rotate.

## 4. The relationship: `SubnetworkRegistry`

The registry records who claims whom and who consented, and nothing else. Power is never stored
here; the indexer verifies it live (section 8, "The registry cannot lie about power").

- **One parent per child.** `claimParent(childId, parentId)` may be called only by the child's
  authority, resolved through the lineage-registry seam. `acceptChild(childId)` may be called only
  by the parent's authority. A link is live only after both steps. Either side can withdraw a
  pending claim before acceptance.
- **Factory path.** Factories granted a registrar role may register a link atomically during
  creation. When the creator of a governed child is the parent's own authority, claim and accept
  collapse into the creation transaction, mirroring how contributions rounds are born linked.
- **Release is parent-only.** `release(childId)` may be called only by the parent's authority.
  Independence is granted, not taken, matching DAO DAO, where only the admin can remove itself. A
  child that secedes by ejecting the parent's module (section 6) does not erase the record; the app
  shows the link with its power unverified, which is the honest description of that state.
- **Cycles are rejected cheaply.** On claim and on accept, the registry walks parent pointers upward
  from the proposed parent, at most 16 steps, and reverts if it meets the child or runs out of
  budget. Sixteen levels is far beyond any plausible organization; deeper chains simply cannot
  register further links. This is a different cycle class from composition's, which rejects
  composite sources at the adapter and stays independently enforced.
- **Any program can be a parent or a child.** Unlike contributions rounds, which require a
  trust-graph parent, the registry requires only that both instances are registered and that both
  authorities resolve. A composite network administering the sub-networks it scores over is a
  supported and interesting configuration.

The registry is deliberately not an extension of `InstanceRegistry`. That contract is a
one-per-chain singleton behind the operational timelock, its record is documented as
presentation-free neutral infrastructure, and its five-field `Instance` struct is ABI-encoded
literally by every factory. `GraphLineageRegistry` set the precedent that relationship registries
live beside it, not inside it.

## 5. The power instrument: `ParentAuthorityModule` and the tier spectrum

`ParentAuthorityModule` is a Zodiac module enabled on the child's Safe:

- Immutable state: the child Safe, `childInstanceId`, `parentInstanceId`, the instance registry, and
  an `executionDelay`. Changing the delay means deploying a fresh module and swapping enablement,
  which keeps every tier change an explicit, observable act.
- **The parent is resolved dynamically**, not pinned: on every use the module resolves the parent's
  current authority through the same seam as `GraphLineageRegistry` (params authority, then its
  controller owner, falling back to the controller). A parent that rotates its own governance never
  leaves a stale admin address behind, and a resolution that reverts or returns the zero address
  fails closed: the module refuses to act.
- With `executionDelay = 0` the parent authority calls `execute(target, value, data, operation)`
  directly. With a nonzero delay the parent schedules, anyone may execute after the deadline, and
  the parent or the child Safe may cancel, mirroring `DelayedRecoveryModule`'s shape exactly so the
  app can render both with one vocabulary. Delegatecall is permitted for the same reason it is
  permitted on the recovery route: repair of the Safe itself must be possible.
- `renounce()` lets the parent authority disable its own power without touching the registry link.
- Every action emits an event carrying both instance ids, so the indexer discovers modules without
  static configuration, the same way signer-sync modules announce themselves.

What a "sub-network" is, then, is a spectrum, and most of it already exists:

| Tier | Instrument | Status |
| --- | --- | --- |
| Department | Ungoverned child whose admin is the parent's authority | exists today |
| Guardian | Parent is the child's recovery proposer (14-day window, cancellable) | exists today for parent-created children |
| Admin | `ParentAuthorityModule` with zero delay | new module |
| Label only | Registry link, no power instrument | new registry |

**Parent-created sub-networks default to the Admin tier**, matching DAO DAO, where creating a SubDAO
makes the creator its admin. The create flow can dial down to Guardian or Label-only. Adopted
networks choose their tier explicitly during the handshake.

## 6. Sovereignty: who must act to stop whom

The structural difference from DAO DAO, and the pivot of this design: in DAO DAO the admin lives in
core state that only the admin can change, so a SubDAO cannot eject its parent. Here, every power
instrument a parent can hold lives inside the child's Safe perimeter. Module enablement, the guard,
and the recovery proposer are all Safe-mutable, and the child's member governance executes arbitrary
Safe transactions. A child community can therefore always vote to eject its parent: publicly, after
its voting delay, voting period, and execution delay, roughly eight days at factory defaults.

We keep this property. Parent power is real but contestable, and both directions of conflict are
slow, public, and legible in the same proposal UI. The execution delay on the parent's module then
determines who must act to stop the other:

- **Zero delay (Admin).** The parent acts immediately; the child's only recourse is ejection or
  exit afterward. Because any ejection vote is visible on-chain for about eight days before it can
  execute, an attentive parent can always pre-empt it. This is DAO DAO admin parity in practice,
  with the difference that a secession attempt is at least visible rather than impossible.
- **Delay of 14 days or more (Guardian).** Every parent action sits in public for two weeks, and the
  child can cancel it either directly (the child Safe may cancel scheduled actions) or by ejecting
  the module first, since eight days beats fourteen. Parent power becomes proposal power: the parent
  suggests, and the child's silence is consent. This matches the existing recovery-module analysis
  in `research/GOVERNED_SAFE_AUTHORITY.md`, which already requires the member vote plus execution
  window (57,601 blocks) to complete inside 14 days on any chain this profile deploys to.
- **Delays between those points** trade off in the obvious way and are not recommended as defaults;
  the wizard should present the two named tiers, not a slider.

Two asymmetries are worth stating plainly. First, the dial is chosen at creation or adoption time by
whoever consents then; a child that accepts an instant-admin parent has accepted that the parent
wins races until the parent releases it. Second, ejection is retaliation, not prevention: under the
Admin tier the child cannot stop a specific parent action, only end the relationship afterward.

## 7. Lifecycle

**Create.** A "Create a sub-network" flow on the parent's page builds one parent proposal that calls
the governed factory and registers the link atomically. The factory verifies the caller holds the
parent's constitutional role, exactly as the contributions factory does. One mechanical fact forces
this atomicity: a freshly created governed network has no accepted score root yet, so its member
governance module has zero voting power and cannot act, and its recovery route waits 14 days. The
parent module therefore must be enabled inside the creation transaction, alongside the member and
recovery modules, or the Admin tier is unreachable until the child's first root lands. Concretely
this is a new entry point on the governed wrappers (an additive overload, keeping the existing ABI
stable for the app), a deployer contract holding the module initcode to protect the wrappers'
EIP-170 headroom, and a registrar grant on the new registry.

**Adopt.** An existing governed network joins a parent in two proposals. The child's community
passes one proposal that enables an already-deployed parent module (module deployment is
permissionless; enablement is the consent) and claims the parent in the registry. The parent's
community passes one proposal that accepts. An ungoverned network adopts by its wallet authority
calling the same registry functions directly, with the Department tier (constitutional transfer to
the parent) or constitutional co-holding as its power instruments, since it has no Safe to carry a
module.

**Graduate.** The parent releases in one proposal: renounce or disable the module, and release the
registry link. The child's page drops the parent breadcrumb; nothing else about the child changes.
Department to Guardian to independent is the expected maturation path, and each step is one
observable transaction.

## 8. Threat cases

**Parent Safe compromise.** Under the Admin tier, a compromised parent authority is a compromised
child: the module executes as the child Safe without delay. This is the sharpest edge in the design
and is stated as a limit in section 9. The composable mitigations: choose the Guardian tier for
children holding significant treasuries (every hostile act then sits in public for 14 days and is
cancellable), rely on the proving vault's independent 7-day withdrawal notice for funds parked
there, and treat the parent's own governance quality as part of the child's threat model, which the
app should surface on the child's page rather than bury.

**Child capture.** The inverse case is the reason admin power exists. A sybil bloc that captures a
small child graph controls its treasury and settings at the next root. A parent on the Admin tier
repairs it immediately: swap the gov module, fix the accepted-root hook, rotate parameters. On the
Guardian tier the repair waits 14 days behind a window the attackers can watch; for young networks
that is often too slow, which is why parent-created children default to Admin.

**Authority rotation mid-link.** The module resolves the parent dynamically, so a parent that
rotates its controller owner (say, from one Safe to a successor) carries its children along
automatically. The registry link is keyed by instance id, not by authority address, so neither
side's rotation orphans the record. Two edges: the protocol's operational timelock can re-point a
network's params authority in `InstanceRegistry`, which would re-point where the module resolves to;
that is an accepted trust assumption, identical to the one lineage endorsements already make. And a
resolution that fails (zero address, revert, no code) fails closed: the module goes inert rather
than falling back to a stale address.

**Cycle attempts.** Two networks claiming each other resolves at accept time: the second accept's
ancestor walk finds the first link and reverts. Claims racing in one block serialize like any other
transactions, and each accept re-walks against committed state. The 16-step budget bounds gas and
makes "cycle via a chain deeper than the walk" impossible by construction, at the cost of capping
registrable depth at 16, which is a product non-issue.

**The registry cannot lie about power.** Because the registry stores only the relationship, every
claim it makes is verifiable: the indexer checks live whether the parent module is enabled, whether
the parent holds the child's constitutional role, and whether the parent is the recovery proposer,
and the app renders "link claimed" and "power verified" as separate facts. A seceded child shows as
claimed-but-unverified, which is true. This also means the registry needs no fail-closed suspension
machinery of its own; honesty lives in the read path.

**Interaction with settled history.** Nothing in this design touches roots, proofs, or epochs. A
parent exercising admin power can change a child's future (parameters, modules, hooks) but settled
epochs remain immutable, preserving the core invariant from `research/UPGRADE_GOVERNANCE.md` that
meaning at an address never mutates retroactively.

## 9. Honest limits

- **Admin-tier children are as safe as their parent.** An instant module means parent compromise is
  child compromise, with ejection available only as retaliation. The tier system exists so this
  exposure is chosen, visible, and reversible, not so it disappears.
- **Soft admin means a determined child can always leave.** A parent who needs guaranteed custody of
  a child's assets should hold those assets in its own treasury and fund the child operationally,
  rather than relying on the module surviving a secession vote.
- **Ungoverned children get a reduced menu.** Without a Safe there is no module to enable, so
  wallet-owned networks participate as Departments, via co-holding, or as label-only links.
- **Dynamic resolution inherits the registry's trust model.** The operational timelock that can
  re-point a params authority can re-point where parent power resolves. This is the same assumption
  every other cross-network read already makes, but it belongs in the child's threat model.
- **Depth is capped at 16.** Deeper hierarchies cannot register further links.

## 10. Alternatives considered

### Extending `InstanceRegistry` with a parent field

Rejected. The registry is a neutral, presentation-free singleton behind the operational timelock;
its `Instance` struct is ABI-frozen into every deployed factory, and redeploying the singleton to
add relationship state inverts the layering that `GraphLineageRegistry` already established for
exactly this kind of record.

### Hard admin via a module guard

True DAO DAO parity would block the child from ejecting the parent, enforced by a guard on the
child Safe's module-management calls. Rejected: it adds a new contract and a dependency on
Safe-version module-guard hooks, it cuts against the exit-as-veto ethos that runs through the
governance design, and the Admin tier's race arithmetic already delivers parent supremacy in
practice while keeping secession visible rather than impossible.

### Constitutional co-holding as the primary instrument

Granting the parent `CONSTITUTIONAL_ROLE` on the child's snapshot is nearly free and covers
snapshot configuration and the proving vault, but not the params controller, the distributor, or the
Safe, so "admin" would mean different things on different pages. It survives as the co-holding
option for ungoverned children, not as the headline instrument.

### Reusing `DelayedRecoveryModule` as the only instrument

Zero new power code, and it is exactly the Guardian tier. Rejected as the whole answer because the
14-day floor forecloses the Admin tier entirely, and the recovery proposer slot is a single slot:
occupying it with the parent evicts the creator's liveness route rather than adding a parallel one.

## 11. Decision record (2026-08-28)

- **Soft admin.** Child ejection of the parent module remains possible, public, and delayed. No
  module guard.
- **Parent-created default: Admin tier.** Instant module, wizard can dial down; adoptions choose
  explicitly.
- **Independence is parent-granted.** Registry release is parent-authority-only.
- **Product name: "sub-networks".** Issue #112 was retitled from "Subgraphs" to avoid colliding
  with The Graph's subgraphs. Code names: `SubnetworkRegistry`, `ParentAuthorityModule`.

## 12. Security invariants

- A registry link exists only if both authorities consented (or one authority was both, via the
  factory path), and only the parent's authority can dissolve it.
- The registry stores no power state, and every power claim the app renders is derived from live
  Safe, role, and module reads.
- The parent module executes only for the currently resolved parent authority; failed resolution is
  inert, never a stale fallback.
- A delayed parent action cannot execute before its deadline, is cancellable by the parent or the
  child Safe, and executing it requires the exact queued call.
- No path in this design mutates `InstanceRegistry` semantics, frozen creation events, settled
  epochs, or the sealed owner-execution guard.
- Ancestor walks are bounded; no registry operation is unbounded in the hierarchy's size.

## 13. Repo fit: the concrete changes

Contracts: `SubnetworkRegistry` (new, beside `GraphLineageRegistry`); `ParentAuthorityModule` plus
an initcode-holding deployer (new, beside the existing module deployers); an additive
sub-network creation overload on the three governed wrappers with a parent-authority gate copied
from the contributions factory; registrar grants for the wrappers on the new registry, mirroring the
existing manual `REGISTRAR_ROLE` step.

Indexer: sources for the registry and module events; a `subnetworkLink` table with parent and child
indexes; children-of and parent-of API routes; live power verification joining Safe module state,
constitutional role holders, and recovery proposer. This work also absorbs an adjacent latent bug:
the `instance.admin` column is frozen at creation because constitutional transfers, role grants, and
params-authority updates are not indexed, and correct hierarchy display needs live authority anyway.

Frontend: the create-sub-network proposal builder on the parent's governance surface; a
Sub-networks tab on the parent and a parent breadcrumb on the child in `network-nav.ts`, which
already renders cross-instance tabs for contributions; a parent card in the Settings Access tab
beside the existing authority cards; the adoption handshake flow.

Docs: a concepts page defining sub-networks and the tier spectrum in plain language, and a build
guide for the create and adopt flows.

The staged plan with checkboxes lives in issue #112.

## 14. Open questions (Jake)

1. Should the child's page actively warn when its parent is Admin-tier with an instant module
   ("this network can be operated by its parent at any time"), or present it neutrally as a
   structural fact? The plain-reader answer and the growth answer may differ.
2. When a parent is itself a sub-network, should the grandparent's page show the full subtree, and
   should grandparent power over grandchildren (transitively, by operating the parent) be surfaced
   in the child's threat model card?
3. Do we want a curated "org chart" view as a first-class app page at launch, or is the per-network
   tab enough until real hierarchies exist?
4. Adoption pricing: creation flows through the vault's banding today; should adoption (which
   deploys only a module) be free, or priced to discourage link spam?
