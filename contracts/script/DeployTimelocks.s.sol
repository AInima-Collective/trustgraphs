// SPDX-License-Identifier: MIT
pragma solidity ^0.8.22;

import {stdJson} from "forge-std/StdJson.sol";
import {console} from "forge-std/console.sol";
import {Strings} from "@openzeppelin/contracts/utils/Strings.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";

import {MerkleSnapshot} from "src/merkle/MerkleSnapshot.sol";

import {Common} from "script/Common.s.sol";

/// @dev OpenZeppelin's constructor grants every proposer `CANCELLER_ROLE`. This constructor keeps
///      the standard controller implementation and self-admin model but assigns the two duties
///      independently from the first block. No temporary external admin or post-deploy role
///      mutation is needed.
contract RoleSeparatedTimelockController is TimelockController {
    error ZeroProposer();
    error ZeroCanceller();
    error ProposerIsCanceller(address account);

    constructor(uint256 minDelay, address proposer, address canceller, address[] memory executors)
        TimelockController(minDelay, new address[](0), executors, address(0))
    {
        if (proposer == address(0)) revert ZeroProposer();
        if (canceller == address(0)) revert ZeroCanceller();
        if (proposer == canceller) revert ProposerIsCanceller(proposer);
        _grantRole(PROPOSER_ROLE, proposer);
        _grantRole(CANCELLER_ROLE, canceller);
    }
}

