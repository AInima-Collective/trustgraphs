# EAS Schema Script Examples

This document provides examples of how to use the `Schema.s.sol` script for managing EAS (Ethereum Attestation Service) schemas.

## Prerequisites

Make sure you have:

- Deployed EAS SchemaRegistry contract
- (Optional) Deployed SchemaRegistrar contract for managed registration
- Your private key set in environment (or use `--private-key` flag)
- Understanding of EAS schema syntax

## Schema Registration

### Register Schema via Registrar Contract

```bash
forge script script/Schema.s.sol:EasSchema \
    --sig "registerSchema(string,string,string,bool)" \
    "0x1234...RegistrarAddress" \
    "string name,uint256 value,bool active" \
    "0x0000000000000000000000000000000000000000" \
    "true" \
    --rpc-url $RPC_URL \
    --broadcast
```

### Register Schema Directly with Registry

```bash
forge script script/Schema.s.sol:EasSchema \
    --sig "registerSchemaDirect(string,string,string,bool)" \
    "0x5678...RegistryAddress" \
    "address recipient,string message,uint256 timestamp" \
    "0x0000000000000000000000000000000000000000" \
    "false" \
    --rpc-url $RPC_URL \
    --broadcast
```

### Register Schema with Custom Resolver

```bash
forge script script/Schema.s.sol:EasSchema \
    --sig "registerSchema(string,string,string,bool)" \
    "0x1234...RegistrarAddress" \
    "bytes32 data,address verifier" \
    "0x9999...ResolverAddress" \
    "true" \
    --rpc-url $RPC_URL \
    --broadcast
```

## Schema Queries

### Show Schema Details

```bash
forge script script/Schema.s.sol:EasSchema \
    --sig "showSchema(string,string)" \
    "0x5678...RegistryAddress" \
    "0xabcd...SchemaUID" \
    --rpc-url $RPC_URL
```

### Check if Schema Exists

```bash
forge script script/Schema.s.sol:EasSchema \
    --sig "schemaExists(string,string)" \
    "0x5678...RegistryAddress" \
    "0xabcd...SchemaUID" \
    --rpc-url $RPC_URL
```

### List Recent Schemas

```bash
forge script script/Schema.s.sol:EasSchema \
    --sig "listRecentSchemas(string)" \
    "0x5678...RegistryAddress" \
    --rpc-url $RPC_URL
```

## Schema Utilities

### Validate Schema Syntax

```bash
forge script script/Schema.s.sol:EasSchema \
    --sig "validateSchema(string)" \
    "string name,uint256 amount,bool verified,address wallet" \
    --rpc-url $RPC_URL
```

### Preview Schema UID

```bash
forge script script/Schema.s.sol:EasSchema \
    --sig "previewSchemaUID(string,string,bool)" \
    "string email,uint256 score" \
    "0x0000000000000000000000000000000000000000" \
    "true" \
    --rpc-url $RPC_URL
```

## Common Schema Examples

### User Profile Schema

```bash
forge script script/Schema.s.sol:EasSchema \
    --sig "registerSchemaDirect(string,string,string,bool)" \
    "0x...RegistryAddress" \
    "string name,string email,uint256 reputation,bool verified" \
    "0x0000000000000000000000000000000000000000" \
    "false" \
    --rpc-url $RPC_URL --broadcast
```

### Financial Transaction Schema

```bash
forge script script/Schema.s.sol:EasSchema \
    --sig "registerSchemaDirect(string,string,string,bool)" \
    "0x...RegistryAddress" \
    "address from,address to,uint256 amount,bytes32 txHash,uint256 blockNumber" \
    "0x0000000000000000000000000000000000000000" \
    "true" \
    --rpc-url $RPC_URL --broadcast
```

### Identity Verification Schema

```bash
forge script script/Schema.s.sol:EasSchema \
    --sig "registerSchemaDirect(string,string,string,bool)" \
    "0x...RegistryAddress" \
    "string documentType,bytes32 documentHash,bool verified,uint256 expirationDate" \
    "0x...IdentityResolverAddress" \
    "true" \
    --rpc-url $RPC_URL --broadcast
```

### Voting/Governance Schema

```bash
forge script script/Schema.s.sol:EasSchema \
    --sig "registerSchemaDirect(string,string,string,bool)" \
    "0x...RegistryAddress" \
    "uint256 proposalId,uint8 vote,string reason,uint256 votingPower" \
    "0x0000000000000000000000000000000000000000" \
    "false" \
    --rpc-url $RPC_URL --broadcast
```

### Reputation/Review Schema

```bash
forge script script/Schema.s.sol:EasSchema \
    --sig "registerSchemaDirect(string,string,string,bool)" \
    "0x...RegistryAddress" \
    "address subject,uint8 rating,string review,string category" \
    "0x0000000000000000000000000000000000000000" \
    "true" \
    --rpc-url $RPC_URL --broadcast
```

## Schema Syntax Reference

### Basic Types

- `uint256` - Unsigned integer (also uint8, uint16, uint32, etc.)
- `int256` - Signed integer (also int8, int16, int32, etc.)
- `string` - Text string
- `bool` - Boolean (true/false)
- `address` - Ethereum address
- `bytes` - Dynamic byte array
- `bytes32` - Fixed 32-byte array

### Schema Format

Schemas are comma-separated field definitions:

```
"type1 name1,type2 name2,type3 name3"
```

### Examples:

- Simple: `"string message"`
- Multiple fields: `"string name,uint256 age,bool active"`
- Complex: `"address user,bytes32 hash,uint256[] values,string metadata"`

