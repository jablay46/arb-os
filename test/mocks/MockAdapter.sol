// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {Types} from "../../src/libraries/Types.sol";

/// @notice Adapter stand-in that pays a fixed multiplier of its input.
/// @dev Lets the tests exercise route validation and profit accounting without a real DEX.
contract MockAdapter {
    using SafeERC20 for IERC20;

    /// @dev Output per 1e18 input, in 1e18 fixed point (1.05e18 = +5%).
    uint256 public rateE18 = 1e18;

    function setRate(uint256 rateE18_) external {
        rateE18 = rateE18_;
    }

    function name() external pure returns (string memory) {
        return "mock-adapter";
    }

    function swap(Types.SwapStep calldata step) external returns (uint256 amountOut) {
        IERC20(step.tokenIn).safeTransferFrom(msg.sender, address(this), step.amountIn);
        amountOut = (step.amountIn * rateE18) / 1e18;
        require(amountOut >= step.minAmountOut, "MIN_OUT");
        IERC20(step.tokenOut).safeTransfer(msg.sender, amountOut);
    }
}
