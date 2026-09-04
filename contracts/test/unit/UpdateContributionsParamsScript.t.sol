// SPDX-License-Identifier: MIT
pragma solidity 0.8.29;

import {Test} from "forge-std/Test.sol";

import {Safe} from "@safe-global/safe-smart-account/Safe.sol";
import {SafeProxyFactory} from "@safe-global/safe-smart-account/proxies/SafeProxyFactory.sol";

import {UpdateContributionsParams} from "script/UpdateContributionsParams.s.sol";
import {ContributionsParamsController} from "src/factory/ContributionsParamsController.sol";
import {ContributionsParamsCodec} from "src/params/ContributionsParamsCodec.sol";

contract MockContributionsParamsController {
    address public owner;
    uint64 public version = 1;
    bytes32 public currentParamsHash;
    address public lastCaller;
    bytes32 public lastEvidenceHash;

    error Unauthorized(address caller);

    constructor(address owner_) {
        owner = owner_;
    }

    function updateParams(ContributionsParamsCodec.Params calldata next, string calldata evidenceURI)
        external
        returns (uint64 newVersion, bytes32 newHash)
    {
        if (msg.sender != owner) revert Unauthorized(msg.sender);

        lastCaller = msg.sender;
        lastEvidenceHash = keccak256(bytes(evidenceURI));
        newVersion = ++version;
        newHash = ContributionsParamsCodec.hash(next);
        currentParamsHash = newHash;
    }
}

contract UpdateContributionsParamsHarness is UpdateContributionsParams {
    function updateForTest(
        ContributionsParamsController controller,
        ContributionsParamsCodec.Params memory next,
        string memory evidenceURI
    ) external returns (uint64 version, bytes32 paramsHash) {
        return _update(controller, next, evidenceURI, address(this));
    }
}

contract UpdateContributionsParamsScriptTest is Test {
    UpdateContributionsParamsHarness internal updater;
    Safe internal singleton;
    SafeProxyFactory internal safeFactory;

    function setUp() public {
        updater = new UpdateContributionsParamsHarness();
        singleton = new Safe();
        safeFactory = new SafeProxyFactory();
    }

    function test_DirectOwnerPublishesParams() public {
        MockContributionsParamsController mock = new MockContributionsParamsController(address(updater));
        ContributionsParamsCodec.Params memory next = _params();

        (uint64 version, bytes32 paramsHash) =
            updater.updateForTest(ContributionsParamsController(address(mock)), next, "local direct update");

        assertEq(version, 2);
        assertEq(paramsHash, ContributionsParamsCodec.hash(next));
        assertEq(mock.lastCaller(), address(updater));
    }

    function test_OneOfOneDevSafePublishesParamsAsSafe() public {
        Safe safe = _safe(address(updater));
        MockContributionsParamsController mock = new MockContributionsParamsController(address(safe));
        ContributionsParamsCodec.Params memory next = _params();

        (uint64 version, bytes32 paramsHash) =
            updater.updateForTest(ContributionsParamsController(address(mock)), next, "local Safe update");

        assertEq(version, 2);
        assertEq(paramsHash, ContributionsParamsCodec.hash(next));
        assertEq(mock.lastCaller(), address(safe));
        assertEq(mock.lastEvidenceHash(), keccak256("local Safe update"));
        assertEq(safe.nonce(), 1);
    }

    function test_RejectsUnrecognizedAuthorityInsteadOfBypassingIt() public {
        address authority = address(0xBEEF);
        MockContributionsParamsController mock = new MockContributionsParamsController(authority);

        vm.expectRevert(
            abi.encodeWithSelector(UpdateContributionsParams.UnsupportedParamsAuthority.selector, authority)
        );
        updater.updateForTest(ContributionsParamsController(address(mock)), _params(), "must not publish");
    }

    function test_RejectsMultisigSafeFromSingleKeyDevPath() public {
        address[] memory owners = new address[](2);
        owners[0] = address(updater);
        owners[1] = address(0xB0B);
        Safe safe = _safe(owners, 2, 2);
        MockContributionsParamsController mock = new MockContributionsParamsController(address(safe));

        vm.expectRevert(
            abi.encodeWithSelector(UpdateContributionsParams.DevSafeThresholdNotOne.selector, address(safe), uint256(2))
        );
        updater.updateForTest(ContributionsParamsController(address(mock)), _params(), "must use governance");
    }

    function _safe(address owner) internal returns (Safe safe) {
        address[] memory owners = new address[](1);
        owners[0] = owner;
        return _safe(owners, 1, 1);
    }

    function _safe(address[] memory owners, uint256 threshold, uint256 nonce) internal returns (Safe safe) {
        bytes memory initializer = abi.encodeWithSignature(
            "setup(address[],uint256,address,bytes,address,address,uint256,address)",
            owners,
            threshold,
            address(0),
            "",
            address(0),
            address(0),
            0,
            address(0)
        );
        safe = Safe(payable(safeFactory.createProxyWithNonce(address(singleton), initializer, nonce)));
    }

    function _params() internal pure returns (ContributionsParamsCodec.Params memory p) {
        p.trustedSeeds = new address[](1);
        p.trustedSeeds[0] = address(0xA11CE);
        p.totalPool = 5_000e6;
        p.roundStart = 1_700_000_000;
        p.roundEnd = 1_700_604_800;
        p.claimSchemaUid = keccak256("claim");
        p.responseSchemaUid = keccak256("response");
        p.valuationSchemaUid = keccak256("valuation");
    }
}
