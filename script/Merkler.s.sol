// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

import {stdJson} from "forge-std/StdJson.sol";
import {console} from "forge-std/console.sol";

import {Common} from "script/Common.s.sol";

import {MerkleSnapshot} from "contracts/merkle/MerkleSnapshot.sol";
import {MerkleFundDistributor} from "contracts/merkle/MerkleFundDistributor.sol";

/// @dev Combined script to update merkle tree and claim rewards
contract Merkler is Common {
    using stdJson for string;

    /// @dev Update merkle tree by adding a trigger
    /// @param merkleSnapshotAddr Address of the MerkleSnapshot contract
    function updateMerkle(string calldata merkleSnapshotAddr) public {
        vm.startBroadcast(_privateKey);
        MerkleSnapshot merkleSnapshot = MerkleSnapshot(payable(vm.parseAddress(merkleSnapshotAddr)));

        uint256 checkpointId = merkleSnapshot.trigger();
        console.log("CheckpointId", checkpointId);
        vm.stopBroadcast();
    }

    /// @dev Claim rewards using merkle proof
    /// @param merkleFundDistributorAddr Address of the MerkleFundDistributor contract
    function claimRewards(string calldata merkleFundDistributorAddr, uint256 distributionIndex) public {
        vm.startBroadcast(_privateKey);
        MerkleFundDistributor merkleFundDistributor =
            MerkleFundDistributor(payable(vm.parseAddress(merkleFundDistributorAddr)));

        MerkleFundDistributor.DistributionState memory distribution =
            merkleFundDistributor.getDistribution(distributionIndex);

        // access IPFS_GATEWAY_URL from env
        string memory ipfsGatewayUrl = vm.envString("IPFS_GATEWAY_URL");
        string memory url = string.concat(ipfsGatewayUrl, distribution.ipfsHashCid);

        // Get the claimer address first
        address claimer = vm.addr(_privateKey);

        console.log("Merkle data URL: ", url);
        console.log("Claiming rewards...");
        // console.log(string.concat("curl -s -X GET ", url, " | jq -c .tree[0]"));

        // Query for the merkle entry for this specific claimer
        string memory claimerStr = vm.toString(claimer);
        // Use case-insensitive comparison by lowercasing both addresses
        string memory entry = runCmd(
            string.concat(
                "claimerLower=$(echo '",
                claimerStr,
                "' | tr '[:upper:]' '[:lower:]'); curl -s -X GET ",
                url,
                ' | jq -c ".tree[] | select(.account == \\"$claimerLower\\")"'
            )
        );

        // Check if entry was found
        if (bytes(entry).length == 0) {
            console.log("No rewards found for address:", claimer);
            vm.stopBroadcast();
            return;
        }

        // Extract the claimable amount and proof
        uint256 value = vm.parseJsonUint(entry, ".value");
        bytes32[] memory proof = vm.parseJsonBytes32Array(entry, ".proof");

        console.log("Claimer:", claimer);
        console.log("Merkle Value:", value);

        // Claim rewards with proof
        uint256 balanceBefore = address(claimer).balance;
        uint256 claimed = merkleFundDistributor.claim(distributionIndex, claimer, value, proof);
        uint256 balanceAfter = address(claimer).balance;

        console.log("Balance before:", balanceBefore);
        console.log("Balance after:", balanceAfter);
        console.log("Claimed:", claimed);

        vm.stopBroadcast();
    }

    /// @dev Combined function to update rewards and then claim them
    /// @param merkleSnapshotAddr Address of the MerkleSnapshot contract
    /// @param merkleFundDistributorAddr Address of the MerkleFundDistributor contract
    /// @param distributionIndex Index of the distribution
    function updateAndClaimRewards(
        string calldata merkleSnapshotAddr,
        string calldata merkleFundDistributorAddr,
        uint256 distributionIndex
    ) public {
        updateMerkle(merkleSnapshotAddr);
        claimRewards(merkleFundDistributorAddr, distributionIndex);
    }

    /// @dev Query current contract state information
    /// @param merkleFundDistributorAddr Address of the MerkleFundDistributor contract
    function queryContractState(string calldata merkleFundDistributorAddr, uint256 distributionIndex) public view {
        MerkleFundDistributor merkleFundDistributor =
            MerkleFundDistributor(payable(vm.parseAddress(merkleFundDistributorAddr)));

        MerkleFundDistributor.DistributionState memory distribution =
            merkleFundDistributor.getDistribution(distributionIndex);
        console.log("=== Distribution", distributionIndex, "===");
        console.log("Block Number:", distribution.blockNumber);
        console.log("Timestamp:", distribution.timestamp);
        console.log("Root:");
        console.logBytes32(distribution.root);
        console.log("IPFS Hash:");
        console.logBytes32(distribution.ipfsHash);
        console.log("IPFS Hash CID:");
        console.log(distribution.ipfsHashCid);
        console.log("Total Merkle Value:", distribution.totalMerkleValue);
        console.log("Distributor:", distribution.distributor);
        console.log("Token:", distribution.token);
        console.log("Amount Funded:", distribution.amountFunded);
        console.log("Amount Distributed:", distribution.amountDistributed);
        console.log("Fee Recipient:", distribution.feeRecipient);
        console.log("Fee Amount:", distribution.feeAmount);
        console.log("=====================");
    }

    /// @dev Get the IPFS URI for the current merkle tree
    /// @param merkleFundDistributorAddr Address of the MerkleFundDistributor contract
    /// @param distributionIndex Index of the distribution
    function getIpfsUri(string calldata merkleFundDistributorAddr, uint256 distributionIndex)
        public
        view
        returns (string memory)
    {
        MerkleFundDistributor merkleFundDistributor =
            MerkleFundDistributor(payable(vm.parseAddress(merkleFundDistributorAddr)));

        MerkleFundDistributor.DistributionState memory distribution =
            merkleFundDistributor.getDistribution(distributionIndex);
        string memory ipfsGatewayUrl = vm.envString("IPFS_GATEWAY_URL");
        string memory uri = string.concat(ipfsGatewayUrl, distribution.ipfsHashCid);

        console.log("IPFS URI:", uri);
        return uri;
    }

    /// @dev Query claim status for an address
    /// @param merkleFundDistributorAddr Address of the MerkleFundDistributor contract
    /// @param distributionIndex Index of the distribution
    /// @param account Address to check claim status for
    function queryClaimStatus(
        string calldata merkleFundDistributorAddr,
        uint256 distributionIndex,
        string calldata account
    ) public view {
        MerkleFundDistributor merkleFundDistributor =
            MerkleFundDistributor(payable(vm.parseAddress(merkleFundDistributorAddr)));

        address accountAddr = vm.parseAddress(account);

        uint256 claimedAmount = merkleFundDistributor.claimed(distributionIndex, accountAddr);

        console.log("=== Claim Status ===");
        console.log("Account:", accountAddr);
        console.log("Already Claimed:", claimedAmount);
        console.log("===================");
    }

    /// @dev Get current balance of reward tokens for an address
    /// @param account Address to check balance for
    function queryBalance(string calldata account) public view {
        address accountAddr = vm.parseAddress(account);

        uint256 balance = address(accountAddr).balance;

        console.log("=== Token Balance ===");
        console.log("Account:", accountAddr);
        console.log("Balance:", balance);
        console.log("====================");
    }

    /// @dev Comprehensive query of all relevant information
    /// @param merkleFundDistributorAddr Address of the MerkleFundDistributor contract
    /// @param account Address to check information for
    function queryAll(string calldata merkleFundDistributorAddr, uint256 distributionIndex, string calldata account)
        public
        view
    {
        console.log("=== COMPREHENSIVE QUERY ===");
        console.log("");

        queryContractState(merkleFundDistributorAddr, distributionIndex);
        console.log("");

        getIpfsUri(merkleFundDistributorAddr, distributionIndex);
        console.log("");

        queryBalance(account);
        console.log("");

        queryClaimStatus(merkleFundDistributorAddr, distributionIndex, account);
        console.log("");

        console.log("=== END COMPREHENSIVE QUERY ===");
    }

    // Run a command and return the output by creating a temporary script with
    // the entire command and running it via bash. This gets around the limits
    // of FFI, such as not being able to pipe between two commands.
    function runCmd(string memory cmd) internal returns (string memory) {
        string memory script = string.concat(vm.projectRoot(), "/.ffirun.sh");
        // Save the cmd to a file
        vm.writeFile(script, cmd);
        // Run the cmd
        string[] memory exec = new string[](2);
        exec[0] = "bash";
        exec[1] = script;
        string memory result = string(vm.ffi(exec));
        // Delete the file
        vm.removeFile(script);
        // Return the result
        return result;
    }
}
