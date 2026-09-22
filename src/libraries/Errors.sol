// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @notice Custom errors for `MorphoArbExecutor`.
/// @dev Kept in one library so off-chain decoders (the Rust/TS bots) can mirror a single
///      list, and so error selectors stay stable across refactors.
library Errors {
    // --- authorization / lifecycle ---
    error Unauthorized();
    error InvalidAddress();
    error InvalidState();
    error Paused();

    // --- request validation ---
    error InvalidToken();
    error InvalidAmount();
    error InvalidMinProfit();
    error InvalidRoute();
    error InvalidAdapter();
    error InvalidSlippage();
    error InvalidProvider();
    error InvalidRecipient();

    // --- flash-loan callback ---
    error CallbackNotAuthorized();
    error CallbackNotInvoked();
    error LoanNotActive();
    error InProgress();
    error RepaymentFailed();
    error InsufficientProfit(uint256 required, uint256 actual);

    // --- route execution ---
    error InsufficientBalance();
    error SwapFailed(uint256 index, uint256 amountOut, uint256 minAmountOut);
    error UnsupportedLegKind(uint8 kind);

    // --- whitelisted-call route ---
    error InvalidCallsLength(uint256 length);
    error InvalidTarget(address target);
    error InvalidSelector(address target, bytes4 selector);
    error ForbiddenSelector(address target, bytes4 selector);
    error NonZeroCallValue(uint256 value);
    error CallFailed(uint256 index, bytes returnData);
    error ErrorCodeReturned(uint256 index, uint256 errorCode);

    // --- per-asset limits ---
    error LoanSizeOutOfBounds(uint256 amount, uint256 minimum, uint256 maximum);

    // --- rescue ---
    error RescueFailed();
}
