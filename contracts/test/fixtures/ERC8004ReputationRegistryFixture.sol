// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IERC8004IdentityFixture {
    function isAuthorizedOrOwner(address spender, uint256 agentId) external view returns (bool);
}

/// @notice Minimal event-compatible local fixture. It is never deployed by production scripts.
contract ERC8004ReputationRegistryFixture {
    event NewFeedback(
        uint256 indexed agentId,
        address indexed clientAddress,
        uint64 feedbackIndex,
        int128 value,
        uint8 valueDecimals,
        string indexed indexedTag1,
        string tag1,
        string tag2,
        string endpoint,
        string feedbackURI,
        bytes32 feedbackHash
    );
    event FeedbackRevoked(uint256 indexed agentId, address indexed clientAddress, uint64 indexed feedbackIndex);
    event ResponseAppended(
        uint256 indexed agentId,
        address indexed clientAddress,
        uint64 feedbackIndex,
        address indexed responder,
        string responseURI,
        bytes32 responseHash
    );
    event Upgraded(address indexed implementation);
    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

    struct Feedback {
        int128 value;
        uint8 valueDecimals;
        string tag1;
        string tag2;
        bool revoked;
    }

    address public immutable identityRegistry;
    address public owner;
    mapping(uint256 => mapping(address => uint64)) public lastIndex;
    mapping(uint256 => mapping(address => mapping(uint64 => Feedback))) private feedback;
    mapping(uint256 => mapping(address => mapping(uint64 => uint64))) public responseCount;

    constructor(address identityRegistry_) {
        identityRegistry = identityRegistry_;
        owner = msg.sender;
        emit Upgraded(address(this));
        emit OwnershipTransferred(address(0), msg.sender);
    }

    function getIdentityRegistry() external view returns (address) {
        return identityRegistry;
    }

    function getVersion() external pure returns (string memory) {
        return "fixture-2.0.0";
    }

    function giveFeedback(
        uint256 agentId,
        int128 value,
        uint8 valueDecimals,
        string calldata tag1,
        string calldata tag2,
        string calldata endpoint,
        string calldata feedbackURI,
        bytes32 feedbackHash
    ) external {
        require(valueDecimals <= 18, "too many decimals");
        require(!IERC8004IdentityFixture(identityRegistry).isAuthorizedOrOwner(msg.sender, agentId), "self feedback");
        uint64 index = ++lastIndex[agentId][msg.sender];
        feedback[agentId][msg.sender][index] = Feedback(value, valueDecimals, tag1, tag2, false);
        emit NewFeedback(
            agentId, msg.sender, index, value, valueDecimals, tag1, tag1, tag2, endpoint, feedbackURI, feedbackHash
        );
    }

    function revokeFeedback(uint256 agentId, uint64 feedbackIndex) external {
        Feedback storage item = feedback[agentId][msg.sender][feedbackIndex];
        require(feedbackIndex > 0 && feedbackIndex <= lastIndex[agentId][msg.sender], "unknown feedback");
        require(!item.revoked, "already revoked");
        item.revoked = true;
        emit FeedbackRevoked(agentId, msg.sender, feedbackIndex);
    }

    function appendResponse(
        uint256 agentId,
        address clientAddress,
        uint64 feedbackIndex,
        string calldata responseURI,
        bytes32 responseHash
    ) external {
        require(feedbackIndex > 0 && feedbackIndex <= lastIndex[agentId][clientAddress], "unknown feedback");
        responseCount[agentId][clientAddress][feedbackIndex]++;
        emit ResponseAppended(agentId, clientAddress, feedbackIndex, msg.sender, responseURI, responseHash);
    }

    function readFeedback(uint256 agentId, address clientAddress, uint64 feedbackIndex)
        external
        view
        returns (int128 value, uint8 valueDecimals, string memory tag1, string memory tag2, bool revoked)
    {
        Feedback storage item = feedback[agentId][clientAddress][feedbackIndex];
        return (item.value, item.valueDecimals, item.tag1, item.tag2, item.revoked);
    }
}
