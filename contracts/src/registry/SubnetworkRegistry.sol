// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

import {IInstanceRegistry} from "interfaces/registry/IInstanceRegistry.sol";
import {ISubnetworkRegistry} from "interfaces/registry/ISubnetworkRegistry.sol";

/// @title SubnetworkRegistry
/// @notice Records consented organizational relationships between trustgraphs instances.
/// @dev A link is metadata, not proof that the parent still controls the child. Consumers must
///      verify any live power instrument independently. Authorities are resolved on every write,
///      so controller ownership rotation does not orphan a pending or accepted relationship.
contract SubnetworkRegistry is ISubnetworkRegistry, AccessControl {
    /// @notice Creation factories may collapse claim and acceptance into one transaction.
    bytes32 public constant REGISTRAR_ROLE = keccak256("REGISTRAR_ROLE");

    /// @notice A child may have at most sixteen accepted ancestors.
    uint256 public constant MAXIMUM_DEPTH = 16;

    IInstanceRegistry public immutable INSTANCE_REGISTRY;

    mapping(bytes32 childInstanceId => bytes32 parentInstanceId) public parentOf;
    mapping(bytes32 childInstanceId => bytes32 parentInstanceId) public pendingParentOf;

    /// @notice Longest accepted descendant path, measured in edges. Leaves have height zero.
    mapping(bytes32 instanceId => uint8 height) public subtreeHeight;
    // Counts by direct child's subtree height let releases recompute heights without enumerating
    // descendants or an unbounded number of siblings. All mutation work is bounded by 16 levels.
    mapping(bytes32 instanceId => mapping(uint8 childHeight => uint256 count)) private _childHeightCounts;

    constructor(IInstanceRegistry instanceRegistry_, address admin) {
        if (address(instanceRegistry_) == address(0) || admin == address(0)) revert ZeroAddress();
        INSTANCE_REGISTRY = instanceRegistry_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    /// @inheritdoc ISubnetworkRegistry
    function claimParent(bytes32 childInstanceId, bytes32 parentInstanceId) external {
        _requireAvailableChild(childInstanceId);
        if (childInstanceId == parentInstanceId) revert SelfParent(childInstanceId);

        address childAuthority = _authorityOf(childInstanceId);
        _authorityOf(parentInstanceId);
        if (msg.sender != childAuthority) {
            revert Unauthorized(childInstanceId, msg.sender, childAuthority);
        }

        _validateHierarchy(childInstanceId, parentInstanceId);
        pendingParentOf[childInstanceId] = parentInstanceId;
        emit ParentClaimed(childInstanceId, parentInstanceId, childAuthority);
    }

    /// @inheritdoc ISubnetworkRegistry
    function acceptChild(bytes32 childInstanceId) external {
        bytes32 parentInstanceId = pendingParentOf[childInstanceId];
        if (parentInstanceId == bytes32(0)) revert NoPendingClaim(childInstanceId);

        address parentAuthority = _authorityOf(parentInstanceId);
        if (msg.sender != parentAuthority) {
            revert Unauthorized(parentInstanceId, msg.sender, parentAuthority);
        }

        // A different link may have landed since the claim, and the ancestry may have changed.
        bytes32 acceptedParent = parentOf[childInstanceId];
        if (acceptedParent != bytes32(0)) revert ParentAlreadySet(childInstanceId, acceptedParent);
        _authorityOf(childInstanceId);
        _validateHierarchy(childInstanceId, parentInstanceId);

        delete pendingParentOf[childInstanceId];
        parentOf[childInstanceId] = parentInstanceId;
        _updateAncestorHeights(parentInstanceId, subtreeHeight[childInstanceId], false, true);
        emit ChildAccepted(childInstanceId, parentInstanceId, parentAuthority);
    }

    /// @inheritdoc ISubnetworkRegistry
    function cancelParentClaim(bytes32 childInstanceId) external {
        bytes32 parentInstanceId = pendingParentOf[childInstanceId];
        if (parentInstanceId == bytes32(0)) revert NoPendingClaim(childInstanceId);

        address childAuthority = _authorityOf(childInstanceId);
        address parentAuthority = _authorityOf(parentInstanceId);
        if (msg.sender != childAuthority && msg.sender != parentAuthority) {
            revert NotClaimParticipant(childInstanceId, msg.sender, childAuthority, parentAuthority);
        }

        delete pendingParentOf[childInstanceId];
        emit ParentClaimCancelled(childInstanceId, parentInstanceId, msg.sender);
    }

    /// @inheritdoc ISubnetworkRegistry
    function registerSubnetwork(bytes32 childInstanceId, bytes32 parentInstanceId) external onlyRole(REGISTRAR_ROLE) {
        _requireAvailableChild(childInstanceId);
        if (childInstanceId == parentInstanceId) revert SelfParent(childInstanceId);
        _authorityOf(childInstanceId);
        _authorityOf(parentInstanceId);
        _validateHierarchy(childInstanceId, parentInstanceId);

        parentOf[childInstanceId] = parentInstanceId;
        _updateAncestorHeights(parentInstanceId, subtreeHeight[childInstanceId], false, true);
        emit SubnetworkRegistered(childInstanceId, parentInstanceId, msg.sender);
    }

    /// @inheritdoc ISubnetworkRegistry
    function release(bytes32 childInstanceId) external {
        bytes32 parentInstanceId = parentOf[childInstanceId];
        if (parentInstanceId == bytes32(0)) revert NoParent(childInstanceId);

        address parentAuthority = _authorityOf(parentInstanceId);
        if (msg.sender != parentAuthority) {
            revert Unauthorized(parentInstanceId, msg.sender, parentAuthority);
        }

        delete parentOf[childInstanceId];
        _updateAncestorHeights(parentInstanceId, subtreeHeight[childInstanceId], true, false);
        emit SubnetworkReleased(childInstanceId, parentInstanceId, parentAuthority);
    }

    /// @inheritdoc ISubnetworkRegistry
    function authorityOf(bytes32 instanceId) external view returns (address) {
        return _authorityOf(instanceId);
    }

    function _requireAvailableChild(bytes32 childInstanceId) internal view {
        bytes32 acceptedParent = parentOf[childInstanceId];
        if (acceptedParent != bytes32(0)) revert ParentAlreadySet(childInstanceId, acceptedParent);
        bytes32 pendingParent = pendingParentOf[childInstanceId];
        if (pendingParent != bytes32(0)) revert PendingClaimExists(childInstanceId, pendingParent);
    }

    /// @dev Resolve the authority as `paramsAuthority(instanceId).owner()`, falling back to the
    ///      params authority itself for legacy/bare authorities. This is the same dynamic seam the
    ///      former lineage registry established: a controller ownership transfer takes effect
    ///      immediately without rewriting the relationship.
    function _authorityOf(bytes32 instanceId) internal view returns (address authority) {
        if (!INSTANCE_REGISTRY.isRegistered(instanceId)) revert UnknownInstance(instanceId);
        address controller = INSTANCE_REGISTRY.paramsAuthority(instanceId);
        if (controller == address(0)) revert MissingAuthority(instanceId);

        authority = controller;
        (bool ok, bytes memory returned) = controller.staticcall(abi.encodeWithSignature("owner()"));
        if (ok && returned.length == 32) {
            address owner = abi.decode(returned, (address));
            if (owner != address(0)) authority = owner;
        }
    }

    /// @dev Bound the deepest existing descendant after the proposed link, not just the child.
    ///      Pending cycles and descendant changes serialize safely because acceptance revalidates.
    function _validateHierarchy(bytes32 childInstanceId, bytes32 parentInstanceId) internal view {
        bytes32 ancestor = parentInstanceId;
        uint256 height = subtreeHeight[childInstanceId];
        for (uint256 depth = 0; depth < MAXIMUM_DEPTH; ++depth) {
            if (ancestor == childInstanceId) revert CycleDetected(childInstanceId, parentInstanceId);
            if (height + depth + 1 > MAXIMUM_DEPTH) {
                revert MaximumDepthExceeded(childInstanceId, parentInstanceId, MAXIMUM_DEPTH);
            }
            ancestor = parentOf[ancestor];
            if (ancestor == bytes32(0)) return;
        }
        revert MaximumDepthExceeded(childInstanceId, parentInstanceId, MAXIMUM_DEPTH);
    }

    /// Propagate a direct-child insertion/removal through ancestors whose height actually changes.
    function _updateAncestorHeights(bytes32 ancestor, uint8 childHeight, bool remove, bool add) private {
        uint8 oldChildHeight = childHeight;
        uint8 newChildHeight = childHeight;
        while (ancestor != bytes32(0)) {
            if (remove) --_childHeightCounts[ancestor][oldChildHeight];
            if (add) ++_childHeightCounts[ancestor][newChildHeight];

            uint8 oldHeight = subtreeHeight[ancestor];
            uint8 newHeight;
            for (uint8 height = uint8(MAXIMUM_DEPTH); height != 0; --height) {
                if (_childHeightCounts[ancestor][height - 1] != 0) {
                    newHeight = height;
                    break;
                }
            }
            if (newHeight == oldHeight) return;
            subtreeHeight[ancestor] = newHeight;
            ancestor = parentOf[ancestor];
            oldChildHeight = oldHeight;
            newChildHeight = newHeight;
            remove = true;
            add = true;
        }
    }
}
