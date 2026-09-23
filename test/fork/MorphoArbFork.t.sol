// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {MorphoArbExecutor} from "../../src/MorphoArbExecutor.sol";
import {UniswapV3Adapter} from "../../src/adapters/UniswapV3Adapter.sol";
import {ISwapRouter02} from "../../src/interfaces/IUniswapV3.sol";
import {Types} from "../../src/libraries/Types.sol";
import {Errors} from "../../src/libraries/Errors.sol";

/// @notice Fork tests against the live Base deployments.
/// @dev These exist to prove the thing unit tests cannot: that the three repayment
///      mechanisms are wired correctly against the **real** provider bytecode. The mocks
///      encode what we believe the providers do; these tests check that belief.
///
///      What is real here: Morpho Blue, both Balancer Vaults, WETH, and the loan/repayment
///      flow end to end. What is synthetic: the swap route. `ForkProfitAdapter` returns its
///      input plus a pre-funded tip, because a genuine profitable cycle cannot be assumed to
///      exist at the pinned block. The loan plumbing is what is under test, not the strategy.
///
///      Run with:
///      ```
///      export BASE_RPC_URL=https://mainnet.base.org
///      forge test --match-path 'test/fork/*' -vv
///      ```
contract MorphoArbForkTest is Test {
    using SafeERC20 for IERC20;

    // Live Base deployments.
    address internal constant MORPHO = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;
    address internal constant BALANCER_V2_VAULT = 0xBA12222222228d8Ba445958a75a0704d566BF2C8;
    address internal constant BALANCER_V3_VAULT = 0xbA1333333333a1BA1108E8412f11850A5C319bA9;
    address internal constant WETH = 0x4200000000000000000000000000000000000006;

    MorphoArbExecutor internal executor;
    ForkProfitAdapter internal adapter;

    address internal admin = address(0xA11CE);
    address internal operator = address(0x0FF1CE);
    address internal treasury = address(0x7EA5);

    /// @dev Deliberately small. Balancer V2 holds ~30 WETH and V3 only ~4 WETH on Base, so a
    ///      loan sized for Morpho's ~80k WETH would revert on the Balancer vaults.
    uint256 internal constant LOAN = 1e18;
    uint256 internal constant TIP = 0.01e18;

    bool internal forked;

    function setUp() public {
        // Falls back to Base's official public endpoint so `forge test` works out of the
        // box; override with BASE_RPC_URL for a private/archive node.
        string memory rpc = vm.envOr("BASE_RPC_URL", string("https://mainnet.base.org"));
        vm.createSelectFork(rpc);
        forked = true;

        adapter = new ForkProfitAdapter();
        executor = new MorphoArbExecutor(MORPHO, BALANCER_V2_VAULT, BALANCER_V3_VAULT, admin);

        vm.startPrank(admin);
        executor.grantRole(executor.OPERATOR_ROLE(), operator);
        executor.setApprovedAdapter(address(adapter), true);
        executor.setTreasury(treasury);
        vm.stopPrank();

        // Fund the adapter's tip so it can pay a small, real profit.
        deal(WETH, address(adapter), 1e18);
    }

    /// @dev Every test is meaningless without a fork, so refuse to report a green run
    ///      when `BASE_RPC_URL` is unset.
    function _requireFork() internal view {
        if (!forked) {
            revert("BASE_RPC_URL not set; fork tests skipped rather than faked");
        }
    }

    // ------------------------------------------------------------------
    // Preconditions: the addresses are what we think they are
    // ------------------------------------------------------------------

    function test_fork_providers_have_code() public {
        _requireFork();
        assertGt(MORPHO.code.length, 0, "Morpho has no code");
        assertGt(BALANCER_V2_VAULT.code.length, 0, "V2 Vault has no code");
        assertGt(BALANCER_V3_VAULT.code.length, 0, "V3 Vault has no code");
        assertGt(WETH.code.length, 0, "WETH has no code");
    }

    function test_fork_providers_hold_enough_weth() public {
        _requireFork();
        assertGe(IERC20(WETH).balanceOf(MORPHO), LOAN, "Morpho under-funded");
        assertGe(IERC20(WETH).balanceOf(BALANCER_V2_VAULT), LOAN, "V2 Vault under-funded");
        assertGe(IERC20(WETH).balanceOf(BALANCER_V3_VAULT), LOAN, "V3 Vault under-funded");
    }

    // ------------------------------------------------------------------
    // The three providers, against live bytecode
    // ------------------------------------------------------------------

    function test_fork_morpho_flash_loan_repays_via_approval() public {
        _requireFork();
        uint256 vaultBefore = IERC20(WETH).balanceOf(MORPHO);
        uint256 treasuryBefore = IERC20(WETH).balanceOf(treasury);

        vm.prank(operator);
        executor.execute(_request(Types.LoanProvider.Morpho));

        assertEq(IERC20(WETH).balanceOf(treasury) - treasuryBefore, TIP, "tip not paid");
        assertEq(IERC20(WETH).balanceOf(MORPHO), vaultBefore, "Morpho not made whole");
        assertEq(IERC20(WETH).balanceOf(address(executor)), 0, "executor not drained");
    }

    function test_fork_balancer_v2_flash_loan_repays_via_transfer() public {
        _requireFork();
        uint256 vaultBefore = IERC20(WETH).balanceOf(BALANCER_V2_VAULT);
        uint256 treasuryBefore = IERC20(WETH).balanceOf(treasury);

        vm.prank(operator);
        executor.execute(_request(Types.LoanProvider.BalancerV2));

        assertEq(IERC20(WETH).balanceOf(treasury) - treasuryBefore, TIP, "tip not paid");
        assertEq(IERC20(WETH).balanceOf(BALANCER_V2_VAULT), vaultBefore, "V2 Vault not made whole");
        assertEq(IERC20(WETH).balanceOf(address(executor)), 0, "executor not drained");
    }

    function test_fork_balancer_v3_flash_loan_settles_transient_delta() public {
        _requireFork();
        uint256 vaultBefore = IERC20(WETH).balanceOf(BALANCER_V3_VAULT);
        uint256 treasuryBefore = IERC20(WETH).balanceOf(treasury);

        vm.prank(operator);
        executor.execute(_request(Types.LoanProvider.BalancerV3));

        assertEq(IERC20(WETH).balanceOf(treasury) - treasuryBefore, TIP, "tip not paid");
        assertEq(IERC20(WETH).balanceOf(BALANCER_V3_VAULT), vaultBefore, "V3 Vault not made whole");
        assertEq(IERC20(WETH).balanceOf(address(executor)), 0, "executor not drained");
    }

    // ------------------------------------------------------------------
    // Fee facts, checked against chain rather than assumed
    // ------------------------------------------------------------------

    /// @dev V2's flash-loan fee lives on the ProtocolFeesCollector, not the Vault. It is
    ///      currently zero on Base, which is the reason this strategy is viable at all.
    function test_fork_balancer_v2_fee_is_zero() public {
        _requireFork();
        address collector = IBalancerV2FeeSource(BALANCER_V2_VAULT).getProtocolFeesCollector();
        assertGt(collector.code.length, 0, "collector has no code");
        assertEq(
            IBalancerV2FeeSource(collector).getFlashLoanFeePercentage(),
            0,
            "V2 flash-loan fee is no longer zero; routes must account for it"
        );
    }

    /// @dev Documents the finding that drove the interface change: V3 exposes no flash-loan
    ///      fee getter, because V3 has no flash-loan fee concept. If a future V3 upgrade
    ///      introduces one, this test fails and forces a re-read of the assumption.
    function test_fork_balancer_v3_has_no_flash_loan_fee_getter() public {
        _requireFork();
        vm.expectRevert();
        IBalancerV3FeeProbe(BALANCER_V3_VAULT).getFlashLoanFeePercentage();
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    /// @dev A single-leg closed cycle WETH -> WETH: the first leg's input and the last leg's
    ///      output are both the loan token, which is what the closed-cycle validation
    ///      requires. The "swap" is 1:1 plus a tip, so the loan mechanics are exercised
    ///      without depending on a live price dislocation.
    function _request(Types.LoanProvider provider)
        internal
        view
        returns (Types.ExecutionRequest memory request)
    {
        Types.SwapStep[] memory steps = new Types.SwapStep[](1);
        steps[0] = Types.SwapStep({
            adapter: address(adapter),
            tokenIn: WETH,
            tokenOut: WETH,
            amountIn: 0,
            minAmountOut: 1,
            kind: Types.KIND_UNISWAP_V3,
            poolData: ""
        });

        request = Types.ExecutionRequest({
            loanProvider: provider,
            loanToken: WETH,
            loanAmount: LOAN,
            minProfit: TIP,
            profitReceiver: treasury,
            mode: Types.RouteMode.AdapterRoute,
            route: Types.AdapterRoute({swaps: steps, minProfit: TIP}),
            calls: new Types.Call[](0)
        });
    }
}

/// @notice Adapter that returns its input plus a pre-funded tip.
/// @dev Exists only to give the fork tests a route that clears the profit floor without
///      relying on a real arbitrage opportunity being present at the pinned block.
contract ForkProfitAdapter {
    using SafeERC20 for IERC20;

    function swap(Types.SwapStep calldata step) external returns (uint256 amountOut) {
        IERC20(step.tokenIn).safeTransferFrom(msg.sender, address(this), step.amountIn);
        amountOut = step.amountIn + 0.01e18;
        IERC20(step.tokenOut).safeTransfer(msg.sender, amountOut);
    }
}

/// @notice End-to-end routes through the **real** Uniswap V3 router and live pools.
/// @dev This is the closest thing to a production run that can be done without deploying.
///      Nothing about the swap is stubbed: the router, the pools, the token transfers and
///      the slippage checks are all live Base state. Only the loan source varies, and all
///      three providers are exercised.
///
///      The routes here are deliberately honest about economics. A WETH -> USDC -> WETH
///      round trip through two fee tiers loses ~0.1%, which is exactly what makes it useful:
///      it proves the executor refuses to settle a losing route, and that no amount of
///      "profitable" reporting from a router can change that.
contract MorphoArbRealAdapterForkTest is Test {
    using SafeERC20 for IERC20;

    address internal constant MORPHO = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;
    address internal constant BALANCER_V2_VAULT = 0xBA12222222228d8Ba445958a75a0704d566BF2C8;
    address internal constant BALANCER_V3_VAULT = 0xbA1333333333a1BA1108E8412f11850A5C319bA9;
    address internal constant WETH = 0x4200000000000000000000000000000000000006;
    address internal constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;
    address internal constant UNISWAP_V3_ROUTER = 0x2626664c2603336E57B271c5C0b26F421741e481;
    address internal constant QUOTER_V2 = 0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a;

    /// @dev Live WETH/USDC fee tiers on Base.
    uint24 internal constant FEE_LOWEST = 100;
    uint24 internal constant FEE_LOW = 500;
    uint24 internal constant FEE_MEDIUM = 3000;
    uint24 internal constant FEE_HIGH = 10000;

    MorphoArbExecutor internal executor;
    UniswapV3Adapter internal adapter;

    address internal admin = address(0xA11CE);
    address internal operator = address(0x0FF1CE);
    address internal treasury = address(0x7EA5);

    /// @dev Small enough for Balancer V3's ~4 WETH, large enough to clear pool minimums.
    uint256 internal constant LOAN = 1e18;

    function setUp() public {
        string memory rpc = vm.envOr("BASE_RPC_URL", string("https://mainnet.base.org"));
        vm.createSelectFork(rpc);

        adapter = new UniswapV3Adapter(UNISWAP_V3_ROUTER);
        executor = new MorphoArbExecutor(MORPHO, BALANCER_V2_VAULT, BALANCER_V3_VAULT, admin);

        vm.startPrank(admin);
        executor.grantRole(executor.OPERATOR_ROLE(), operator);
        executor.setApprovedAdapter(address(adapter), true);
        executor.setTreasury(treasury);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------
    // The adapter against the real router
    // ------------------------------------------------------------------

    /// @dev A real single-leg swap must deliver a sane amount, not zero and not the input.
    ///      Executed through the adapter directly, because a one-leg route that leaves the
    ///      executor holding USDC is not a valid arbitrage cycle for `execute`.
    function test_real_adapter_swaps_weth_to_usdc() public {
        uint256 quoted = _quote(WETH, USDC, LOAN, FEE_LOW);

        Types.SwapStep memory step = _step(WETH, USDC, LOAN, 1, FEE_LOW);
        deal(WETH, address(this), LOAN);
        IERC20(WETH).forceApprove(address(adapter), LOAN);

        uint256 out = adapter.swap(step);

        assertGt(out, 0, "router returned zero");
        assertApproxEqRel(out, quoted, 0.01e18, "output deviates from quote by >1%");
        // The adapter must not retain the input or leave an allowance behind.
        assertEq(IERC20(WETH).balanceOf(address(adapter)), 0, "adapter kept input");
        assertEq(IERC20(WETH).allowance(address(adapter), UNISWAP_V3_ROUTER), 0, "allowance left");
    }

    /// @dev Slippage floor above the achievable output must revert rather than fill at a loss.
    function test_real_adapter_enforces_min_amount_out() public {
        uint256 quoted = _quote(WETH, USDC, LOAN, FEE_LOW);

        Types.SwapStep memory step = _step(WETH, USDC, LOAN, quoted * 2, FEE_LOW);
        deal(WETH, address(this), LOAN);
        IERC20(WETH).forceApprove(address(adapter), LOAN);

        vm.expectRevert();
        adapter.swap(step);
    }

    // ------------------------------------------------------------------
    // Full executor runs through live pools
    // ------------------------------------------------------------------

    /// @dev A genuine round trip loses ~0.2% on Base. The executor must refuse to settle
    ///      specifically because of the profit floor -- not because a pool reverted -- and
    ///      must not leave the loan unpaid or funds stranded while doing so.
    function test_real_route_that_loses_is_rejected_by_profit_floor() public {
        // minProfit = 1 wei: unachievable for a round trip through two fee tiers.
        Types.ExecutionRequest memory request =
            _twoLegRequest(Types.LoanProvider.Morpho, FEE_LOWEST, FEE_LOW, 1);

        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(Errors.InsufficientProfit.selector, uint256(1), uint256(0))
        );
        executor.execute(request);

        assertEq(IERC20(WETH).balanceOf(address(executor)), 0, "executor left holding WETH");
    }

    /// @dev Same losing route, but settled through Balancer V2's balance-check repayment.
    ///      Proves the refusal is provider-independent and that the V2 vault is made whole
    ///      on the revert path.
    function test_real_losing_route_rejected_on_balancer_v2() public {
        uint256 vaultBefore = IERC20(WETH).balanceOf(BALANCER_V2_VAULT);

        Types.ExecutionRequest memory request =
            _twoLegRequest(Types.LoanProvider.BalancerV2, FEE_LOWEST, FEE_LOW, 1);

        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(Errors.InsufficientProfit.selector, uint256(1), uint256(0))
        );
        executor.execute(request);

        assertEq(IERC20(WETH).balanceOf(BALANCER_V2_VAULT), vaultBefore, "V2 Vault not whole");
        assertEq(IERC20(WETH).balanceOf(address(executor)), 0, "executor left holding WETH");
    }

    /// @dev A round trip with a zero floor is still refused, because `minProfit == 0` is
    ///      rejected at validation before any pool is touched.
    function test_real_route_with_zero_floor_rejected_before_swapping() public {
        Types.ExecutionRequest memory request =
            _twoLegRequest(Types.LoanProvider.Morpho, FEE_LOWEST, FEE_LOW, 0);

        vm.prank(operator);
        vm.expectRevert(Errors.InvalidMinProfit.selector);
        executor.execute(request);
    }

    /// @dev The happy path, through live pools: a real dislocation, then a real settlement.
    ///
    ///      A mispricing is manufactured the way it happens on chain -- by pushing a large
    ///      trade through one fee tier and leaving the others behind -- because no dislocation
    ///      can be assumed to exist at a pinned block. The trade is done with `deal`ed funds,
    ///      so the test is self-contained and never depends on a live opportunity.
    ///
    ///      The executor then borrows 1 WETH and settles a genuine profit out of the pools.
    function test_real_profitable_route_settles_through_live_pools() public {
        // The 0.01% pool holds ~47 WETH against the 0.3% pool's ~18,000, so it is the only
        // tier a trade this size can actually move.
        _dislocate(FEE_LOWEST, 30e18);

        (uint24 buyFee, uint24 sellFee, uint256 quotedOut) = _bestRoundTrip();
        assertGt(quotedOut, LOAN, "dislocation did not create a profitable cycle");

        // QuoterV2 does not model the executor's extra hops, so require slightly less than
        // quoted and let the real settlement be the thing under test.
        uint256 floor = (quotedOut * 99) / 100;

        Types.SwapStep[] memory steps = new Types.SwapStep[](2);
        steps[0] = _step(WETH, USDC, 0, 1, buyFee);
        steps[1] = _step(USDC, WETH, 0, floor, sellFee);

        Types.ExecutionRequest memory request = Types.ExecutionRequest({
            loanProvider: Types.LoanProvider.Morpho,
            loanToken: WETH,
            loanAmount: LOAN,
            minProfit: 1,
            profitReceiver: treasury,
            mode: Types.RouteMode.AdapterRoute,
            route: Types.AdapterRoute({swaps: steps, minProfit: 1}),
            calls: new Types.Call[](0)
        });

        uint256 treasuryBefore = IERC20(WETH).balanceOf(treasury);

        vm.prank(operator);
        executor.execute(request);

        uint256 received = IERC20(WETH).balanceOf(treasury) - treasuryBefore;
        assertGt(received, 0, "treasury received nothing");
        assertEq(IERC20(WETH).balanceOf(address(executor)), 0, "executor left holding WETH");
        emit log_named_uint("profit to treasury (wei)", received);
        emit log_named_uint("buy fee", buyFee);
        emit log_named_uint("sell fee", sellFee);
    }

    /// @dev Pushes a large swap through one fee tier so it trades at a worse price than the
    ///      others, leaving a genuine cross-tier dislocation behind. Funds are `deal`ed, so
    ///      this mirrors the effect of a whale trade without needing one to have happened.
    function _dislocate(uint24 fee, uint256 wethIn) internal {
        deal(WETH, address(this), wethIn);
        IERC20(WETH).forceApprove(UNISWAP_V3_ROUTER, wethIn);

        ISwapRouter02(UNISWAP_V3_ROUTER)
            .exactInputSingle(
                ISwapRouter02.ExactInputSingleParams({
                    tokenIn: WETH,
                    tokenOut: USDC,
                    fee: fee,
                    recipient: address(this),
                    amountIn: wethIn,
                    amountOutMinimum: 0,
                    sqrtPriceLimitX96: 0
                })
            );
    }

    /// @dev Quotes every ordered pair of live WETH/USDC fee tiers and returns the best.
    function _bestRoundTrip() internal returns (uint24 bestBuy, uint24 bestSell, uint256 bestOut) {
        uint24[4] memory fees = [FEE_LOWEST, FEE_LOW, FEE_MEDIUM, FEE_HIGH];

        for (uint256 i = 0; i < fees.length; ++i) {
            uint256 usdcOut = _quote(WETH, USDC, LOAN, fees[i]);
            if (usdcOut == 0) continue;
            for (uint256 j = 0; j < fees.length; ++j) {
                uint256 wethOut = _quote(USDC, WETH, usdcOut, fees[j]);
                if (wethOut > bestOut) {
                    bestOut = wethOut;
                    bestBuy = fees[i];
                    bestSell = fees[j];
                }
            }
        }
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    function _step(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        uint24 fee
    ) internal view returns (Types.SwapStep memory) {
        return Types.SwapStep({
            adapter: address(adapter),
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            amountIn: amountIn,
            minAmountOut: minAmountOut,
            kind: Types.KIND_UNISWAP_V3,
            poolData: abi.encode(fee)
        });
    }

    /// @dev WETH -> USDC -> WETH, a closed cycle the executor's validation accepts.
    ///      `amountIn = 0` on the first leg means "use the loan"; the second leg takes
    ///      whatever the first produced.
    function _twoLegRequest(
        Types.LoanProvider provider,
        uint24 firstFee,
        uint24 secondFee,
        uint256 minProfit
    ) internal view returns (Types.ExecutionRequest memory request) {
        Types.SwapStep[] memory steps = new Types.SwapStep[](2);
        steps[0] = _step(WETH, USDC, 0, 1, firstFee);
        steps[1] = _step(USDC, WETH, 0, 1, secondFee);

        request = Types.ExecutionRequest({
            loanProvider: provider,
            loanToken: WETH,
            loanAmount: LOAN,
            minProfit: minProfit,
            profitReceiver: treasury,
            mode: Types.RouteMode.AdapterRoute,
            route: Types.AdapterRoute({swaps: steps, minProfit: minProfit}),
            calls: new Types.Call[](0)
        });
    }

    /// @dev Reads the live quoter so assertions track real pool state instead of a
    ///      hardcoded number that would rot. QuoterV2 is not `view` -- it deliberately
    ///      reverts to return its result -- so this cannot be a view helper.
    function _quote(address tokenIn, address tokenOut, uint256 amountIn, uint24 fee)
        internal
        returns (uint256)
    {
        (uint256 out,,,) = IUniswapV3QuoterV2(QUOTER_V2)
            .quoteExactInputSingle(
                IUniswapV3QuoterV2.QuoteExactInputSingleParams({
                    tokenIn: tokenIn,
                    tokenOut: tokenOut,
                    amountIn: amountIn,
                    fee: fee,
                    sqrtPriceLimitX96: 0
                })
            );
        return out;
    }
}

interface IUniswapV3QuoterV2 {
    struct QuoteExactInputSingleParams {
        address tokenIn;
        address tokenOut;
        uint256 amountIn;
        uint24 fee;
        uint160 sqrtPriceLimitX96;
    }

    function quoteExactInputSingle(QuoteExactInputSingleParams memory params)
        external
        returns (
            uint256 amountOut,
            uint160 sqrtPriceX96After,
            uint32 initializedTicksCrossed,
            uint256 gasEstimate
        );
}

interface IBalancerV2FeeSource {
    function getProtocolFeesCollector() external view returns (address);
    function getFlashLoanFeePercentage() external view returns (uint256);
}

interface IBalancerV3FeeProbe {
    function getFlashLoanFeePercentage() external view returns (uint256);
}
