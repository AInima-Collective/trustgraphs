# Merkler Script Examples

This document provides usage examples for the `Merkler.s.sol` script, which combines reward updating and claiming functionality.

## Overview

The `Merkler.s.sol` script provides three main functions:

- `updateMerkle`: Adds a trigger to update the merkle tree
- `claimRewards`: Claims available rewards using a merkle proof
- `updateAndClaimRewards`: Combines both operations in a single transaction

## Prerequisites

Before running any rewards scripts, ensure you have:

1. Set the `IPFS_GATEWAY_URL` environment variable
2. Set the `FUNDED_KEY` environment variable (or use default)
3. Access to `curl` and `jq` commands for IPFS data retrieval
4. Deployed MerkleFundDistributor and reward-token (ERC-20) contracts

## Environment Variables

```bash
export IPFS_GATEWAY_URL="https://gateway.pinata.cloud/ipfs/"
export FUNDED_KEY="your_private_key_here"
```

## Function Examples

### 1. Update Rewards Only

Updates the rewards distribution by adding a trigger:

```bash
forge script script/Merkler.s.sol:Merkler \
    --sig "updateMerkle(string)" \
    "0x1234567890123456789012345678901234567890" \
    --rpc-url $RPC_URL \
    --broadcast
```

**Parameters:**

- `merkleSnapshotAddr`: Address of the deployed MerkleSnapshot contract

**Output:**

- Logs the new TriggerId that was created

### 2. Claim Rewards Only

Claims available rewards for the caller using merkle proof:

```bash
forge script script/Merkler.s.sol:Merkler \
    --sig "claimRewards(string,string)" \
    "0x1234567890123456789012345678901234567890" \
    "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd" \
    --rpc-url $RPC_URL \
    --broadcast
```

**Parameters:**

- `merkleFundDistributorAddr`: Address of the deployed MerkleFundDistributor contract
- `rewardTokenAddr`: Address of the reward token (ERC-20) contract

**Output:**

- Verification of merkle root and IPFS hash
- Merkle data URL
- Claimable amount
- Balance before and after claiming
- Amount successfully claimed

### 3. Update and Claim Rewards (Combined)

Performs both operations in sequence:

```bash
forge script script/Merkler.s.sol:Merkler \
    --sig "updateAndClaimRewards(string,string,string)" \
    "0x1234567890123456789012345678901234567890" \
    "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd" \
    "0x2345678901234567890123456789012345678901" \
    --rpc-url $RPC_URL \
    --broadcast
```

**Parameters:**

- `merkleSnapshotAddr`: Address of the deployed MerkleSnapshot contract
- `merkleFundDistributorAddr`: Address of the deployed MerkleFundDistributor contract
- `rewardTokenAddr`: Address of the reward token (ERC-20) contract

**Output:**

- Combined output from both update and claim operations

### 4. Query Contract State

Get current contract state information including root, IPFS hash, and next trigger ID:

```bash
forge script script/Merkler.s.sol:Merkler \
    --sig "queryContractState(string)" \
    "0x1234567890123456789012345678901234567890" \
    --rpc-url $RPC_URL
```

**Parameters:**

- `merkleFundDistributorAddr`: Address of the deployed MerkleFundDistributor contract

### 5. Get IPFS URI

Get the IPFS URI for the current merkle tree:

```bash
forge script script/Merkler.s.sol:Merkler \
    --sig "getIpfsUri(string)" \
    "0x1234567890123456789012345678901234567890" \
    --rpc-url $RPC_URL
```

**Parameters:**

- `merkleFundDistributorAddr`: Address of the deployed MerkleFundDistributor contract

**Parameters:**

- `merkleFundDistributorAddr`: Address of the deployed MerkleFundDistributor contract
- `triggerId`: The trigger ID to query (e.g., 1, 2, 3...)

### 6. Query Claim Status

Check how much an address has already claimed:

