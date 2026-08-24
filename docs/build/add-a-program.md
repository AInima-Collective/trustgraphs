# Add a scoring program

A scoring program defines how committed inputs become a proven output. Add a program only when the
input model, score semantics, or output subject differs from the existing programs. To launch
another network with existing semantics, use [Create a network](./create-a-network.md).

## 1. Define deterministic semantics

Create a Rust core crate for input decoding, reconciliation, scoring, output construction, parameter
encoding, and the public journal. Consensus code must avoid floating-point arithmetic and
non-deterministic iteration.

Assign the program:

- a stable program ID;
- a versioned output domain;
- a canonical key encoding, such as Ethereum address or `bytes32`; and
- an explicit input decoder and API namespace.

Do not infer a program from a display name, key width, or output shape.

## 2. Add an isolated guest

Create a dedicated workspace under `zk/<name>-program/` with pinned SP1 dependencies and its own
lockfile. Register the guest in the prover build and add the usual `vkey`, `paramshash`,
`execute`, and `prove` commands.

Isolation matters because changing one program should not silently rebuild or rotate the
verification keys of unrelated programs.

## 3. Freeze cross-language vectors

Add a canonical fixture under `tests/golden/` and test it in every implementation that constructs
consensus bytes:

- the Rust core and guest;
- Solidity parameter, journal, leaf, and Merkle helpers; and
- TypeScript code used by the frontend or indexer.

An encoding change and its regenerated vector belong in the same change.

## 4. Register and index the program

Deploy a verifier with the new guest's key and register each instance's program, snapshot,
verifier, input contract, and parameter hash in `InstanceRegistry`.

Add the program and output domain to `packages/frontend/lib/score-program.ts`. Indexer and
frontend dispatch must validate that authenticated binding before interpreting score keys. Unknown
or conflicting bindings should fail closed.

When storage changes are required, deploy compatible database migrations and indexer support before
the frontend begins requesting the new response shape.

## 5. Document the public behavior

Add one page at `docs/build/<name>.md` explaining what the program does, when to use it, and its
trust boundary. Put architecture notes, runbooks, test procedures, rollout records, and review
artifacts under `research/`, where they remain available to repository contributors without
becoming public product documentation.

Add the public page to the docs manifest and the program table in
[Networks and programs](../concepts/networks-and-programs.md).
