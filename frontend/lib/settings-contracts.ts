import { parseAbi } from 'viem'

/** Read-only surface used by the settings page. Kept small so the UI remains independent of the
 * generated address map; the shared vault can also be discovered from `TrustGraphFactory.VAULT`.
 */
export const provingVaultReadAbi = parseAbi([
  'function depositETH(bytes32 instanceId) payable',
  'function depositUSDC(bytes32 instanceId, uint256 amount)',
  'function accountOf(bytes32 instanceId) view returns (address snapshot, bytes32 program, uint128 ethBalance, uint128 usdcBalance)',
  'function policyOf(bytes32 instanceId) view returns (uint64 minPaidIntervalBlocks, uint96 maxPerRootUsd, uint64 lastPaidBlock)',
  'function pendingWithdrawalOf(bytes32 instanceId) view returns (uint128 ethAmount, uint128 usdcAmount, uint64 readyAt)',
  'function quote(bytes32 instanceId, uint64 leafCount, uint64 anchorCount) view returns (uint256 feeUsd, uint256 gasUsd, uint256 payableUsd, bool eligible, uint8 reason)',
  'function bandOf(bytes32 program, uint64 leafCount, uint64 anchorCount) view returns (uint8)',
  'function feePerRootUsd(bytes32 program, uint8 band) view returns (uint256)',
  'function REGISTRY() view returns (address)',
  'function USDC() view returns (address)',
  'function ETH_USD_FEED() view returns (address)',
  'function FEED_MAX_STALENESS() view returns (uint64)',
  'function MIN_ETH_USD() view returns (uint256)',
  'function MAX_ETH_USD() view returns (uint256)',
  'function MAX_PRICED_INPUTS() view returns (uint64)',
  'function maxGasUnitsPerClaim() view returns (uint256)',
  'function nominalGasUnits() view returns (uint256)',
  'function withdrawalNotice() view returns (uint64)',
])

export const priceFeedReadAbi = parseAbi([
  'function decimals() view returns (uint8)',
  'function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)',
])

export const erc20MetadataReadAbi = parseAbi([
  'function symbol() view returns (string)',
  'function decimals() view returns (uint8)',
])
