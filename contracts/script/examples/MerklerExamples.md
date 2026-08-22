# Merkler Script Examples

This document provides usage examples for the `Merkler.s.sol` script, which combines merkle checkpoint updating and reward claiming functionality.

## Overview

The `Merkler.s.sol` script provides three main functions:

- `updateMerkle`: Triggers a new checkpoint on the MerkleSnapshot contract
- `claimRewards`: Claims available rewards from a distribution using a merkle proof
- `updateAndClaimRewards`: Combines both operations in a single run

Plus query helpers: `queryContractState`, `getIpfsUri`, `queryClaimStatus`, `queryBalance`, and `queryAll`.

Most functions operate on a specific distribution of the `MerkleFundDistributor`, identified by a `distributionIndex` (0, 1, 2, ...).

## Prerequisites

Before running any rewards scripts, ensure you have:

1. Set the `IPFS_GATEWAY_URL` environment variable
2. Set the `FUNDED_KEY` environment variable (or use default)
3. Access to `curl` and `jq` commands for IPFS data retrieval
4. Deployed MerkleSnapshot and MerkleFundDistributor contracts

`claimRewards` fetches the merkle tree from IPFS with `curl`/`jq`, so it must be run with the `--ffi` flag.

## Environment Variables

```bash
export IPFS_GATEWAY_URL="https://gateway.pinata.cloud/ipfs/"
export FUNDED_KEY="your_private_key_here"
```

## Function Examples

### 1. Update Merkle Checkpoint Only

Triggers a new checkpoint on the snapshot contract:

```bash
forge script contracts/script/Merkler.s.sol:Merkler \
    --sig "updateMerkle(string)" \
    "0x1234567890123456789012345678901234567890" \
    --rpc-url $RPC_URL \
    --broadcast
```

**Parameters:**

- `merkleSnapshotAddr`: Address of the deployed MerkleSnapshot contract

**Output:**

- Logs the new checkpoint id that was created

### 2. Claim Rewards Only

Claims available rewards for the caller from a distribution using a merkle proof:

```bash
forge script contracts/script/Merkler.s.sol:Merkler \
    --sig "claimRewards(string,uint256)" \
    "0x1234567890123456789012345678901234567890" \
    0 \
    --rpc-url $RPC_URL \
    --broadcast --ffi
```

**Parameters:**

- `merkleFundDistributorAddr`: Address of the deployed MerkleFundDistributor contract
- `distributionIndex`: Index of the distribution to claim from

**Output:**

- Merkle data URL for the distribution
- Claimer address and merkle value
- Balance before and after claiming
- Amount successfully claimed

### 3. Update and Claim Rewards (Combined)

Performs both operations in sequence:

```bash
forge script contracts/script/Merkler.s.sol:Merkler \
    --sig "updateAndClaimRewards(string,string,uint256)" \
    "0x1234567890123456789012345678901234567890" \
    "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd" \
    0 \
    --rpc-url $RPC_URL \
    --broadcast --ffi
```

**Parameters:**

- `merkleSnapshotAddr`: Address of the deployed MerkleSnapshot contract
- `merkleFundDistributorAddr`: Address of the deployed MerkleFundDistributor contract
- `distributionIndex`: Index of the distribution to claim from

**Output:**

- Combined output from both update and claim operations

### 4. Query Contract State

Get state information for a distribution, including root, IPFS hash, funding, and fees:

```bash
forge script contracts/script/Merkler.s.sol:Merkler \
    --sig "queryContractState(string,uint256)" \
    "0x1234567890123456789012345678901234567890" \
    0 \
    --rpc-url $RPC_URL
```

**Parameters:**

- `merkleFundDistributorAddr`: Address of the deployed MerkleFundDistributor contract
- `distributionIndex`: Index of the distribution to query

### 5. Get IPFS URI

Get the IPFS URI for a distribution's merkle tree:

```bash
forge script contracts/script/Merkler.s.sol:Merkler \
    --sig "getIpfsUri(string,uint256)" \
    "0x1234567890123456789012345678901234567890" \
    0 \
    --rpc-url $RPC_URL
```

**Parameters:**

- `merkleFundDistributorAddr`: Address of the deployed MerkleFundDistributor contract
- `distributionIndex`: Index of the distribution to query

