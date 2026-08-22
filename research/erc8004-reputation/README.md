# Pinned-policy ERC-8004 reputation experiment

This directory is the reproducible evidence for issue #59. It consumes the raw canonical feedback
projection established in #58, but it is not imported by a contract, guest, operator, indexer, or
existing TrustGraph scoring route. The output is experimental, unproved, policy-specific, and not a
universal ERC-8004 score.

## Reproduce

```sh
node --import tsx --test research/erc8004-reputation/*.test.ts
pnpm exec tsc research/erc8004-reputation/*.ts --noEmit \
  --module esnext --moduleResolution bundler --target es2022 \
  --skipLibCheck --strict --types node --typeRoots packages/indexer/node_modules/@types
pnpm exec tsx research/erc8004-reputation/simulate.ts
pnpm exec tsx research/erc8004-reputation/export.ts
```

`policy.json` pins the Optimism registry provenance and cutoff, exact `quality` / `points/100`
interpretation, qualified-agent reviewer root at epoch 42, historical attribution rule, pair
reconciliation, denominators, arithmetic, bounds, tie order, and output identity domain.
`input.json` is a representative #58 projection. `canonical-policy.json` and
`canonical-input.json` are the exact sorted-key serializations that are SHA-256 committed in
`golden.json`.

`reference.ts` performs the primary exact-BigInt replay. It emits one reason for every excluded
record, a reviewer-weighted direct candidate, a fixed-mass damped positive-edge candidate, coverage
and concentration metrics, and every leave-one-reviewer-out delta. `independent.test.ts` deliberately
imports nothing from the primary reference and independently reproduces serialization, filtering,
pair selection, integer apportionment, iteration, and ordering from the JSON inputs.

`export.ts` is the only writer. It regenerates the canonical serializations, complete golden, and
the bounded presentation artifact used by the dedicated frontend experiment route. Review the diff
after running it; a policy or input change necessarily changes the committed hashes.

## Trust boundary

- The reviewer source is a declared research fixture, not a live or automatically selected root.
- Only one exact tag, unit, decimal interpretation, registry, and chain is eligible.
- Historical reviewer-agent attribution is accepted only when #58 recorded exactly one verified
  relation strictly before the feedback event. Current owner or wallet state is never consulted.
- Revocations remove that record from the active pair candidates without deleting history.
  Responses are counted and displayed but never validate, erase, or alter a value.
- Missing reviewer-target pairs are missing evidence. They are not converted to zero. An included
  literal zero remains separately observable.
- The propagation candidate uses positive edges only and is deliberately tested against a small
  reciprocal ring. No output is admitted to a TrustGraph edge, rank, root, or proof.

See `REPORT.md` for the measured comparison and bounded no-go recommendation.
