// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {IZkVerifier} from "interfaces/merkle/IZkVerifier.sol";
import {IAttestationAccumulator} from "interfaces/merkle/IAttestationAccumulator.sol";
import {MerkleSnapshot} from "contracts/merkle/MerkleSnapshot.sol";
import {MerkleFundDistributor} from "contracts/merkle/MerkleFundDistributor.sol";

/// @title MerkleSnapshotDeployer
/// @notice A one-per-chain singleton whose only job is to hold `MerkleSnapshot`'s creation code so
///         `TrustGraphFactory` doesn't have to.
/// @dev    Why this exists at all: a factory that deploys N child types carries every child's
///         creation code in its own RUNTIME bytecode. Resolver + snapshot + distributor initcode is
///         ~22.6 KB before the factory's own logic, which blows the 24,576-byte EIP-170 limit. The
///         two large children therefore get thin deployer singletons; the factory keeps only the
///         resolver.
///
///         Deploying through a helper is safe here because `MerkleSnapshot` takes both admins as
///         constructor arguments — nothing is derived from `msg.sender`, so this contract never
///         holds a role on anything it creates and is permissionless by design. Anyone may call it;
///         a snapshot that is not registered by the factory is simply an unlisted contract.
contract MerkleSnapshotDeployer {
    /// @notice Deploy a `MerkleSnapshot` with the given wiring and admins.
    /// @param verifier The proof verifier gating root updates (the shared `SP1JournalVerifier`).
    /// @param paramsHash The canonical params hash the guest must match.
    /// @param accumulator The instance's `EASIndexerResolver` (its attestation accumulator).
    /// @param constitutionalAdmin Holder of `CONSTITUTIONAL_ROLE` at birth (the factory, transiently).
    /// @param operationalAdmin Holder of `OPERATIONAL_ROLE` at birth (the instance admin).
    function deploy(
        IZkVerifier verifier,
        bytes32 paramsHash,
        IAttestationAccumulator accumulator,
        address constitutionalAdmin,
        address operationalAdmin
    ) external returns (MerkleSnapshot) {
        return new MerkleSnapshot(verifier, paramsHash, accumulator, constitutionalAdmin, operationalAdmin);
    }
}

/// @title MerkleFundDistributorDeployer
/// @notice The same trick for `MerkleFundDistributor` (see `MerkleSnapshotDeployer` for why).
/// @dev    Safe for the same reason: since the distributor's constructor sets `owner = owner_`
///         directly (docs/DEVIATIONS.md), this deployer is never the owner of what it deploys.
contract MerkleFundDistributorDeployer {
    /// @notice Deploy a `MerkleFundDistributor` owned by `owner`.
    /// @param owner The distributor's owner (the instance admin), set outright — no pending transfer.
    /// @param merkleSnapshot The snapshot whose proven root gates claims.
    /// @param feeRecipient Where the distribution fee goes.
    /// @param feePercentage The fee taken from each distribution (1e18 = 100%).
    /// @param allowlistEnabled Whether only allowlisted addresses may fund distributions.
    function deploy(
        address owner,
        address merkleSnapshot,
        address feeRecipient,
        uint256 feePercentage,
        bool allowlistEnabled
    ) external returns (MerkleFundDistributor) {
        return new MerkleFundDistributor(owner, merkleSnapshot, feeRecipient, feePercentage, allowlistEnabled);
    }
}
