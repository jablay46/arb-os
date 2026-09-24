// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IAdapter} from "../interfaces/IAdapter.sol";
import {ISlipstreamRouter} from "../interfaces/ISlipstream.sol";
import {Types} from "../libraries/Types.sol";

/// @notice Adapter for Aerodrome Slipstream (Base's concentrated-liquidity AMM).
/// @dev `poolData` is the ABI-encoded `(int24 tickSpacing, address factory)`:
///      `abi.encode(tickSpacing, factory)`. Unlike Uniswap V3, the pool descriptor is an
///      `int24` tick spacing and not a `uint24` fee tier; WETH/USDC alone has Slipstream pools
///      at tick spacings 1, 10, 50, 100, 200 and 2000.
///
///      **The `factory` field is not decoration; it is a consistency check.** Aerodrome runs
///      two Slipstream CL generations on Base and both are live. Each generation has its own
///      factory, router, and quoter, and a router only ever swaps against pools minted by its
///      own factory:
///
///      | | old generation | new generation |
///      |---|---|---|
///      | factory | `0x5e7BB104...` | `0xf8f2eB49...` |
///      | router  | `0xBE6D8f0d...` | `0x698Cb2b6...` |
///      | tickSpacing | 1, 100 | 1, 10, 50 |
///
///      Both routers share the same `exactInputSingle` selector (`0xa026383e`), so the two
///      generations are indistinguishable from calldata alone. A router resolves the pool for
///      a given `(tokenIn, tokenOut, tickSpacing)` against **its own** factory, so a leg that
///      was priced against the other generation's pool would execute against a different pool
///      at a different price. The constructor records the router's own `factory()`, and
///      `swap` refuses a leg whose `poolData` names any other factory. A cross-generation
///      misconfiguration therefore reverts instead of filling at an unexpected price.
///
///      One adapter is bound to one router; supporting the other generation is a second
///      deployment, mirroring how the other adapters treat a router upgrade as a new adapter.
contract SlipstreamAdapter is IAdapter {
    using SafeERC20 for IERC20;

    /// @notice Slipstream `SwapRouter`. Immutable: a router upgrade is a new adapter.
    address public immutable router;

    /// @notice The CL factory `router` was deployed against, read from the router itself.
    ///         Every leg must name this factory in its `poolData`.
    address public immutable factory;

    error WrongKind(uint8 expected, uint8 actual);
    error ZeroAddress();
    error AmountInZero();
    error FactoryMismatch(address expected, address actual);

    constructor(address router_) {
        if (router_ == address(0)) revert ZeroAddress();
        router = router_;

        // Read the pairing from the chain rather than accepting it as an argument: a
        // constructor argument could be set to the wrong generation's factory, which is
        // exactly the mismatch this adapter exists to catch.
        address factory_ = ISlipstreamRouter(router_).factory();
        if (factory_ == address(0)) revert ZeroAddress();
        factory = factory_;
    }

    /// @inheritdoc IAdapter
    function name() external pure returns (string memory) {
        return "slipstream";
    }

    /// @inheritdoc IAdapter
    /// @dev Reverts with the router's own error when the pool cannot fill the swap, and with
    ///      `Too little received` when the output is below `minAmountOut`. The executor still
    ///      verifies the balance delta rather than trusting the returned value.
    function swap(Types.SwapStep calldata step) external returns (uint256 amountOut) {
        if (step.kind != Types.KIND_SLIPSTREAM) {
            revert WrongKind(Types.KIND_SLIPSTREAM, step.kind);
        }
        if (step.amountIn == 0) revert AmountInZero();

        (int24 tickSpacing, address stepFactory) = abi.decode(step.poolData, (int24, address));
        if (stepFactory != factory) revert FactoryMismatch(factory, stepFactory);

        IERC20(step.tokenIn).safeTransferFrom(msg.sender, address(this), step.amountIn);
        IERC20(step.tokenIn).forceApprove(router, step.amountIn);

        amountOut = ISlipstreamRouter(router)
            .exactInputSingle(
                ISlipstreamRouter.ExactInputSingleParams({
                    tokenIn: step.tokenIn,
                    tokenOut: step.tokenOut,
                    tickSpacing: tickSpacing,
                    recipient: msg.sender,
                    // A profitable route has to land in the block it was priced for, so a
                    // caller-supplied deadline adds no protection a block builder cannot
                    // already give itself. `block.timestamp` satisfies the router's own check.
                    deadline: block.timestamp,
                    amountIn: step.amountIn,
                    amountOutMinimum: step.minAmountOut,
                    sqrtPriceLimitX96: 0
                })
            );

        // Clear the allowance so a failed or partial fill cannot leave a spendable approval
        // behind for the next leg.
        IERC20(step.tokenIn).forceApprove(router, 0);
    }
}
