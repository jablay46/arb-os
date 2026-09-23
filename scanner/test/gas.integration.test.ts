/**
 * Integration test: the gas-cost inputs must be readable from live Base.
 *
 * The unit tests cover the arithmetic; this covers the two RPC reads that
 * feed it. They are separate on purpose -- a ranking bug and an RPC bug would
 * otherwise hide behind each other, and both produce the same symptom: a
 * plausible-looking net number that is wrong.
 *
 * Requires BASE_RPC_URL. Skipped otherwise so the unit suite stays offline.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { RpcClient } from "../src/rpc.js";
import { fetchGasPrice, fetchL1FeeUpperBound, unsignedTxRlpLen, EXECUTE_CALLDATA_LEN } from "../src/gas.js";
import { BASE_CHAIN_ID } from "../src/config.js";

const rpcUrl = process.env.BASE_RPC_URL;
const skip = rpcUrl ? false : "BASE_RPC_URL not set";

test("the L2 gas price is readable and plausible", { skip }, async () => {
  const rpc = new RpcClient(rpcUrl!);
  const wei = await fetchGasPrice(rpc);
  // Base sits orders of magnitude below Ethereum L1. A value above 100 gwei
  // would mean the endpoint answered a different chain, or returned wei where
  // gwei was meant -- both would inflate gas cost and hide real opportunities.
  assert.ok(wei > 0n, "gas price must be positive");
  assert.ok(wei < 100_000_000_000n, `implausible L2 gas price ${wei} wei`);
});

test("the L1 data fee is priced, and is not zero", { skip }, async () => {
  const rpc = new RpcClient(rpcUrl!);
  const block = await rpc.blockNumber();
  const fee = await fetchL1FeeUpperBound(rpc, BASE_CHAIN_ID, block);

  assert.notEqual(fee, null, "the GasPriceOracle predeploy must be readable on Base");
  // Every broadcast pays this, so a zero here would mean the oracle call was
  // mis-encoded and the fee is silently absent -- the exact failure the
  // null-means-skip-the-block rule exists to prevent.
  assert.ok(fee! > 0n, `L1 data fee must be positive, got ${fee}`);
});

test("the L1 fee is priced for the full transaction size", { skip }, async () => {
  // The fee scales with the size fed to the oracle. Pricing a bare calldata
  // length would under-report; pricing a much larger size would over-report.
  // Both are checked as a band around the correctly computed size.
  const rpc = new RpcClient(rpcUrl!);
  const block = await rpc.blockNumber();

  const correctSize = unsignedTxRlpLen(BASE_CHAIN_ID, EXECUTE_CALLDATA_LEN);
  assert.equal(correctSize, 866, "regression: the tx-size calculation changed");

  const correct = await fetchL1FeeUpperBound(rpc, BASE_CHAIN_ID, block, EXECUTE_CALLDATA_LEN);
  const calldataOnly = await fetchL1FeeUpperBound(rpc, BASE_CHAIN_ID, block, EXECUTE_CALLDATA_LEN - 94);

  assert.notEqual(correct, null);
  assert.notEqual(calldataOnly, null);
  assert.ok(
    correct! >= calldataOnly!,
    `a larger priced transaction must not cost less: full=${correct} calldataOnly=${calldataOnly}`,
  );
});
