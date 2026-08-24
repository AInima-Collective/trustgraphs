# Addresses and verification keys

Never rely on an address or verification key copied from a chat message or an old screenshot.
Resolve deployment data from the tracked manifest for the chain you are using, then check it
against the chain.

## Deployment manifests

Chain-specific manifests live under `deployments/`. A usable release manifest records the chain
ID, contract addresses, deployment blocks, transaction hashes, source revision, program
verification keys, and relevant external dependencies.

A manifest marked as planned, or one with missing project addresses, is not a deployment record.
RPC URLs, private keys, and service credentials do not belong in these files.

## Check an address

Confirm that the connected RPC reports the manifest's chain ID, then inspect the deployment
transaction and runtime bytecode. For registered networks, resolve the contract set from the
`InstanceRegistry` rather than trusting a frontend label.

```bash
cast chain-id --rpc-url "$RPC_URL"
cast code 0xCONTRACT --rpc-url "$RPC_URL"
```

## Check a verification key

A verifier pins the key for one exact SP1 guest binary:

```bash
cast call 0xVERIFIER "programVKey()(bytes32)" --rpc-url "$RPC_URL"
```

Build the guest from the source revision and pinned SP1 toolchain named by the deployment, then
derive its key:

```bash
task zk:build
task zk:vkey PROGRAM=trust-graph
```

The locally derived value must match the deployed verifier. If it does not, stop: the local guest
is not the program that the contract accepts.

Verification keys can change when the guest binary or build toolchain changes, even when a source
edit appears behavior-preserving. Always compare against the deployed contract and the release's
recorded build inputs.
