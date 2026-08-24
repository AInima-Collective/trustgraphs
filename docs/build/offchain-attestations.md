# Off-chain EAS attestations

Off-chain EAS attestations let members sign vouches without sending an Ethereum transaction. A
relay stores the signed payload and anchors an immutable commitment that the trust-graph proof can
verify later.

## Supported model

The supported path uses public EAS off-chain attestations signed by Ethereum accounts. Vouches are
not private or erasable: the signed payload must remain available for future proofs, and a
revocation is another authenticated record.

The operator must use the newest committed history. If required payloads are missing or invalid,
the checkpoint stops instead of producing a partial graph.

## Operational requirements

This feature adds relays, durable content storage, availability monitoring, and recovery procedures
to the trust boundary. Separate relay keys and storage paths reduce the risk that one failure can
erase or censor the only copy of a signed vouch.

Off-chain EAS support is currently an opt-in testnet feature. Communities should use ordinary
onchain vouches unless they are prepared to operate and monitor the additional infrastructure.

For the standard scoring path, see [Trust graph](./trust-graph.md).
