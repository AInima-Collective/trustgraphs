# Governed Safe authority boundary

Status: accepted for factory-created networks (issue #20)

## Decision

`GovernedTrustgraphsFactory` graduates every new Safe inside the creation transaction. The factory is
the sole temporary bootstrap owner. Before replacing itself with the creator as the visible Safe
owner, it enables exactly two modules and installs an execution guard:

1. `MerkleGovModule` is the ordinary member route. Proposals wait the module's voting delay and
   voting period, then its execution delay, before they can call the Safe.
2. `DelayedRecoveryModule` is the liveness route. The named recovery proposer may publish one exact
   call or delegatecall, but it cannot execute before an immutable delay of at least 14 days. Anyone
   may execute after the deadline. The proposer or the Safe may cancel; only the Safe may rotate the
   proposer.
3. `SafeExecutionGuard` closes the owner-signature route. While the factory is assembling the Safe it
   admits only factory-submitted transactions. The factory swaps itself out, seals the guard in the
   same outer transaction, and can never reopen it. A creator signature cannot call a settings
   contract, move Safe funds, enable a module, remove the guard, batch, or delegatecall.

Safe guards do not inspect module execution. That is why every enabled module has its own delay and
why the factory test enumerates the Safe's module list rather than merely checking that the expected
module is present. The installed addresses and creation-time recovery terms are recorded in
`GovernedAuthorityInstalled` and `authorityOf(instanceId)`; consumers read the recovery module for
the current proposer after any rotation.

The creator remains a 1-of-1 Safe owner for identity and Safe compatibility, but that owner is not an
execution authority. The UI calls it the recovery identity, never a break-glass signer. A network is
graduated only when the factory-recorded guard is installed and sealed and both recorded modules are
enabled. Creation either reaches that state atomically or reverts.

## Alternatives considered

### Safe guard or modifier

A Safe guard provides the narrowest enforceable boundary around owner-originated
`execTransaction`: it covers calls, value transfers, delegatecalls, Safe self-configuration, and
MultiSend batches before their target runs. Its important limitation is equally clear: enabled
modules bypass it. A guard is therefore sufficient only with an enumerated, delay-enforcing module
set. We chose this design because the Safe remains the on-chain owner of every network contract and
existing Zodiac member governance remains usable.

A removable policy guard would not solve the problem: the 1-of-1 owner could remove it in the same
transaction sequence. The selected guard has no unseal function; changing it is itself possible only
through a delayed module action.

### Timelock-owned authority

Making separate operational and constitutional timelocks the direct owners would make the delay
obvious at each target and can support different delay classes. It also fragments the factory's
authority graph: the Safe would no longer be the uniform target owner, Safe-native proposals would
need timelock adapters, and arbitrary Safe assets/configuration would still need a separately guarded
route. This remains appropriate for bespoke production deployments that need 2-day operational and
14-day constitutional lanes, but is not the one-click factory default.

### Staged bootstrap and graduation

A creator-controlled setup phase is useful when owners, thresholds, and roles require coordination
after deployment. It is also easy to leave unfinished or present as decentralized while one key can
still act. We rejected a post-creation bootstrap. The only privileged setup phase is the synchronous
factory call; there is no externally observable block, callback, deadline, or user action between
installing the authority and sealing it. Failure at any point reverts the whole network creation.

## Emergency recovery and liveness

- Before the first accepted score root, member voting may not yet be usable. The recovery proposer
  can queue a repair, but the public gets the full 14-day observation window before it can run.
- A queued recovery is an event containing the exact target, value, calldata, operation, nonce, and
  deadline. Substituting any field produces a different action and does not execute the queued one.
- Members may use ordinary governance to make the Safe cancel an action or rotate the proposer.
  The proposer can also cancel an accidental action. Execution is permissionless after the deadline
  so the proposer cannot withhold a repair the community has observed and accepted.
- Chain deployment must confirm that the default member vote plus execution window (57,601 blocks)
  normally completes inside 14 days; otherwise `RECOVERY_DELAY` must be raised before this factory
  profile is used. A stalled chain is fail-closed, not an excuse for an undelayed owner route.
- Recovery deliberately permits arbitrary calls and delegatecalls after 14 days. That allows repair
  of the Safe itself, module replacement, fund movement, and migration when the ordinary route is
  broken. It is constitutional power with a public exit/veto window, not an undelayed admin key.
- Loss of the recovery key does not stop member governance. Loss of both usable scoring governance
  and recovery is fail-closed; there is no hidden owner bypass.

## Security invariants

- A valid owner signature always reverts at the sealed guard, regardless of target or operation.
- The Safe has exactly the factory-recorded member and recovery modules at graduation.
- Member actions retain the voting and execution block delays reported by the factory.
- Recovery actions cannot execute before `block.timestamp + RECOVERY_DELAY`.
- Guard removal, module addition, settings changes, withdrawals, batches, and delegatecalls can occur
  only through one of those delayed module routes.
- The create review shows the constants before signature; network settings derive graduation from
  live Safe, guard, and module state rather than trusting a label.
