import { parseAbi } from 'viem'

/** Organizational links are recorded independently from the power instruments behind them. */
export const subnetworkRegistryAbi = parseAbi([
  'event ParentClaimed(bytes32 indexed childInstanceId,bytes32 indexed parentInstanceId,address indexed childAuthority)',
  'event ChildAccepted(bytes32 indexed childInstanceId,bytes32 indexed parentInstanceId,address indexed parentAuthority)',
  'event ParentClaimCancelled(bytes32 indexed childInstanceId,bytes32 indexed parentInstanceId,address indexed cancelledBy)',
  'event SubnetworkRegistered(bytes32 indexed childInstanceId,bytes32 indexed parentInstanceId,address indexed registrar)',
  'event SubnetworkReleased(bytes32 indexed childInstanceId,bytes32 indexed parentInstanceId,address indexed parentAuthority)',
  'function authorityOf(bytes32 instanceId) view returns (address)',
  'function INSTANCE_REGISTRY() view returns (address)',
  'function parentOf(bytes32 childInstanceId) view returns (bytes32)',
  'function pendingParentOf(bytes32 childInstanceId) view returns (bytes32)',
])

/** Permissionless initcode holder used by all governed factory wrappers. */
export const parentAuthorityModuleDeployerAbi = parseAbi([
  'event ParentAuthorityModuleConfigured(bytes32 indexed childInstanceId,bytes32 indexed parentInstanceId,address indexed parentAuthorityModule,address childSafe,address instanceRegistry,uint48 executionDelay)',
])

/** Events needed to keep a deployed parent's power and pending actions observable. */
export const parentAuthorityModuleAbi = parseAbi([
  'event ParentActionScheduled(bytes32 indexed childInstanceId,bytes32 indexed parentInstanceId,bytes32 indexed actionId,uint256 nonce,address parentAuthority,address target,uint256 value,bytes data,uint8 operation,uint256 executableAt)',
  'event ParentActionCancelled(bytes32 indexed childInstanceId,bytes32 indexed parentInstanceId,bytes32 indexed actionId,address cancelledBy)',
  'event ParentActionExecuted(bytes32 indexed childInstanceId,bytes32 indexed parentInstanceId,bytes32 indexed actionId,uint256 nonce,address executor,address target,uint256 value,bytes data,uint8 operation)',
  'event ParentPowerRenounced(bytes32 indexed childInstanceId,bytes32 indexed parentInstanceId,address indexed parentAuthority)',
])

export const delayedRecoveryModuleAbi = parseAbi([
  'event RecoveryProposerUpdated(address indexed previousProposer,address indexed newProposer)',
])

/** Ownable2Step controllers all share this event and view regardless of program family. */
export const paramsAuthorityOwnerAbi = parseAbi([
  'event OwnershipTransferred(address indexed previousOwner,address indexed newOwner)',
  'function owner() view returns (address)',
])
