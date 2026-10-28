// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {SignatureChecker} from "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

/// @title Escrow
/// @notice Conditional payments (native ETH or ERC-20) between a payer and a payee, optionally
///         supervised by an arbiter. Supports gasless release through EIP-712 typed-data
///         signatures (ERC-1271 aware), and settles through a pull-payment ledger so that no
///         external value transfer is ever made during a state transition.
///
/// @dev Security model, in short:
///      * Checks-Effects-Interactions everywhere; the only outbound value transfers happen in
///        {withdraw}, which is `nonReentrant` and zeroes the ledger before transferring.
///      * `whenNotPaused` guards *entry* paths (create / release / resolve). Exit paths
///        ({refund}, {withdraw}) are deliberately NOT pausable so the owner can never trap funds.
///      * Signed releases are bound to (escrowId, nonce, deadline) under this contract's EIP-712
///        domain (name, version, chainId, verifyingContract), so a signature cannot be replayed
///        across escrows, chains or deployments. Nonces are sequential per payer.
///      * ERC-20 deposits record the balance delta actually received, so fee-on-transfer tokens
///        cannot be used to over-credit a payee.
///      * Ownership is `Ownable2Step` to prevent an accidental transfer to a dead address.
contract Escrow is EIP712, ReentrancyGuard, Pausable, Ownable2Step {
    using SafeERC20 for IERC20;

    // -------------------------------------------------------------------------
    // Types
    // -------------------------------------------------------------------------

    enum Status {
        None,
        Active,
        Released,
        Refunded,
        Resolved
    }

    /// @dev Packed into 5 storage slots: payer | payee | arbiter | amount | (token, deadline, status).
    struct EscrowData {
        address payer;
        address payee;
        address arbiter;
        uint256 amount;
        address token; // address(0) == native ETH
        uint64 deadline;
        Status status;
    }

    // -------------------------------------------------------------------------
    // Constants & storage
    // -------------------------------------------------------------------------

    /// @notice Sentinel token address meaning native ETH.
    address public constant NATIVE = address(0);

    /// @notice EIP-712 type hash for a gasless release authorisation.
    bytes32 public constant RELEASE_TYPEHASH =
        keccak256("Release(uint256 escrowId,uint256 nonce,uint256 deadline)");

    /// @notice Next escrow id to be assigned (ids start at 1; 0 is never valid).
    uint256 public nextId = 1;

    /// @notice Sequential EIP-712 nonce per payer.
    mapping(address payer => uint256) public nonces;

    /// @notice Withdrawable balances: account => token => amount.
    mapping(address account => mapping(address token => uint256)) public balances;

    mapping(uint256 id => EscrowData) private _escrows;

    // -------------------------------------------------------------------------
    // Events
    // -------------------------------------------------------------------------

    event EscrowCreated(
        uint256 indexed id,
        address indexed payer,
        address indexed payee,
        address arbiter,
        address token,
        uint256 amount,
        uint64 deadline
    );
    event EscrowReleased(uint256 indexed id, address indexed by, uint256 payeeAmount);
    event EscrowRefunded(uint256 indexed id, address indexed by, uint256 payerAmount);
    event EscrowResolved(uint256 indexed id, address indexed arbiter, uint256 payeeAmount, uint256 payerAmount);
    event Withdrawn(address indexed account, address indexed token, uint256 amount);

    // -------------------------------------------------------------------------
    // Errors
    // -------------------------------------------------------------------------

    error ZeroAddress();
    error ZeroAmount();
    error SelfEscrow();
    error InvalidDeadline();
    error InvalidMsgValue();
    error EscrowNotFound(uint256 id);
    error InvalidStatus(uint256 id, Status current);
    error Unauthorized(address caller);
    error DeadlineNotReached(uint64 deadline);
    error SignatureExpired(uint256 deadline);
    error InvalidSignature();
    error SplitExceedsAmount(uint256 payeeAmount, uint256 amount);
    error NothingToWithdraw();
    error NativeTransferFailed();

    // -------------------------------------------------------------------------
    // Constructor
    // -------------------------------------------------------------------------

    constructor(address initialOwner) EIP712("Escrow", "1") Ownable(initialOwner) {}

    // -------------------------------------------------------------------------
    // Entry paths (pausable)
    // -------------------------------------------------------------------------

    /// @notice Lock `amount` of `token` (or ETH when `token == NATIVE`) for `payee`.
    /// @param payee    Recipient on release.
    /// @param arbiter  Optional third party allowed to {resolve}. `address(0)` disables arbitration.
    /// @param token    ERC-20 address, or `NATIVE`.
    /// @param amount   Amount to lock. For ERC-20, the amount actually received is recorded.
    /// @param deadline Unix timestamp after which the funds become refundable.
    /// @return id      The new escrow id.
    function createEscrow(address payee, address arbiter, address token, uint256 amount, uint64 deadline)
        external
        payable
        whenNotPaused
        nonReentrant
        returns (uint256 id)
    {
        if (payee == address(0)) revert ZeroAddress();
        if (payee == msg.sender) revert SelfEscrow();
        if (amount == 0) revert ZeroAmount();
        if (deadline <= block.timestamp) revert InvalidDeadline();

        uint256 received;
        if (token == NATIVE) {
            if (msg.value != amount) revert InvalidMsgValue();
            received = amount;
        } else {
            if (msg.value != 0) revert InvalidMsgValue();
            // Measure the delta so fee-on-transfer / rebasing tokens cannot over-credit.
            uint256 before = IERC20(token).balanceOf(address(this));
            IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
            received = IERC20(token).balanceOf(address(this)) - before;
            if (received == 0) revert ZeroAmount();
        }

        id = nextId++;
        _escrows[id] = EscrowData({
            payer: msg.sender,
            payee: payee,
            arbiter: arbiter,
            amount: received,
            token: token,
            deadline: deadline,
            status: Status.Active
        });

        emit EscrowCreated(id, msg.sender, payee, arbiter, token, received, deadline);
    }

    /// @notice Payer releases the full amount to the payee.
    function release(uint256 id) external whenNotPaused {
        EscrowData storage e = _getActive(id);
        if (msg.sender != e.payer) revert Unauthorized(msg.sender);
        _release(e, id);
    }

    /// @notice Anyone may submit a payer-signed EIP-712 authorisation to release `id`.
    /// @dev Gasless for the payer. The signature covers Release(escrowId, nonce, deadline) where
    ///      `nonce == nonces[payer]` at execution time. Supports EOAs and ERC-1271 wallets.
    function releaseWithSig(uint256 id, uint256 deadline, bytes calldata signature) external whenNotPaused {
        EscrowData storage e = _getActive(id);
        if (block.timestamp > deadline) revert SignatureExpired(deadline);

        address payer = e.payer;
        uint256 nonce = nonces[payer]++;
        bytes32 digest = _hashTypedDataV4(keccak256(abi.encode(RELEASE_TYPEHASH, id, nonce, deadline)));
        if (!SignatureChecker.isValidSignatureNow(payer, digest, signature)) revert InvalidSignature();

        _release(e, id);
    }

    /// @notice Arbiter settles the escrow: `payeeAmount` to the payee, the remainder to the payer.
    function resolve(uint256 id, uint256 payeeAmount) external whenNotPaused {
        EscrowData storage e = _getActive(id);
        if (msg.sender != e.arbiter) revert Unauthorized(msg.sender);
        if (payeeAmount > e.amount) revert SplitExceedsAmount(payeeAmount, e.amount);

        uint256 payerAmount = e.amount - payeeAmount;
        e.status = Status.Resolved;
        if (payeeAmount != 0) balances[e.payee][e.token] += payeeAmount;
        if (payerAmount != 0) balances[e.payer][e.token] += payerAmount;

        emit EscrowResolved(id, msg.sender, payeeAmount, payerAmount);
    }

    // -------------------------------------------------------------------------
    // Exit paths (NOT pausable: funds must always be recoverable)
    // -------------------------------------------------------------------------

    /// @notice After `deadline`, the payer or the payee may return the funds to the payer.
    function refund(uint256 id) external {
        EscrowData storage e = _getActive(id);
        if (msg.sender != e.payer && msg.sender != e.payee) revert Unauthorized(msg.sender);
        if (block.timestamp < e.deadline) revert DeadlineNotReached(e.deadline);

        e.status = Status.Refunded;
        balances[e.payer][e.token] += e.amount;

        emit EscrowRefunded(id, msg.sender, e.amount);
    }

    /// @notice Pull your accumulated balance of `token`.
    function withdraw(address token) external nonReentrant {
        uint256 amount = balances[msg.sender][token];
        if (amount == 0) revert NothingToWithdraw();

        balances[msg.sender][token] = 0; // effects before interaction
        emit Withdrawn(msg.sender, token, amount);

        if (token == NATIVE) {
            (bool ok,) = msg.sender.call{value: amount}("");
            if (!ok) revert NativeTransferFailed();
        } else {
            IERC20(token).safeTransfer(msg.sender, amount);
        }
    }

    // -------------------------------------------------------------------------
    // Admin
    // -------------------------------------------------------------------------

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // -------------------------------------------------------------------------
    // Views
    // -------------------------------------------------------------------------

    function getEscrow(uint256 id) external view returns (EscrowData memory e) {
        e = _escrows[id];
        if (e.status == Status.None) revert EscrowNotFound(id);
    }

    /// @notice EIP-712 digest a payer must sign to authorise a gasless release.
    function hashRelease(uint256 id, uint256 nonce, uint256 deadline) external view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(RELEASE_TYPEHASH, id, nonce, deadline)));
    }

    // -------------------------------------------------------------------------
    // Internals
    // -------------------------------------------------------------------------

    function _getActive(uint256 id) private view returns (EscrowData storage e) {
        e = _escrows[id];
        if (e.status == Status.None) revert EscrowNotFound(id);
        if (e.status != Status.Active) revert InvalidStatus(id, e.status);
    }

    function _release(EscrowData storage e, uint256 id) private {
        e.status = Status.Released;
        balances[e.payee][e.token] += e.amount;
        emit EscrowReleased(id, msg.sender, e.amount);
    }
}
