# Envelope0PayloadV1 golden corpus

This directory is the checked-in, deterministic M0 interoperability corpus for the supported EAS
v2 off-chain profile. The positive payloads and every negative mutation are generated with
`@ethereum-attestation-service/eas-sdk` **2.9.0**, which is pinned exactly in `frontend/package.json`
and `pnpm-lock.yaml`.

Regenerate from the repository root:

```sh
pnpm --dir frontend fixture:eas-offchain
```

Check that the committed corpus is byte-for-byte reproducible without rewriting it:

```sh
pnpm --dir frontend fixture:eas-offchain:check
```

`manifest.json` contains the official SDK responses, independently reproduced EAS UIDs and typed
digests, typed head authorizations, prefix heads, SHA-256 commitments, raw CIDv1 values, and the
expected protocol error for each negative payload. Rust consumes the corpus from
`packages/eas-offchain-v2/src/payload_v1.rs`; Solidity independently checks it from
`test/unit/golden/EasOffchainPayloadGolden.t.sol`.

The private key in `manifest.json` is an intentionally public deterministic fixture key. Never use
it for funds, deployment, or any non-test signature.
