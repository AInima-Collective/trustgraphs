# Sub-networks

A sub-network is a complete Trustgraphs network that belongs to another network. It keeps its own
members, scoring rules, governance, treasury, and history. The parent-child link is organizational;
it does not merge either network's graph or scores.

The registry and the parent's power are intentionally separate facts. A link is created only after
both network authorities consent, or atomically when a parent creates a new child. The app then
checks the live contracts to show whether the parent still holds power. If a child removes a parent
module, the relationship remains visible as **linked, power not verified** instead of disappearing.

## Authority tiers

- **Admin** installs an instant parent module on the child's Safe. The parent can operate the child
  immediately. A child governance vote can remove the module, but cannot stop an action that has
  already executed.
- **Guardian** makes the parent the child's recovery proposer. Parent actions wait 14 days and can
  be cancelled by the child before execution.
- **Department** means the parent authority directly holds the child's constitutional role. This
  is useful for networks without a Safe, but covers fewer contracts than an admin module.
- **Label only** records the relationship without granting parent power.

New parent-created children default to Admin. Choose Guardian for a child whose treasury warrants a
public intervention window, or Label only when the relationship is descriptive.

## Independence and risk

Only the parent can release an accepted registry link. The child's member governance can still
disable power instruments inside its Safe, so parent control is real but contestable. An Admin-tier
child inherits the security risk of its parent: compromise of the parent can immediately compromise
the child. Guardian and Label-only tiers reduce that exposure.

The parent release proposal also renounces an Admin module. Guardian recovery is a child-owned
instrument, so releasing that link does not silently rewrite it; the child must rotate its recovery
proposer in a separate proposal when it graduates.

Parent authority follows the parent network, not one wallet address. If the parent's params
controller ownership rotates to a successor Safe, its child modules resolve that new authority on
their next action.
