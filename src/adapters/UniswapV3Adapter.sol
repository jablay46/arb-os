// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IAdapter} from "../interfaces/IAdapter.sol";
import {ISwapRouter02} from "../interfaces/IUniswapV3.sol";
import {Types} from "../libraries/Types.sol";

/// @notice Adapter for Uniswap V3 style concentrated-liquidity routers.
/// @dev `poolData` is the ABI-encoded fee tier:
///      `abi.encode(uint24 fee)` where `fee` is one of 100, 500, 3000, 10000.
///
///      The executor approves this contract for exactly `step.amountIn` and clears the
///      allowance afterwards, so the router only ever spends what this adapter forwards.
///      Output is sent straight to the caller (the executor) rather than routed through this
///      contract, which keeps the executor's balance-delta measurement honest and leaves no
///      tokens sitting here between legs.
contract UniswapV3Adapter is IAdapter {
    using SafeERC20 for IERC20;

    /// @notice Uniswap V3 `SwapRouter02`. Immutable: a router upgrade is a new adapter.
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
        return "uniswap-v3";
    }

    /// @inheritdoc IAdapter
    /// @dev Reverts with the router's own error when the pool cannot fill the swap, and with
    ///      the router's `Too little received` when the output is below `minAmountOut`. No
    ///      separate check is needed here, but the executor verifies the balance delta anyway.
    function swap(Types.SwapStep calldata step) external returns (uint256 amountOut) {
        if (step.kind != Types.KIND_UNISWAP_V3) revert WrongKind(Types.KIND_UNISWAP_V3, step.kind);
        if (step.amountIn == 0) revert AmountInZero();

        uint24 fee = abi.decode(step.poolData, (uint24));

        IERC20(step.tokenIn).safeTransferFrom(msg.sender, address(this), step.amountIn);
        IERC20(step.tokenIn).forceApprove(router, step.amountIn);

        amountOut = ISwapRouter02(router)
            .exactInputSingle(
                ISwapRouter02.ExactInputSingleParams({
                    tokenIn: step.tokenIn,
                    tokenOut: step.tokenOut,
                    fee: fee,
                    recipient: msg.sender,
                    amountIn: step.amountIn,
                    amountOutMinimum: step.minAmountOut,
                    sqrtPriceLimitX96: 0
                })
            );

        // The router pulls exactly `amountIn`, but clearing the allowance keeps a failed or
        // partial fill from leaving a spendable approval behind for the next route.
        IERC20(step.tokenIn).forceApprove(router, 0);
    }
}
