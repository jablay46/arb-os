// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {MorphoArbExecutor} from "../../src/MorphoArbExecutor.sol";
import {SlipstreamAdapter} from "../../src/adapters/SlipstreamAdapter.sol";
import {UniswapV3Adapter} from "../../src/adapters/UniswapV3Adapter.sol";
import {
    ISlipstreamFactory,
    ISlipstreamQuoterV2,
    ISlipstreamRouter
} from "../../src/interfaces/ISlipstream.sol";
import {ISwapRouter02, IUniswapV3QuoterV2} from "../../src/interfaces/IUniswapV3.sol";
import {Types} from "../../src/libraries/Types.sol";

/// @notice Fork tests for Aerodrome Slipstream against the live Base deployments.
/// @dev Slipstream is unusual among the venues: Aerodrome runs **two** CL generations on Base
///      and both are live. Each generation has its own factory, router and quoter, and a
///      router only ever swaps against pools minted by its own factory. The two routers share
///      the `exactInputSingle` selector (`0xa026383e`), so from calldata alone they are
///      indistinguishable -- the generation is decided entirely by which router address is
///      called and which factory that router resolves the pool against.
///
///      That makes a cross-generation mismatch a silent, not a loud, failure: point a leg at
///      the old router for a pool that only exists on the new one and the router resolves a
///      *different* pool, at a *different* price, without reverting. These tests pin that
///      reality -- including the measured quote divergence -- and prove the adapter's
///      `factory` check turns the silent case into a revert.
///
///      Nothing here is stubbed: both routers, both factories and both quoters are the real
///      Base contracts.
contract SlipstreamForkTest is Test {
    using SafeERC20 for IERC20;

    address internal constant MORPHO = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;
    address internal constant BALANCER_V2_VAULT = 0xBA12222222228d8Ba445958a75a0704d566BF2C8;
    address internal constant BALANCER_V3_VAULT = 0xbA1333333333a1BA1108E8412f11850A5C319bA9;
    address internal constant WETH = 0x4200000000000000000000000000000000000006;
    address internal constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    // Slipstream generation 1 ("old"): tick spacings 1, 100 on WETH/USDC.
    address internal constant SLIP_OLD_ROUTER = 0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5;
    address internal constant SLIP_OLD_FACTORY = 0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A;
    address internal constant SLIP_OLD_QUOTER = 0x254cF9E1E6e233aa1AC962CB9B05b2cfeAaE15b0;

    // Slipstream generation 2 ("new"): tick spacings 1, 10, 50 on WETH/USDC.
    address internal constant SLIP_NEW_ROUTER = 0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F;
    address internal constant SLIP_NEW_FACTORY = 0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef;
    address internal constant SLIP_NEW_QUOTER = 0x514c8B5f54112481E28028F1166Bd78501089259;

    address internal constant UNISWAP_V3_ROUTER = 0x2626664c2603336E57B271c5C0b26F421741e481;
    address internal constant UNISWAP_V3_FACTORY = 0x33128a8fC17869897dcE68Ed026d694621f6FDfD;
    address internal constant UNISWAP_QUOTER_V2 = 0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a;

    // The old generation's canonical WETH/USDC tick spacing; the new generation has no ts=100.
    int24 internal constant OLD_TICK_SPACING = 100;
    // ts=10 exists only on the new generation, and is the deliberate mismatch target.
    int24 internal constant NEW_TICK_SPACING = 10;
    uint24 internal constant UNI_FEE_THIN = 100;

    MorphoArbExecutor internal executor;
    SlipstreamAdapter internal slipOld;
    SlipstreamAdapter internal slipNew;
    UniswapV3Adapter internal uniAdapter;

    address internal admin = address(0xA11CE);
    address internal operator = address(0x0FF1CE);
    address internal treasury = address(0x7EA5);

    uint256 internal constant LOAN = 1e18;

    function setUp() public {
        string memory rpc = vm.envOr("BASE_RPC_URL", string("https://mainnet.base.org"));
        // Pinned for determinism, as elsewhere: a moving head changes pool depth, so a
        // dislocation sized for one block can be far too small for the next. The default is
        // recent enough that a public endpoint serves it; a private RPC removes the flakiness.
        vm.createSelectFork(rpc, vm.envOr("BASE_FORK_BLOCK", uint256(51668376)));

        slipOld = new SlipstreamAdapter(SLIP_OLD_ROUTER);
        slipNew = new SlipstreamAdapter(SLIP_NEW_ROUTER);
        uniAdapter = new UniswapV3Adapter(UNISWAP_V3_ROUTER);
        executor = new MorphoArbExecutor(MORPHO, BALANCER_V2_VAULT, BALANCER_V3_VAULT, admin);

        vm.startPrank(admin);
        executor.grantRole(executor.OPERATOR_ROLE(), operator);
        executor.setApprovedAdapter(address(slipOld), true);
        executor.setApprovedAdapter(address(slipNew), true);
        executor.setApprovedAdapter(address(uniAdapter), true);
        executor.setTreasury(treasury);
        vm.stopPrank();
    }

    // ------------------------------------------------------------------
    // The two generations
    // ------------------------------------------------------------------

    /// @dev The two routers are distinct contracts, each reporting its own factory, and the
    ///      adapter must record the router's factory rather than a caller-supplied guess.
    function test_two_slipstream_generations_are_distinct() public view {
        assertTrue(SLIP_OLD_ROUTER != SLIP_NEW_ROUTER, "routers must differ");
        assertTrue(SLIP_OLD_FACTORY != SLIP_NEW_FACTORY, "factories must differ");

        assertEq(
            ISlipstreamRouter(SLIP_OLD_ROUTER).factory(), SLIP_OLD_FACTORY, "old router factory"
        );
        assertEq(
            ISlipstreamRouter(SLIP_NEW_ROUTER).factory(), SLIP_NEW_FACTORY, "new router factory"
        );

        assertEq(slipOld.factory(), SLIP_OLD_FACTORY, "adapter read wrong old factory");
        assertEq(slipNew.factory(), SLIP_NEW_FACTORY, "adapter read wrong new factory");
    }

    /// @dev The same `(pair, tickSpacing)` resolves to a *different pool address* in each
    ///      generation. This is the fact that makes a cross-generation swap silent rather than
    ///      reverting: both addresses are valid pools, they just are not the same pool.
    function test_same_tick_spacing_resolves_to_different_pools_per_generation() public view {
        address oldPool = ISlipstreamFactory(SLIP_OLD_FACTORY).getPool(WETH, USDC, 1);
        address newPool = ISlipstreamFactory(SLIP_NEW_FACTORY).getPool(WETH, USDC, 1);

        assertTrue(oldPool != address(0), "old generation ts=1 pool missing");
        assertTrue(newPool != address(0), "new generation ts=1 pool missing");
        assertTrue(oldPool != newPool, "pools from two generations must not coincide");
    }

    /// @dev A quantified version of the trap: the **wrong** generation's quoter answers a
    ///      ts=10 leg with a plausible-looking number instead of reverting, because it
    ///      resolves its *own* generation's ts=10 pool. The correct quoter and the wrong one
    ///      disagree by far more than any fee difference could explain -- Slipstream fees are
    ///      well under 0.1%, so even a 2x gap cannot be a fee.
    function test_wrong_generation_quoter_answers_with_a_wrong_price() public {
        uint256 correct = _slipQuote(SLIP_NEW_QUOTER, WETH, USDC, LOAN, NEW_TICK_SPACING);
        uint256 wrong = _slipQuote(SLIP_OLD_QUOTER, WETH, USDC, LOAN, NEW_TICK_SPACING);

        assertGt(correct, 0, "canonical quoter returned zero");
        assertGt(wrong, 0, "wrong-generation quoter returned zero (a revert would be kinder)");
        assertTrue(wrong != correct, "the two generations quoted the same price");
        // Measure the gap as a ratio in both directions so the assertion does not depend on
        // which generation happens to be deeper at the pinned block.
        uint256 hi = correct > wrong ? correct : wrong;
        uint256 lo = correct > wrong ? wrong : correct;
        assertTrue(hi > lo * 2, "divergence under 2x is too small to demonstrate the trap");
        emit log_named_uint("ts=10 via correct (new) quoter", correct);
        emit log_named_uint("ts=10 via wrong (old) quoter", wrong);
    }

    /// @dev The adapter's `factory` check is what turns that silent mismatch into a revert:
    ///      a leg mounted on the new router but naming the old factory is refused before any
    ///      swap is attempted.
    function test_adapter_refuses_a_leg_from_the_other_generation() public {
        Types.SwapStep memory step = Types.SwapStep({
            adapter: address(slipNew),
            tokenIn: WETH,
            tokenOut: USDC,
            amountIn: LOAN,
            minAmountOut: 1,
            kind: Types.KIND_SLIPSTREAM,
            poolData: abi.encode(OLD_TICK_SPACING, SLIP_OLD_FACTORY)
        });

        vm.expectRevert(
            abi.encodeWithSelector(
                SlipstreamAdapter.FactoryMismatch.selector, SLIP_NEW_FACTORY, SLIP_OLD_FACTORY
            )
        );
        slipNew.swap(step);
    }

    // ------------------------------------------------------------------
    // The adapters against the real routers
    // ------------------------------------------------------------------

    /// @dev Old generation, ts=100 (its deepest WETH/USDC pool): the adapter must swap through
    ///      the live router and deliver what the router's own quoter promised.
    function test_old_generation_adapter_swaps_against_real_router() public {
        uint256 quoted = _slipQuote(SLIP_OLD_QUOTER, WETH, USDC, LOAN, OLD_TICK_SPACING);
        assertGt(quoted, 0, "old generation quoted zero");

        Types.SwapStep memory step = Types.SwapStep({
            adapter: address(slipOld),
            tokenIn: WETH,
            tokenOut: USDC,
            amountIn: LOAN,
            minAmountOut: 1,
            kind: Types.KIND_SLIPSTREAM,
            poolData: abi.encode(OLD_TICK_SPACING, SLIP_OLD_FACTORY)
        });

        deal(WETH, address(this), LOAN);
        IERC20(WETH).forceApprove(address(slipOld), LOAN);
        uint256 out = slipOld.swap(step);

        assertGt(out, 0, "router returned zero");
        assertApproxEqRel(out, quoted, 0.005e18, "output deviates from router quote by >0.5%");
        assertEq(IERC20(WETH).balanceOf(address(slipOld)), 0, "adapter kept input");
        assertEq(IERC20(WETH).allowance(address(slipOld), SLIP_OLD_ROUTER), 0, "allowance left");
    }

    /// @dev New generation, ts=10 -- a pool that only the new factory's router will price
    ///      correctly. This is the test that proves the second router genuinely works, not
    ///      just that the first one does with a second address tolerated.
    ///
    ///      Both factories technically resolve *some* ts=10 pool, which is precisely why this
    ///      is dangerous: the old generation's ts=10 pool is nearly empty, so routing a leg
    ///      through it would fill at a wildly wrong price while still "succeeding". The
    ///      assertion below records that both pools exist but differ, and then proves the new
    ///      router delivers the quote from *its* generation's pool.
    function test_new_generation_adapter_swaps_against_real_router() public {
        assertTrue(
            ISlipstreamFactory(SLIP_NEW_FACTORY).getPool(WETH, USDC, NEW_TICK_SPACING)
                != ISlipstreamFactory(SLIP_OLD_FACTORY).getPool(WETH, USDC, NEW_TICK_SPACING),
            "ts=10 resolves to the same pool in both generations"
        );

        uint256 quoted = _slipQuote(SLIP_NEW_QUOTER, WETH, USDC, LOAN, NEW_TICK_SPACING);
        assertGt(quoted, 0, "new generation quoted zero");

        Types.SwapStep memory step = Types.SwapStep({
            adapter: address(slipNew),
            tokenIn: WETH,
            tokenOut: USDC,
            amountIn: LOAN,
            minAmountOut: 1,
            kind: Types.KIND_SLIPSTREAM,
            poolData: abi.encode(NEW_TICK_SPACING, SLIP_NEW_FACTORY)
        });

        deal(WETH, address(this), LOAN);
        IERC20(WETH).forceApprove(address(slipNew), LOAN);
        uint256 out = slipNew.swap(step);

        assertGt(out, 0, "router returned zero");
        assertApproxEqRel(out, quoted, 0.005e18, "output deviates from router quote by >0.5%");
        assertEq(IERC20(WETH).balanceOf(address(slipNew)), 0, "adapter kept input");
        assertEq(IERC20(WETH).allowance(address(slipNew), SLIP_NEW_ROUTER), 0, "allowance left");
    }

    // ------------------------------------------------------------------
    // End to end through the executor
    // ------------------------------------------------------------------

    /// @dev Slipstream inside a real arbitrage cycle: dislocate the thin Uniswap V3 0.01% pool
    ///      by pushing WETH through it (the way a dislocation appears in production), then let
    ///      the executor borrow 1 WETH and settle a cross-venue round trip against it.
    function test_arbitrage_through_slipstream_settles_profit() public {
        // The Uniswap V3 0.01% WETH/USDC pool holds only ~45 WETH, so 30 WETH moves it
        // materially; the Slipstream ts=100 pool holds ~2,100 WETH and stays the reference.
        _dislocateUniswapThinPool(30e18);

        (bool slipFirst, uint256 bestOut) = _bestSlipVsUniRoundTrip();
        assertGt(bestOut, LOAN, "dislocation did not create a cross-venue cycle");
        uint256 floor = (bestOut * 99) / 100;

        // Execute the direction that was actually priced; applying a floor from the other
        // direction would guarantee a "too little received" revert.
        Types.SwapStep[] memory steps = new Types.SwapStep[](2);
        if (slipFirst) {
            steps[0] = _slipStep(address(slipOld), WETH, USDC, 0, 1, OLD_TICK_SPACING);
            steps[1] = _uniStep(USDC, WETH, 0, floor, UNI_FEE_THIN);
        } else {
            steps[0] = _uniStep(WETH, USDC, 0, 1, UNI_FEE_THIN);
            steps[1] = _slipStep(address(slipOld), USDC, WETH, 0, floor, OLD_TICK_SPACING);
        }

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
        emit log_named_string("first venue", slipFirst ? "slipstream" : "uniswap-v3");
        emit log_named_uint("slipstream cross-venue profit to treasury (wei)", received);
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    function _slipStep(
        address adapter,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        int24 tickSpacing
    ) internal view returns (Types.SwapStep memory) {
        return Types.SwapStep({
            adapter: adapter,
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            amountIn: amountIn,
            minAmountOut: minAmountOut,
            kind: Types.KIND_SLIPSTREAM,
            poolData: abi.encode(tickSpacing, SlipstreamAdapter(adapter).factory())
        });
    }

    function _uniStep(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        uint24 fee
    ) internal view returns (Types.SwapStep memory) {
        return Types.SwapStep({
            adapter: address(uniAdapter),
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            amountIn: amountIn,
            minAmountOut: minAmountOut,
            kind: Types.KIND_UNISWAP_V3,
            poolData: abi.encode(fee)
        });
    }

    /// @dev Slipstream's QuoterV2 is not `view` (it reverts internally to return its answer),
    ///      so this cannot be a `view` helper.
    function _slipQuote(
        address quoter,
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        int24 tickSpacing
    ) internal returns (uint256) {
        (uint256 out,,,) = ISlipstreamQuoterV2(quoter)
            .quoteExactInputSingle(
                ISlipstreamQuoterV2.QuoteExactInputSingleParams({
                    tokenIn: tokenIn,
                    tokenOut: tokenOut,
                    amountIn: amountIn,
                    tickSpacing: tickSpacing,
                    sqrtPriceLimitX96: 0
                })
            );
        return out;
    }

    function _uniQuote(address tokenIn, address tokenOut, uint256 amountIn, uint24 fee)
        internal
        returns (uint256)
    {
        (uint256 out,,,) = IUniswapV3QuoterV2(UNISWAP_QUOTER_V2)
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

    /// @dev Pushes a large WETH trade through Uniswap V3's thin 0.01% pool so it prices away
    ///      from Slipstream. Funds are `deal`ed, so the test needs no live opportunity.
    function _dislocateUniswapThinPool(uint256 wethIn) internal {
        deal(WETH, address(this), wethIn);
        IERC20(WETH).forceApprove(UNISWAP_V3_ROUTER, wethIn);

        ISwapRouter02(UNISWAP_V3_ROUTER)
            .exactInputSingle(
                ISwapRouter02.ExactInputSingleParams({
                    tokenIn: WETH,
                    tokenOut: USDC,
                    fee: UNI_FEE_THIN,
                    recipient: address(this),
                    amountIn: wethIn,
                    amountOutMinimum: 0,
                    sqrtPriceLimitX96: 0
                })
            );
    }

    /// @dev Compares both Slipstream/Uniswap directions and keeps the better one, returning
    ///      which venue came first so the caller executes the exact direction it priced.
    function _bestSlipVsUniRoundTrip() internal returns (bool slipFirst, uint256 bestOut) {
        uint256 slipToUsdc = _slipQuote(SLIP_OLD_QUOTER, WETH, USDC, LOAN, OLD_TICK_SPACING);
        if (slipToUsdc > 0) {
            uint256 uniBack = _uniQuote(USDC, WETH, slipToUsdc, UNI_FEE_THIN);
            if (uniBack > bestOut) {
                bestOut = uniBack;
                slipFirst = true;
            }
        }

        uint256 uniToUsdc = _uniQuote(WETH, USDC, LOAN, UNI_FEE_THIN);
        if (uniToUsdc > 0) {
            uint256 slipBack = _slipQuote(SLIP_OLD_QUOTER, USDC, WETH, uniToUsdc, OLD_TICK_SPACING);
            if (slipBack > bestOut) {
                bestOut = slipBack;
                slipFirst = false;
            }
        }
    }
}