### 6. Query Claim Status

Check how much an address has already claimed from a distribution:

```bash
forge script contracts/script/Merkler.s.sol:Merkler \
    --sig "queryClaimStatus(string,uint256,string)" \
    "0x1234567890123456789012345678901234567890" \
    0 \
    "0x742d35Cc6634C0532925a3b8D21Ce0C7a26F5BA5" \
    --rpc-url $RPC_URL
```

**Parameters:**

- `merkleFundDistributorAddr`: Address of the deployed MerkleFundDistributor contract
- `distributionIndex`: Index of the distribution to query
- `account`: Address to check claim status for

### 7. Query Balance

Check the current native (ETH) balance for an address:

```bash
forge script contracts/script/Merkler.s.sol:Merkler \
    --sig "queryBalance(string)" \
    "0x742d35Cc6634C0532925a3b8D21Ce0C7a26F5BA5" \
    --rpc-url $RPC_URL
```

**Parameters:**

- `account`: Address to check balance for

### 8. Comprehensive Query

Get all relevant information in a single call:

```bash
forge script contracts/script/Merkler.s.sol:Merkler \
    --sig "queryAll(string,uint256,string)" \
    "0x1234567890123456789012345678901234567890" \
    0 \
    "0x742d35Cc6634C0532925a3b8D21Ce0C7a26F5BA5" \
    --rpc-url $RPC_URL
```

**Parameters:**

- `merkleFundDistributorAddr`: Address of the deployed MerkleFundDistributor contract
- `distributionIndex`: Index of the distribution to query
- `account`: Address to check information for

## Example Output

### Query Contract State Output

```
=== Distribution 0 ===
Block Number: 12345
Timestamp: 1712345678
Root:
0x1234567890123456789012345678901234567890123456789012345678901234
IPFS Hash:
0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd
IPFS Hash CID:
QmXxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
Total Merkle Value: 1000000000000000000
Distributor: 0x...
Token: 0x...
Amount Funded: 1000000000000000000
Amount Distributed: 500000000000000000
Fee Recipient: 0x...
Fee Amount: 0
=====================
```

### Get IPFS URI Output

```
IPFS URI: https://gateway.pinata.cloud/ipfs/QmXxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
```

### Query Claim Status Output

```
=== Claim Status ===
Account: 0x742d35Cc6634C0532925a3b8D21Ce0C7a26F5BA5
Already Claimed: 500000000000000000
===================
```

### Query Balance Output

```
=== Token Balance ===
Account: 0x742d35Cc6634C0532925a3b8D21Ce0C7a26F5BA5
Balance: 1000000000000000000
====================
```

## Common Issues and Troubleshooting

### 1. IPFS Gateway Timeout

If the IPFS gateway is slow or unavailable, try using an alternative gateway:

```bash
export IPFS_GATEWAY_URL="https://ipfs.io/ipfs/"
```

### 2. jq Command Not Found

Install jq on your system:

```bash
# Ubuntu/Debian
sudo apt-get install jq

# macOS
brew install jq
```

### 3. Insufficient Rewards to Claim

If no entry exists for your address in the distribution's merkle tree, the script logs "No rewards found" and exits. Make sure:

- The reward distributor has been properly funded
- Your address is eligible for rewards in the chosen distribution
- You are querying the right `distributionIndex`

### 4. FFI Disabled

`claimRewards` (and `updateAndClaimRewards`) shell out to `curl`/`jq` to fetch the merkle tree from IPFS. Pass `--ffi` on the forge command line or the run will fail.

### 5. Private Key Issues

Ensure your private key has sufficient ETH for gas fees and is authorized to interact with the contracts.

## Gas Optimization

The combined `updateAndClaimRewards` function performs both operations in one run, which is convenient for testing. Note that a checkpoint triggered by `updateMerkle` is not proven instantly: a proof must land before new scores are claimable, so in practice you will usually run the two steps separately:

1. Call `updateMerkle` first
2. Wait for the checkpoint to be proven and submitted
3. Call `claimRewards` to claim your rewards

## Security Considerations

- Never hardcode private keys in scripts
- Always verify contract addresses before running scripts
- Test on testnets before mainnet deployment
- Ensure IPFS data integrity by verifying merkle roots match expected values
