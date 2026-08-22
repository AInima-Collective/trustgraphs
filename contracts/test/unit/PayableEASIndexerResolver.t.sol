// SPDX-License-Identifier: MIT
pragma solidity 0.8.27;

import {Test} from "forge-std/Test.sol";
import {PayableEASIndexerResolver} from "../../src/eas/resolvers/PayableEASIndexerResolver.sol";
import {EAS} from "@ethereum-attestation-service/eas-contracts/contracts/EAS.sol";
import {SchemaRegistry} from "@ethereum-attestation-service/eas-contracts/contracts/SchemaRegistry.sol";
import {
    IEAS,
    AttestationRequest,
    AttestationRequestData,
    RevocationRequest,
    RevocationRequestData,
    Attestation
} from "@ethereum-attestation-service/eas-contracts/contracts/IEAS.sol";
import {ISchemaRegistry} from "@ethereum-attestation-service/eas-contracts/contracts/SchemaRegistry.sol";

contract PayableEASIndexerResolverTest is Test {
    PayableEASIndexerResolver resolver;
    EAS eas;
    SchemaRegistry schemaRegistry;

    address owner = address(0x1);
    address attester1 = address(0x2);
    address attester2 = address(0x3);
    address recipient = address(0x4);
    address withdrawRecipient = address(0x5);

    bytes32 schemaUID;
    string constant SCHEMA = "string message";
    uint256 constant TARGET_VALUE = 0.001 ether;

    event TargetValueUpdated(uint256 previousValue, uint256 newValue);
    event FundsWithdrawn(address indexed recipient, uint256 amount);

    function setUp() public {
        vm.startPrank(owner);

        // Deploy EAS infrastructure
        schemaRegistry = new SchemaRegistry();
        eas = new EAS(ISchemaRegistry(address(schemaRegistry)));

        // Deploy resolver with target value
        resolver = new PayableEASIndexerResolver(IEAS(address(eas)), TARGET_VALUE, owner);

        // Register schema with resolver
        schemaUID = schemaRegistry.register(SCHEMA, resolver, true);

        vm.stopPrank();

        // Give test addresses some ETH
        vm.deal(attester1, 10 ether);
        vm.deal(attester2, 10 ether);
        vm.deal(withdrawRecipient, 1 ether);
    }

    function testConstruction_ShouldInitializeCorrectly() public view {
        assertEq(resolver.getTargetValue(), TARGET_VALUE);
        assertEq(resolver.owner(), owner);
        assertTrue(resolver.isPayable());
        assertEq(resolver.getBalance(), 0);
    }

    function testConstruction_ShouldRevertWithInvalidEAS() public {
        vm.expectRevert();
        new PayableEASIndexerResolver(IEAS(address(0)), TARGET_VALUE, owner);
    }

    function testIsPayable_ShouldAlwaysReturnTrue() public view {
        assertTrue(resolver.isPayable());
    }

    function testGetTargetValue_ShouldReturnCorrectValue() public view {
        assertEq(resolver.getTargetValue(), TARGET_VALUE);
    }

    function testSetTargetValue_ShouldUpdateValue() public {
        uint256 newValue = 0.002 ether;

        vm.prank(owner);
        vm.expectEmit(true, true, true, true);
        emit TargetValueUpdated(TARGET_VALUE, newValue);
        resolver.setTargetValue(newValue);

        assertEq(resolver.getTargetValue(), newValue);
    }

    function testSetTargetValue_ShouldAllowZeroValue() public {
        uint256 newValue = 0;

        vm.prank(owner);
        vm.expectEmit(true, true, true, true);
        emit TargetValueUpdated(TARGET_VALUE, newValue);
        resolver.setTargetValue(newValue);

        assertEq(resolver.getTargetValue(), newValue);
    }

    function testSetTargetValue_ShouldRevertWithNonOwner() public {
        vm.prank(attester1);
        vm.expectRevert();
        resolver.setTargetValue(0.002 ether);
    }

    function testGetBalance_ShouldReturnCorrectBalance() public view {
        assertEq(resolver.getBalance(), 0);
    }

    function testOnAttest_ShouldSucceedWithCorrectPayment() public {
        vm.prank(attester1);

        AttestationRequestData memory requestData = AttestationRequestData({
            recipient: recipient,
            expirationTime: 0,
            revocable: true,
            refUID: bytes32(0),
            data: abi.encode("test message"),
            value: TARGET_VALUE
        });

        AttestationRequest memory request = AttestationRequest({schema: schemaUID, data: requestData});

        bytes32 attestationUID = eas.attest{value: TARGET_VALUE}(request);

        // Verify attestation was created
        Attestation memory attestation = eas.getAttestation(attestationUID);
        assertEq(attestation.attester, attester1);
        assertEq(attestation.recipient, recipient);

        // Verify contract received payment
        assertEq(resolver.getBalance(), TARGET_VALUE);
    }

    function testOnAttest_ShouldFailWithIncorrectPayment() public {
        vm.prank(attester1);

        AttestationRequestData memory requestData = AttestationRequestData({
            recipient: recipient,
            expirationTime: 0,
            revocable: true,
            refUID: bytes32(0),
            data: abi.encode("test message"),
            value: TARGET_VALUE + 1 wei // Wrong value
        });

        AttestationRequest memory request = AttestationRequest({schema: schemaUID, data: requestData});

        // Should fail validation
        vm.expectRevert();
        eas.attest{value: TARGET_VALUE + 1 wei}(request);
    }

    function testOnAttest_ShouldFailWithNoPayment() public {
        vm.prank(attester1);

        AttestationRequestData memory requestData = AttestationRequestData({
            recipient: recipient,
            expirationTime: 0,
            revocable: true,
            refUID: bytes32(0),
            data: abi.encode("test message"),
            value: 0
        });

        AttestationRequest memory request = AttestationRequest({schema: schemaUID, data: requestData});

        // Should fail validation (no payment sent)
        vm.expectRevert();
        eas.attest(request);
    }

    function testOnAttest_ShouldAccumulateFundsFromMultipleAttestations() public {
        // First attestation
        vm.prank(attester1);
        AttestationRequestData memory requestData1 = AttestationRequestData({
            recipient: recipient,
            expirationTime: 0,
            revocable: true,
            refUID: bytes32(0),
            data: abi.encode("test message 1"),
            value: TARGET_VALUE
        });
        AttestationRequest memory request1 = AttestationRequest({schema: schemaUID, data: requestData1});
        eas.attest{value: TARGET_VALUE}(request1);

        // Second attestation
        vm.prank(attester2);
        AttestationRequestData memory requestData2 = AttestationRequestData({
            recipient: recipient,
            expirationTime: 0,
            revocable: true,
            refUID: bytes32(0),
            data: abi.encode("test message 2"),
            value: TARGET_VALUE
        });
        AttestationRequest memory request2 = AttestationRequest({schema: schemaUID, data: requestData2});
        eas.attest{value: TARGET_VALUE}(request2);

        // Verify total accumulated funds
        assertEq(resolver.getBalance(), TARGET_VALUE * 2);
    }

    function testOnRevoke_ShouldAlwaysReturnTrue() public {
        // First create an attestation
        vm.prank(attester1);
        AttestationRequestData memory requestData = AttestationRequestData({
            recipient: recipient,
            expirationTime: 0,
            revocable: true,
            refUID: bytes32(0),
            data: abi.encode("test message"),
            value: TARGET_VALUE
        });
        AttestationRequest memory request = AttestationRequest({schema: schemaUID, data: requestData});
        bytes32 attestationUID = eas.attest{value: TARGET_VALUE}(request);

        // Now revoke it
        vm.prank(attester1);
        RevocationRequestData memory revocationData = RevocationRequestData({uid: attestationUID, value: 0});
        RevocationRequest memory revocationRequest = RevocationRequest({schema: schemaUID, data: revocationData});

        eas.revoke(revocationRequest);

        // Verify attestation was revoked
        Attestation memory attestation = eas.getAttestation(attestationUID);
        assertEq(attestation.revocationTime, block.timestamp);

        // Funds should still be in the contract (no refund on revocation)
        assertEq(resolver.getBalance(), TARGET_VALUE);
    }

    function testWithdraw_ShouldTransferFundsToRecipient() public {
        // First accumulate some funds
        vm.prank(attester1);
        AttestationRequestData memory requestData = AttestationRequestData({
            recipient: recipient,
            expirationTime: 0,
            revocable: true,
            refUID: bytes32(0),
            data: abi.encode("test message"),
            value: TARGET_VALUE
        });
        AttestationRequest memory request = AttestationRequest({schema: schemaUID, data: requestData});
        eas.attest{value: TARGET_VALUE}(request);

        uint256 initialBalance = withdrawRecipient.balance;

        // Withdraw funds
        vm.prank(owner);
        vm.expectEmit(true, true, true, true);
        emit FundsWithdrawn(withdrawRecipient, TARGET_VALUE);
        resolver.withdraw(payable(withdrawRecipient));

        // Verify funds transferred
        assertEq(withdrawRecipient.balance, initialBalance + TARGET_VALUE);
        assertEq(resolver.getBalance(), 0);
    }

    function testWithdraw_ShouldRevertWithNonOwner() public {
        vm.prank(attester1);
        vm.expectRevert();
        resolver.withdraw(payable(withdrawRecipient));
    }

    function testWithdraw_ShouldRevertWithZeroAddress() public {
        vm.prank(owner);
        vm.expectRevert("Invalid recipient address");
        resolver.withdraw(payable(address(0)));
    }

    function testWithdraw_ShouldRevertWithZeroBalance() public {
        vm.prank(owner);
        vm.expectRevert("No funds to withdraw");
        resolver.withdraw(payable(withdrawRecipient));
    }

    function testWithdrawToOwner_ShouldTransferFundsToOwner() public {
        // First accumulate some funds
        vm.prank(attester1);
        AttestationRequestData memory requestData = AttestationRequestData({
            recipient: recipient,
            expirationTime: 0,
            revocable: true,
            refUID: bytes32(0),
            data: abi.encode("test message"),
            value: TARGET_VALUE
        });
        AttestationRequest memory request = AttestationRequest({schema: schemaUID, data: requestData});
        eas.attest{value: TARGET_VALUE}(request);

        uint256 initialBalance = owner.balance;

        // Withdraw funds to owner
        vm.prank(owner);
        vm.expectEmit(true, true, true, true);
        emit FundsWithdrawn(owner, TARGET_VALUE);
        resolver.withdrawToOwner();

        // Verify funds transferred
        assertEq(owner.balance, initialBalance + TARGET_VALUE);
        assertEq(resolver.getBalance(), 0);
    }

    function testWithdrawToOwner_ShouldRevertWithNonOwner() public {
        vm.prank(attester1);
        vm.expectRevert();
        resolver.withdrawToOwner();
    }

    function testWithdrawToOwner_ShouldRevertWithZeroBalance() public {
        vm.prank(owner);
        vm.expectRevert("No funds to withdraw");
        resolver.withdrawToOwner();
    }

    function testOwnership_ShouldBeTransferrable() public {
        address newOwner = address(0x6);

        vm.prank(owner);
        resolver.transferOwnership(newOwner);

        assertEq(resolver.owner(), newOwner);

        // Old owner should not be able to set target value
        vm.prank(owner);
        vm.expectRevert();
        resolver.setTargetValue(0.002 ether);

        // New owner should be able to set target value
        vm.prank(newOwner);
        resolver.setTargetValue(0.002 ether);
        assertEq(resolver.getTargetValue(), 0.002 ether);
    }

    function testDynamicPricing_ShouldWorkWithDifferentValues() public {
        // Change target value
        uint256 newValue = 0.005 ether;
        vm.prank(owner);
        resolver.setTargetValue(newValue);

        // Test attestation with new value
        vm.prank(attester1);
        AttestationRequestData memory requestData = AttestationRequestData({
            recipient: recipient,
            expirationTime: 0,
            revocable: true,
            refUID: bytes32(0),
            data: abi.encode("test message"),
            value: newValue
        });
        AttestationRequest memory request = AttestationRequest({schema: schemaUID, data: requestData});

        bytes32 attestationUID = eas.attest{value: newValue}(request);

        // Verify attestation succeeded and funds accumulated
        Attestation memory attestation = eas.getAttestation(attestationUID);
        assertEq(attestation.attester, attester1);
        assertEq(resolver.getBalance(), newValue);
    }

    function testFreeAttestations_ShouldWorkWithZeroValue() public {
        // Set target value to 0 (free attestations)
        vm.prank(owner);
        resolver.setTargetValue(0);

        // Test free attestation
        vm.prank(attester1);
        AttestationRequestData memory requestData = AttestationRequestData({
            recipient: recipient,
            expirationTime: 0,
            revocable: true,
            refUID: bytes32(0),
            data: abi.encode("test message"),
            value: 0
        });
        AttestationRequest memory request = AttestationRequest({schema: schemaUID, data: requestData});

        bytes32 attestationUID = eas.attest(request);

        // Verify attestation succeeded with no payment
        Attestation memory attestation = eas.getAttestation(attestationUID);
        assertEq(attestation.attester, attester1);
        assertEq(resolver.getBalance(), 0);
    }

    function testLargePayments_ShouldHandleHighValues() public {
        uint256 largeValue = 100 ether;

        // Set high target value
        vm.prank(owner);
        resolver.setTargetValue(largeValue);

        // Give attester enough ETH
        vm.deal(attester1, 200 ether);

        // Test large payment attestation
        vm.prank(attester1);
        AttestationRequestData memory requestData = AttestationRequestData({
            recipient: recipient,
            expirationTime: 0,
            revocable: true,
            refUID: bytes32(0),
            data: abi.encode("expensive attestation"),
            value: largeValue
        });
        AttestationRequest memory request = AttestationRequest({schema: schemaUID, data: requestData});

        bytes32 attestationUID = eas.attest{value: largeValue}(request);

        // Verify attestation succeeded and large amount accumulated
        Attestation memory attestation = eas.getAttestation(attestationUID);
        assertEq(attestation.attester, attester1);
        assertEq(resolver.getBalance(), largeValue);
    }

    function testCompleteWorkflow_ShouldHandleFullLifecycle() public {
        uint256 initialOwnerBalance = owner.balance;

        // 1. Create multiple paid attestations
        for (uint256 i = 0; i < 3; i++) {
            vm.prank(attester1);
            AttestationRequestData memory loopRequestData = AttestationRequestData({
                recipient: recipient,
                expirationTime: 0,
                revocable: true,
                refUID: bytes32(0),
                data: abi.encode("test message", i),
                value: TARGET_VALUE
            });
            AttestationRequest memory loopRequest = AttestationRequest({schema: schemaUID, data: loopRequestData});
            eas.attest{value: TARGET_VALUE}(loopRequest);
        }

        // 2. Verify accumulated funds
        uint256 expectedBalance = TARGET_VALUE * 3;
        assertEq(resolver.getBalance(), expectedBalance);

        // 3. Update pricing
        uint256 newPrice = TARGET_VALUE * 2;
        vm.prank(owner);
        resolver.setTargetValue(newPrice);

        // 4. Create attestation with new price
        vm.prank(attester2);
        AttestationRequestData memory requestData = AttestationRequestData({
            recipient: recipient,
            expirationTime: 0,
            revocable: true,
            refUID: bytes32(0),
            data: abi.encode("expensive attestation"),
            value: newPrice
        });
        AttestationRequest memory request = AttestationRequest({schema: schemaUID, data: requestData});
        eas.attest{value: newPrice}(request);

        // 5. Verify total accumulated funds
        expectedBalance += newPrice;
        assertEq(resolver.getBalance(), expectedBalance);

        // 6. Withdraw all funds to owner
        vm.prank(owner);
        resolver.withdrawToOwner();

        // 7. Verify final state
        assertEq(resolver.getBalance(), 0);
        assertEq(owner.balance, initialOwnerBalance + expectedBalance);
    }
}
