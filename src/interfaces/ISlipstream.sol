// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @notice Minimal Aerodrome Slipstream (concentrated-liquidity) surfaces.
/// @dev Slipstream is a CL fork, but its pool identity is a `tickSpacing` (`int24`), not a
///      Uniswap V3 fee tier. The structs below are the router's real ABI, read from the
///      verified source of the Base deployment at `0xBE6D8f0d...`:
///
///      - `exactInputSingle` is the 8-field `ExactInputSingleParams` with both a `deadline`
///        and a `tickSpacing` (selector `0xa026383e`). It differs from Uniswap V3's
///        `SwapRouter02` (7 fields, `uint24 fee`, no deadline) in both the pool descriptor
///        and the presence of a deadline, so the two encodings are not interchangeable.
///      - the swap path packs the pool as `tokenIn | tickSpacing | tokenOut`.
///
///      `factory()` is exposed because Aerodrome runs **two** CL generations on Base, each
///      with its own factory and router, and a router only ever swaps against pools minted by
///      its own factory. See `SlipstreamAdapter` for why that matters.
interface ISlipstreamRouter {
    struct ExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        int24 tickSpacing;
        address recipient;
        uint256 deadline;
        uint256 amountIn;
        uint256 amountOutMinimum;
        uint160 sqrtPriceLimitX96;
    }

    /// @notice Swaps `amountIn` of `tokenIn` for `tokenOut` through one Slipstream pool.
    /// @dev The router checks `block.timestamp <= deadline` and reverts `"Transaction too old"`
    ///      otherwise, so a zero or stale deadline fails before any swap happens. The pool is
    ///      resolved from `tickSpacing` against the router's own factory.
    function exactInputSingle(ExactInputSingleParams calldata params)
        external
        payable
        returns (uint256 amountOut);

    /// @notice The CL factory this router was deployed against.
    function factory() external view returns (address);
}

/// @notice Slipstream `QuoterV2`, used for live pricing in tests.
/// @dev Not `view`: like Uniswap's QuoterV2 it reverts internally to return its result, so a
///      `staticcall` wrapper does not work and callers must treat it as state-changing.
///      A quoter also belongs to exactly one factory; `factory()` lets a caller prove which.
interface ISlipstreamQuoterV2 {
    struct QuoteExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        int24 tickSpacing;
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

    function factory() external view returns (address);
}

/// @notice Slipstream factory, used to resolve and validate that a pool belongs to the venue.
interface ISlipstreamFactory {
    function getPool(address tokenA, address tokenB, int24 tickSpacing)
        external
        view
        returns (address);
    function isPool(address pool) external view returns (bool);
}
