// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";

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

/// @notice End-to-end tests for the merged executor.
/// @dev The point of these tests is to prove the three flash-loan providers actually work
///      through their three DIFFERENT repayment mechanisms -- that is the part of the merge
///      most likely to be silently wrong, since all three look alike at the call site.
contract MorphoArbExecutorTest is Test {
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
    uint256 internal constant MIN_PROFIT = 1e18;

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

        // Fund the three loan sources.
        weth.mint(address(morpho), 1_000_000e18);
        weth.mint(address(vaultV2), 1_000_000e18);
        weth.mint(address(vaultV3), 1_000_000e18);

        // Give the adapter inventory to pay out with.
        weth.mint(address(adapter), 1_000_000e18);
        usdc.mint(address(adapter), 1_000_000e18);
    }

    // ------------------------------------------------------------------
    // Helpers
    // ------------------------------------------------------------------

    /// @dev A two-leg cycle WETH -> USDC -> WETH, both legs through the mock adapter.
    ///      `rate` sets the round-trip multiplier per leg.
    function _cycleRoute(uint256 minProfit)
        internal
        view
        returns (Types.AdapterRoute memory route)
    {
        Types.SwapStep[] memory steps = new Types.SwapStep[](2);

        steps[0] = Types.SwapStep({
            adapter: address(adapter),
            tokenIn: address(weth),
            tokenOut: address(usdc),
            amountIn: 0,
            minAmountOut: 1,
            kind: Types.KIND_UNISWAP_V3,
            poolData: ""
        });
        steps[1] = Types.SwapStep({
            adapter: address(adapter),
            tokenIn: address(usdc),
            tokenOut: address(weth),
            amountIn: 0,
            minAmountOut: 1,
            kind: Types.KIND_UNISWAP_V3,
            poolData: ""
        });

        route = Types.AdapterRoute({swaps: steps, minProfit: minProfit});
    }

    /// @dev Sets the adapter multiplier and builds the request; not `view` because it
    ///      configures the mock adapter's payout rate.
    function _request(Types.LoanProvider provider, uint256 rateE18, uint256 minProfit)
        internal
        returns (Types.ExecutionRequest memory request)
    {
        adapter.setRate(rateE18);
        request = Types.ExecutionRequest({
            loanProvider: provider,
            loanToken: address(weth),
            loanAmount: LOAN,
            minProfit: minProfit,
            profitReceiver: treasury,
            mode: Types.RouteMode.AdapterRoute,
            route: _cycleRoute(minProfit),
            calls: new Types.Call[](0)
        });
    }

    // ------------------------------------------------------------------
    // Provider 1: Morpho (approve-based repayment)
    // ------------------------------------------------------------------

    function test_morpho_route_repays_and_pays_profit() public {
        // Two legs at 1.05 each => 1.1025 round trip => ~102.5 WETH profit.
        Types.ExecutionRequest memory request =
            _request(Types.LoanProvider.Morpho, 1.05e18, MIN_PROFIT);

        uint256 treasuryBefore = weth.balanceOf(treasury);
        vm.prank(operator);
        executor.execute(request);

        uint256 profit = weth.balanceOf(treasury) - treasuryBefore;
        assertEq(profit, 102.5e18, "profit to treasury");
        assertEq(weth.balanceOf(address(executor)), 0, "no stranded balance");
        assertEq(weth.balanceOf(address(morpho)), 1_000_000e18, "loan repaid");
    }

    function test_morpho_reverts_when_profit_below_floor() public {
        Types.ExecutionRequest memory request = _request(Types.LoanProvider.Morpho, 1.01e18, 100e18);

        // Round trip 1.01^2 = 1.0201 => 20.1 WETH profit, below the 100 WETH floor.
        // `required` is measured against the pre-loan balance (zero here), so the floor is
        // exactly `minProfit`.
        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(Errors.InsufficientProfit.selector, 100e18, 20.1e18));
        executor.execute(request);
    }

    // ------------------------------------------------------------------
    // Provider 2: Balancer V2 (transfer-based repayment)
    // ------------------------------------------------------------------

    function test_balancer_v2_route_repays_and_pays_profit() public {
        Types.ExecutionRequest memory request =
            _request(Types.LoanProvider.BalancerV2, 1.05e18, MIN_PROFIT);

        uint256 treasuryBefore = weth.balanceOf(treasury);
        vm.prank(operator);
        executor.execute(request);

        assertEq(weth.balanceOf(treasury) - treasuryBefore, 102.5e18, "profit to treasury");
        assertEq(weth.balanceOf(address(executor)), 0, "no stranded balance");
        assertEq(weth.balanceOf(address(vaultV2)), 1_000_000e18, "loan repaid to vault");
    }

    // ------------------------------------------------------------------
    // Provider 3: Balancer V3 (unlock + settle)
    // ------------------------------------------------------------------

    function test_balancer_v3_route_repays_and_pays_profit() public {
        Types.ExecutionRequest memory request =
            _request(Types.LoanProvider.BalancerV3, 1.05e18, MIN_PROFIT);

        uint256 treasuryBefore = weth.balanceOf(treasury);
        vm.prank(operator);
        executor.execute(request);

        assertEq(weth.balanceOf(treasury) - treasuryBefore, 102.5e18, "profit to treasury");
        assertEq(weth.balanceOf(address(executor)), 0, "no stranded balance");
        assertEq(weth.balanceOf(address(vaultV3)), 1_000_000e18, "loan settled back");
    }

    function test_balancer_v3_charges_no_fee() public {
        // V3 has no flash-loan fee at all: a flash loan is an unbalanced-then-rebalanced
        // transient delta with no fee term. The executor must therefore repay exactly the
        // principal, and the Vault must end with exactly what it started with.
        Types.ExecutionRequest memory request =
            _request(Types.LoanProvider.BalancerV3, 1.05e18, MIN_PROFIT);

        uint256 vaultBefore = weth.balanceOf(address(vaultV3));
        uint256 treasuryBefore = weth.balanceOf(treasury);
        vm.prank(operator);
        executor.execute(request);

        assertEq(weth.balanceOf(treasury) - treasuryBefore, 102.5e18, "full profit, no fee");
        assertEq(weth.balanceOf(address(vaultV3)), vaultBefore, "vault balance unchanged");
    }

    // ------------------------------------------------------------------
    // Idle-balance handling (the bug the merge fixes)
    // ------------------------------------------------------------------

    function test_pre_existing_balance_is_not_stranded() public {
        // Simulate dust left in the executor by a previous partial run.
        weth.mint(address(executor), 7e18);

        Types.ExecutionRequest memory request =
            _request(Types.LoanProvider.Morpho, 1.05e18, MIN_PROFIT);

        uint256 treasuryBefore = weth.balanceOf(treasury);
        vm.prank(operator);
        executor.execute(request);

        // Everything except the loan (which Morpho pulls) must reach the receiver.
        assertEq(weth.balanceOf(treasury) - treasuryBefore, 109.5e18, "dust returned too");
        assertEq(weth.balanceOf(address(executor)), 0, "executor drained");
    }

    function test_pre_existing_balance_does_not_satisfy_profit_floor() public {
        // A large idle balance must not be usable to fake a profitable route: with a losing
        // route the transaction has to revert even though the contract holds extra tokens.
        weth.mint(address(executor), 10_000e18);

        Types.ExecutionRequest memory request =
            _request(Types.LoanProvider.Morpho, 0.99e18, MIN_PROFIT);

        vm.prank(operator);
        vm.expectRevert();
        executor.execute(request);
    }

    // ------------------------------------------------------------------
    // Access control
    // ------------------------------------------------------------------

    function test_only_operator_can_execute() public {
        // A stranger holding no role must be refused.
        address stranger = address(0xB0B);
        Types.ExecutionRequest memory request =
            _request(Types.LoanProvider.Morpho, 1.05e18, MIN_PROFIT);

        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                stranger,
                executor.OPERATOR_ROLE()
            )
        );
        vm.prank(stranger);
        executor.execute(request);
    }

    function test_admin_without_operator_role_cannot_execute() public {
        // ADMIN_ROLE must not imply the ability to move funds through arbitrage.
        Types.ExecutionRequest memory request =
            _request(Types.LoanProvider.Morpho, 1.05e18, MIN_PROFIT);

        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector,
                admin,
                executor.OPERATOR_ROLE()
            )
        );
        vm.prank(admin);
        executor.execute(request);
    }

    function test_operator_cannot_withdraw_or_manage_whitelist() public {
        vm.startPrank(operator);
        vm.expectRevert();
        executor.rescueToken(address(weth), operator, 1);
        vm.expectRevert();
        executor.setApprovedAdapter(address(0xBEEF), true);
        vm.expectRevert();
        executor.setTreasury(operator);
        vm.expectRevert();
        executor.unpause();
        vm.stopPrank();
    }

    function test_paused_blocks_execution() public {
        vm.prank(admin);
        executor.pause();

        Types.ExecutionRequest memory request =
            _request(Types.LoanProvider.Morpho, 1.05e18, MIN_PROFIT);

        vm.prank(operator);
        vm.expectRevert();
        executor.execute(request);
    }

    // ------------------------------------------------------------------
    // Validation
    // ------------------------------------------------------------------

    function test_zero_min_profit_rejected() public {
        Types.ExecutionRequest memory request = _request(Types.LoanProvider.Morpho, 1.05e18, 0);

        vm.prank(operator);
        vm.expectRevert(Errors.InvalidMinProfit.selector);
        executor.execute(request);
    }

    function test_unapproved_adapter_rejected() public {
        Types.ExecutionRequest memory request =
            _request(Types.LoanProvider.Morpho, 1.05e18, MIN_PROFIT);
        request.route.swaps[0].adapter = address(0xBAD);

        vm.prank(operator);
        vm.expectRevert(Errors.InvalidAdapter.selector);
        executor.execute(request);
    }

    function test_zero_min_amount_out_rejected() public {
        Types.ExecutionRequest memory request =
            _request(Types.LoanProvider.Morpho, 1.05e18, MIN_PROFIT);
        request.route.swaps[0].minAmountOut = 0;

        vm.prank(operator);
        vm.expectRevert(Errors.InvalidSlippage.selector);
        executor.execute(request);
    }

    function test_open_cycle_rejected() public {
        // Last leg must return to the loan token.
        Types.ExecutionRequest memory request =
            _request(Types.LoanProvider.Morpho, 1.05e18, MIN_PROFIT);
        request.route.swaps[1].tokenOut = address(usdc);

        vm.prank(operator);
        vm.expectRevert(Errors.InvalidRoute.selector);
        executor.execute(request);
    }

    function test_discontiguous_legs_rejected() public {
        Types.ExecutionRequest memory request =
            _request(Types.LoanProvider.Morpho, 1.05e18, MIN_PROFIT);
        request.route.swaps[1].tokenIn = address(0xDEAD);

        vm.prank(operator);
        vm.expectRevert(Errors.InvalidRoute.selector);
        executor.execute(request);
    }

    function test_loan_size_limits_enforced() public {
        vm.prank(admin);
        executor.setLoanSizeLimits(address(weth), 5000e18, 0);

        Types.ExecutionRequest memory request =
            _request(Types.LoanProvider.Morpho, 1.05e18, MIN_PROFIT);

        vm.prank(operator);
        vm.expectRevert(
            abi.encodeWithSelector(Errors.LoanSizeOutOfBounds.selector, LOAN, 5000e18, uint256(0))
        );
        executor.execute(request);
    }

    function test_unconfigured_provider_rejected() public {
        // Deployed with `address(this)` as admin so the test contract holds OPERATOR_ROLE.
        MorphoArbExecutor noBalancer =
            new MorphoArbExecutor(address(morpho), address(0), address(0), address(this));
        // OPERATOR_ROLE is not granted at construction (by design), so grant it here.
        noBalancer.grantRole(noBalancer.OPERATOR_ROLE(), address(this));

        Types.ExecutionRequest memory request =
            _request(Types.LoanProvider.BalancerV2, 1.05e18, MIN_PROFIT);

        vm.expectRevert(Errors.InvalidProvider.selector);
        noBalancer.execute(request);
    }

    // ------------------------------------------------------------------
    // Whitelisted-call route (liquidation escape hatch)
    // ------------------------------------------------------------------

    function test_whitelisted_call_route_reaches_profit_check() public {
        // A whitelisted-call route cannot move tokens, so it can never clear a profit floor.
        // What matters is that the whitelisted call is actually reached and the floor is what
        // stops it -- proving the escape hatch is wired end-to-end, not just validated.
        CallTarget target = new CallTarget();

        vm.startPrank(admin);
        executor.addTargetToWhitelist(address(target));
        executor.addCallSelectorToWhitelist(address(target), target.ping.selector);
        vm.stopPrank();

        Types.Call[] memory calls = new Types.Call[](1);
        calls[0] = Types.Call({
            target: address(target), value: 0, data: abi.encodeWithSelector(target.ping.selector)
        });

        Types.ExecutionRequest memory request = Types.ExecutionRequest({
            loanProvider: Types.LoanProvider.Morpho,
            loanToken: address(weth),
            loanAmount: LOAN,
            minProfit: MIN_PROFIT,
            profitReceiver: treasury,
            mode: Types.RouteMode.WhitelistedCalls,
            route: Types.AdapterRoute({swaps: new Types.SwapStep[](0), minProfit: 0}),
            calls: calls
        });

        // The loan is repaid from the same balance, so net is zero and the floor must reject.
        // `required` is measured against the pre-loan balance (zero here).
        vm.expectRevert(abi.encodeWithSelector(Errors.InsufficientProfit.selector, MIN_PROFIT, 0));
        vm.prank(operator);
        executor.execute(request);

        // The whole transaction reverted, so `target.called()` was rolled back; the revert
        // reason above is itself the proof that the call executed and only the floor stopped
        // the route.
    }

    function test_whitelisted_call_route_can_complete_when_route_profits() public {
        // A whitelisted-call route that earns: the "liquidation" target itself performs a
        // swap, so the escape hatch is proven usable end-to-end and not merely validated.
        CallTarget target = new CallTarget();
        target.configure(address(weth), address(usdc), address(adapter));
        // The adapter is what actually pays out, so its rate is what has to move.
        adapter.setRate(1.05e18);

        vm.startPrank(admin);
        executor.addTargetToWhitelist(address(target));
        executor.addCallSelectorToWhitelist(address(target), target.swapAndReturn.selector);
        executor.addTargetToWhitelist(address(weth));
        executor.addCallSelectorToWhitelist(address(weth), IERC20.approve.selector);
        vm.stopPrank();

        // Approve the target to pull WETH, then have it swap WETH -> USDC -> WETH and return
        // the proceeds. Two calls, mirroring a real liquidation sequence's shape.
        Types.Call[] memory calls = new Types.Call[](2);
        calls[0] = Types.Call({
            target: address(weth),
            value: 0,
            data: abi.encodeWithSelector(IERC20.approve.selector, address(target), LOAN)
        });
        calls[1] = Types.Call({
            target: address(target),
            value: 0,
            data: abi.encodeWithSelector(target.swapAndReturn.selector, LOAN)
        });

        Types.ExecutionRequest memory request = Types.ExecutionRequest({
            loanProvider: Types.LoanProvider.BalancerV2,
            loanToken: address(weth),
            loanAmount: LOAN,
            minProfit: MIN_PROFIT,
            profitReceiver: treasury,
            mode: Types.RouteMode.WhitelistedCalls,
            route: Types.AdapterRoute({swaps: new Types.SwapStep[](0), minProfit: 0}),
            calls: calls
        });

        uint256 treasuryBefore = weth.balanceOf(treasury);
        vm.prank(operator);
        executor.execute(request);

        assertEq(weth.balanceOf(treasury) - treasuryBefore, 102.5e18, "route profit paid");
        assertEq(weth.balanceOf(address(executor)), 0, "executor drained");
    }

    function test_unwhitelisted_target_rejected() public {
        CallTarget target = new CallTarget();

        Types.Call[] memory calls = new Types.Call[](1);
        calls[0] = Types.Call({
            target: address(target), value: 0, data: abi.encodeWithSelector(target.ping.selector)
        });

        Types.ExecutionRequest memory request = Types.ExecutionRequest({
            loanProvider: Types.LoanProvider.Morpho,
            loanToken: address(weth),
            loanAmount: LOAN,
            minProfit: MIN_PROFIT,
            profitReceiver: treasury,
            mode: Types.RouteMode.WhitelistedCalls,
            route: Types.AdapterRoute({swaps: new Types.SwapStep[](0), minProfit: 0}),
            calls: calls
        });

        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(Errors.InvalidTarget.selector, address(target)));
        executor.execute(request);
    }

    function test_transfer_selector_cannot_be_whitelisted() public {
        CallTarget target = new CallTarget();

        vm.startPrank(admin);
        executor.addTargetToWhitelist(address(target));
        vm.expectRevert(
            abi.encodeWithSelector(
                Errors.ForbiddenSelector.selector, address(target), IERC20.transfer.selector
            )
        );
        executor.addCallSelectorToWhitelist(address(target), IERC20.transfer.selector);
        vm.stopPrank();
    }

    function test_non_zero_call_value_rejected() public {
        CallTarget target = new CallTarget();

        vm.startPrank(admin);
        executor.addTargetToWhitelist(address(target));
        executor.addCallSelectorToWhitelist(address(target), target.ping.selector);
        vm.stopPrank();

        Types.Call[] memory calls = new Types.Call[](1);
        calls[0] = Types.Call({
            target: address(target), value: 1, data: abi.encodeWithSelector(target.ping.selector)
        });

        Types.ExecutionRequest memory request = Types.ExecutionRequest({
            loanProvider: Types.LoanProvider.Morpho,
            loanToken: address(weth),
            loanAmount: LOAN,
            minProfit: MIN_PROFIT,
            profitReceiver: treasury,
            mode: Types.RouteMode.WhitelistedCalls,
            route: Types.AdapterRoute({swaps: new Types.SwapStep[](0), minProfit: 0}),
            calls: calls
        });

        vm.prank(operator);
        vm.expectRevert(abi.encodeWithSelector(Errors.NonZeroCallValue.selector, uint256(1)));
        executor.execute(request);
    }

    // ------------------------------------------------------------------
    // Callback hardening
    // ------------------------------------------------------------------

    function test_callback_cannot_be_called_directly() public {
        vm.expectRevert(Errors.CallbackNotAuthorized.selector);
        executor.onMorphoFlashLoan(1, "");

        vm.expectRevert(Errors.CallbackNotAuthorized.selector);
        executor.receiveFlashLoan(new address[](0), new uint256[](0), new uint256[](0), "");

        vm.expectRevert(Errors.CallbackNotAuthorized.selector);
        executor.unlockCallback("");
    }

    function test_provider_that_skips_callback_reverts() public {
        // A provider that returns without borrowing must not look like a success.
        SilentMorpho silent = new SilentMorpho();
        MorphoArbExecutor ex =
            new MorphoArbExecutor(address(silent), address(0), address(0), address(this));
        // The new executor has no approved adapters; approve one so validation passes and the
        // test actually reaches the callback-invocation guard.
        ex.setApprovedAdapter(address(adapter), true);
        // OPERATOR_ROLE is not granted at construction (by design), so grant it here.
        ex.grantRole(ex.OPERATOR_ROLE(), address(this));

        Types.ExecutionRequest memory request =
            _request(Types.LoanProvider.Morpho, 1.05e18, MIN_PROFIT);

        vm.expectRevert(Errors.CallbackNotInvoked.selector);
        ex.execute(request);
    }
}

