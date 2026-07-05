# Attestation UI Implementation

This document describes the functional attestation UI implementation for the TrustGraph EAS project.

## Features Implemented

### 1. Wallet Integration
- **Connect Wallet**: Uses wagmi's useConnect hook with injected connector (MetaMask)
- **Account Status**: Displays connected wallet address and connection status
- **Local Chain Support**: Configured for Anvil local development (chain ID 31337)

### 2. Attestation Form
- **Schema Selection**: Dropdown with available schemas (Basic and Compute)
- **Recipient Input**: Ethereum address validation
- **Data Input**: Textarea for attestation data with schema-specific hints
- **Form Validation**: React Hook Form integration with proper error handling

### 3. Contract Integration
- **Contract Address**: Uses deployed Attester contract from deployment_summary.json
- **ABI Integration**: Full Attester contract ABI included
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
- `lib/contracts.ts`: Contract addresses, ABIs, and schema UIDs
- `hooks/useAttestation.ts`: Custom hook for attestation creation
- `app/backroom/attestations/page.tsx`: Main attestation page component
- `components/ui/*`: UI component library

### Contract Integration Details
- **Attester Contract**: `0xB593Ee0C7b01711449129b655d28d5b69f9488BE`
- **Chain ID**: 31337 (local Anvil)
- **RPC URL**: `http://localhost:8545`
- **Schema Support**: Basic Schema and Compute Schema from deployment

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
2. Ensure the Attester contract is deployed at the specified address
3. Have a wallet with ETH for gas fees
4. Connect the wallet and try creating an attestation

The UI will show loading states during transaction processing and success/error states based on the outcome.