// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {SafeOwnerPolicy} from "src/factory/SafeOwnerPolicy.sol";
import {MerkleFundDistributorDeployer} from "src/factory/InstanceDeployers.sol";
import {MerkleSnapshot} from "src/merkle/MerkleSnapshot.sol";
import {IInstanceRegistry} from "interfaces/registry/IInstanceRegistry.sol";

/// @title DistributorAttaching
/// @notice The instance-id derivation and the attach-a-fund-later path shared by the instance
///         factories. Kept identical across programs on purpose: a fix to the attachment rules
///         must reach every factory at once.
abstract contract DistributorAttaching {
    /// @notice The program id every instance of this factory registers under.
    bytes32 public immutable PROGRAM;
    IInstanceRegistry public immutable INSTANCE_REGISTRY;
    MerkleFundDistributorDeployer public immutable DISTRIBUTOR_DEPLOYER;

    /// @notice The one fund distributor this factory knows per instance: the creation-time one,
    ///         or the one `attachDistributor` deployed later. Zero means "none yet".
    mapping(bytes32 instanceId => address distributor) public distributorOf;

    /// @notice A fund distributor was attached to an existing instance after creation.
    ///         `distributorToken` is presentation only, exactly like the creation-time field.
    event DistributorAttached(bytes32 indexed instanceId, address distributor, address distributorToken);

    error ZeroAddress();
    error UnknownInstance(bytes32 instanceId);
    error NotInstanceAuthority(bytes32 instanceId, address owner);
    error DistributorAlreadyAttached(bytes32 instanceId, address distributor);
    error InvalidDistributorSafe(address owner);

    constructor(bytes32 program, IInstanceRegistry instanceRegistry, MerkleFundDistributorDeployer deployer) {
        if (address(instanceRegistry) == address(0) || address(deployer) == address(0)) {
            revert ZeroAddress();
        }
        PROGRAM = program;
        INSTANCE_REGISTRY = instanceRegistry;
        DISTRIBUTOR_DEPLOYER = deployer;
    }

    function computeInstanceId(address creator, string calldata name, bytes32 salt) public pure returns (bytes32) {
        return keccak256(abi.encode(creator, name, salt));
    }

    /// @notice Attach a fund distributor to an instance created without one. Permissionless to
    ///         CALL — anyone may pay the gas — but the deployed fund is owned by `owner`, which
    ///         must be an initialized Safe holding the instance's constitutional role right now.
    ///         Same terms as the creation-time path: fee 0, `feeRecipient = owner`.
    function attachDistributor(bytes32 instanceId, address owner, address distributorToken)
        external
        returns (address distributor)
    {
        // An unregistered id reverts inside the registry (`InstanceNotFound`); this factory only
        // adds the program check so it never serves another program's instance.
        IInstanceRegistry.Instance memory record = INSTANCE_REGISTRY.getInstance(instanceId);
        if (record.program != PROGRAM) revert UnknownInstance(instanceId);
        address existing = distributorOf[instanceId];
        if (existing != address(0)) revert DistributorAlreadyAttached(instanceId, existing);
        MerkleSnapshot snapshot = MerkleSnapshot(record.snapshot);
        if (!snapshot.hasRole(snapshot.CONSTITUTIONAL_ROLE(), owner)) {
            revert NotInstanceAuthority(instanceId, owner);
        }
        if (!SafeOwnerPolicy.isSafe(owner)) revert InvalidDistributorSafe(owner);
        distributor = address(DISTRIBUTOR_DEPLOYER.deploy(owner, record.snapshot, owner, 0, false));
        distributorOf[instanceId] = distributor;
        emit DistributorAttached(instanceId, distributor, distributorToken);
    }
}
