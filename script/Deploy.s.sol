// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {Script} from "forge-std/Script.sol";
import {MorphoArbExecutor} from "../src/MorphoArbExecutor.sol";

/// @notice Deploys `MorphoArbExecutor` and wires its flash-loan providers.
/// @dev Addresses come from the environment so the same script serves Base mainnet and
///      Base Sepolia without edits:
///
///      ```
///      export ADMIN_ADDRESS=0x...      # cold wallet; ADMIN + PAUSER, and initial treasury
///      export OPERATOR_ADDRESS=0x...   # hot wallet; granted OPERATOR_ROLE after deploy
///      export MORPHO_ADDRESS=0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb
///      export BALANCER_V2_VAULT=0xBA12222222228d8Ba445958a75a0704d566BF2C8
///      export BALANCER_V3_VAULT=0xbA1333333333a1BA1108E8412f11850A5C319bA9
///      forge script script/Deploy.s.sol --rpc-url $RPC_URL --broadcast
///      ```
///
///      Both vault addresses above are verified live on Base. Passing `address(0)` disables a
///      provider (execution against it then reverts `InvalidProvider`), which supports a
///      staged rollout where only Morpho is wired first.
contract Deploy is Script {
    function run() external returns (MorphoArbExecutor executor) {
        address admin = vm.envAddress("ADMIN_ADDRESS");
        address morpho = vm.envOr("MORPHO_ADDRESS", address(0));
        address balancerV2 = vm.envOr("BALANCER_V2_VAULT", address(0));
        address balancerV3 = vm.envOr("BALANCER_V3_VAULT", address(0));

        vm.startBroadcast();
        executor = new MorphoArbExecutor(morpho, balancerV2, balancerV3, admin);

        // OPERATOR_ROLE is intentionally not granted at construction; hand it to the hot key
        // explicitly so the cold admin wallet cannot move funds through arbitrage.
        address operator = vm.envOr("OPERATOR_ADDRESS", address(0));
        if (operator != address(0)) {
            executor.grantRole(executor.OPERATOR_ROLE(), operator);
        }
        vm.stopBroadcast();
    }
}
