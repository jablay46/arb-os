// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Types} from "../libraries/Types.sol";

/// @notice Uniform adapter surface for every DEX family.
/// @dev The executor owns route validation and profit accounting; an adapter owns exactly
///      one thing: turning `amountIn` of `step.tokenIn` into `step.tokenOut` through its
///      own router, reverting if it cannot meet `step.minAmountOut`.
///      Adapters are trusted (allow-listed) contracts, but the executor still measures the
///      token balance delta around the call instead of trusting the returned value.
interface IAdapter {
    /// @notice Executes one swap leg.
    /// @dev Implementations MUST:
    ///      - pull `amountIn` of `step.tokenIn` from `msg.sender` (the executor),
    ///      - send the output to `msg.sender`,
    ///      - revert when the realised output is below `step.minAmountOut`,
    ///      - never leave a residual allowance behind.
    /// @param step Leg to execute. `step.amountIn` is guaranteed non-zero by the executor.
    /// @return amountOut Tokens delivered to the caller.
    function swap(Types.SwapStep calldata step) external returns (uint256 amountOut);

    /// @notice Human-readable adapter id (e.g. "uniswap-v3"), used for logging and wiring.
    function name() external view returns (string memory);
}
