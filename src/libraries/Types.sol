// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

/// @notice Shared data structures for `MorphoArbExecutor`.
/// @dev Two route encodings coexist deliberately:
///      - `AdapterRoute` is the structured, audited default for cross-DEX cycles. Every
///        field is validated (closed cycle, contiguous tokens, approved adapter, non-zero
///        `minAmountOut`) before a single external call is made.
///      - `Call[]` is the escape hatch inherited from the liquidation design: an arbitrary
///        but strictly whitelisted (target, selector) sequence. It exists because a
///        Moonwell liquidation is not expressible as a token cycle: it is
///        `approve` + `liquidateBorrow` + `approve` + `swap`.
///      Forcing one encoding onto both would either lose the route validation or make the
///      liquidation impossible, so both are supported and validated separately.
library Types {
    /// @notice DEX family discriminator consumed by `FlashArbitrage`-style swap dispatch.
    /// @dev Values are carried over unchanged from the Rust bot's `SwapLeg.kind` so existing
    ///      off-chain encoders keep working.
    uint8 internal constant KIND_UNISWAP_V2 = 0;
    uint8 internal constant KIND_AERODROME = 1;
    uint8 internal constant KIND_UNISWAP_V3 = 2;
    uint8 internal constant KIND_UNISWAP_V4 = 3;
    uint8 internal constant KIND_SLIPSTREAM = 4;

    /// @notice One swap leg executed through a registered adapter contract.
    /// @param adapter        Adapter contract (must be approved in the executor).
    /// @param tokenIn        Token sold on this leg.
    /// @param tokenOut       Token bought on this leg.
    /// @param amountIn       Exact input; `0` means "use the full output of the previous leg".
    /// @param minAmountOut   Slippage floor. MUST be non-zero: a zero floor turns a sandwich
    ///                       into an unbounded loss.
    /// @param kind           DEX family, see the `KIND_*` constants.
    /// @param poolData       Adapter-specific pool descriptor (fee tier, stable flag, factory,
    ///                       tick spacing, hooks, ...). Opaque to the executor.
    struct SwapStep {
        address adapter;
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint256 minAmountOut;
        uint8 kind;
        bytes poolData;
    }

    /// @notice Structured, closed-cycle route: `swaps[0].tokenIn == loanToken` and
    ///         `swaps[last].tokenOut == loanToken`.
    /// @param swaps       Ordered legs.
    /// @param minProfit   On-chain profit floor in `profitToken` units.
    struct AdapterRoute {
        SwapStep[] swaps;
        uint256 minProfit;
    }

    /// @notice One whitelisted external call (liquidation escape hatch).
    /// @param target  Contract to call; must be whitelisted.
    /// @param value   Native value. MUST be zero: no route needs to donate ETH.
    /// @param data    Calldata; its selector must be whitelisted for `target`.
    struct Call {
        address target;
        uint256 value;
        bytes data;
    }

    /// @notice Flash-loan provider selector.
    /// @dev The three providers differ in repayment mechanism, which is why the executor
    ///      cannot treat them as interchangeable:
    ///      - `Morpho` (V1/V2): Morpho pulls the loan back with `transferFrom`, so the
    ///        executor must `approve` it. Fee is zero. Callback: `onMorphoFlashLoan`.
    ///      - `BalancerV2`: the Vault checks its own post-callback balance, so the executor
    ///        must `transfer` the tokens back itself. `feeAmounts` is always zero.
    ///        Callback: `receiveFlashLoan`.
    ///      - `BalancerV3`: the Vault credits a transient delta inside `unlock`; the executor
    ///        must `transfer` to the Vault then call `settle(token, amountHint)`. There is no
    ///        flash-loan fee at all in V3, so nothing is added to the repayment.
    ///        Callback: `unlockCallback`, reached via `unlock(abi.encodeCall(...))`.
    enum LoanProvider {
        Morpho,
        BalancerV2,
        BalancerV3
    }

    /// @notice Which route encoding a request uses.
    enum RouteMode {
        AdapterRoute,
        WhitelistedCalls
    }

    /// @notice Fully-specified execution request.
    /// @param loanProvider  Flash-loan source.
    /// @param loanToken     Token borrowed; also the token the cycle must return in.
    /// @param loanAmount    Amount borrowed, in loan-token base units.
    /// @param minProfit     On-chain profit floor in loan-token units. MUST be non-zero live.
    /// @param profitReceiver Where verified profit is sent.
    /// @param mode          Route encoding selector.
    /// @param route         Structured adapter route (when `mode == AdapterRoute`).
    /// @param calls         Whitelisted call list (when `mode == WhitelistedCalls`).
    struct ExecutionRequest {
        LoanProvider loanProvider;
        address loanToken;
        uint256 loanAmount;
        uint256 minProfit;
        address profitReceiver;
        RouteMode mode;
        AdapterRoute route;
        Call[] calls;
    }
}
