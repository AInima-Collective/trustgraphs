# Composition decision evidence

This directory is the reproducible Phase-0 evidence for issue #36. Nothing here is imported by a
production contract, guest, operator, indexer, or frontend route.

## Reproduce

```sh
node --import tsx --test research/composition/reference.test.ts
pnpm exec tsc research/composition/*.ts --noEmit \
  --module esnext --moduleResolution bundler --target es2022 --skipLibCheck --strict \
  --types node --typeRoots indexer/node_modules/@types
pnpm exec tsx research/composition/simulate.ts
pnpm exec tsx research/composition/export-fixture.ts
```

`reference.ts` is an exact BigInt reference for the selected two-stage, source-aware Hamilton
policy. It strictly re-encodes complete canonical score blobs, checks their SHA-256/CID/OZ Merkle
root/total, validates frozen provenance and freshness, and emits the existing address/value blob
and Merkle shape. `fixture-builder.ts` uses the repository's existing TrustGraph golden output as
source A and two deliberately unequal, sparse sources as B and C. `golden.json` pins source and
composite commitments, exact quotas, per-source attribution, output, invalid cases, and a source
update after trigger.

`simulate.ts` is the A/B/C weight-simplex explorer and adversarial/scaling harness. It prints all
36 positive 10%-grid policies; pairwise overlap, correlation, and Jensen-Shannon disagreement;
leave-one-source-out changes; a compromised source; clone-family amplification; a personalized
meta-referral cartel; comparison with a single-stage ideal-mass Hamilton candidate; and bounded
synthetic measurements. The checked-in `simulation-summary.json` and `benchmarks.csv` record the
decision run while keeping volatile timing out of the golden tests.

## Measurement boundary

Measurements were taken on 2026-08-14 with Node 22.23.1 on Linux/aarch64. Timing covers complete
reference validation and composition after synthetic source construction, with five samples and
the median reported. `deterministic_live_bytes_floor` counts exact source bytes plus 36 bytes for
each address/u128 record in the validated source, attribution, union, and output vectors. It is not
RSS, SP1 cycles, proof time, or an Optimism gas quote.

At the selected aggregate cap of 8,192 canonical address/u128 records, even the worst literal JSON
shape is below 0.75 MiB; the 1 MiB byte cap is independently enforced. The measured representative
8-source/8,192-record shape used 425,035 source bytes, a 1,346,635-byte deterministic live-data
floor, and a 293.9 ms native median. These results justify a conservative research/implementation
ceiling, not production proving economics: the core/guest issue must measure SP1 cycles and memory
and may lower the cap. Raising it requires new evidence and governance/versioning.
