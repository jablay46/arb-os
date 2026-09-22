// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @notice Balancer V2 Vault flash loans.
/// @dev Zero fee in practice: `_calculateFlashLoanFeeAmount` is hardcoded to 0 in
///      `FlashLoans.sol`, so `feeAmounts` is always a zero array. Do not rely on that
///      blindly -- the callback still receives `feeAmounts` and the executor repays
///      `amounts[i] + feeAmounts[i]`, so a future fee would be honoured rather than
///      silently defaulted.
///      Repayment mechanism: the Vault re-reads its OWN balance after the callback and
///      requires `postLoanBalance >= preLoanBalance`. The borrower must therefore
///      **transfer** the tokens back; an `approve` is not enough (unlike Morpho).
interface IBalancerV2Vault {
    function flashLoan(
        IBalancerV2FlashLoanRecipient recipient,
        address[] memory tokens,
        uint256[] memory amounts,
        bytes memory userData
    ) external;
}

/// @notice Callback invoked by the Balancer V2 Vault mid-flash-loan.
interface IBalancerV2FlashLoanRecipient {
    function receiveFlashLoan(
        address[] memory tokens,
        uint256[] memory amounts,
        uint256[] memory feeAmounts,
        bytes memory userData
    ) external;
}

/// @notice Balancer V3 Vault transient-accounting surface used for flash loans.
/// @dev V3 has no dedicated `flashLoan` entry point. A flash loan is expressed as an
///      `unlock` window in which the borrower:
///        1. `sendTo(token, self, amount)`   -- pull the loan out of the Vault,
///        2. does whatever it wants,
///        3. transfers the tokens back to the Vault and `settle(token, amountHint)`,
///      and every token delta must net to zero before the lock is released.
///      Fee is read from `getFlashLoanFeePercentage()` (18-decimal fixed point) and is
///      expected to be zero; the executor does not assume it.
///      `settle`/`sendTo` take an `IERC20` in the canonical interface; `address` is used
///      here because the ABI encoding is identical and it avoids an extra import.
interface IBalancerV3Vault {
    function unlock(bytes calldata data) external returns (bytes memory result);

    function settle(address token, uint256 amountHint) external returns (uint256 credit);

    function sendTo(address token, address to, uint256 amount) external;

    function getFlashLoanFeePercentage() external view returns (uint256);
}

/// @notice Callback invoked by the Balancer V3 Vault inside `unlock`.
interface IBalancerV3UnlockCallback {
    function unlockCallback(bytes calldata data) external returns (bytes memory);
}
