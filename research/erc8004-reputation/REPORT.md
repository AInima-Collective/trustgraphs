# ERC-8004 pinned-policy experiment report

## Decision

**No-go for production scoring or proof integration.** The artifact is useful as a reproducible
policy/data-quality diagnostic, but the fixture exposes sparse coverage, reviewer concentration,
leave-one-out instability, and strong reciprocal-ring amplification in the propagation candidate.
Continue only with explicit policies and offline comparisons until the completeness and
program-aware ingestion gates are resolved.

This conclusion is bounded to the checked-in fixture and policy. It does not claim that ERC-8004
feedback is generally useful or useless, and it must not be presented as an agent's universal
reputation.

## Committed run

| Artifact                        | SHA-256                                                              |
| ------------------------------- | -------------------------------------------------------------------- |
| Canonical policy                | `0x6940174185c73adf5aefca9bc4a6ed968ff908fca4c2a7265c6e97f905d516a1` |
| Canonical input                 | `0xeede605460e4e49fdf8a925a94c5c37fd510a34964ae60582ed018bbad7dad2c` |
| Complete result                 | `0xac1d3c8b0d2372e1c09cf309f5f2d973fb7c1697e168cc0c71011648c5514661` |
| Reviewer fixture root, epoch 42 | `0x57583f4552126e9264409bbe7ef36954c56d9b83038e15d7d88a71efec32f010` |

The policy pins Optimism chain 10, Reputation Registry
`0x8004baa17c55a88189ae136b182e5fda19de9b63`, implementation
`0x16e0fa7f7c56b9a767e34b192b51f921be31da34`, version 2.0.0, and block cutoff
155,551,592. It accepts only exact tag `quality`, unit `points/100`, zero decimals, and values in
the closed 0–100 interval.

## Coverage and exclusions

- 22 supplied records; 20 are in the pinned registry and cutoff denominator.
- 9 reconciled reviewer-target pairs out of 28 declared possible pairs: 32.1428% coverage.
- 19 pairs are missing evidence. One included pair is an observed literal zero; these states remain
  distinct in both the golden and UI.
- Historical attribution succeeds for 15 of 17 otherwise shape-matching records (88.2352%); one is
  unattributed and one ambiguous.
- Agent #1 accounts for 50% of included reviewer-weight mass across pairs.
- Each of the 13 exclusion reasons is exercised exactly once: wrong registry, after cutoff, outside
  target universe, wrong tag, wrong unit, wrong decimals, unattributed reviewer, ambiguous reviewer,
  ineligible reviewer, self-feedback, out-of-range value, revocation, and superseded repetition.

The exact denominator definitions live in the policy. In particular, sparse pairs are not silently
removed from the coverage denominator, and missing feedback is not imputed.

## Candidate comparison

The direct candidate computes an exact reviewer-trust-weighted mean over the latest active record
for each pair. Values below are points on the policy's 0–100 scale.

| Direct rank | Target   |     Score | Reviewers | Observed reviewer weight |
| ----------: | -------- | --------: | --------: | -----------------------: |
|           1 | Agent #4 | 77.142857 |         2 |                7,000 bps |
|           2 | Agent #5 | 71.666666 |         2 |                6,000 bps |
|           3 | Agent #9 | 31.428571 |         2 |                3,500 bps |
|           4 | Agent #8 | 28.888888 |         2 |                4,500 bps |
|           5 | Agent #6 |         0 |         1 |                3,000 bps |
|           — | Agent #7 |   missing |         0 |                    0 bps |

The propagation candidate starts from the same exact reviewer prior, admits only positive
reconciled edges, uses 0.85 damping, a 10^12 fixed mass, Hamilton remainder allocation, and 64
iterations. Its target ordering is Agent #9, #8, #4, #5, #6, #7. The #8/#9 reciprocal pair rises
from third/fourth under the direct policy to first/second and captures 66.9419% of all mass landing
on declared targets. Four observed targets move by two rank positions between candidates.

That is enough to reject the damped candidate for production: a seemingly conventional propagation
step changes the meaning from weighted observations to recursively reinforced connectivity and
makes the small ring dominant.

## Adversarial and lifecycle fixtures

| Fixture                   | Pinned outcome                                                                                                             |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| Repeated feedback         | The older Agent #1 → #4 value 80 is `superseded`; the later value 90 wins.                                                 |
| Revocation                | Agent #2 → #5 is `revoked`; its creation and response count stay in the raw input.                                         |
| Responses                 | Two responses on the selected repeated record are preserved but do not change 90.                                          |
| Wallet rotation           | The same wallet maps to Agent #1 before rotation and Agent #3 after it; both event-time mappings survive.                  |
| Self-feedback             | Agent #8 → #8 is `self_feedback` and excluded.                                                                             |
| Unadmitted Sybil/clone    | Agent #77 is absent from the pinned reviewer root and is `reviewer_not_eligible`; the curated root is the only Sybil gate. |
| Reciprocal ring           | #8 ↔ #9 remains eligible under the declared root and dominates propagated target mass; it is not hidden.                  |
| Missing trusted reviewers | Agent #7 has no pair evidence and stays missing; Agent #6 has one explicit zero and stays observed.                        |
| Tag/unit mismatch         | `responseTime` and `stars/5` records are independently excluded; no cross-policy average exists.                           |
| Sparse coverage           | The declared 28-pair denominator yields 9 observed and 19 missing pairs.                                                   |

## Sensitivity

Every eligible reviewer is removed in turn and the full filter, reconciliation, direct arithmetic,
and propagation run is repeated. Removing Agent #2 erases Agent #6's only direct evidence. Removing
Agent #1 changes one direct score by 71.111112 points. Removing either reciprocal-ring member moves
a target's propagated mass by 17.0710% or 17.9623% of total mass. Even the central reviewers move a
target by roughly 4.8–5.5% of total propagated mass.

These are fixture diagnostics, not confidence intervals. They demonstrate that the observed output
is conditional on a small curated reviewer set and that neither candidate is robust enough to
justify a guest, production root, or proof-completeness claim.

## What would change the recommendation

A future experiment should first pin a defensible completeness model and program-aware source,
then test materially broader coverage, reviewer-family/Sybil caps, ring-resistant arithmetic,
multiple independent reviewer roots, and stability across cutoffs. Any new tag or unit is a new
policy and must receive a new hash and report. The current artifact should remain visible only as
experimental, unproved evidence separate from proven TrustGraph scores.