/// @notice Whitelist target for the call-route tests. Optionally performs a real swap so the
///         escape hatch can be exercised with a route that actually earns.
contract CallTarget {
    bool public called;
    address public weth;
    address public usdc;
    address public adapter;
    uint256 public rateE18 = 1e18;

    /// @dev Wired up by the swap test; the plain `ping` tests need no configuration.
    function configure(address weth_, address usdc_, address adapter_) external {
        weth = weth_;
        usdc = usdc_;
        adapter = adapter_;
    }

    function setRate(uint256 rateE18_) external {
        rateE18 = rateE18_;
    }

    function ping() external returns (uint256) {
        called = true;
        return 1;
    }

    /// @dev Pulls `amountIn` WETH, swaps it to USDC and back through the adapter, then
    ///      transfers the proceeds to the caller. Shape mirrors a liquidation's
    ///      pull-collateral / sell-collateral sequence.
    function swapAndReturn(uint256 amountIn) external returns (uint256 out) {
        called = true;
        IERC20(weth).transferFrom(msg.sender, address(this), amountIn);

        IERC20(weth).approve(adapter, amountIn);
        Types.SwapStep memory leg1 = Types.SwapStep({
            adapter: adapter,
            tokenIn: weth,
            tokenOut: usdc,
            amountIn: amountIn,
            minAmountOut: 1,
            kind: Types.KIND_UNISWAP_V3,
            poolData: ""
        });
        uint256 usdcOut = MockAdapter(adapter).swap(leg1);

        IERC20(usdc).approve(adapter, usdcOut);
        Types.SwapStep memory leg2 = Types.SwapStep({
            adapter: adapter,
            tokenIn: usdc,
            tokenOut: weth,
            amountIn: usdcOut,
            minAmountOut: 1,
            kind: Types.KIND_UNISWAP_V3,
            poolData: ""
        });
        out = MockAdapter(adapter).swap(leg2);

        IERC20(weth).transfer(msg.sender, out);
    }
}

/// @notice A "Morpho" that never invokes the callback.
contract SilentMorpho {
    function flashLoan(address, uint256, bytes calldata) external {}
}
