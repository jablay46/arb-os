// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @notice Minimal Uniswap V3 `SwapRouter02` surface.
/// @dev `SwapRouter02` (the Base deployment at `0x2626664c...`) uses the 7-field
///      `ExactInputSingleParams` with no `deadline`; the older `SwapRouter` variant has an
///      8-field struct with a deadline and a different selector (`0x414bf389` vs
///      `0x04e45aaf`). Base runs `SwapRouter02`, so the deadline is deliberately absent.
///      Sending the wrong encoding would revert, not silently misprice.
interface ISwapRouter02 {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint24 fee;
        address recipient;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    function exactInputSingle(ExactInputSingleParams calldata params)
        external
        payable
        returns (uint256 amountOut);
}
