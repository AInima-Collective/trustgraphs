// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {GnosisSafe} from "@gnosis.pm/safe-contracts/GnosisSafe.sol";
import {Enum} from "@gnosis.pm/safe-contracts/common/Enum.sol";
import {GnosisSafeProxyFactory} from "@gnosis.pm/safe-contracts/proxies/GnosisSafeProxyFactory.sol";

import {TrustGraphFactory} from "contracts/factory/TrustGraphFactory.sol";
import {MerkleSnapshot} from "contracts/merkle/MerkleSnapshot.sol";
import {MerkleGovModule} from "contracts/zodiac/MerkleGovModule.sol";
import {IInstanceRegistry} from "interfaces/registry/IInstanceRegistry.sol";
import {IMerkleSnapshotHook} from "interfaces/merkle/IMerkleSnapshotHook.sol";

/// @title GovernedTrustGraphFactory
/// @notice Creates a factory trust graph and its DAO Safe + Merkle governance module as one
///         transaction, with the Safe installed as every instance authority from genesis.
/// @dev The base factory remains the canonical instance creator. This wrapper temporarily owns a
///      fresh one-owner Safe, has that Safe call `TrustGraphFactory.createInstance`, installs the
///      snapshot-specific governance module, and finally replaces itself with the caller as the
///      Safe's initial break-glass signer. Targets therefore see the Safe — never this wrapper or
///      the creator EOA — as `msg.sender`, and `TrustGraphParamsController.owner()` is correct from
///      version one onward.
contract GovernedTrustGraphFactory {
    address internal constant SENTINEL_OWNERS = address(0x1);

    TrustGraphFactory public immutable FACTORY;
    GnosisSafeProxyFactory public immutable SAFE_FACTORY;
    address public immutable SAFE_SINGLETON;

    error ZeroAddress();
    error SafeFundingFailed();
    error SafeExecutionFailed(address target, bytes data);
    error InstanceDiscoveryFailed(bytes32 instanceId);

    event GovernedInstanceCreated(
        bytes32 indexed instanceId,
        address indexed creator,
        address indexed safe,
        address merkleGovModule,
        address snapshot
    );

    constructor(TrustGraphFactory factory_, GnosisSafeProxyFactory safeFactory_, address safeSingleton_) {
        if (address(factory_) == address(0) || address(safeFactory_) == address(0) || safeSingleton_ == address(0)) {
            revert ZeroAddress();
        }
        FACTORY = factory_;
        SAFE_FACTORY = safeFactory_;
        SAFE_SINGLETON = safeSingleton_;
    }

    /// @notice Create one DAO-governed trust graph. `requested.admin` is deliberately ignored:
    ///         the newly-created Safe is the instance admin, controller owner and fund owner.
    function createGovernedInstance(TrustGraphFactory.CreateArgs calldata requested)
        external
        payable
        returns (bytes32 instanceId, address safeAddress, address merkleGovModule, address snapshot)
    {
        GnosisSafe safe = _createBootstrapSafe(msg.sender, requested.name, requested.salt);
        safeAddress = address(safe);

        TrustGraphFactory.CreateArgs memory args = requested;
        args.admin = safeAddress;

        if (msg.value != 0) {
            (bool funded,) = payable(safeAddress).call{value: msg.value}("");
            if (!funded) revert SafeFundingFailed();
        }

        _execSafe(safe, address(FACTORY), msg.value, abi.encodeCall(TrustGraphFactory.createInstance, (args)));

        // The Safe is the actual factory caller, hence part of the canonical instance id.
        instanceId = FACTORY.computeInstanceId(safeAddress, args.name, args.salt);
        IInstanceRegistry.Instance memory record = FACTORY.INSTANCE_REGISTRY().getInstance(instanceId);
        snapshot = record.snapshot;
        if (snapshot == address(0)) revert InstanceDiscoveryFailed(instanceId);

        MerkleGovModule module = new MerkleGovModule(safeAddress, safeAddress, safeAddress, snapshot);
        merkleGovModule = address(module);

        // Both calls must originate from the Safe: it owns its own module list and holds the new
        // snapshot's constitutional role from the instant the base factory returns.
        _execSafe(safe, safeAddress, 0, abi.encodeWithSignature("enableModule(address)", merkleGovModule));
        _execSafe(safe, snapshot, 0, abi.encodeCall(MerkleSnapshot.addHook, (IMerkleSnapshotHook(merkleGovModule))));

        // The wrapper existed only to finish same-transaction setup. The creator becomes the
        // initial Safe signer; community governance can execute immediately through the enabled
        // module once the first score root supplies voting power.
        _execSafe(
            safe,
            safeAddress,
            0,
            abi.encodeWithSignature("swapOwner(address,address,address)", SENTINEL_OWNERS, address(this), msg.sender)
        );

        emit GovernedInstanceCreated(instanceId, msg.sender, safeAddress, merkleGovModule, snapshot);
    }

    function _createBootstrapSafe(address creator, string calldata name, bytes32 salt)
        internal
        returns (GnosisSafe safe)
    {
        address[] memory owners = new address[](1);
        owners[0] = address(this);
        bytes memory initializer = abi.encodeWithSignature(
            "setup(address[],uint256,address,bytes,address,address,uint256,address)",
            owners,
            1,
            address(0),
            bytes(""),
            address(0),
            address(0),
            0,
            address(0)
        );
        uint256 nonce = uint256(keccak256(abi.encode(block.chainid, creator, name, salt)));
        safe = GnosisSafe(payable(SAFE_FACTORY.createProxyWithNonce(SAFE_SINGLETON, initializer, nonce)));
    }

    function _execSafe(GnosisSafe safe, address target, uint256 value, bytes memory data) internal {
        bool success = safe.execTransaction(
            target,
            value,
            data,
            Enum.Operation.Call,
            0,
            0,
            0,
            address(0),
            payable(address(0)),
            _approvedSignature(address(this))
        );
        if (!success) revert SafeExecutionFailed(target, data);
    }

    /// @dev Safe v1.3 approved-hash signature. During bootstrap this contract is the sole owner
    ///      and the direct `execTransaction` caller, so v=1 authorizes the call without an ECDSA
    ///      private key or a persistent privileged entry point.
    function _approvedSignature(address signer) internal pure returns (bytes memory) {
        return abi.encodePacked(uint256(uint160(signer)), uint256(0), uint8(1));
    }
}