```bash
forge script script/Merkler.s.sol:Merkler \
    --sig "queryClaimStatus(string,string,string)" \
    "0x1234567890123456789012345678901234567890" \
    "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd" \
    "0x742d35Cc6634C0532925a3b8D21Ce0C7a26F5BA5" \
    --rpc-url $RPC_URL
```

**Parameters:**

- `merkleFundDistributorAddr`: Address of the deployed MerkleFundDistributor contract
- `rewardTokenAddr`: Address of the reward token (ERC-20) contract
- `account`: Address to check claim status for

### 7. Query Token Balance

Check current token balance for an address:

```bash
forge script script/Merkler.s.sol:Merkler \
    --sig "queryBalance(string,string)" \
    "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd" \
    "0x742d35Cc6634C0532925a3b8D21Ce0C7a26F5BA5" \
    --rpc-url $RPC_URL
```

**Parameters:**

- `rewardTokenAddr`: Address of the reward token (ERC-20) contract
- `account`: Address to check balance for

### 8. Comprehensive Query

Get all relevant information in a single call:

```bash
forge script script/Merkler.s.sol:Merkler \
    --sig "queryAll(string,string,string)" \
    "0x1234567890123456789012345678901234567890" \
    "0xabcdefabcdefabcdefabcdefabcdefabcdefabcd" \
    "0x742d35Cc6634C0532925a3b8D21Ce0C7a26F5BA5" \
    --rpc-url $RPC_URL
```

**Parameters:**

- `merkleFundDistributorAddr`: Address of the deployed MerkleFundDistributor contract
- `rewardTokenAddr`: Address of the reward token (ERC-20) contract
- `account`: Address to check information for

## Example Output

### Query Contract State Output

```
=== Contract State ===
Current Root:
0x1234567890123456789012345678901234567890123456789012345678901234

Current IPFS Hash:
0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdef

Current IPFS Hash CID:
QmXxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
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
Reward Token: 0xabcdefabcdefabcdefabcdefabcdefabcdefabcd
Already Claimed: 500000000000000000
===================
```

### Query Token Balance Output

```
=== Token Balance ===
Account: 0x742d35Cc6634C0532925a3b8D21Ce0C7a26F5BA5
Token: 0xabcdefabcdefabcdefabcdefabcdefabcdefabcd
Balance: 1000000000000000000
====================
```

### Comprehensive Query Output

```
=== COMPREHENSIVE QUERY ===

=== Contract State ===
Current Root:
0x1234567890123456789012345678901234567890123456789012345678901234

Current IPFS Hash:
0xabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdef

Current IPFS Hash CID:
QmXxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
=====================

IPFS URI: https://gateway.pinata.cloud/ipfs/QmXxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx

=== Token Balance ===
Account: 0x742d35Cc6634C0532925a3b8D21Ce0C7a26F5BA5
Token: 0xabcdefabcdefabcdefabcdefabcdefabcdefabcd
Balance: 1000000000000000000
====================

=== Claim Status ===
Account: 0x742d35Cc6634C0532925a3b8D21Ce0C7a26F5BA5
Reward Token: 0xabcdefabcdefabcdefabcdefabcdefabcdefabcd
Already Claimed: 500000000000000000
===================

=== END COMPREHENSIVE QUERY ===
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

If no rewards are available, the claimable amount will be 0. Make sure:

- The reward distributor has been properly funded
- Your address is eligible for rewards in the current distribution
- The merkle proof is valid for your address

### 4. Private Key Issues

Ensure your private key has sufficient ETH for gas fees and is authorized to interact with the contracts.

## Gas Optimization

The combined `updateAndClaimRewards` function performs both operations in a single transaction, which can save on gas compared to calling them separately. However, if either operation fails, both will revert.

For maximum reliability, consider using the individual functions:

1. Call `updateMerkle` first
2. Wait for confirmation
3. Call `claimRewards` to claim your rewards

## Security Considerations

- Never hardcode private keys in scripts
- Always verify contract addresses before running scripts
- Test on testnets before mainnet deployment
- Ensure IPFS data integrity by verifying merkle roots match expected values