/// @title DeployTimelocks
/// @notice Deploys the two-tier governance timelocks for a legacy/raw-role `MerkleSnapshot` and performs the
///         bootstrap → handoff: grant the roles to the timelocks, then have the deployer renounce
///         them so ONLY the timelocks retain authority (DECISIONS D7).
/// @dev Factory-created trust graphs do not use this script for scoring authority: their snapshot's
///      operational role belongs permanently to `TrustgraphsParamsController`. Use
///      `DeployParamsTimelock.s.sol` to transfer that controller's two-step ownership instead.
///
///  - CONSTITUTIONAL timelock (long delay, default 14 days) → holds `CONSTITUTIONAL_ROLE`
///    (owns `zkVerifier`, `accumulator`, hooks — "what is correct PageRank").
///  - OPERATIONAL timelock (short delay, default 2 days) → holds `OPERATIONAL_ROLE`
///    (owns `paramsHash`).
///
/// Lockout guard: roles are GRANTED to the timelocks and the grants are VERIFIED before the deployer
/// renounces anything. If a grant somehow failed, the script reverts before the deployer gives up
/// authority, so the contract can never be left ungoverned.
contract DeployTimelocks is Common {
    using stdJson for string;

    string public root = vm.projectRoot();

    /// @dev Default minimum delays for the two tiers (overridable via run() params).
    uint256 public constant DEFAULT_CONSTITUTIONAL_DELAY = 14 days;
    uint256 public constant DEFAULT_OPERATIONAL_DELAY = 2 days;

    /// @notice Deploy + wire timelocks for one or more networks' `MerkleSnapshot` contracts.
    /// @param constitutionalProposerAddr Proposer for the constitutional timelock. If empty,
    ///        defaults to the deployer.
    /// @param constitutionalCancellerAddr Independent constitutional brake. Required and must not
    ///        equal the constitutional proposer.
    /// @param operationalProposerAddr Proposer for the operational timelock. If empty, defaults to
    ///        the deployer.
    /// @param operationalCancellerAddr Independent operational brake. Required and must not equal
    ///        the operational proposer.
    /// @param executorAddr Executor for BOTH timelocks. If empty, defaults to the deployer. Pass the
    ///        zero address explicitly (`0x0000...0000`) to allow open (permissionless) execution.
    /// @param constitutionalDelay Min delay for the constitutional timelock; 0 → 14 days.
    /// @param operationalDelay Min delay for the operational timelock; 0 → 2 days.
    /// @param env The environment suffix used to locate `config/network_deploy_<env>_<i>.json`.
    /// @param firstIndex The index of the first network to wire.
    /// @param count How many networks to wire.
    function run(
        string calldata constitutionalProposerAddr,
        string calldata constitutionalCancellerAddr,
        string calldata operationalProposerAddr,
        string calldata operationalCancellerAddr,
        string calldata executorAddr,
        uint256 constitutionalDelay,
        uint256 operationalDelay,
        string calldata env,
        uint256 firstIndex,
        uint256 count
    ) public {
        address deployer = vm.addr(_privateKey);

        address constitutionalProposer =
            bytes(constitutionalProposerAddr).length == 0 ? deployer : vm.parseAddress(constitutionalProposerAddr);
        require(bytes(constitutionalCancellerAddr).length != 0, "DeployTimelocks: constitutional canceller required");
        address constitutionalCanceller = vm.parseAddress(constitutionalCancellerAddr);
        address operationalProposer =
            bytes(operationalProposerAddr).length == 0 ? deployer : vm.parseAddress(operationalProposerAddr);
        require(bytes(operationalCancellerAddr).length != 0, "DeployTimelocks: operational canceller required");
        address operationalCanceller = vm.parseAddress(operationalCancellerAddr);
        // An empty string defaults to the deployer; an explicit zero address enables open execution.
        address executor = bytes(executorAddr).length == 0 ? deployer : vm.parseAddress(executorAddr);

        uint256 constDelay = constitutionalDelay == 0 ? DEFAULT_CONSTITUTIONAL_DELAY : constitutionalDelay;
        uint256 opDelay = operationalDelay == 0 ? DEFAULT_OPERATIONAL_DELAY : operationalDelay;

        for (uint256 i = firstIndex; i < firstIndex + count; i++) {
            address merkleSnapshotAddr = _readMerkleSnapshot(env, i);
            require(merkleSnapshotAddr != address(0), "DeployTimelocks: merkle_snapshot missing");

            vm.startBroadcast(_privateKey);

            // --- Deploy the two timelocks (self-administered: no external admin backdoor). ---
            // OpenZeppelin grants DEFAULT_ADMIN_ROLE to each timelock itself. The derived
            // constructor deliberately bypasses OZ's proposer=>canceller coupling, so role changes
            // remain possible only as delayed calls to the timelock, while a proposer cannot veto
            // the proposal that removes it.
            address[] memory executors = new address[](1);
            executors[0] = executor;

            TimelockController constitutionalTimelock = new RoleSeparatedTimelockController(
                constDelay, constitutionalProposer, constitutionalCanceller, executors
            );
            TimelockController operationalTimelock =
                new RoleSeparatedTimelockController(opDelay, operationalProposer, operationalCanceller, executors);

            // --- Grant the MerkleSnapshot roles to the timelocks (deployer still holds them). ---
            MerkleSnapshot merkleSnapshot = MerkleSnapshot(merkleSnapshotAddr);
            bytes32 constitutionalRole = merkleSnapshot.CONSTITUTIONAL_ROLE();
            bytes32 operationalRole = merkleSnapshot.OPERATIONAL_ROLE();

            merkleSnapshot.grantRole(constitutionalRole, address(constitutionalTimelock));
            merkleSnapshot.grantRole(operationalRole, address(operationalTimelock));

            // --- LOCKOUT GUARD: verify the timelocks hold their roles BEFORE renouncing. ---
            require(
                merkleSnapshot.hasRole(constitutionalRole, address(constitutionalTimelock)),
                "DeployTimelocks: constitutional grant failed"
            );
            require(
                merkleSnapshot.hasRole(operationalRole, address(operationalTimelock)),
                "DeployTimelocks: operational grant failed"
            );

            // --- Handoff: deployer renounces both roles so only the timelocks retain authority. ---
            merkleSnapshot.renounceRole(constitutionalRole, deployer);
            merkleSnapshot.renounceRole(operationalRole, deployer);

            vm.stopBroadcast();

            // --- Post-conditions: deployer holds neither role; timelocks hold theirs. ---
            require(
                !merkleSnapshot.hasRole(constitutionalRole, deployer)
                    && !merkleSnapshot.hasRole(operationalRole, deployer),
                "DeployTimelocks: deployer still privileged"
            );

            console.log("Network", i, "MerkleSnapshot:", merkleSnapshotAddr);
            console.log("  Constitutional timelock:", address(constitutionalTimelock));
            console.log("  Operational timelock:   ", address(operationalTimelock));

            _writeOutput(
                env,
                i,
                address(constitutionalTimelock),
                address(operationalTimelock),
                constDelay,
                opDelay,
                constitutionalProposer,
                constitutionalCanceller,
                operationalProposer,
                operationalCanceller,
                executor
            );
        }
    }

    /// @dev Read the deployed `MerkleSnapshot` address from the network deploy JSON.
    function _readMerkleSnapshot(string memory env, uint256 index) internal view returns (address) {
        string memory networkDeployPath =
            string.concat(root, "/config/network_deploy_", env, "_", Strings.toString(index), ".json");
        string memory json = vm.readFile(networkDeployPath);
        return json.readAddress(".contracts.merkle_snapshot");
    }

    /// @dev Persist the deployed timelocks for the deploy orchestration.
    function _writeOutput(
        string memory env,
        uint256 index,
        address constitutionalTimelock,
        address operationalTimelock,
        uint256 constDelay,
        uint256 opDelay,
        address constitutionalProposer,
        address constitutionalCanceller,
        address operationalProposer,
        address operationalCanceller,
        address executor
    ) internal {
        string memory outputPath = string.concat(
            root, "/config/timelocks_deploy_", env, "_", Strings.toString(index), ".json"
        );

        string memory _json = "timelocks";
        _json.serialize("constitutional_timelock", Strings.toChecksumHexString(constitutionalTimelock));
        _json.serialize("operational_timelock", Strings.toChecksumHexString(operationalTimelock));
        _json.serialize("constitutional_delay", Strings.toString(constDelay));
        _json.serialize("operational_delay", Strings.toString(opDelay));
        _json.serialize("constitutional_proposer", Strings.toChecksumHexString(constitutionalProposer));
        _json.serialize("constitutional_canceller", Strings.toChecksumHexString(constitutionalCanceller));
        _json.serialize("operational_proposer", Strings.toChecksumHexString(operationalProposer));
        _json.serialize("operational_canceller", Strings.toChecksumHexString(operationalCanceller));
        string memory finalJson = _json.serialize("executor", Strings.toChecksumHexString(executor));
        vm.writeFile(outputPath, finalJson);
    }
}
