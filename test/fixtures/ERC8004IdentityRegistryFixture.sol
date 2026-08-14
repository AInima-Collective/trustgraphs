// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal event-compatible local fixture. It is never deployed by production scripts.
contract ERC8004IdentityRegistryFixture {
    event Registered(uint256 indexed agentId, string agentURI, address indexed owner);
    event URIUpdated(uint256 indexed agentId, string newURI, address indexed updatedBy);
    event MetadataSet(
        uint256 indexed agentId, string indexed indexedMetadataKey, string metadataKey, bytes metadataValue
    );
    event Transfer(address indexed from, address indexed to, uint256 indexed tokenId);

    uint256 private nextId;
    mapping(uint256 => address) public ownerOf;
    mapping(uint256 => address) public getAgentWallet;
    mapping(uint256 => string) public tokenURI;

    function getVersion() external pure returns (string memory) {
        return "fixture-2.0.0";
    }

    function register(string calldata agentURI) external returns (uint256 agentId) {
        agentId = nextId++;
        ownerOf[agentId] = msg.sender;
        getAgentWallet[agentId] = msg.sender;
        tokenURI[agentId] = agentURI;
        emit Transfer(address(0), msg.sender, agentId);
        emit Registered(agentId, agentURI, msg.sender);
        emit MetadataSet(agentId, "agentWallet", "agentWallet", abi.encodePacked(msg.sender));
    }

    function setAgentURI(uint256 agentId, string calldata newURI) external onlyAgentOwner(agentId) {
        tokenURI[agentId] = newURI;
        emit URIUpdated(agentId, newURI, msg.sender);
    }

    function setAgentWallet(uint256 agentId, address wallet) external onlyAgentOwner(agentId) {
        getAgentWallet[agentId] = wallet;
        emit MetadataSet(agentId, "agentWallet", "agentWallet", abi.encodePacked(wallet));
    }

    function unsetAgentWallet(uint256 agentId) external onlyAgentOwner(agentId) {
        getAgentWallet[agentId] = address(0);
        emit MetadataSet(agentId, "agentWallet", "agentWallet", "");
    }

    function transferFrom(address from, address to, uint256 agentId) external onlyAgentOwner(agentId) {
        require(from == msg.sender, "wrong from");
        require(to != address(0), "zero to");
        // Match the reference implementation's safety-critical order exactly.
        getAgentWallet[agentId] = address(0);
        emit MetadataSet(agentId, "agentWallet", "agentWallet", "");
        ownerOf[agentId] = to;
        emit Transfer(from, to, agentId);
    }

    modifier onlyAgentOwner(uint256 agentId) {
        require(ownerOf[agentId] == msg.sender, "not owner");
        _;
    }
}
