# Trustgraphs EAS offchain client

This browser-compatible package is the reference TypeScript implementation of
`Envelope0PayloadV1`. It uses the pinned official EAS SDK for v2 UID construction, signing, and
verification. Consensus data is always the frozen binary payload; JSON is only the portable bundle
and encrypted-draft transport.

The intended edit flow is:

1. Call `syncCanonicalNode` to read the live count/head/commitment and retrieve the byte-exact
   payload by its locally derived raw CID.
2. Create EAS v2 records with `signEasV2Attestation`. It generates a fresh Web Crypto salt and asks
   the connected wallet for EIP-712 `Attest`; it never accepts a private key.
3. Keep user intent as `DraftOperation` values. `saveEncryptedDraft` stores only PBKDF2/AES-GCM
   ciphertext in browser storage. `loadEncryptedDraft` authenticates and recovers it.
4. Apply operations to the synced full history and call `createSignedBundle`. The library verifies
   the old prefix, computes the exact next payload commitment/CID, and asks the same wallet for the
   typed `Trustgraphs Offchain Head` v2 authorization.
5. `exportBundle`/`importBundle` move the signed artifact between clients and relays. On a `409`
   reload response, use `reloadAndReapply`; signed attestations retain their salts and bytes, while
   a new head authorization is requested for the new canonical prefix.

Callers should use a viem wallet client or account-backed adapter implementing
`WalletTypedDataSigner`. The adapter has only an address and `signTypedData` method. Do not expose
or persist raw wallet keys in application code.
