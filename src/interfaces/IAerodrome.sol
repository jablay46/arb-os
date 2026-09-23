// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @notice Minimal Aerodrome `Router` surface.
/// @dev Aerodrome encodes a pool as `Route(from, to, stable, factory)` rather than
///      `(tokenIn, tokenOut, fee)`, because a pair can exist twice -- once as a volatile
///      (constant-product) pool and once as a stable (x^3+y^3=k) pool. The `stable` flag is
///      therefore part of the pool identity, not a hint, and `factory` selects which factory
///      the pool belongs to (Aerodrome has had more than one).
interface IAerodromeRouter {
    struct Route {
        address from;
        address to;
        bool stable;
        address factory;
    }

    /// @notice Factory used when a route does not name one.
    function defaultFactory() external view returns (address);

    /// @notice Quote for a multi-hop route; returns the amount out per hop.
    function getAmountsOut(uint256 amountIn, Route[] calldata routes)
        external
        view
        returns (uint256[] memory amounts);

    function swapExactTokensForTokens(
        uint256 amountIn,
        uint256 amountOutMin,
        Route[] calldata routes,
        address to,
        uint256 deadline
    ) external returns (uint256[] memory amounts);
}

interface IAerodromeFactory {
    function getPool(address tokenA, address tokenB, bool stable) external view returns (address);
}
