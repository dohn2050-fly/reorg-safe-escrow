// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// Test-only helpers. MockERC20 is also deployed by the chaos runner to exercise ERC-20 escrows.

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC1271} from "@openzeppelin/contracts/interfaces/IERC1271.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Escrow} from "../Escrow.sol";

/// @dev Plain ERC-20 with open mint.
contract MockERC20 is ERC20 {
    constructor(string memory name_, string memory symbol_) ERC20(name_, symbol_) {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}

/// @dev ERC-20 that burns `feeBps` of every transfer. Used to prove the escrow records the
///      amount actually received rather than the amount requested.
contract FeeOnTransferERC20 is ERC20 {
    uint256 public immutable feeBps;

    constructor(uint256 feeBps_) ERC20("Fee Token", "FEE") {
        feeBps = feeBps_;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 fee = (value * feeBps) / 10_000;
            super._update(from, address(0), fee); // burn the fee
            value -= fee;
        }
        super._update(from, to, value);
    }
}

/// @dev Minimal ERC-1271 smart-contract wallet controlled by a single EOA signer.
contract ERC1271Wallet is IERC1271 {
    address public immutable signer;

    constructor(address signer_) {
        signer = signer_;
    }

    function isValidSignature(bytes32 hash, bytes memory signature) external view override returns (bytes4) {
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(hash, signature);
        if (err == ECDSA.RecoverError.NoError && recovered == signer) {
            return IERC1271.isValidSignature.selector;
        }
        return bytes4(0);
    }

    receive() external payable {}
}

/// @dev Payee that attempts to re-enter `withdraw` while receiving ETH.
contract ReentrantReceiver {
    Escrow public immutable escrow;
    uint256 public reentryAttempts;
    bool public reentrySucceeded;

    constructor(Escrow escrow_) {
        escrow = escrow_;
    }

    function pull() external {
        escrow.withdraw(address(0));
    }

    receive() external payable {
        if (reentryAttempts < 3) {
            reentryAttempts++;
            (bool ok,) = address(escrow).call(abi.encodeWithSelector(Escrow.withdraw.selector, address(0)));
            if (ok) reentrySucceeded = true;
        }
    }
}

/// @dev Contract whose `receive` always reverts, to exercise NativeTransferFailed.
contract RejectingReceiver {
    receive() external payable {
        revert("nope");
    }
}
