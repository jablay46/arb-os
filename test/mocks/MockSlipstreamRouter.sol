// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {ISlipstreamRouter} from "../../src/interfaces/ISlipstream.sol";

/// @notice Minimal Slipstream `SwapRouter` stand-in for adapter unit tests.
/// @dev Mirrors the real router's observable behaviour: it pulls `amountIn` from the caller,
///      enforces `amountOutMinimum` with the same `"Too little received"` reason, reverts when
///      `block.timestamp > deadline`, and reports a `factory()`. It also records the exact
///      params it received so a test can assert the adapter encoded `tickSpacing`, `recipient`
///      and `deadline` correctly -- the encoding is the part most likely to be silently wrong.
contract MockSlipstreamRouter is ISlipstreamRouter {
    using SafeERC20 for IERC20;

    /// @dev Output per 1e18 input, in 1e18 fixed point (1.05e18 = +5%).
    uint256 public rateE18 = 1e18;

    /// @dev The factory this mock pretends to belong to. Distinct from the adapter's real
    ///      deployment addresses because these unit tests are offline.
    address public mockFactory = address(0xFAC);

    /// @dev Last params seen, for encoding assertions.
    ExactInputSingleParams public lastParams;
    bool public called;

    function setRate(uint256 rateE18_) external {
        rateE18 = rateE18_;
    }

    function setFactory(address factory_) external {
        mockFactory = factory_;
    }

    /// @inheritdoc ISlipstreamRouter
    function factory() external view returns (address) {
        return mockFactory;
    }

    function exactInputSingle(ExactInputSingleParams calldata params)
        external
        payable
        returns (uint256 amountOut)
    {
        require(block.timestamp <= params.deadline, "Transaction too old");

        lastParams = params;
        called = true;

        IERC20(params.tokenIn).safeTransferFrom(msg.sender, address(this), params.amountIn);
        amountOut = (params.amountIn * rateE18) / 1e18;
        require(amountOut >= params.amountOutMinimum, "Too little received");
        IERC20(params.tokenOut).safeTransfer(params.recipient, amountOut);
    }
}
