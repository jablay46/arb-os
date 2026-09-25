// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

import {MorphoArbExecutor} from "../src/MorphoArbExecutor.sol";
import {AerodromeAdapter} from "../src/adapters/AerodromeAdapter.sol";
import {SlipstreamAdapter} from "../src/adapters/SlipstreamAdapter.sol";
import {UniswapV3Adapter} from "../src/adapters/UniswapV3Adapter.sol";

/// @notice Deploys the venue adapters and approves them on an existing executor.
/// @dev Exists because the executor is useless without adapters, and deploying six of them by
///      hand is exactly the kind of repetitive step where one address gets transposed. This is
///      the safe half of the setup: it deploys *adapters only* and never deploys the executor or
///      touches roles, so it cannot be used to take control of an executor it does not already
///      administer. `setApprovedAdapter` is itself `ADMIN_ROLE`-gated, so the broadcasting key
///      must be the admin.
///
///      Adapters are only deployed for the routers named in the environment; unset ones are
///      skipped, so a partial venue rollout is the normal case rather than an error:
///
///      ```
///      export EXECUTOR_ADDRESS=0x...            # existing executor (must not be zero)
///      export UNISWAP_V3_ROUTER=0x2626664c2603336E57B271c5C0b26F421741e481
///      export AERODROME_ROUTER=0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43
///      export SLIPSTREAM_ROUTER_OLD=0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5
///      export SLIPSTREAM_ROUTER_NEW=0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F
///      forge script script/DeployAdapters.s.sol --rpc-url $RPC_URL --broadcast
///      ```
///
///      The script prints the env var each adapter belongs in, because the bot looks them up by
///      venue label and a copy-paste mistake there is silent: the venue simply never trades.
contract DeployAdapters is Script {
    /// @dev Refuse a zero executor here rather than discovering it after six deployments. The
    ///      zero address accepts a `setApprovedAdapter` call as a no-op, so without this check
    ///      the script would report success having configured nothing.
    error ExecutorNotSet();
    error NoRoutersSet();

    function run() external {
        address executor = vm.envAddress("EXECUTOR_ADDRESS");
        if (executor == address(0)) revert ExecutorNotSet();

        address uniRouter = vm.envOr("UNISWAP_V3_ROUTER", address(0));
        address aeroRouter = vm.envOr("AERODROME_ROUTER", address(0));
        address slipRouterOld = vm.envOr("SLIPSTREAM_ROUTER_OLD", address(0));
        address slipRouterNew = vm.envOr("SLIPSTREAM_ROUTER_NEW", address(0));

        if (
            uniRouter == address(0) && aeroRouter == address(0) && slipRouterOld == address(0)
                && slipRouterNew == address(0)
        ) {
            revert NoRoutersSet();
        }

        // The executor declares a payable fallback, so the cast must go through `payable`.
        MorphoArbExecutor ex = MorphoArbExecutor(payable(executor));

        vm.startBroadcast();

        if (uniRouter != address(0)) {
            UniswapV3Adapter a = new UniswapV3Adapter(uniRouter);
            ex.setApprovedAdapter(address(a), true);
            _report("ADAPTER_UNISWAP_V3_0_05", address(a), "uniswap-v3-0.05%");
        }

        if (aeroRouter != address(0)) {
            AerodromeAdapter a = new AerodromeAdapter(aeroRouter);
            ex.setApprovedAdapter(address(a), true);
            _report("ADAPTER_AERODROME_VOLATILE", address(a), "aerodrome-volatile");
        }

        // Two Slipstream generations, two adapters. Each reads its own factory from the router
        // in its constructor, so pairing a router with the wrong factory is not expressible.
        if (slipRouterOld != address(0)) {
            SlipstreamAdapter a = new SlipstreamAdapter(slipRouterOld);
            ex.setApprovedAdapter(address(a), true);
            _report("ADAPTER_SLIPSTREAM_OLD_TS100", address(a), "slipstream-old-ts100");
        }

        if (slipRouterNew != address(0)) {
            SlipstreamAdapter a = new SlipstreamAdapter(slipRouterNew);
            ex.setApprovedAdapter(address(a), true);
            _report("ADAPTER_SLIPSTREAM_NEW_TS50", address(a), "slipstream-new-ts50");
        }

        vm.stopBroadcast();
    }

    /// @dev Print the env var and venue label alongside the address. The bot keys adapters off
    ///      the label, so the pairing is the part that is easy to get wrong.
    function _report(string memory envVar, address adapter, string memory label) internal view {
        console2.log(string.concat(envVar, "=", vm.toString(adapter)));
        console2.log(string.concat("  venue label: ", label));
    }
}
