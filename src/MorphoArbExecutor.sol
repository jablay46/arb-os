// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {IMorphoFlashLoan, IMorphoFlashLoanCallback} from "./interfaces/IMorpho.sol";
import {
    IBalancerV2Vault,
    IBalancerV2FlashLoanRecipient,
    IBalancerV3Vault,
    IBalancerV3UnlockCallback
} from "./interfaces/IBalancer.sol";
import {IAdapter} from "./interfaces/IAdapter.sol";
import {Types} from "./libraries/Types.sol";
import {Errors} from "./libraries/Errors.sol";

/// @title MorphoArbExecutor
/// @notice Flash-loan-funded arbitrage executor for Base, merging three prior designs:
///         the router coverage and simulation-friendly leg encoding of the Rust bot, the
///         role separation and call whitelisting of the Moonwell liquidation bot, and the
///         structured closed-cycle route validation of the TypeScript bot.
///
/// @dev Design decisions worth knowing before reading further:
///
///      **Three flash-loan providers, three repayment mechanisms.** Morpho pulls the loan
///      back via `transferFrom` (approve required); Balancer V2 re-reads its own balance
///      (transfer required); Balancer V3 uses transient deltas settled by `settle`
///      (transfer + settle required). The executor branches on `LoanProvider` rather than
///      pretending they are uniform, because getting this wrong means the callback reverts.
///
///      **The whole post-callback balance goes back to the initiator.** The prior Rust
///      contract swept only `profit` to the owner and left any pre-existing balance
///      stranded in the contract. Here `balanceAfter - loanAmount` is returned, so idle
///      funds are never trapped mid-route.
///
///      **`minProfit == 0` is rejected.** A zero floor combined with a loss-clamping
///      comparison is how a "successful" transaction ends up paying for a losing trade.
///
///      **Two route encodings.** See `Types`: structured `AdapterRoute` for DEX cycles,
///      whitelisted `Call[]` for liquidations that are not token cycles.
contract MorphoArbExecutor is
    AccessControl,
    Pausable,
    ReentrancyGuard,
    IMorphoFlashLoanCallback,
    IBalancerV2FlashLoanRecipient,
    IBalancerV3UnlockCallback
{
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------------
    // Roles
    // ---------------------------------------------------------------------

    /// @notice Cold-wallet role: whitelists, limits, treasury, rescue, role management.
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    /// @notice Hot-wallet role: may only trigger arbitrage.
    bytes32 public constant OPERATOR_ROLE = keccak256("OPERATOR_ROLE");
    /// @notice Emergency stop only; cannot unpause.
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    // ---------------------------------------------------------------------
    // Constants
    // ---------------------------------------------------------------------

    /// @notice Upper bound on the whitelisted-call route length (gas-griefing guard).
    uint256 public constant MAX_CALLS = 20;

    // ---------------------------------------------------------------------
    // Immutables
    // ---------------------------------------------------------------------

    address public immutable morpho;
    address public immutable balancerV2Vault;
    address public immutable balancerV3Vault;

    // ---------------------------------------------------------------------
    // Storage
    // ---------------------------------------------------------------------

    /// @notice Receives verified profit. Admin-controlled so a compromised operator key
    ///         cannot redirect the proceeds of its own trades.
    address public treasury;

    /// @notice Adapters permitted in an `AdapterRoute`.
    mapping(address => bool) public approvedAdapter;
    /// @notice Contracts permitted as `Call.target` in a whitelisted-call route.
    mapping(address => bool) public isTargetWhitelisted;
    /// @notice Selectors permitted per whitelisted target.
    mapping(address => mapping(bytes4 => bool)) public isCallWhitelisted;
    /// @notice Per-asset loan-size floors/ceilings (`0` ceiling = unbounded).
    mapping(address => uint256) public minLoanSize;
    mapping(address => uint256) public maxLoanSize;

    /// @dev In-flight loan bookkeeping. Set in `execute`/`unlockCallback` entry, cleared
    ///      after the callback completes; doubles as the reentrancy guard for callbacks.
    address internal _loanToken;
    uint256 internal _loanAmount;
    uint256 internal _loanFee;
    uint256 internal _balanceBeforeLoan;
    address internal _initiator;
    Types.LoanProvider internal _provider;
    bool internal _callbackInvoked;

    // ---------------------------------------------------------------------
    // Events
    // ---------------------------------------------------------------------

    event ArbExecuted(
        address indexed initiator,
        address indexed loanToken,
        uint256 loanAmount,
        uint256 profit,
        Types.LoanProvider provider
    );
    event AdapterApproved(address indexed adapter, bool status);
    event TargetWhitelisted(address indexed target, bool status);
    event CallSelectorWhitelisted(address indexed target, bytes4 indexed selector, bool status);
    event TreasuryUpdated(address indexed previousTreasury, address indexed newTreasury);
    event LoanSizeLimitsUpdated(address indexed asset, uint256 minimum, uint256 maximum);
    event Rescued(address indexed token, address indexed to, uint256 amount);

    // ---------------------------------------------------------------------
    // Construction
    // ---------------------------------------------------------------------

    /// @param morpho_          Morpho Blue address (zero disables the provider).
    /// @param balancerV2Vault_ Balancer V2 Vault (zero disables the provider).
    /// @param balancerV3Vault_ Balancer V3 Vault (zero disables the provider).
    /// @param admin            Initial ADMIN + PAUSER holder (a cold key).
    /// @dev `OPERATOR_ROLE` is deliberately NOT granted here. The liquidation bot granted all
    ///      four roles at construction and relied on a follow-up setup script to revoke
    ///      `OPERATOR_ROLE` from the admin -- forget that step and the cold wallet can move
    ///      funds forever. Separation is the safe default, so the operator key must be granted
    ///      explicitly via `grantRole(OPERATOR_ROLE, hotKey)`.
    constructor(
        address morpho_,
        address balancerV2Vault_,
        address balancerV3Vault_,
        address admin
    ) {
        if (admin == address(0)) revert Errors.InvalidAddress();
        morpho = morpho_;
        balancerV2Vault = balancerV2Vault_;
        balancerV3Vault = balancerV3Vault_;
        treasury = admin;

        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(ADMIN_ROLE, admin);
        _grantRole(PAUSER_ROLE, admin);
    }

    // ---------------------------------------------------------------------
    // Entry points
    // ---------------------------------------------------------------------

    /// @notice Borrows `request.loanAmount` via the selected provider and runs the route.
    /// @dev `nonReentrant` here and on the callbacks is defence in depth: the callback also
    ///      requires the in-flight flag, so a stray direct call cannot be used as a free
    ///      entry point even if the lock were bypassed.
    function execute(Types.ExecutionRequest calldata request)
        external
        onlyRole(OPERATOR_ROLE)
        whenNotPaused
        nonReentrant
    {
        _validateRequest(request);

        _loanToken = request.loanToken;
        _loanAmount = request.loanAmount;
        _loanFee = 0;
        _initiator = msg.sender;
        _provider = request.loanProvider;
        _callbackInvoked = false;
        // Snapshot before the provider moves any tokens: profit is measured against this,
        // not against the loan amount, so idle balances are neither counted as profit nor
        // stranded in the contract afterwards.
        _balanceBeforeLoan = IERC20(request.loanToken).balanceOf(address(this));

        bytes memory data = abi.encode(request);

        if (request.loanProvider == Types.LoanProvider.Morpho) {
            IMorphoFlashLoan(morpho).flashLoan(request.loanToken, request.loanAmount, data);
        } else if (request.loanProvider == Types.LoanProvider.BalancerV2) {
            address[] memory tokens = new address[](1);
            uint256[] memory amounts = new uint256[](1);
            tokens[0] = request.loanToken;
            amounts[0] = request.loanAmount;
            IBalancerV2Vault(balancerV2Vault)
                .flashLoan(IBalancerV2FlashLoanRecipient(address(this)), tokens, amounts, data);
        } else {
            // Balancer V3: the loan is pulled inside the unlock window, not before it.
            // `unlock` does `msg.sender.functionCall(data)`, so `data` must be a complete
            // call to our own callback -- passing bare request bytes would be dispatched as
            // an empty call and revert with `FailedInnerCall`.
            IBalancerV3Vault(balancerV3Vault)
                .unlock(abi.encodeCall(IBalancerV3UnlockCallback.unlockCallback, (data)));
        }

        // A provider that returns without ever invoking the callback would otherwise be a
        // silent no-op that still looks like a mined, successful arbitrage transaction.
        if (!_callbackInvoked) revert Errors.CallbackNotInvoked();

        _clearLoanState();
    }

    // ---------------------------------------------------------------------
    // Callbacks
    // ---------------------------------------------------------------------

    /// @inheritdoc IMorphoFlashLoanCallback
    function onMorphoFlashLoan(uint256 assets, bytes calldata data) external override {
        if (msg.sender != morpho) revert Errors.CallbackNotAuthorized();
        if (_provider != Types.LoanProvider.Morpho) revert Errors.LoanNotActive();
        if (assets != _loanAmount) revert Errors.InvalidAmount();
        _callbackInvoked = true;

        Types.ExecutionRequest memory request = abi.decode(data, (Types.ExecutionRequest));
        _runRoute(request);

        // Morpho pulls the repayment with `transferFrom` after this callback returns.
        _forceApprove(_loanToken, morpho, _loanAmount);
        _settleProfit(request);
    }

    /// @inheritdoc IBalancerV2FlashLoanRecipient
    function receiveFlashLoan(
        address[] memory tokens,
        uint256[] memory amounts,
        uint256[] memory feeAmounts,
        bytes memory userData
    ) external override {
        if (msg.sender != balancerV2Vault) {
            revert Errors.CallbackNotAuthorized();
        }
        if (_provider != Types.LoanProvider.BalancerV2) revert Errors.LoanNotActive();
        if (tokens.length != 1 || amounts.length != 1 || feeAmounts.length != 1) {
            revert Errors.InvalidRoute();
        }
        if (tokens[0] != _loanToken || amounts[0] != _loanAmount) revert Errors.InvalidAmount();

        _callbackInvoked = true;
        _loanFee = feeAmounts[0];

        Types.ExecutionRequest memory request = abi.decode(userData, (Types.ExecutionRequest));
        _runRoute(request);

        // The Vault re-reads its own balance, so the loan must be transferred, not approved.
        // The floor is checked first: a bare `transfer` of an unaffordable amount reverts
        // with an empty ERC20 error, which would hide the real cause from the operator.
        _requireRepayable(request);
        IERC20(_loanToken).safeTransfer(balancerV2Vault, _loanAmount + _loanFee);
        _settleProfit(request);
    }

    /// @inheritdoc IBalancerV3UnlockCallback
    function unlockCallback(bytes calldata data) external override returns (bytes memory) {
        if (msg.sender != balancerV3Vault) revert Errors.CallbackNotAuthorized();
        if (_provider != Types.LoanProvider.BalancerV3) revert Errors.LoanNotActive();
        _callbackInvoked = true;

        Types.ExecutionRequest memory request = abi.decode(data, (Types.ExecutionRequest));

        // Pull the loan out of the Vault; only possible inside this unlock window.
        IBalancerV3Vault(balancerV3Vault).sendTo(_loanToken, address(this), _loanAmount);

        _loanFee = _balancerV3Fee(_loanAmount);
        _runRoute(request);

        // V3 tracks a transient delta per token: the balance has to reach the Vault and then
        // be declared with `settle`, or the lock will not be released. As on the V2 path,
        // check the floor before moving money so the failure reason survives.
        uint256 owed = _loanAmount + _loanFee;
        _requireRepayable(request);
        IERC20(_loanToken).safeTransfer(balancerV3Vault, owed);
        IBalancerV3Vault(balancerV3Vault).settle(_loanToken, owed);

        _settleProfit(request);
        return "";
    }

    // ---------------------------------------------------------------------
    // Route execution
    // ---------------------------------------------------------------------

    /// @dev Dispatches on the request's route encoding. Both paths share the same profit
    ///      accounting, which happens once in `_settleProfit`.
    function _runRoute(Types.ExecutionRequest memory request) internal {
        if (request.mode == Types.RouteMode.AdapterRoute) {
            _executeAdapterRoute(request.route);
        } else {
            _executeWhitelistedCalls(request.calls);
        }
    }

    function _executeAdapterRoute(Types.AdapterRoute memory route) internal {
        uint256 currentAmount = _loanAmount;

        for (uint256 i = 0; i < route.swaps.length; ++i) {
            Types.SwapStep memory step = route.swaps[i];
            // `amountIn == 0` means "use the full output of the previous leg"; the resolved
            // value must be written back, because the adapter reads `step.amountIn` and would
            // otherwise be asked to swap zero.
            if (step.amountIn == 0) {
                step.amountIn = currentAmount;
            }

            if (step.amountIn > IERC20(step.tokenIn).balanceOf(address(this))) {
                revert Errors.InsufficientBalance();
            }

            IERC20(step.tokenIn).forceApprove(step.adapter, step.amountIn);
            uint256 balanceBefore = IERC20(step.tokenOut).balanceOf(address(this));
            IAdapter(step.adapter).swap(step);
            uint256 amountOut = IERC20(step.tokenOut).balanceOf(address(this)) - balanceBefore;
            IERC20(step.tokenIn).forceApprove(step.adapter, 0);

            // Measure the realised balance delta rather than trusting the adapter's return
            // value: an adapter that reports more than it delivered must not be able to
            // satisfy the profit floor.
            if (amountOut < step.minAmountOut) {
                revert Errors.SwapFailed(i, amountOut, step.minAmountOut);
            }
            currentAmount = amountOut;
        }
    }

    function _executeWhitelistedCalls(Types.Call[] memory calls) internal {
        for (uint256 i = 0; i < calls.length; ++i) {
            _validateCall(calls[i]);
            (bool ok, bytes memory ret) = calls[i].target.call{value: calls[i].value}(calls[i].data);
            if (!ok) revert Errors.CallFailed(i, ret);
            _checkCompoundErrorCode(i, calls[i].data, ret);
        }
    }

    // ---------------------------------------------------------------------
    // Profit accounting
    // ---------------------------------------------------------------------

    /// @dev The repayable check, run by the Balancer callbacks before any money moves. A bare
    ///      `transfer` of an unaffordable amount reverts with an empty ERC20 error, which would
    ///      hide the real cause from the operator; this turns that into a named error.
    ///
    ///      Deliberately uses the same `required`/`available` figures as `_settleProfit`, so a
    ///      floor violation reports identical numbers no matter which of the two catches it.
    ///      The debt is always still held at this point, on every provider.
    function _requireRepayable(Types.ExecutionRequest memory request) internal view {
        uint256 balance = IERC20(_loanToken).balanceOf(address(this));
        uint256 owed = _loanAmount + _loanFee;
        uint256 available = balance > owed ? balance - owed : 0;
        uint256 required = _balanceBeforeLoan + request.minProfit;

        if (available < required) revert Errors.InsufficientProfit(required, available);
    }

    /// @dev Profit is measured as "tokens the contract owns beyond what it started with",
    ///      which requires excluding the loan that must still be repaid. The three providers
    ///      settle repayment at different moments, so the exclusion differs:
    ///        - Morpho: repayment is pulled AFTER this returns, so the loan is still in the
    ///          balance and must be excluded explicitly.
    ///        - Balancer V2/V3: repayment already left the contract inside the callback, so
    ///          the balance is already net of the loan.
    ///      Everything the contract owns is then returned to the receiver. The Rust
    ///      predecessor swept only `profit` and left any pre-existing balance stranded; here
    ///      the pre-loan balance is returned too.
    ///
    ///      Reverts rather than clamping when the route lost money, so a loss can never be
    ///      reported as a zero-profit success.
    function _settleProfit(Types.ExecutionRequest memory request) internal {
        uint256 balance = IERC20(_loanToken).balanceOf(address(this));

        // Morpho still holds the loan, so it is not the contract's to spend.
        uint256 retained = _provider == Types.LoanProvider.Morpho ? _loanAmount + _loanFee : 0;
        uint256 netBalance = balance > retained ? balance - retained : 0;

        uint256 required = _balanceBeforeLoan + request.minProfit;
        if (netBalance < required) revert Errors.InsufficientProfit(required, netBalance);

        uint256 profit = netBalance - _balanceBeforeLoan;

        if (netBalance > 0) {
            IERC20(_loanToken).safeTransfer(request.profitReceiver, netBalance);
        }

        emit ArbExecuted(_initiator, _loanToken, _loanAmount, profit, _provider);
    }

    // ---------------------------------------------------------------------
    // Validation
    // ---------------------------------------------------------------------

    function _validateRequest(Types.ExecutionRequest calldata request) internal view {
        if (request.loanToken == address(0)) revert Errors.InvalidToken();
        if (request.loanAmount == 0) revert Errors.InvalidAmount();
        // A zero floor is never acceptable live: it removes the only on-chain backstop
        // against a route that silently loses value.
        if (request.minProfit == 0) revert Errors.InvalidMinProfit();
        if (request.profitReceiver == address(0)) revert Errors.InvalidRecipient();
        if (request.loanProvider == Types.LoanProvider.Morpho) {
            if (morpho == address(0)) revert Errors.InvalidProvider();
        } else if (request.loanProvider == Types.LoanProvider.BalancerV2) {
            if (balancerV2Vault == address(0)) revert Errors.InvalidProvider();
        } else {
            if (balancerV3Vault == address(0)) revert Errors.InvalidProvider();
        }

        uint256 minimum = minLoanSize[request.loanToken];
        uint256 maximum = maxLoanSize[request.loanToken];
        if (request.loanAmount < minimum) {
            revert Errors.LoanSizeOutOfBounds(request.loanAmount, minimum, maximum);
        }
        if (maximum != 0 && request.loanAmount > maximum) {
            revert Errors.LoanSizeOutOfBounds(request.loanAmount, minimum, maximum);
        }

        if (request.mode == Types.RouteMode.AdapterRoute) {
            _validateAdapterRoute(request.route, request.loanToken);
        } else {
            if (request.calls.length == 0 || request.calls.length > MAX_CALLS) {
                revert Errors.InvalidCallsLength(request.calls.length);
            }
            for (uint256 i = 0; i < request.calls.length; ++i) {
                _validateCall(request.calls[i]);
            }
        }
    }

    /// @dev Enforces a closed cycle: the route starts at the loan token, tokens are
    ///      contiguous across legs, and the last leg returns to the loan token. Without the
    ///      contiguity check a route could quietly swap into an unrelated token and leave
    ///      the executor holding it.
    function _validateAdapterRoute(Types.AdapterRoute memory route, address loanToken)
        internal
        view
    {
        uint256 length = route.swaps.length;
        if (length == 0) revert Errors.InvalidRoute();
        if (route.swaps[0].tokenIn != loanToken) revert Errors.InvalidRoute();

        for (uint256 i = 0; i < length; ++i) {
            Types.SwapStep memory step = route.swaps[i];
            if (step.adapter == address(0) || !approvedAdapter[step.adapter]) {
                revert Errors.InvalidAdapter();
            }
            if (step.tokenIn == address(0) || step.tokenOut == address(0)) {
                revert Errors.InvalidToken();
            }
            // A zero floor would let a sandwich drain the route with no on-chain objection.
            if (step.minAmountOut == 0) revert Errors.InvalidSlippage();
            if (i > 0 && step.tokenIn != route.swaps[i - 1].tokenOut) {
                revert Errors.InvalidRoute();
            }
        }

        if (route.swaps[length - 1].tokenOut != loanToken) revert Errors.InvalidRoute();
    }

    function _validateCall(Types.Call memory call) internal view {
        // No route needs native value; forbidding it stops an operator from donating the
        // contract's ETH balance into a payable call.
        if (call.value != 0) revert Errors.NonZeroCallValue(call.value);
        if (!isTargetWhitelisted[call.target]) revert Errors.InvalidTarget(call.target);

        bytes4 selector = _selector(call.data);
        if (!isCallWhitelisted[call.target][selector]) {
            revert Errors.InvalidSelector(call.target, selector);
        }
    }

    // ---------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------

    function setApprovedAdapter(address adapter, bool status) external onlyRole(ADMIN_ROLE) {
        if (adapter == address(0)) revert Errors.InvalidAddress();
        approvedAdapter[adapter] = status;
        emit AdapterApproved(adapter, status);
    }

    function setTreasury(address newTreasury) external onlyRole(ADMIN_ROLE) {
        if (newTreasury == address(0)) revert Errors.InvalidAddress();
        emit TreasuryUpdated(treasury, newTreasury);
        treasury = newTreasury;
    }

    function setLoanSizeLimits(address asset, uint256 minimum, uint256 maximum)
        external
        onlyRole(ADMIN_ROLE)
    {
        if (asset == address(0)) revert Errors.InvalidAddress();
        if (maximum != 0 && maximum < minimum) revert Errors.InvalidAmount();
        minLoanSize[asset] = minimum;
        maxLoanSize[asset] = maximum;
        emit LoanSizeLimitsUpdated(asset, minimum, maximum);
    }

    function addTargetToWhitelist(address target) external onlyRole(ADMIN_ROLE) {
        if (target == address(0)) revert Errors.InvalidAddress();
        isTargetWhitelisted[target] = true;
        emit TargetWhitelisted(target, true);
    }

    function removeTargetFromWhitelist(address target) external onlyRole(ADMIN_ROLE) {
        isTargetWhitelisted[target] = false;
        emit TargetWhitelisted(target, false);
    }

    function addCallSelectorToWhitelist(address target, bytes4 selector)
        external
        onlyRole(ADMIN_ROLE)
    {
        if (!isTargetWhitelisted[target]) revert Errors.InvalidTarget(target);
        if (selector == IERC20.transfer.selector || selector == IERC20.transferFrom.selector) {
            // Tokens are whitelisted targets (so `approve` works inside a route); allowing
            // transfer/transferFrom would let an operator drain idle balances.
            revert Errors.ForbiddenSelector(target, selector);
        }
        isCallWhitelisted[target][selector] = true;
        emit CallSelectorWhitelisted(target, selector, true);
    }

    function removeCallSelectorFromWhitelist(address target, bytes4 selector)
        external
        onlyRole(ADMIN_ROLE)
    {
        isCallWhitelisted[target][selector] = false;
        emit CallSelectorWhitelisted(target, selector, false);
    }

    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(ADMIN_ROLE) {
        _unpause();
    }

    /// @notice Rescues tokens stranded in the executor (dust from a partial run).
    function rescueToken(address token, address to, uint256 amount) external onlyRole(ADMIN_ROLE) {
        if (token == address(0) || to == address(0)) revert Errors.InvalidAddress();
        // Never touch the token backing an in-flight loan.
        if (token == _loanToken && _loanAmount != 0) revert Errors.InProgress();
        IERC20(token).safeTransfer(to, amount);
        emit Rescued(token, to, amount);
    }

    function rescueETH(address payable to, uint256 amount) external onlyRole(ADMIN_ROLE) {
        if (to == address(0)) revert Errors.InvalidAddress();
        (bool ok,) = to.call{value: amount}("");
        if (!ok) revert Errors.RescueFailed();
        emit Rescued(address(0), to, amount);
    }

    /// @dev Native ETH can arrive from a router refund; a payable receiver keeps it
    ///      recoverable via `rescueETH` instead of reverting the whole route.
    receive() external payable {}

    // ---------------------------------------------------------------------
    // Internals
    // ---------------------------------------------------------------------

    /// @dev Balancer V3 has no flash-loan fee and no fee getter. V2 charges a protocol fee
    ///      that is currently 0 on Base and is reported through `feeAmounts` in the callback,
    ///      so it is handled there. V3's fee is structurally zero: a flash loan is just a
    ///      transient delta that is rebalanced before the lock is released, with no fee term
    ///      anywhere in the Vault. Hardcoding zero here is therefore not an assumption about
    ///      configuration -- there is no configuration to read.
    function _balancerV3Fee(uint256) internal pure returns (uint256) {
        return 0;
    }

    /// @dev Compound-style markets (Moonwell) return an error code instead of reverting.
    ///      Surfacing it as a revert prevents a failed liquidation from being misreported
    ///      downstream as `InsufficientProfit`, which would send the operator hunting for a
    ///      pricing bug instead of a rejected market operation.
    function _checkCompoundErrorCode(uint256 index, bytes memory data, bytes memory ret)
        internal
        pure
    {
        if (ret.length < 32) return;
        bytes4 selector = _selector(data);
        if (selector == COMPOUND_LIQUIDATE_BORROW || selector == COMPOUND_REDEEM) {
            uint256 code = abi.decode(ret, (uint256));
            if (code != 0) revert Errors.ErrorCodeReturned(index, code);
        }
    }

    bytes4 internal constant COMPOUND_LIQUIDATE_BORROW = 0x715c9ecf; // liquidateBorrow(address,uint256,address)
    bytes4 internal constant COMPOUND_REDEEM = 0x852a12e3; // redeem(uint256)

    function _forceApprove(address token, address spender, uint256 amount) internal {
        IERC20(token).forceApprove(spender, 0);
        IERC20(token).forceApprove(spender, amount);
    }

    function _clearLoanState() internal {
        _loanToken = address(0);
        _loanAmount = 0;
        _loanFee = 0;
        _balanceBeforeLoan = 0;
        _initiator = address(0);
        _callbackInvoked = false;
    }

    function _selector(bytes memory data) internal pure returns (bytes4 selector) {
        if (data.length < 4) return bytes4(0);
        assembly {
            selector := mload(add(data, 32))
        }
    }
}
