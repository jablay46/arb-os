// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IMorphoFlashLoanCallback} from "../../src/interfaces/IMorpho.sol";
import {
    IBalancerV2FlashLoanRecipient,
    IBalancerV3UnlockCallback
} from "../../src/interfaces/IBalancer.sol";

/// @notice Morpho Blue stand-in.
/// @dev Reproduces the two behaviours the executor depends on: the loan is pushed to the
///      borrower before the callback, and repayment is PULLED with `transferFrom` after the
///      callback returns (so an `approve` is required, not a `transfer`).
contract MockMorpho {
    using SafeERC20 for IERC20;

    function flashLoan(address token, uint256 assets, bytes calldata data) external {
        IERC20(token).safeTransfer(msg.sender, assets);
        IMorphoFlashLoanCallback(msg.sender).onMorphoFlashLoan(assets, data);
        IERC20(token).safeTransferFrom(msg.sender, address(this), assets);
    }
}

/// @notice Balancer V2 Vault stand-in.
/// @dev Reproduces the crucial difference from Morpho: repayment is verified by re-reading
///      the Vault's OWN balance, so the borrower must transfer the tokens back.
contract MockBalancerV2Vault {
    using SafeERC20 for IERC20;

    function flashLoan(
        IBalancerV2FlashLoanRecipient recipient,
        address[] memory tokens,
        uint256[] memory amounts,
        bytes memory userData
    ) external {
        uint256 len = tokens.length;
        uint256[] memory fees = new uint256[](len);
        uint256[] memory pre = new uint256[](len);

        for (uint256 i = 0; i < len; ++i) {
            pre[i] = IERC20(tokens[i]).balanceOf(address(this));
            IERC20(tokens[i]).safeTransfer(address(recipient), amounts[i]);
        }

        recipient.receiveFlashLoan(tokens, amounts, fees, userData);

        for (uint256 i = 0; i < len; ++i) {
            require(
                IERC20(tokens[i]).balanceOf(address(this)) >= pre[i], "INVALID_POST_LOAN_BALANCE"
            );
        }
    }
}

/// @notice Balancer V3 Vault stand-in.
/// @dev Reproduces the transient-accounting pattern: liquidity is pulled inside the unlock
///      window via `sendTo`, and the borrower must `settle` the debt. Settled credit is
///      compared against what was lent out, so a borrower that forgets to repay cannot
///      silently pass -- and a fee (extra credit) is allowed rather than treated as an error.
contract MockBalancerV3Vault {
    using SafeERC20 for IERC20;

    uint256 public feePercentage;
    bool public unlocked;
    address internal _caller;

    address[] internal _touched;
    mapping(address => uint256) internal _sent;
    mapping(address => uint256) internal _settled;

    function setFeePercentage(uint256 pct) external {
        feePercentage = pct;
    }

    function getFlashLoanFeePercentage() external view returns (uint256) {
        return feePercentage;
    }

    /// @dev Seed Vault liquidity.
    function seed(address token, uint256 amount) external {
        IERC20(token).safeTransferFrom(msg.sender, address(this), amount);
    }

    function unlock(bytes calldata data) external returns (bytes memory) {
        unlocked = true;
        _caller = msg.sender;
        _reset();

        bytes memory result = IBalancerV3UnlockCallback(msg.sender).unlockCallback(data);

        for (uint256 i = 0; i < _touched.length; ++i) {
            require(_settled[_touched[i]] >= _sent[_touched[i]], "VAULT_NOT_SETTLED");
        }

        unlocked = false;
        _caller = address(0);
        return result;
    }

    function sendTo(address token, address to, uint256 amount) external {
        require(unlocked && msg.sender == _caller, "VAULT_NOT_UNLOCKED");
        _track(token);
        _sent[token] += amount;
        IERC20(token).safeTransfer(to, amount);
    }

    function settle(address token, uint256 amountHint) external returns (uint256 credit) {
        require(unlocked && msg.sender == _caller, "VAULT_NOT_UNLOCKED");
        _track(token);
        credit = amountHint;
        _settled[token] += credit;
    }

    function _track(address token) internal {
        if (_sent[token] == 0 && _settled[token] == 0) {
            _touched.push(token);
        }
    }

    function _reset() internal {
        for (uint256 i = 0; i < _touched.length; ++i) {
            _sent[_touched[i]] = 0;
            _settled[_touched[i]] = 0;
        }
        delete _touched;
    }
}
