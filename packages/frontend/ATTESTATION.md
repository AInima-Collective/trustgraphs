# Attestation UI Implementation

This document describes the functional attestation UI implementation for the trustgraphs EAS project.

## Features Implemented

### 1. Wallet Integration
- **Connect Wallet**: Uses wagmi's useConnect hook; the picker lists the browser wallet plus any wallets the browser announces (MetaMask, Coinbase Wallet, WalletConnect, Porto)
- **Account Status**: Displays connected wallet address and connection status
- **Local Chain Support**: Configured for Anvil local development (chain ID 31337)

### 2. Attestation Form
- **Schema Selection**: Dropdown with the schemas registered for this deployment (from the schema registry)
- **Recipient Input**: Ethereum address validation
- **Data Input**: Schema-specific fields with hints
- **Form Validation**: React Hook Form integration with proper error handling

### 3. Contract Integration
- **Contract Address**: Attestations are created directly against the deployed EAS contract; addresses come from the generated config
- **ABI Integration**: EAS ABI included via generated contract bindings
- **Transaction Handling**: Proper loading states and transaction confirmation
- **Error Handling**: Displays contract and network errors

### 4. UI/UX Features
- **Responsive Design**: Works on mobile and desktop
- **Loading States**: Proper feedback during wallet connection and transactions
- **Success States**: Shows transaction hash on successful attestation

## Technical Implementation

### Components Used
- **wagmi**: For Ethereum wallet and contract interactions
- **React Hook Form**: For form state management and validation
- **Radix UI**: For accessible UI components
- **viem**: For Ethereum utilities and encoding

### Key Files
- `lib/wagmi.ts`: Wagmi configuration with local chain support
- `lib/contracts.ts`: Generated contract addresses and ABIs
- `lib/schemas.ts` / `lib/schema-registry.ts`: Schema definitions, encoding, and decoding
- `hooks/useAttestation.ts`: Custom hook for attestation creation
- `app/attestations/page.tsx`: Main attestation page component
- `components/*`: UI component library

### Contract Integration Details
- **EAS Contract**: Address comes from the generated config for the active deployment
- **Chain ID**: 31337 (local Anvil)
- **RPC URL**: `http://localhost:8545`
- **Schema Support**: Schema UIDs come from the deployment's schema registry

## Usage

1. **Start the frontend**: `pnpm run dev`
2. **Connect Wallet**: Click "CONNECT WALLET" button
3. **Select Schema**: Choose from available schemas
4. **Enter Details**: Add recipient address and attestation data
5. **Submit**: Click "CREATE ATTESTATION" to submit to blockchain

## Development Notes

- The UI automatically detects wallet connection status
- Form validation prevents invalid submissions
- Transaction states are properly tracked and displayed
- Schema UIDs are pulled from the actual deployment
- Error messages are user-friendly and contextual

## Testing

To test the attestation functionality:
1. Ensure Anvil is running on `http://localhost:8545`
2. Ensure the contracts are deployed (EAS, resolver, and schemas) and the frontend config has been generated
3. Have a wallet with ETH for gas fees
4. Connect the wallet and try creating an attestation

The UI will show loading states during transaction processing and success/error states based on the outcome.