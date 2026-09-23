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

/// @notice Minimal Uniswap V3 `QuoterV2` surface, used for live pricing.
/// @dev Not `view`: QuoterV2 reverts internally to return its result, so a `staticcall`
///      wrapper does not work and callers must treat it as a state-changing call.
interface IUniswapV3QuoterV2 {
    struct QuoteExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint24 fee;
        uint160 sqrtPriceLimitX96;
    }

    function quoteExactInputSingle(QuoteExactInputSingleParams memory params)
        external
        returns (
            uint256 amountOut,
            uint160 sqrtPriceX96After,
            uint32 initializedTicksCrossed,
            uint256 gasEstimate
        );
}
