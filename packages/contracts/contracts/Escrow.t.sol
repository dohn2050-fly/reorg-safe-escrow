// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Escrow} from "./Escrow.sol";
import {
    MockERC20,
    FeeOnTransferERC20,
    ERC1271Wallet,
    ReentrantReceiver,
    RejectingReceiver
} from "./mocks/Mocks.sol";

contract EscrowTest is Test {
    Escrow internal escrow;
    MockERC20 internal token;

    address internal owner = makeAddr("owner");
    uint256 internal payerKey = 0xA11CE;
    address internal payer = vm.addr(payerKey);
    address internal payee = makeAddr("payee");
    address internal arbiter = makeAddr("arbiter");
    address internal relayer = makeAddr("relayer");
    address internal stranger = makeAddr("stranger");

    uint256 internal constant AMOUNT = 1 ether;
    uint64 internal deadline;

    bytes32 internal constant RELEASE_TYPEHASH =
        keccak256("Release(uint256 escrowId,uint256 nonce,uint256 deadline)");

    function setUp() public {
        escrow = new Escrow(owner);
        token = new MockERC20("Mock", "MCK");
        vm.deal(payer, 100 ether);
        vm.deal(stranger, 100 ether);
        token.mint(payer, 1_000_000e18);
        deadline = uint64(block.timestamp + 1 days);
    }

    // ------------------------------------------------------------------ helpers

    function _createNative(uint256 amount) internal returns (uint256 id) {
        vm.prank(payer);
        id = escrow.createEscrow{value: amount}(payee, arbiter, address(0), amount, deadline);
    }

    function _createNativeNoArbiter(uint256 amount) internal returns (uint256 id) {
        vm.prank(payer);
        id = escrow.createEscrow{value: amount}(payee, address(0), address(0), amount, deadline);
    }

    function _createToken(uint256 amount) internal returns (uint256 id) {
        vm.startPrank(payer);
        token.approve(address(escrow), amount);
        id = escrow.createEscrow(payee, arbiter, address(token), amount, deadline);
        vm.stopPrank();
    }

    function _sign(uint256 key, uint256 id, uint256 nonce, uint256 sigDeadline) internal view returns (bytes memory) {
        bytes32 digest = escrow.hashRelease(id, nonce, sigDeadline);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, digest);
        return abi.encodePacked(r, s, v);
    }

    // ------------------------------------------------------------------ create

    function test_CreateNative_StoresDataAndEmits() public {
        vm.expectEmit(true, true, true, true);
        emit Escrow.EscrowCreated(1, payer, payee, arbiter, address(0), AMOUNT, deadline);

        uint256 id = _createNative(AMOUNT);
        assertEq(id, 1);
        assertEq(escrow.nextId(), 2);

        Escrow.EscrowData memory e = escrow.getEscrow(id);
        assertEq(e.payer, payer);
        assertEq(e.payee, payee);
        assertEq(e.arbiter, arbiter);
        assertEq(e.token, address(0));
        assertEq(e.amount, AMOUNT);
        assertEq(e.deadline, deadline);
        assertEq(uint8(e.status), uint8(Escrow.Status.Active));
        assertEq(address(escrow).balance, AMOUNT);
    }

    function test_CreateERC20_PullsTokens() public {
        uint256 id = _createToken(500e18);
        assertEq(token.balanceOf(address(escrow)), 500e18);
        assertEq(escrow.getEscrow(id).amount, 500e18);
    }

    function test_CreateERC20_FeeOnTransfer_RecordsReceivedAmount() public {
        FeeOnTransferERC20 fee = new FeeOnTransferERC20(100); // 1%
        fee.mint(payer, 1_000e18);

        vm.startPrank(payer);
        fee.approve(address(escrow), 1_000e18);
        uint256 id = escrow.createEscrow(payee, arbiter, address(fee), 1_000e18, deadline);
        vm.stopPrank();

        uint256 received = fee.balanceOf(address(escrow));
        assertEq(received, 990e18);
        assertEq(escrow.getEscrow(id).amount, received, "recorded amount must equal tokens actually held");
    }

    function test_Create_RevertsOnBadInputs() public {
        vm.startPrank(payer);

        vm.expectRevert(Escrow.ZeroAddress.selector);
        escrow.createEscrow{value: AMOUNT}(address(0), arbiter, address(0), AMOUNT, deadline);

        vm.expectRevert(Escrow.SelfEscrow.selector);
        escrow.createEscrow{value: AMOUNT}(payer, arbiter, address(0), AMOUNT, deadline);

        vm.expectRevert(Escrow.ZeroAmount.selector);
        escrow.createEscrow(payee, arbiter, address(0), 0, deadline);

        vm.expectRevert(Escrow.InvalidDeadline.selector);
        escrow.createEscrow{value: AMOUNT}(payee, arbiter, address(0), AMOUNT, uint64(block.timestamp));

        vm.expectRevert(Escrow.InvalidMsgValue.selector);
        escrow.createEscrow{value: AMOUNT - 1}(payee, arbiter, address(0), AMOUNT, deadline);

        token.approve(address(escrow), AMOUNT);
        vm.expectRevert(Escrow.InvalidMsgValue.selector);
        escrow.createEscrow{value: 1}(payee, arbiter, address(token), AMOUNT, deadline);

        vm.stopPrank();
    }

    function test_GetEscrow_RevertsForUnknownId() public {
        vm.expectRevert(abi.encodeWithSelector(Escrow.EscrowNotFound.selector, 42));
        escrow.getEscrow(42);
    }

    // ------------------------------------------------------------------ release

    function test_Release_ByPayer_CreditsPayee() public {
        uint256 id = _createNative(AMOUNT);

        vm.expectEmit(true, true, true, true);
        emit Escrow.EscrowReleased(id, payer, AMOUNT);
        vm.prank(payer);
        escrow.release(id);

        assertEq(uint8(escrow.getEscrow(id).status), uint8(Escrow.Status.Released));
        assertEq(escrow.balances(payee, address(0)), AMOUNT);
    }

    function test_Release_RevertsForNonPayer() public {
        uint256 id = _createNative(AMOUNT);
        vm.expectRevert(abi.encodeWithSelector(Escrow.Unauthorized.selector, arbiter));
        vm.prank(arbiter);
        escrow.release(id);
    }

    function test_Release_RevertsWhenNotActive() public {
        uint256 id = _createNative(AMOUNT);
        vm.prank(payer);
        escrow.release(id);

        vm.expectRevert(abi.encodeWithSelector(Escrow.InvalidStatus.selector, id, Escrow.Status.Released));
        vm.prank(payer);
        escrow.release(id);
    }

    // ------------------------------------------------------------------ releaseWithSig

    function test_ReleaseWithSig_RelayedByThirdParty() public {
        uint256 id = _createNative(AMOUNT);
        uint256 nonce = escrow.nonces(payer);
        bytes memory sig = _sign(payerKey, id, nonce, deadline);

        vm.expectEmit(true, true, true, true);
        emit Escrow.EscrowReleased(id, relayer, AMOUNT);
        vm.prank(relayer);
        escrow.releaseWithSig(id, deadline, sig);

        assertEq(uint8(escrow.getEscrow(id).status), uint8(Escrow.Status.Released));
        assertEq(escrow.nonces(payer), nonce + 1);
        assertEq(escrow.balances(payee, address(0)), AMOUNT);
    }

    function test_ReleaseWithSig_RejectsReplay() public {
        uint256 id1 = _createNative(AMOUNT);
        uint256 id2 = _createNative(AMOUNT);
        bytes memory sig = _sign(payerKey, id1, 0, deadline);

        vm.prank(relayer);
        escrow.releaseWithSig(id1, deadline, sig);

        // Same signature, same escrow: status check trips first.
        vm.expectRevert(abi.encodeWithSelector(Escrow.InvalidStatus.selector, id1, Escrow.Status.Released));
        vm.prank(relayer);
        escrow.releaseWithSig(id1, deadline, sig);

        // Signature for id1/nonce0 cannot be redirected to id2 (different escrowId + nonce consumed).
        vm.expectRevert(Escrow.InvalidSignature.selector);
        vm.prank(relayer);
        escrow.releaseWithSig(id2, deadline, sig);
    }

    function test_ReleaseWithSig_RejectsExpired() public {
        uint256 id = _createNative(AMOUNT);
        uint256 sigDeadline = block.timestamp + 10;
        bytes memory sig = _sign(payerKey, id, 0, sigDeadline);

        vm.warp(sigDeadline + 1);
        vm.expectRevert(abi.encodeWithSelector(Escrow.SignatureExpired.selector, sigDeadline));
        vm.prank(relayer);
        escrow.releaseWithSig(id, sigDeadline, sig);
    }

    function test_ReleaseWithSig_RejectsWrongSigner() public {
        uint256 id = _createNative(AMOUNT);
        bytes memory sig = _sign(0xBAD, id, 0, deadline);

        vm.expectRevert(Escrow.InvalidSignature.selector);
        vm.prank(relayer);
        escrow.releaseWithSig(id, deadline, sig);
    }

    function test_ReleaseWithSig_RejectsStaleNonce() public {
        uint256 id = _createNative(AMOUNT);
        // Signed for nonce 1 while current nonce is 0.
        bytes memory sig = _sign(payerKey, id, 1, deadline);

        vm.expectRevert(Escrow.InvalidSignature.selector);
        vm.prank(relayer);
        escrow.releaseWithSig(id, deadline, sig);
    }

    function test_ReleaseWithSig_DifferentDeploymentCannotReplay() public {
        uint256 id = _createNative(AMOUNT);
        bytes memory sig = _sign(payerKey, id, 0, deadline);

        Escrow other = new Escrow(owner);
        vm.prank(payer);
        other.createEscrow{value: AMOUNT}(payee, arbiter, address(0), AMOUNT, deadline);

        vm.expectRevert(Escrow.InvalidSignature.selector);
        vm.prank(relayer);
        other.releaseWithSig(1, deadline, sig);
    }

    function test_ReleaseWithSig_ERC1271Wallet() public {
        uint256 walletKey = 0xC0FFEE;
        ERC1271Wallet wallet = new ERC1271Wallet(vm.addr(walletKey));
        vm.deal(address(wallet), 10 ether);

        vm.prank(address(wallet));
        uint256 id = escrow.createEscrow{value: AMOUNT}(payee, arbiter, address(0), AMOUNT, deadline);

        bytes memory sig = _sign(walletKey, id, 0, deadline);
        vm.prank(relayer);
        escrow.releaseWithSig(id, deadline, sig);

        assertEq(uint8(escrow.getEscrow(id).status), uint8(Escrow.Status.Released));
    }

    function test_HashRelease_MatchesEIP712Encoding() public view {
        (, string memory name, string memory version, uint256 chainId, address verifying,,) = escrow.eip712Domain();
        bytes32 domainSeparator = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256(bytes(name)),
                keccak256(bytes(version)),
                chainId,
                verifying
            )
        );
        bytes32 structHash = keccak256(abi.encode(RELEASE_TYPEHASH, uint256(7), uint256(3), uint256(99)));
        bytes32 expected = keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
        assertEq(escrow.hashRelease(7, 3, 99), expected);
    }

    // ------------------------------------------------------------------ refund

    function test_Refund_AfterDeadline_ByPayer() public {
        uint256 id = _createNative(AMOUNT);
        vm.warp(deadline);

        vm.expectEmit(true, true, true, true);
        emit Escrow.EscrowRefunded(id, payer, AMOUNT);
        vm.prank(payer);
        escrow.refund(id);

        assertEq(uint8(escrow.getEscrow(id).status), uint8(Escrow.Status.Refunded));
        assertEq(escrow.balances(payer, address(0)), AMOUNT);
    }

    function test_Refund_AfterDeadline_ByPayee() public {
        uint256 id = _createNative(AMOUNT);
        vm.warp(deadline);
        vm.prank(payee);
        escrow.refund(id);
        assertEq(escrow.balances(payer, address(0)), AMOUNT);
    }

    function test_Refund_RevertsBeforeDeadline() public {
        uint256 id = _createNative(AMOUNT);
        vm.expectRevert(abi.encodeWithSelector(Escrow.DeadlineNotReached.selector, deadline));
        vm.prank(payer);
        escrow.refund(id);
    }

    function test_Refund_RevertsForStranger() public {
        uint256 id = _createNative(AMOUNT);
        vm.warp(deadline);
        vm.expectRevert(abi.encodeWithSelector(Escrow.Unauthorized.selector, stranger));
        vm.prank(stranger);
        escrow.refund(id);
    }

    // ------------------------------------------------------------------ resolve

    function test_Resolve_SplitsBetweenParties() public {
        uint256 id = _createNative(AMOUNT);

        vm.expectEmit(true, true, true, true);
        emit Escrow.EscrowResolved(id, arbiter, 0.3 ether, 0.7 ether);
        vm.prank(arbiter);
        escrow.resolve(id, 0.3 ether);

        assertEq(uint8(escrow.getEscrow(id).status), uint8(Escrow.Status.Resolved));
        assertEq(escrow.balances(payee, address(0)), 0.3 ether);
        assertEq(escrow.balances(payer, address(0)), 0.7 ether);
    }

    function test_Resolve_RevertsForNonArbiter() public {
        uint256 id = _createNative(AMOUNT);
        vm.expectRevert(abi.encodeWithSelector(Escrow.Unauthorized.selector, payer));
        vm.prank(payer);
        escrow.resolve(id, AMOUNT);
    }

    function test_Resolve_RevertsWithoutArbiter() public {
        uint256 id = _createNativeNoArbiter(AMOUNT);
        vm.expectRevert(abi.encodeWithSelector(Escrow.Unauthorized.selector, arbiter));
        vm.prank(arbiter);
        escrow.resolve(id, AMOUNT);
    }

    function test_Resolve_RevertsWhenSplitExceedsAmount() public {
        uint256 id = _createNative(AMOUNT);
        vm.expectRevert(abi.encodeWithSelector(Escrow.SplitExceedsAmount.selector, AMOUNT + 1, AMOUNT));
        vm.prank(arbiter);
        escrow.resolve(id, AMOUNT + 1);
    }

    // ------------------------------------------------------------------ withdraw

    function test_Withdraw_Native() public {
        uint256 id = _createNative(AMOUNT);
        vm.prank(payer);
        escrow.release(id);

        uint256 before = payee.balance;
        vm.expectEmit(true, true, true, true);
        emit Escrow.Withdrawn(payee, address(0), AMOUNT);
        vm.prank(payee);
        escrow.withdraw(address(0));

        assertEq(payee.balance - before, AMOUNT);
        assertEq(escrow.balances(payee, address(0)), 0);
        assertEq(address(escrow).balance, 0);
    }

    function test_Withdraw_ERC20() public {
        uint256 id = _createToken(500e18);
        vm.prank(payer);
        escrow.release(id);

        vm.prank(payee);
        escrow.withdraw(address(token));
        assertEq(token.balanceOf(payee), 500e18);
        assertEq(token.balanceOf(address(escrow)), 0);
    }

    function test_Withdraw_RevertsWhenNothingToWithdraw() public {
        vm.expectRevert(Escrow.NothingToWithdraw.selector);
        vm.prank(stranger);
        escrow.withdraw(address(0));
    }

    function test_Withdraw_ReentrancyIsBlocked() public {
        ReentrantReceiver attacker = new ReentrantReceiver(escrow);

        vm.prank(payer);
        uint256 id = escrow.createEscrow{value: AMOUNT}(address(attacker), arbiter, address(0), AMOUNT, deadline);
        vm.prank(payer);
        escrow.release(id);

        attacker.pull();

        assertEq(attacker.reentryAttempts(), 1, "receive() should have been invoked exactly once");
        assertFalse(attacker.reentrySucceeded(), "re-entrant withdraw must fail");
        assertEq(address(attacker).balance, AMOUNT, "attacker receives exactly its balance, once");
        assertEq(address(escrow).balance, 0);
    }

    function test_Withdraw_RevertsIfReceiverRejectsEther() public {
        RejectingReceiver rejecting = new RejectingReceiver();
        vm.prank(payer);
        uint256 id = escrow.createEscrow{value: AMOUNT}(address(rejecting), arbiter, address(0), AMOUNT, deadline);
        vm.prank(payer);
        escrow.release(id);

        vm.expectRevert(Escrow.NativeTransferFailed.selector);
        vm.prank(address(rejecting));
        escrow.withdraw(address(0));

        // Balance is preserved for a later successful withdrawal (state rolled back).
        assertEq(escrow.balances(address(rejecting), address(0)), AMOUNT);
    }

    // ------------------------------------------------------------------ pause

    function test_Pause_BlocksEntryButNotExit() public {
        uint256 id = _createNative(AMOUNT);
        uint256 id2 = _createNative(AMOUNT);
        vm.prank(payer);
        escrow.release(id2);

        vm.prank(owner);
        escrow.pause();

        // Entry paths blocked.
        vm.expectRevert(Pausable.EnforcedPause.selector);
        vm.prank(payer);
        escrow.createEscrow{value: AMOUNT}(payee, arbiter, address(0), AMOUNT, deadline);

        vm.expectRevert(Pausable.EnforcedPause.selector);
        vm.prank(payer);
        escrow.release(id);

        vm.expectRevert(Pausable.EnforcedPause.selector);
        vm.prank(arbiter);
        escrow.resolve(id, AMOUNT);

        // Exit paths still open.
        vm.prank(payee);
        escrow.withdraw(address(0));
        assertEq(payee.balance, AMOUNT);

        vm.warp(deadline);
        vm.prank(payer);
        escrow.refund(id);
        vm.prank(payer);
        escrow.withdraw(address(0));
        assertEq(address(escrow).balance, 0);
    }

    function test_Pause_OnlyOwner() public {
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, stranger));
        vm.prank(stranger);
        escrow.pause();
    }

    // ------------------------------------------------------------------ fuzz

    function testFuzz_ResolveConservesValue(uint96 amount, uint96 payeeAmount) public {
        amount = uint96(bound(amount, 1, 50 ether));
        payeeAmount = uint96(bound(payeeAmount, 0, amount));

        uint256 id = _createNative(amount);
        vm.prank(arbiter);
        escrow.resolve(id, payeeAmount);

        assertEq(escrow.balances(payee, address(0)) + escrow.balances(payer, address(0)), amount);
        assertEq(address(escrow).balance, amount);
    }

    function testFuzz_CreateReleaseWithdraw(uint96 amount) public {
        amount = uint96(bound(amount, 1, 50 ether));

        uint256 id = _createNative(amount);
        vm.prank(payer);
        escrow.release(id);
        vm.prank(payee);
        escrow.withdraw(address(0));

        assertEq(payee.balance, amount);
        assertEq(address(escrow).balance, 0);
    }

    function testFuzz_SignatureOnlyValidForExactTuple(uint256 id, uint256 nonce, uint256 sigDeadline, uint256 badNonce)
        public
        view
    {
        vm.assume(nonce != badNonce);
        vm.assume(sigDeadline >= block.timestamp);

        bytes32 good = escrow.hashRelease(id, nonce, sigDeadline);
        bytes32 bad = escrow.hashRelease(id, badNonce, sigDeadline);
        assertTrue(good != bad);
    }

    function testFuzz_RefundOnlyAfterDeadline(uint64 warpTo) public {
        uint256 id = _createNative(AMOUNT);
        warpTo = uint64(bound(warpTo, block.timestamp, uint256(deadline) * 2));
        vm.warp(warpTo);

        vm.prank(payer);
        if (warpTo < deadline) {
            vm.expectRevert(abi.encodeWithSelector(Escrow.DeadlineNotReached.selector, deadline));
            escrow.refund(id);
        } else {
            escrow.refund(id);
            assertEq(escrow.balances(payer, address(0)), AMOUNT);
        }
    }
}
