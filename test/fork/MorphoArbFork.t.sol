// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {MorphoArbExecutor} from "../../src/MorphoArbExecutor.sol";
import {Types} from "../../src/libraries/Types.sol";

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

interface IBalancerV2FeeSource {
    function getProtocolFeesCollector() external view returns (address);
    function getFlashLoanFeePercentage() external view returns (uint256);
}

interface IBalancerV3FeeProbe {
    function getFlashLoanFeePercentage() external view returns (uint256);
}
