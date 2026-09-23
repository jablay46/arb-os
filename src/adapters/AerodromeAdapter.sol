// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IAerodromeRouter} from "../interfaces/IAerodrome.sol";
import {IAdapter} from "../interfaces/IAdapter.sol";
import {Types} from "../libraries/Types.sol";

/// @notice Adapter for Aerodrome (Base's largest native DEX).
/// @dev `poolData` is the ABI-encoded `(bool stable, address factory)`:
///      `abi.encode(stable, factory)`. `factory` may be `address(0)` to use the router's
///      `defaultFactory()`.
///
///      `stable` is genuinely part of the pool identity here, unlike a fee tier: a pair can
///      exist as both a volatile and a stable pool with the same tokens, and routing to the
///      wrong one either reverts or, worse, fills at a materially different price.
contract AerodromeAdapter is IAdapter {
    using SafeERC20 for IERC20;

    /// @notice Aerodrome `Router`. Immutable: a router upgrade is a new adapter.
    address public immutable router;

    error WrongKind(uint8 expected, uint8 actual);
    error ZeroAddress();
    error AmountInZero();

    constructor(address router_) {
        if (router_ == address(0)) revert ZeroAddress();
        router = router_;
    }

    /// @inheritdoc IAdapter
    function name() external pure returns (string memory) {
        return "aerodrome";
    }

    /// @inheritdoc IAdapter
    function swap(Types.SwapStep calldata step) external returns (uint256 amountOut) {
        if (step.kind != Types.KIND_AERODROME) revert WrongKind(Types.KIND_AERODROME, step.kind);
        if (step.amountIn == 0) revert AmountInZero();

        (bool stable, address factory) = abi.decode(step.poolData, (bool, address));
        if (factory == address(0)) factory = IAerodromeRouter(router).defaultFactory();

        IERC20(step.tokenIn).safeTransferFrom(msg.sender, address(this), step.amountIn);
        IERC20(step.tokenIn).forceApprove(router, step.amountIn);

        IAerodromeRouter.Route[] memory routes = new IAerodromeRouter.Route[](1);
        routes[0] = IAerodromeRouter.Route({
            from: step.tokenIn, to: step.tokenOut, stable: stable, factory: factory
        });

        // `deadline` is not part of the executor's step encoding. The transaction is
        // submitted by the operator and must land in the same block to be profitable at all,
        // so a deadline adds no protection a block builder cannot already give itself;
        // `block.timestamp` keeps the router's own expiry check satisfied.
        uint256[] memory amounts = IAerodromeRouter(router)
            .swapExactTokensForTokens(
                step.amountIn, step.minAmountOut, routes, msg.sender, block.timestamp
            );
        amountOut = amounts[amounts.length - 1];

        // Clearing the allowance keeps a partial fill from leaving a spendable approval
        // behind for the next leg.
        IERC20(step.tokenIn).forceApprove(router, 0);
    }
}
