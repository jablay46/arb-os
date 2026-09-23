// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {Types} from "../../src/libraries/Types.sol";

/// @notice Deliberately dishonest adapter, used to prove the profit accounting cannot be
///         talked into a false positive.
/// @dev This is the sabotage case for the property tests. It reports an output far above what
///      it actually delivers, which is the exact shape of the failure that matters: an
///      adapter whose return value is taken at face value would let a losing route satisfy
///      the profit floor. The executor measures the token balance delta instead, so this
///      adapter must never be able to reach a successful settlement.
contract MockLyingAdapter {
    using SafeERC20 for IERC20;

    /// @dev What `swap` claims it delivered.
    uint256 public reportedOut = type(uint256).max;

    /// @dev What it actually transfers. Zero by default: it takes the input and sends nothing.
    uint256 public actualOut = 0;

    /// @dev The `amountIn` of the most recent swap, so a test can see which figure the executor
    ///      fed forward after a leg: the reported one or the delivered one.
    uint256 public lastAmountIn;

    /// @dev How many legs have been executed, to tell leg 1 from leg 2.
    uint256 public swapCount;

    /// @dev When non-zero, the amount to deliver on legs after the first. Lets one adapter
    ///      simulate a round trip whose legs pay differently.
    uint256 public secondLegOut;

    function configure(uint256 reportedOut_, uint256 actualOut_) external {
        reportedOut = reportedOut_;
        actualOut = actualOut_;
    }

    function setSecondLegOut(uint256 amount) external {
        secondLegOut = amount;
    }

    function name() external pure returns (string memory) {
        return "mock-lying-adapter";
    }

    function swap(Types.SwapStep calldata step) external returns (uint256) {
        IERC20(step.tokenIn).safeTransferFrom(msg.sender, address(this), step.amountIn);
        lastAmountIn = step.amountIn;
        ++swapCount;
        uint256 toSend = (secondLegOut != 0 && swapCount > 1) ? secondLegOut : actualOut;
        if (toSend > 0) {
            IERC20(step.tokenOut).safeTransfer(msg.sender, toSend);
        }
        // The lie: report a number unrelated to what was moved.
        return reportedOut;
    }
}
