// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {MorphoArbExecutor} from "../src/MorphoArbExecutor.sol";
import {Types} from "../src/libraries/Types.sol";
import {Errors} from "../src/libraries/Errors.sol";

import {MockERC20} from "./mocks/MockERC20.sol";
import {
    MockMorpho,
    MockBalancerV2Vault,
    MockBalancerV3Vault
} from "./mocks/MockFlashLoanProviders.sol";
import {MockAdapter} from "./mocks/MockAdapter.sol";
import {MockLyingAdapter} from "./mocks/MockLyingAdapter.sol";

/// @notice Property tests for the one rule that must hold on every route.
/// @dev The named tests elsewhere assert specific routes at specific numbers. This file
///      asserts the invariant that has to hold for *arbitrary* inputs, for each of the three
///      providers:
///
///          either the route settles, having paid exactly its realised profit to the
///          receiver and left nothing behind,
///          or it reverts for one of a known set of reasons.
///
///      The distinction matters because the named tests only cover routes someone thought
///      of. A newly added adapter with a misencoded parameter still produces a plausible
///      number, and only this shape of test catches that. The sabotage tests at the bottom
///      prove the property can actually fail: a dishonest adapter that reports an enormous
///      output must not be able to satisfy the floor.
contract MorphoArbPropertyTest is Test {
    MorphoArbExecutor internal executor;
    MockERC20 internal weth;
    MockERC20 internal usdc;
    MockMorpho internal morpho;
    MockBalancerV2Vault internal vaultV2;
    MockBalancerV3Vault internal vaultV3;
    MockAdapter internal adapter;

    address internal admin = address(0xA11CE);
    address internal operator = address(0x0FF1CE);
    address internal treasury = address(0x7EA5);

    uint256 internal constant LOAN = 1000e18;

    function setUp() public {
        weth = new MockERC20();
        usdc = new MockERC20();
        morpho = new MockMorpho();
        vaultV2 = new MockBalancerV2Vault();
        vaultV3 = new MockBalancerV3Vault();
        adapter = new MockAdapter();

        executor = new MorphoArbExecutor(address(morpho), address(vaultV2), address(vaultV3), admin);

        vm.startPrank(admin);
        executor.grantRole(executor.OPERATOR_ROLE(), operator);
        executor.setApprovedAdapter(address(adapter), true);
        executor.setTreasury(treasury);
        vm.stopPrank();

        weth.mint(address(morpho), 1_000_000e18);
        weth.mint(address(vaultV2), 1_000_000e18);
        weth.mint(address(vaultV3), 1_000_000e18);
        weth.mint(address(adapter), 1_000_000e18);
        usdc.mint(address(adapter), 1_000_000e18);
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    function _route(address adapter_, uint256 minProfit)
        internal
        pure
        returns (Types.AdapterRoute memory route)
    {
        Types.SwapStep[] memory steps = new Types.SwapStep[](2);
        steps[0] = Types.SwapStep({
            adapter: adapter_,
            tokenIn: address(0), // filled by _request, kept token-agnostic below
            tokenOut: address(0),
            amountIn: 0,
            minAmountOut: 1,
            kind: Types.KIND_UNISWAP_V3,
            poolData: ""
        });
        steps[1] = Types.SwapStep({
            adapter: adapter_,
            tokenIn: address(0),
            tokenOut: address(0),
            amountIn: 0,
            minAmountOut: 1,
            kind: Types.KIND_UNISWAP_V3,
            poolData: ""
        });
        route = Types.AdapterRoute({swaps: steps, minProfit: minProfit});
    }

    function _request(Types.LoanProvider provider, uint256 rateE18, uint256 minProfit)
        internal
        returns (Types.ExecutionRequest memory request)
    {
        adapter.setRate(rateE18);

        Types.AdapterRoute memory route = _route(address(adapter), minProfit);
        route.swaps[0].tokenIn = address(weth);
        route.swaps[0].tokenOut = address(usdc);
        route.swaps[1].tokenIn = address(usdc);
        route.swaps[1].tokenOut = address(weth);

        request = Types.ExecutionRequest({
            loanProvider: provider,
            loanToken: address(weth),
            loanAmount: LOAN,
            minProfit: minProfit,
            profitReceiver: treasury,
            mode: Types.RouteMode.AdapterRoute,
            route: route,
            calls: new Types.Call[](0)
        });
    }

    /// @dev Output of two chained legs at `rateE18`, i.e. the realised gross return.
    function _gross(uint256 rateE18) internal pure returns (uint256) {
        uint256 leg1 = (LOAN * rateE18) / 1e18;
        return (leg1 * rateE18) / 1e18;
    }

    function _selectorOf(bytes memory err) internal pure returns (bytes4 sel) {
        if (err.length < 4) return bytes4(0);
        assembly {
            sel := mload(add(err, 0x20))
        }
    }

    /// @dev A rejection counts as expected when it is one of the executor's own profit/slippage
    ///      errors, or the adapter's own min-out guard. Both are legitimate: `MockAdapter`
    ///      enforces the floor itself, so its `require` fires before the executor's identical
    ///      check ever runs. Anything else -- a panic, or a Vault settlement failure -- would
    ///      mean the route broke in a way nobody designed, so it must not be waved through.
    function _isExpectedFailure(bytes memory err) internal pure returns (bool) {
        bytes4 sel = _selectorOf(err);
        if (
            sel == Errors.InsufficientProfit.selector || sel == Errors.SwapFailed.selector
                || sel == Errors.InsufficientBalance.selector
        ) {
            return true;
        }
        if (sel == 0x08c379a0) {
            // Error(string); only the adapter's slippage guard is acceptable here.
            bytes memory payload = new bytes(err.length - 4);
            for (uint256 i = 0; i < payload.length; ++i) {
                payload[i] = err[i + 4];
            }
            return keccak256(bytes(abi.decode(payload, (string)))) == keccak256(bytes("MIN_OUT"));
        }
        return false;
    }

    // ------------------------------------------------------------------
    // The property, one test per provider
    // ------------------------------------------------------------------

    /// @dev `rateE18` is bounded well below the point where `LOAN * rate` could overflow, so
    ///      the fuzzer spends its budget on real route shapes rather than on reverts caused
    ///      by arithmetic limits. `minProfit` is bounded above zero because rejecting a zero
    ///      floor is covered by a dedicated test.
    function _assertProperty(Types.LoanProvider provider, uint256 rateE18, uint256 minProfit)
        internal
    {
        rateE18 = bound(rateE18, 0, 5e18);
        minProfit = bound(minProfit, 1, 3000e18);

        Types.ExecutionRequest memory request = _request(provider, rateE18, minProfit);

        uint256 treasuryBefore = weth.balanceOf(treasury);
        uint256 executorBefore = weth.balanceOf(address(executor));
        uint256 gross = _gross(rateE18);
        bool shouldSucceed = gross >= LOAN + minProfit;

        vm.prank(operator);
        try executor.execute(request) {
            // Settled: the arithmetic above said it must, and what moved must match.
            // The receiver gets the realised profit plus any balance the executor already
            // held, since settlement sweeps everything it owns.
            assertTrue(shouldSucceed, "settled a route the floor should have rejected");
            assertEq(
                weth.balanceOf(treasury) - treasuryBefore,
                executorBefore + gross - LOAN,
                "receiver did not get the realised profit"
            );
            assertEq(weth.balanceOf(address(executor)), 0, "balance stranded after success");
        } catch (bytes memory err) {
            assertTrue(_isExpectedFailure(err), "reverted for an unexpected reason");
            assertFalse(shouldSucceed, "rejected a route that clears the floor");
            // A revert must leave the contract exactly as it was, or a failed attempt could
            // still move value.
            assertEq(weth.balanceOf(address(executor)), executorBefore, "revert moved balance");
            assertEq(weth.balanceOf(treasury), treasuryBefore, "revert paid the receiver");
        }
    }

    function testFuzz_property_morpho(uint256 rateE18, uint256 minProfit) public {
        _assertProperty(Types.LoanProvider.Morpho, rateE18, minProfit);
    }

    function testFuzz_property_balancer_v2(uint256 rateE18, uint256 minProfit) public {
        _assertProperty(Types.LoanProvider.BalancerV2, rateE18, minProfit);
    }

    function testFuzz_property_balancer_v3(uint256 rateE18, uint256 minProfit) public {
        _assertProperty(Types.LoanProvider.BalancerV3, rateE18, minProfit);
    }

    /// @dev Anti-vacuity: if every input reverted, the three properties above would pass while
    ///      proving nothing. This pins both branches as reachable.
    function test_property_has_both_branches_reachable() public {
        Types.ExecutionRequest memory losing = _request(Types.LoanProvider.Morpho, 0.99e18, 1e18);
        vm.prank(operator);
        vm.expectRevert();
        executor.execute(losing);

        Types.ExecutionRequest memory winning = _request(Types.LoanProvider.Morpho, 1.05e18, 1e18);
        vm.prank(operator);
        executor.execute(winning);
        assertGt(weth.balanceOf(treasury), 0, "profitable branch never ran");
    }

    // ------------------------------------------------------------------
    // Boundary: the floor is inclusive, and one wei short is not close enough
    // ------------------------------------------------------------------

    function test_floor_met_exactly_settles() public {
        // 1.05^2 = 1.1025 => gross 1102.5e18, profit 102.5e18. Ask for exactly that.
        Types.ExecutionRequest memory request =
            _request(Types.LoanProvider.Morpho, 1.05e18, 102.5e18);

        vm.prank(operator);
        executor.execute(request);
        assertEq(weth.balanceOf(treasury), 102.5e18, "exact-floor profit not paid");
    }

    function test_one_wei_above_realised_profit_reverts_with_numbers() public {
        Types.ExecutionRequest memory request =
            _request(Types.LoanProvider.Morpho, 1.05e18, 102.5e18 + 1);

        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(Errors.InsufficientProfit.selector, 102.5e18 + 1, 102.5e18)
        );
        executor.execute(request);
    }

    // ------------------------------------------------------------------
    // Sabotage: prove the property can fail, and that the executor stops it
    // ------------------------------------------------------------------

    /// @dev The dishonest adapter claims an enormous output while delivering only 500e18. The
    ///      property is what the executor does with that claim, and there are two observable
    ///      consequences: the amount it feeds into leg 2, and the amount the receiver is paid.
    ///      Both are asserted, because either alone can pass under an executor that trusts the
    ///      adapter's return value.
    ///
    ///      The route is arranged to succeed so the state is observable at all: a revert undoes
    ///      everything, including any counter a mock keeps.
    function test_lying_adapter_profit_comes_from_the_delta_not_the_claim() public {
        MockLyingAdapter liar = new MockLyingAdapter();
        // Claims max on both legs, delivers 500e18 on leg 1 and 1100e18 on leg 2.
        liar.configure(type(uint256).max, 500e18);
        liar.setSecondLegOut(1100e18);
        usdc.mint(address(liar), 500e18);
        weth.mint(address(liar), 1100e18);

        vm.prank(admin);
        executor.setApprovedAdapter(address(liar), true);

        Types.AdapterRoute memory route = _route(address(liar), 1e18);
        route.swaps[0].tokenIn = address(weth);
        route.swaps[0].tokenOut = address(usdc);
        route.swaps[1].tokenIn = address(usdc);
        route.swaps[1].tokenOut = address(weth);

        Types.ExecutionRequest memory request = Types.ExecutionRequest({
            loanProvider: Types.LoanProvider.Morpho,
            loanToken: address(weth),
            loanAmount: LOAN,
            minProfit: 1e18,
            profitReceiver: treasury,
            mode: Types.RouteMode.AdapterRoute,
            route: route,
            calls: new Types.Call[](0)
        });

        uint256 treasuryBefore = weth.balanceOf(treasury);
        vm.prank(operator);
        executor.execute(request);

        // Leg 2 was handed what leg 1 delivered (500e18), not what it claimed (max uint256).
        assertEq(liar.lastAmountIn(), 500e18, "reported output was carried into the next leg");
        // Profit is 1100e18 - 1000e18 = 100e18, not the imaginary max-uint256 cycle.
        assertEq(
            weth.balanceOf(treasury) - treasuryBefore, 100e18, "profit was computed from the claim"
        );
    }

    /// @dev Same lie, but the claim must not rescue an unprofitable route. Asserting the revert
    ///      selector separates "rejected on profit" from the balance error that results when an
    ///      executor forwards the impossible claim into leg 2.
    function test_lying_adapter_cannot_buy_a_profitable_outcome() public {
        MockLyingAdapter liar = new MockLyingAdapter();
        // Claims max, delivers 100e18 on each leg: 1000e18 out for 1000e18 in, no profit.
        liar.configure(type(uint256).max, 100e18);
        usdc.mint(address(liar), 100e18);
        weth.mint(address(liar), 100e18);

        vm.prank(admin);
        executor.setApprovedAdapter(address(liar), true);

        Types.AdapterRoute memory route = _route(address(liar), 1e18);
        route.swaps[0].tokenIn = address(weth);
        route.swaps[0].tokenOut = address(usdc);
        route.swaps[1].tokenIn = address(usdc);
        route.swaps[1].tokenOut = address(weth);

        Types.ExecutionRequest memory request = Types.ExecutionRequest({
            loanProvider: Types.LoanProvider.Morpho,
            loanToken: address(weth),
            loanAmount: LOAN,
            minProfit: 1e18,
            profitReceiver: treasury,
            mode: Types.RouteMode.AdapterRoute,
            route: route,
            calls: new Types.Call[](0)
        });

        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(Errors.InsufficientProfit.selector, 1e18, 0));
        executor.execute(request);
    }

    /// @dev A route that would clear the floor on its own, but the first leg delivers below
    ///      `minAmountOut`. Uses the non-reverting adapter on purpose: `MockAdapter` enforces the
    ///      floor itself with `require(..., "MIN_OUT")`, so the executor's own check would never
    ///      run. The executor must not depend on a well-behaved adapter to catch this, since a
    ///      misbehaving one is exactly the case the check exists for.
    function test_leg_below_min_amount_out_is_rejected_by_the_executor() public {
        MockLyingAdapter nonEnforcing = new MockLyingAdapter();
        nonEnforcing.configure(0, 5e18); // delivers 5e18, claims nothing; no require either way
        usdc.mint(address(nonEnforcing), 5e18);

        vm.prank(admin);
        executor.setApprovedAdapter(address(nonEnforcing), true);

        Types.AdapterRoute memory route = _route(address(nonEnforcing), 1e18);
        route.swaps[0].tokenIn = address(weth);
        route.swaps[0].tokenOut = address(usdc);
        route.swaps[0].minAmountOut = 1_000e18;
        route.swaps[1].tokenIn = address(usdc);
        route.swaps[1].tokenOut = address(weth);

        Types.ExecutionRequest memory request = Types.ExecutionRequest({
            loanProvider: Types.LoanProvider.Morpho,
            loanToken: address(weth),
            loanAmount: LOAN,
            minProfit: 1e18,
            profitReceiver: treasury,
            mode: Types.RouteMode.AdapterRoute,
            route: route,
            calls: new Types.Call[](0)
        });

        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(Errors.SwapFailed.selector, 0, 5e18, 1_000e18));
        executor.execute(request);
    }
}
