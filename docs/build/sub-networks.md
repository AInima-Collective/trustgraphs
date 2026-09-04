# Create or adopt a sub-network

## Create a child atomically

1. Open the parent network and choose **Sub-networks**.
2. Choose **Create a sub-network**. Complete the ordinary network wizard: the child is a full
   network, so it needs the same profile, starting accounts, scoring policy, and optional fund.
3. Choose Admin, Guardian, or Label-only parent authority under **Governance and extras**.
4. Review the exact call and prepare the parent governance proposal.
5. Pass and execute that proposal.

Execution creates the child's Safe and contracts, installs the selected authority, and records the
parent link in one transaction. Atomic creation matters because a fresh child has no accepted score
root and therefore cannot immediately pass its own member proposal to finish setup.

## Adopt an existing network

Adoption is a two-proposal consent handshake:

1. On the prospective child's **Sub-networks** page, enter the parent's instance ID and explicitly
   choose Admin, Guardian, or Label only.
2. For Admin, deploy the inert parent module when prompted. Module deployment is permissionless;
   the module has no Safe power until the child enables it.
3. Prepare, pass, and execute the child proposal. It enables the selected power instrument and
   claims the parent in the same execution. The registry now shows a pending claim.
4. On the parent's **Sub-networks** page, prepare, pass, and execute the acceptance proposal.

The Admin child proposal enables a zero-delay `ParentAuthorityModule`; Guardian rotates the existing
delayed recovery module's proposer to the parent's current authority; Label only adds no power.
Ungoverned Department adoption remains a contract-level flow because it requires constitutional
role transfer rather than a Safe proposal.

## Verify the result

The parent page lists accepted children. The child header links back to its parent, and **Settings →
Access** shows the relationship, tier, observed instruments, and whether parent power is currently
verified. Treat an active link with unverified power as organizational metadata, not authority.

## Cold-stack walkthrough

Start from a checkout with no running Trustgraphs services and follow [Run trustgraphs locally](./quickstart.md):

```bash
anvil --block-time 1
task start-all-local
task demo
pnpm indexer start
pnpm frontend dev
```

Start the indexer only after `task demo` completes so it reads the fresh registry, deployer, and
factory addresses. Then exercise the complete product path:

1. Open the demo network, check that **Sub-networks** appears, and create an Admin child.
2. Pass and execute the parent proposal. Confirm that the child appears with **Power verified** and
   that its header and **Settings → Access** point back to the parent.
3. From a second governed network, adopt the demo network once per tier as needed: execute the child
   claim proposal, then execute the pending acceptance proposal on the parent.
4. Disable or renounce an Admin module and confirm that the accepted link remains visible while its
   power changes to **not verified**.
5. Use **Prepare release proposal** on the parent. For an Admin child, the proposal renounces the
   parent module and releases the registry link together. Confirm that the child disappears from
   the active list and loses its parent breadcrumb without changing its graph, treasury, or
   history. A Guardian child must separately rotate its child-owned recovery proposer.

For a code-level gate before the browser walkthrough, run `forge test` in `contracts`,
`pnpm --dir packages/indexer test`, and `pnpm --dir packages/frontend test` from the repository root.