## Common Workflows

### 1. Design and Register New Schema

```bash
# 1. Validate your schema syntax first
forge script script/Schema.s.sol:EasSchema \
    --sig "validateSchema(string)" \
    "address user,string action,uint256 timestamp" \
    --rpc-url $RPC_URL

# 2. Preview the schema UID
forge script script/Schema.s.sol:EasSchema \
    --sig "previewSchemaUID(string,string,bool)" \
    "address user,string action,uint256 timestamp" \
    "0x0000000000000000000000000000000000000000" \
    "true" \
    --rpc-url $RPC_URL

# 3. Register the schema
forge script script/Schema.s.sol:EasSchema \
    --sig "registerSchemaDirect(string,string,string,bool)" \
    "0x...RegistryAddress" \
    "address user,string action,uint256 timestamp" \
    "0x0000000000000000000000000000000000000000" \
    "true" \
    --rpc-url $RPC_URL --broadcast
```

### 2. Verify Schema Registration

```bash
# 1. Check if schema exists (using UID from registration output)
forge script script/Schema.s.sol:EasSchema \
    --sig "schemaExists(string,string)" \
    "0x...RegistryAddress" \
    "0x...SchemaUID" \
    --rpc-url $RPC_URL

# 2. Show full schema details
forge script script/Schema.s.sol:EasSchema \
    --sig "showSchema(string,string)" \
    "0x...RegistryAddress" \
    "0x...SchemaUID" \
    --rpc-url $RPC_URL
```

### 3. Schema Management Pipeline

```bash
# For production use - validate, then register with resolver
# 1. Validate
forge script script/Schema.s.sol:EasSchema \
    --sig "validateSchema(string)" \
    "bytes32 agreementHash,address[] parties,uint256 value,bool executed"

# 2. Register with custom resolver for validation
forge script script/Schema.s.sol:EasSchema \
    --sig "registerSchemaDirect(string,string,string,bool)" \
    "0x...RegistryAddress" \
    "bytes32 agreementHash,address[] parties,uint256 value,bool executed" \
    "0x...ContractResolverAddress" \
    "true" \
    --rpc-url $RPC_URL --broadcast
```

## Advanced Examples

### Schema with Array Types

```bash
forge script script/Schema.s.sol:EasSchema \
    --sig "registerSchemaDirect(string,string,string,bool)" \
    "0x...RegistryAddress" \
    "address[] participants,uint256[] amounts,string description" \
    "0x0000000000000000000000000000000000000000" \
    "false" \
    --rpc-url $RPC_URL --broadcast
```

### Multi-Purpose Schema

```bash
forge script script/Schema.s.sol:EasSchema \
    --sig "registerSchemaDirect(string,string,string,bool)" \
    "0x...RegistryAddress" \
    "string eventType,bytes data,address[] witnesses,uint256 blockNumber,bytes32 previousAttestation" \
    "0x...EventResolverAddress" \
    "true" \
    --rpc-url $RPC_URL --broadcast
```

## Environment Variables Setup

For easier usage, set these in your `.env` file:

```bash
# Common addresses
SCHEMA_REGISTRY_ADDRESS=0x...
SCHEMA_REGISTRAR_ADDRESS=0x...
DEFAULT_RESOLVER_ADDRESS=0x0000000000000000000000000000000000000000

# Then use in commands:
forge script script/Schema.s.sol:EasSchema \
    --sig "showSchema(string,string)" \
    "$SCHEMA_REGISTRY_ADDRESS" \
    "0x...SchemaUID" \
    --rpc-url $RPC_URL
```

## Tips

1. **Schema Design**: Keep schemas focused - one schema per use case
2. **Field Names**: Use descriptive names that clearly indicate the data purpose
3. **Revocability**: Set to `true` only if you need the ability to revoke attestations
4. **Resolvers**: Use custom resolvers for validation logic, access control, or side effects
5. **Arrays**: Be careful with array types - they increase gas costs for attestations
6. **Versioning**: Create new schemas for breaking changes rather than modifying existing ones

## Troubleshooting

### Common Errors

- **"Invalid schema"**: Check schema syntax - ensure proper type,name formatting
- **"Schema already exists"**: The exact schema+resolver+revocable combination is already registered
- **"Invalid resolver"**: Resolver address doesn't implement ISchemaResolver interface
- **"Insufficient permissions"**: Using registrar contract without proper permissions

### Schema Syntax Validation

Valid examples:

- ✅ `"string name"`
- ✅ `"string name,uint256 value"`
- ✅ `"address user,bool active,uint256[] scores"`

Invalid examples:

- ❌ `"string"` (missing field name)
- ❌ `"name string"` (wrong order)
- ❌ `"string name uint256 value"` (missing comma)

### Getting Schema UIDs

After registration, look for the console output:

```
SCHEMA_REGISTRATION_RESULT:
{"schema_uid":"0x...","schema":"...","resolver":"...","revocable":true}
```

Save the `schema_uid` for future attestation creation!

## Integration with Attestation Creation

Once you have a schema UID, you can use it to create a direct EAS attestation:

```bash
# Use your registered schema UID in attestation creation
forge script script/EASAttest.s.sol:EASAttest \
    --sig "attest(string,string,string,string)" \
    "0x...EASAddress" \
    "0x...YourSchemaUID" \
    "0x...RecipientAddress" \
    "your,attestation,data" \
    --rpc-url $RPC_URL --broadcast
```
