// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {MorphoArbExecutor} from "../../src/MorphoArbExecutor.sol";
import {AerodromeAdapter} from "../../src/adapters/AerodromeAdapter.sol";
import {UniswapV3Adapter} from "../../src/adapters/UniswapV3Adapter.sol";
import {IAerodromeRouter} from "../../src/interfaces/IAerodrome.sol";
import {IUniswapV3QuoterV2} from "../../src/interfaces/IUniswapV3.sol";
import {Errors} from "../../src/libraries/Errors.sol";
import {Types} from "../../src/libraries/Types.sol";

/// @notice Cross-DEX routes: Aerodrome and Uniswap V3 in the same cycle.
/// @dev This is the shape a real Base arbitrage usually takes. Two venues disagree more
///      often, and by more, than two fee tiers of the same venue. It also exercises
///      something the single-venue suite cannot: the executor dispatching to two different
///      adapters inside one route, and the route validation accepting that.
///
///      Aerodrome is the harder of the two to integrate correctly. A pair can exist as both
///      a volatile and a stable pool with identical tokens, so `stable` is part of the pool
///      identity, not a hint -- and the WETH/USDC stable pool on Base holds only ~2 WETH
///      against ~1,657 in the volatile one, so choosing wrongly is a real and expensive
///      mistake rather than a theoretical one.
contract CrossDexForkTest is Test {
    using SafeERC20 for IERC20;

    address internal constant MORPHO = 0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb;
    address internal constant BALANCER_V2_VAULT = 0xBA12222222228d8Ba445958a75a0704d566BF2C8;
    address internal constant BALANCER_V3_VAULT = 0xbA1333333333a1BA1108E8412f11850A5C319bA9;
    address internal constant WETH = 0x4200000000000000000000000000000000000006;
    address internal constant USDC = 0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913;

    address internal constant UNISWAP_V3_ROUTER = 0x2626664c2603336E57B271c5C0b26F421741e481;
    address internal constant QUOTER_V2 = 0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a;
    address internal constant AERODROME_ROUTER = 0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43;
    address internal constant AERODROME_FACTORY = 0x420DD381b31aEf6683db6B902084cB0FFECe40Da;

    uint24 internal constant FEE_MEDIUM = 3000;

    MorphoArbExecutor internal executor;
    UniswapV3Adapter internal uniAdapter;
    AerodromeAdapter internal aeroAdapter;

    address internal admin = address(0xA11CE);
    address internal operator = address(0x0FF1CE);
    address internal treasury = address(0x7EA5);

    uint256 internal constant LOAN = 1e18;

    function setUp() public {
        string memory rpc = vm.envOr("BASE_RPC_URL", string("https://mainnet.base.org"));
        // Pinned for determinism: a moving fork head makes a pool's depth depend on when the
        // suite ran, so a dislocation sized for one block can be far too small for the next.
        // It also collapses fork state fetches to a single block, which matters because the
        // public Base endpoint rate-limits hard enough to fail setUp on a bad run.
        vm.createSelectFork(rpc, vm.envOr("BASE_FORK_BLOCK", uint256(51668376)));

        uniAdapter = new UniswapV3Adapter(UNISWAP_V3_ROUTER);
        aeroAdapter = new AerodromeAdapter(AERODROME_ROUTER);
        executor = new MorphoArbExecutor(MORPHO, BALANCER_V2_VAULT, BALANCER_V3_VAULT, admin);

        vm.startPrank(admin);
        executor.grantRole(executor.OPERATOR_ROLE(), operator);
        executor.setApprovedAdapter(address(uniAdapter), true);
        executor.setApprovedAdapter(address(aeroAdapter), true);
        executor.setTreasury(treasury);
        vm.stopPrank();
    }

    /// @dev Both Aerodrome pool flavours must be reachable, and the `stable` flag must matter.
    function test_aerodrome_quote_distinguishes_stable_from_volatile() public {
        uint256 volatileOut = _aeroQuote(WETH, USDC, LOAN, false);
        uint256 stableOut = _aeroQuote(WETH, USDC, LOAN, true);

        assertGt(volatileOut, 0, "volatile pool quoted zero");
        assertGt(stableOut, 0, "stable pool quoted zero");
        assertGt(
            volatileOut,
            stableOut,
            "volatile pool should price far better at 1 WETH given its depth"
        );
    }

    /// @dev The adapter must swap through the real router and deliver what the router's own
    ///      quote promised, leaving nothing behind.
    function test_aerodrome_adapter_swaps_against_real_router() public {
        uint256 quoted = _aeroQuote(WETH, USDC, LOAN, false);

        Types.SwapStep memory step = _aeroStep(WETH, USDC, LOAN, 1, false);
        deal(WETH, address(this), LOAN);
        IERC20(WETH).forceApprove(address(aeroAdapter), LOAN);

        uint256 out = aeroAdapter.swap(step);

        assertGt(out, 0, "router returned zero");
        assertApproxEqRel(out, quoted, 0.005e18, "output deviates from router quote by >0.5%");
        assertEq(IERC20(WETH).balanceOf(address(aeroAdapter)), 0, "adapter kept input");
        assertEq(
            IERC20(WETH).allowance(address(aeroAdapter), AERODROME_ROUTER), 0, "allowance left"
        );
    }

    /// @dev The cross-venue case, end to end: manufacture a dislocation on Aerodrome, then
    ///      borrow WETH, cross to Uniswap V3 or back, and settle. Both adapters are live
    ///      contracts; nothing is stubbed.
    function test_cross_dex_route_between_aerodrome_and_uniswap_v3() public {
        // Aerodrome's volatile WETH/USDC pool holds ~1,657 WETH, so this moves its price
        // without needing an unrealistic size.
        _dislocateAerodrome(false, 250e18);

        (bool aeroFirst, uint256 bestOut) = _bestCrossVenueRoundTrip();
        assertGt(bestOut, LOAN, "dislocation did not create a cross-venue cycle");

        uint256 floor = (bestOut * 99) / 100;

        // Execute the direction that was actually found profitable: quoting the other one and
        // applying this floor to it would guarantee a "too little received" revert.
        Types.SwapStep[] memory steps = new Types.SwapStep[](2);
        if (aeroFirst) {
            steps[0] = _aeroStep(WETH, USDC, 0, 1, false);
            steps[1] = _uniStep(USDC, WETH, 0, floor, FEE_MEDIUM);
        } else {
            steps[0] = _uniStep(WETH, USDC, 0, 1, FEE_MEDIUM);
            steps[1] = _aeroStep(USDC, WETH, 0, floor, false);
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
        emit log_named_string("first venue", aeroFirst ? "aerodrome" : "uniswap-v3");
        emit log_named_uint("cross-DEX profit to treasury (wei)", received);
    }

    /// @dev A cross-venue cycle with no dislocation loses money and must be refused, proving
    ///      the floor is enforced across two different adapters and not only within one.
    function test_cross_dex_losing_route_is_refused() public {
        Types.SwapStep[] memory steps = new Types.SwapStep[](2);
        steps[0] = _aeroStep(WETH, USDC, 0, 1, false);
        steps[1] = _uniStep(USDC, WETH, 0, 1, FEE_MEDIUM);

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

        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(Errors.InsufficientProfit.selector, uint256(1), uint256(0))
        );
        executor.execute(request);

        assertEq(IERC20(WETH).balanceOf(address(executor)), 0, "executor left holding WETH");
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

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

    function _aeroStep(
        address tokenIn,
        address tokenOut,
        uint256 amountIn,
        uint256 minAmountOut,
        bool stable
    ) internal view returns (Types.SwapStep memory) {
        return Types.SwapStep({
            adapter: address(aeroAdapter),
            tokenIn: tokenIn,
            tokenOut: tokenOut,
            amountIn: amountIn,
            minAmountOut: minAmountOut,
            kind: Types.KIND_AERODROME,
            poolData: abi.encode(stable, AERODROME_FACTORY)
        });
    }

    function _aeroQuote(address tokenIn, address tokenOut, uint256 amountIn, bool stable)
        internal
        view
        returns (uint256)
    {
        IAerodromeRouter.Route[] memory routes = new IAerodromeRouter.Route[](1);
        routes[0] = IAerodromeRouter.Route({
            from: tokenIn, to: tokenOut, stable: stable, factory: AERODROME_FACTORY
        });
        uint256[] memory amounts =
            IAerodromeRouter(AERODROME_ROUTER).getAmountsOut(amountIn, routes);
        return amounts[amounts.length - 1];
    }

    /// @dev Pushes a large trade through Aerodrome's volatile pool so it prices away from
    ///      Uniswap V3, creating a genuine cross-venue dislocation. Funds are `deal`ed.
    function _dislocateAerodrome(bool stable, uint256 wethIn) internal {
        deal(WETH, address(this), wethIn);
        IERC20(WETH).forceApprove(AERODROME_ROUTER, wethIn);

        IAerodromeRouter.Route[] memory routes = new IAerodromeRouter.Route[](1);
        routes[0] = IAerodromeRouter.Route({
            from: WETH, to: USDC, stable: stable, factory: AERODROME_FACTORY
        });
        IAerodromeRouter(AERODROME_ROUTER)
            .swapExactTokensForTokens(wethIn, 0, routes, address(this), block.timestamp);
    }

    /// @dev Compares both cross-venue directions and keeps the better one. Returns which venue
    ///      came first so the caller can execute the exact direction it priced.
    function _bestCrossVenueRoundTrip() internal returns (bool aeroFirst, uint256 bestOut) {
        uint256 aeroToUsdc = _aeroQuote(WETH, USDC, LOAN, false);
        if (aeroToUsdc > 0) {
            uint256 uniBack = _quoteUni(USDC, WETH, aeroToUsdc, FEE_MEDIUM);
            if (uniBack > bestOut) {
                bestOut = uniBack;
                aeroFirst = true;
            }
        }

        uint256 uniToUsdc = _quoteUni(WETH, USDC, LOAN, FEE_MEDIUM);
        if (uniToUsdc > 0) {
            uint256 aeroBack = _aeroQuote(USDC, WETH, uniToUsdc, false);
            if (aeroBack > bestOut) {
                bestOut = aeroBack;
                aeroFirst = false;
            }
        }
    }

    function _quoteUni(address tokenIn, address tokenOut, uint256 amountIn, uint24 fee)
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
