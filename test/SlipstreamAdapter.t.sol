// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {SlipstreamAdapter} from "../src/adapters/SlipstreamAdapter.sol";
import {Types} from "../src/libraries/Types.sol";

import {MockERC20} from "./mocks/MockERC20.sol";
import {MockSlipstreamRouter} from "./mocks/MockSlipstreamRouter.sol";

/// @notice Unit tests for `SlipstreamAdapter`, offline against a mock router.
/// @dev The adapter's only interesting job is encoding and generation consistency.
///      Slipstream's `ExactInputSingleParams` carries an `int24 tickSpacing` and a `deadline`,
///      both different from Uniswap V3's `SwapRouter02`, so a copy-paste of the V3 adapter
///      would compile while sending the wrong struct. On top of that, Base runs two
///      Slipstream generations whose routers share the selector and differ only in which
///      factory they resolve pools against, so these tests also pin that a leg naming the
///      wrong factory is refused rather than silently filled from the other generation.
contract SlipstreamAdapterTest is Test {
    MockERC20 internal weth;
    MockERC20 internal usdc;
    MockSlipstreamRouter internal router;
    SlipstreamAdapter internal adapter;

    address internal constant OTHER_FACTORY = address(0xBADFAC);

    int24 internal constant TICK_SPACING = 100;

    function setUp() public {
        weth = new MockERC20();
        usdc = new MockERC20();
        router = new MockSlipstreamRouter();
        adapter = new SlipstreamAdapter(address(router));

        weth.mint(address(this), 100e18);
        usdc.mint(address(router), 1_000_000e18);
    }

    function _step(uint256 amountIn, uint256 minAmountOut, int24 tickSpacing)
        internal
        view
        returns (Types.SwapStep memory)
    {
        return Types.SwapStep({
            adapter: address(adapter),
            tokenIn: address(weth),
            tokenOut: address(usdc),
            amountIn: amountIn,
            minAmountOut: minAmountOut,
            kind: Types.KIND_SLIPSTREAM,
            poolData: abi.encode(tickSpacing, adapter.factory())
        });
    }

    function test_name() public view {
        assertEq(adapter.name(), "slipstream");
    }

    /// @dev The adapter must read the router's own factory rather than trusting an argument,
    ///      because a wrong-generation factory is the mismatch it exists to catch.
    function test_constructor_reads_router_factory() public view {
        assertEq(adapter.factory(), router.mockFactory());
    }

    /// @dev The encoded `tickSpacing` must survive the round trip to the router verbatim, and
    ///      the swap must be paid for from the caller and delivered to the caller.
    function test_swap_encodes_tick_spacing_and_delivers_to_caller() public {
        router.setRate(1.05e18);
        Types.SwapStep memory step = _step(10e18, 1, TICK_SPACING);

        IERC20(address(weth)).approve(address(adapter), 10e18);
        uint256 out = adapter.swap(step);

        assertEq(out, 10.5e18, "unexpected output");
        assertEq(IERC20(address(usdc)).balanceOf(address(this)), 10.5e18, "output not delivered");

        (,, int24 encodedSpacing, address recipient, uint256 deadline, uint256 amountIn,,) =
            router.lastParams();
        assertEq(encodedSpacing, TICK_SPACING, "tickSpacing mis-encoded");
        assertEq(recipient, address(this), "recipient should be the caller");
        assertEq(amountIn, 10e18, "amountIn mis-encoded");
        assertEq(deadline, block.timestamp, "deadline should be block.timestamp");
    }

    /// @dev A different tick spacing must not be conflated with the first: Slipstream pool
    ///      identity is the tick spacing, so this is the whole pool selection.
    function test_swap_honours_a_different_tick_spacing() public {
        Types.SwapStep memory step = _step(1e18, 1, 2000);
        IERC20(address(weth)).approve(address(adapter), 1e18);
        adapter.swap(step);

        (,, int24 encodedSpacing,,,,,) = router.lastParams();
        assertEq(encodedSpacing, 2000, "tickSpacing mis-encoded");
    }

    /// @dev A leg naming the other generation's factory must be refused, not filled against
    ///      this generation's pool. This is the whole reason `poolData` carries a factory.
    function test_swap_reverts_on_factory_mismatch() public {
        Types.SwapStep memory step = _step(1e18, 1, TICK_SPACING);
        step.poolData = abi.encode(TICK_SPACING, OTHER_FACTORY);
        IERC20(address(weth)).approve(address(adapter), 1e18);

        vm.expectRevert(
            abi.encodeWithSelector(
                SlipstreamAdapter.FactoryMismatch.selector, adapter.factory(), OTHER_FACTORY
            )
        );
        adapter.swap(step);
    }

    function test_swap_reverts_on_wrong_kind() public {
        Types.SwapStep memory step = _step(1e18, 1, TICK_SPACING);
        step.kind = Types.KIND_UNISWAP_V3;

        vm.expectRevert(
            abi.encodeWithSelector(
                SlipstreamAdapter.WrongKind.selector, Types.KIND_SLIPSTREAM, Types.KIND_UNISWAP_V3
            )
        );
        adapter.swap(step);
    }

    function test_swap_reverts_on_zero_amount_in() public {
        Types.SwapStep memory step = _step(0, 1, TICK_SPACING);
        vm.expectRevert(SlipstreamAdapter.AmountInZero.selector);
        adapter.swap(step);
    }

    /// @dev The router enforces the floor; the adapter must not lower it.
    function test_swap_reverts_below_min_amount_out() public {
        router.setRate(1e18);
        Types.SwapStep memory step = _step(1e18, 2e18, TICK_SPACING);
        IERC20(address(weth)).approve(address(adapter), 1e18);

        vm.expectRevert(bytes("Too little received"));
        adapter.swap(step);
    }

    /// @dev No residual approval and no retained input, so one leg cannot spend into the next.
    function test_swap_leaves_no_allowance_or_balance() public {
        IERC20(address(weth)).approve(address(adapter), 1e18);
        adapter.swap(_step(1e18, 1, TICK_SPACING));

        assertEq(IERC20(address(weth)).balanceOf(address(adapter)), 0, "adapter kept input");
        assertEq(
            IERC20(address(weth)).allowance(address(adapter), address(router)), 0, "allowance left"
        );
    }

    function test_constructor_rejects_zero_router() public {
        vm.expectRevert(SlipstreamAdapter.ZeroAddress.selector);
        new SlipstreamAdapter(address(0));
    }

    /// @dev A router that answers `factory()` with zero cannot be paired with a factory, so the
    ///      adapter must refuse it rather than deploy with an unusable identity check.
    function test_constructor_rejects_router_with_zero_factory() public {
        router.setFactory(address(0));
        vm.expectRevert(SlipstreamAdapter.ZeroAddress.selector);
        new SlipstreamAdapter(address(router));
    }
}
