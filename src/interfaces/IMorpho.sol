// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @notice Morpho Blue's flash-loan entry point.
/// @dev Morpho Blue charges no flash-loan fee; `assets` must be approved back to
///      Morpho by the end of the callback.
interface IMorphoFlashLoan {
    function flashLoan(address token, uint256 assets, bytes calldata data) external;
}

/// @notice The callback Morpho Blue invokes on the borrower mid-flash-loan.
interface IMorphoFlashLoanCallback {
    function onMorphoFlashLoan(uint256 assets, bytes calldata data) external;
}
