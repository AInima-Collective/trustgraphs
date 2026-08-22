// SPDX-License-Identifier: MIT

pragma solidity 0.8.27;

import {MessageHashUtils} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ShortString, ShortStrings} from "@openzeppelin/contracts/utils/ShortStrings.sol";

/// @title EIP712Verifier
/// @notice EIP712 verifier that supports receiving the target aggress
abstract contract EIP712Verifier {
    using ShortStrings for *;

    bytes32 private constant TYPE_HASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");

    address private immutable TARGET;

    // Cache the domain separator as an immutable value, but also store the chain id that it corresponds to, in order to
    // invalidate the cached domain separator if the chain id changes.
    bytes32 private immutable CACHED_DOMAIN_SEPARATOR;
    uint256 private immutable CACHED_CHAIN_ID;
    address private immutable CACHED_THIS;

    bytes32 private immutable HASHEDNAME;
    bytes32 private immutable HASHED_VERSION;

    ShortString private immutable NAME;
    ShortString private immutable VERSION;

    /// @dev Initializes the domain separator and parameter caches.
    constructor(string memory name, string memory version, address target) {
        TARGET = target;

        NAME = name.toShortString();
        VERSION = version.toShortString();
        HASHEDNAME = keccak256(bytes(name));
        HASHED_VERSION = keccak256(bytes(version));

        CACHED_CHAIN_ID = block.chainid;
        CACHED_DOMAIN_SEPARATOR = _buildDomainSeparator();
        CACHED_THIS = address(this);
    }

    /// @dev Returns the domain separator for the current chain and for a specific target.
    function _domainSeparatorV4() internal view returns (bytes32) {
        if (address(this) == CACHED_THIS && block.chainid == CACHED_CHAIN_ID) {
            return CACHED_DOMAIN_SEPARATOR;
        }

        return _buildDomainSeparator();
    }

    /// @dev Builds the domain separator for the current chain and for a specific target.
    function _buildDomainSeparator() private view returns (bytes32) {
        return keccak256(abi.encode(TYPE_HASH, HASHEDNAME, HASHED_VERSION, block.chainid, TARGET));
    }

    /// @dev Given an already hashed struct, this function returns the hash of the fully encoded EIP712 message for this
    /// domain.
    /// @param structHash The hashed struct to verify.
    function _hashTypedDataV4(bytes32 structHash) internal view virtual returns (bytes32) {
        return MessageHashUtils.toTypedDataHash(_domainSeparatorV4(), structHash);
    }
}
