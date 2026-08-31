# EASAttest Script Documentation

The `EASAttest.s.sol` script provides a simple interface for making direct attestations to Ethereum Attestation Service (EAS) contracts with optional ETH payment support.

## Overview

This Foundry script allows you to:

- Create vouching attestations (comment + confidence)
- Create basic EAS attestations without payment
- Create EAS attestations with ETH payment (useful for payment-enabled resolvers)
- Use convenient milliether units for payments
- Integrate seamlessly with the project's Taskfile workflow

## Quick Start

### Via Taskfile (Recommended)

```bash
# Create a vouching attestation (uses the dev network's vouching schema)
task forge:vouch RECIPIENT=0xYOUR_RECIPIENT_ADDRESS COMMENT="great work" CONFIDENCE=90

# Create a statement attestation with 0.001 ETH payment
# (STATEMENT_SCHEMA_UID is not auto-resolved; pass it explicitly)
task forge:trigger-statement-attestation INPUT="Hello, World!" STATEMENT_SCHEMA_UID=0xYOUR_SCHEMA_UID
```

### Direct Forge Script Execution

```bash
# Basic attestation without payment
forge script contracts/script/EASAttest.s.sol:EASAttest \
  --sig "attest(string,string,string,string)" \
  "0xDeaDb50427AeEebaCD2CFa380fE194CA3A252807" \
  "0x8d4db77aebacb5aff7fbf2d15f4b876aa2897459393ae6a0d8e702f47467cc81" \
  "0xYOUR_RECIPIENT_ADDRESS" \
  "Hello World" \
  --rpc-url http://localhost:8545 --broadcast

# Attestation with 0.001 ETH payment (1 milliether)
forge script contracts/script/EASAttest.s.sol:EASAttest \
  --sig "attestWithMilliEth(string,string,string,string,uint256)" \
  "0xDeaDb50427AeEebaCD2CFa380fE194CA3A252807" \
  "0x8d4db77aebacb5aff7fbf2d15f4b876aa2897459393ae6a0d8e702f47467cc81" \
  "0xYOUR_RECIPIENT_ADDRESS" \
  "Hello World" \
  1 \
  --rpc-url http://localhost:8545 --broadcast
```

## Available Methods

### 0. `vouch(easAddr, vouchingSchema, recipient, comment, confidence)`

Creates a vouching attestation (the schema behind trust-graph edges).

**Parameters:**

- `easAddr`: EAS contract address (hex string with 0x prefix)
- `vouchingSchema`: Vouching schema UID (hex string with 0x prefix, 32 bytes)
- `recipient`: Recipient address (hex string with 0x prefix)
- `comment`: Comment string
- `confidence`: Confidence level (0-100)

**Features:**

- Encodes `(comment, confidence)` as the attestation data
- Revocable attestation, no expiration time, no payment
- Uses FUNDED_KEY for signing
- Available via `task forge:vouch` (reads the vouching schema UID from `config/network_deploy_dev_<N>.json`)

### 1. `attest(easAddr, schema, recipient, data)`

Creates a basic attestation without payment.

**Parameters:**

- `easAddr`: EAS contract address (hex string with 0x prefix)
- `schema`: Schema UID (hex string with 0x prefix, 32 bytes)
- `recipient`: Recipient address (hex string with 0x prefix, use 0x0 for no specific recipient)
- `data`: Attestation data string (encoded as bytes)

**Features:**

- No payment sent
- Revocable attestation
- No expiration time
- Uses FUNDED_KEY for signing

### 2. `attestWithPayment(easAddr, schema, recipient, data, value)`

Creates an attestation with ETH payment in wei.

**Parameters:**

- `easAddr`: EAS contract address
- `schema`: Schema UID
- `recipient`: Recipient address
- `data`: Attestation data string
- `value`: Payment amount in wei

**Use Cases:**

- Payment-enabled resolvers
- Fee-based attestation systems
- Incentivized attestation networks

### 3. `attestWithMilliEth(easAddr, schema, recipient, data, milliEthAmount)`

Convenience method for payments using milliether units.

**Parameters:**

- `easAddr`: EAS contract address
- `schema`: Schema UID
- `recipient`: Recipient address
- `data`: Attestation data string
- `milliEthAmount`: Payment amount in milliether (1 = 0.001 ETH)

**Common Values:**

- `1` = 0.001 ETH (1 milliether)
- `10` = 0.01 ETH (10 milliether)
- `100` = 0.1 ETH (100 milliether)

## Environment Variables

The script uses the following environment variables (configured via `.env`):

- `FUNDED_KEY`: Private key for signing transactions (required)
- `RPC_URL`: Ethereum RPC endpoint (defaults to http://localhost:8545)

## Integration with Taskfile

The script is integrated with the project's Taskfile workflow:

### Task: `forge:trigger-statement-attestation`

```yaml
trigger-statement-attestation:
  desc: 'Create direct EAS attestation with 0.001 ETH payment'
  vars:
    RPC_URL:
      sh: task get-rpc
  requires:
    vars: [INPUT]
  cmds:
    - |
      forge script contracts/script/EASAttest.s.sol:EASAttest \
        --sig "attestWithMilliEth(string,string,string,string,uint256)" \
        "{{.EAS_ADDR}}" \
        "{{.STATEMENT_SCHEMA_UID}}" \
        "{{.WALLET_ADDRESS}}" \
        "{{.INPUT}}" \
        1 \
        --rpc-url {{.RPC_URL}} --broadcast
```

**Key points:**

- Uses `EASAttest.s.sol`
- Calls `attestWithMilliEth` with 1 milliether (0.001 ETH)
- Targets the EAS contract directly (`{{.EAS_ADDR}}`)
- Sends payment along with attestation

## Environment Variable Sources

The Taskfile automatically resolves most variables from deployment configuration:

- `EAS_ADDR`: From `.docker/deployment_summary.json` → `eas.eas`
- `WALLET_ADDRESS`: Derived from `FUNDED_KEY` using `cast wallet address`
- `STATEMENT_SCHEMA_UID`: Not auto-resolved; pass it on the command line
  (`task forge:trigger-statement-attestation INPUT=... STATEMENT_SCHEMA_UID=0x...`)
  after registering a statement schema (see `SchemaExamples.md`)

## Payment Support

### Why Payment?

Payment support enables:

1. **Economic incentives**: Align attestation behavior with economic value
2. **Fee mechanisms**: Support fee-based attestation services
3. **Resolver flexibility**: Work with payment-enabled resolvers

### Payment Flow

1. User specifies payment amount (wei or milliether)
2. Script creates `AttestationRequestData` with payment value
3. EAS contract receives payment via `{value: amount}` call
4. Resolver contract can access payment through attestation value field
5. Payment-enabled resolvers validate minimum payment requirements

## Error Handling

Common errors and solutions:

**Insufficient funds:**

```
Error: InsufficientBalance
Solution: Ensure wallet has enough ETH for payment + gas fees
```

**Invalid schema:**

```
Error: InvalidSchema
Solution: Verify schema UID exists and is correctly formatted (32 bytes hex)
```

**Invalid EAS address:**

```
Error: Contract not deployed
Solution: Verify EAS contract address and network
```

## Examples

### Statement Attestation with Payment

```bash
# Create a statement attestation with 0.001 ETH payment
task forge:trigger-statement-attestation INPUT="I believe in decentralized attestations"
```

### Custom Schema Attestation

```bash
# Direct script call with custom schema
forge script contracts/script/EASAttest.s.sol:EASAttest \
  --sig "attestWithMilliEth(string,string,string,string,uint256)" \
  "0xDeaDb50427AeEebaCD2CFa380fE194CA3A252807" \
  "0xYOUR_CUSTOM_SCHEMA_UID" \
  "0xRECIPIENT_ADDRESS" \
  "Custom attestation data" \
  5 \
  --rpc-url http://localhost:8545 --broadcast
```

### No-Payment Attestation

```bash
forge script contracts/script/EASAttest.s.sol:EASAttest \
  --sig "attest(string,string,string,string)" \
  "0xDeaDb50427AeEebaCD2CFa380fE194CA3A252807" \
  "0xSCHEMA_UID" \
  "0xRECIPIENT_ADDRESS" \
  "Free attestation data" \
  --rpc-url http://localhost:8545 --broadcast
```

## Testing

The script includes comprehensive unit tests in `contracts/test/unit/EASAttest.t.sol`:

```bash
# Run tests
forge test --match-contract EASAttestTest -v
```

Tests cover:

- Milliether to wei conversion
- Script deployment
- String conversion utilities
- Edge cases and error conditions

## Architecture Integration

This script integrates with the broader trustgraphs architecture:

1. **Direct EAS Integration**: Creates attestations directly against the EAS contract
2. **Payment Support**: Enables economic models around attestations
3. **Resolver Compatibility**: Works with all EAS resolver types
4. **Taskfile Integration**: Seamless developer workflow
5. **Environment Configuration**: Automatic contract address resolution

## Security Considerations

- **Private Key Management**: Uses environment variables for private keys
- **Payment Validation**: Always verify payment amounts before execution
- **Network Verification**: Ensure correct network and contract addresses
- **Gas Estimation**: Account for gas costs in addition to payment amounts
- **Recipient Validation**: Verify recipient addresses are correct

## Troubleshooting

### Common Issues

1. **Transaction fails with insufficient gas:**
   - Increase gas limit or check network congestion

2. **Payment amount incorrect:**
   - Verify milliether to wei conversion (1 milliether = 1e15 wei)

3. **Schema not found:**
   - Check deployment summary for correct schema UIDs

4. **Wallet not funded:**
   - Ensure FUNDED_KEY account has sufficient ETH balance

### Debug Mode

Enable verbose logging:

```bash
forge script ... -vvv
```

This provides detailed transaction information and error messages.
