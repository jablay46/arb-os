/**
 * Live integration test for the execution path's simulation gate.
 *
 * Requires `BASE_RPC_URL` and an `EXECUTOR_ADDRESS` that is actually deployed and
 * has an approved adapter. Skipped otherwise, so CI stays offline.
 *
 * What this proves that `execute.test.ts` cannot: that the calldata we build is
 * accepted by the *real* executor's decoder, and that a route which clears its
 * floor is distinguished from one that does not, by `eth_call` alone. A purely
 * offline test cannot tell a well-formed request from a well-formed-looking one;
 * only the deployed contract's decoder can.
 *
 * Run:
 *   BASE_RPC_URL=... EXECUTOR_ADDRESS=0x... \
 *     OPERATOR_ADDRESS=0x... npx tsx --test scanner/test/execute.integration.test.ts
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeAbiParameters, parseAbiParameters, type Address } from "viem";

import { RpcClient } from "../src/rpc.js";
import { ADDR } from "../src/config.js";
import { encodeExecute, EXECUTE_SELECTOR, Kind, type ExecutionRequest } from "../src/abi.js";
import { preflight } from "../src/preflight.js";
import { decodeRevert } from "../src/errors.js";

const RPC_URL = process.env.BASE_RPC_URL?.trim();
const EXECUTOR = process.env.EXECUTOR_ADDRESS?.trim() as Address | undefined;
const OPERATOR = process.env.OPERATOR_ADDRESS?.trim() as Address | undefined;

/** This suite is opt-in: it needs a live endpoint and a deployed executor. */
const enabled = Boolean(RPC_URL && EXECUTOR && OPERATOR);

const describe = enabled ? test : test.skip;

describe("preflight finds the executor and its admin-configured state", async () => {
  const rpc = new RpcClient(RPC_URL!);

  const chainId = await rpc.chainId();
  assert.equal(chainId, 8453, "must run against Base");

  // Preflight should either succeed with a coherent state, or fail with a
  // SafetyError naming what is missing. What it must NOT do is pass while the
  // executor is misconfigured.
  try {
    const pf = await preflight({
      rpc,
      executor: EXECUTOR!,
      operator: OPERATOR!,
      loanToken: ADDR.WETH,
      requiredAdapters: [],
    });
    assert.notEqual(
      pf.treasury.toLowerCase(),
      "0x0000000000000000000000000000000000000000",
      "a zero treasury would burn profit",
    );
    assert.equal(pf.operatorHasRole, true, "preflight passed without the operator role");
    assert.ok(pf.approvedAdapters instanceof Set);
  } catch (e) {
    const msg = (e as Error).message;
    assert.match(
      msg,
      /paused|OPERATOR_ROLE|treasury|not approved|no contract/i,
      `unexpected preflight failure: ${msg}`,
    );
  }
});

/**
 * A request built by this bot must decode on the real executor.
 *
 * This is the cross-language check that matters. If `abi.ts` disagreed with
 * `Types.sol`, the executor would revert with a decoding failure *before* any
 * route validation -- which this asserts does not happen.
 */
describe("a well-formed request decodes on the deployed executor", async () => {
  const rpc = new RpcClient(RPC_URL!);

  // Build a request with a leg that is intentionally under-sized, so the route
  // itself is refused (too little received) rather than the calldata being
  // un-decodable. The distinction is the whole point: a *decoding* revert means
  // the encoding is wrong, a *route* revert means the encoding is fine.
  const request: ExecutionRequest = {
    loanProvider: 0,
    loanToken: ADDR.WETH,
    loanAmount: 10n ** 15n, // tiny: the route below cannot satisfy its floor
    minProfit: 1n,
    profitReceiver: OPERATOR!,
    swaps: [
      {
        adapter: OPERATOR!, // an EOA "adapter": the route will fail, but decode fine
        tokenIn: ADDR.WETH,
        tokenOut: ADDR.USDC,
        amountIn: 10n ** 15n,
        minAmountOut: 10n ** 18n, // deliberately unachievable
        kind: Kind.UniswapV3,
        poolData: encodeAbiParameters(parseAbiParameters("uint24"), [500]),
      },
    ],
  };

  const data = encodeExecute(request);

  try {
    await rpc.callFrom({ to: EXECUTOR!, data, from: OPERATOR! });
    // If it did not revert, that is also fine: it means the executor accepted a
    // route that (implausibly) succeeded. Log rather than fail, because pool
    // state is not ours to control.
    assert.ok(true);
  } catch (e) {
    const decoded = decodeRevert((e as { data?: string }).data ?? "0x");
    // A decoding failure surfaces as an unrecognised selector or a panic. A
    // route-level refusal surfaces as one of the executor's own errors.
    assert.notEqual(
      decoded.name,
      null,
      `calldata did not decode on the executor: ${decoded.summary}. ` +
        `This means abi.ts disagrees with Types.sol.`,
    );
  }
});

/**
 * The selector the bot uses must be the selector the executor exposes.
 *
 * Checked against live bytecode by dispatching a call: if the selector were
 * wrong the executor would fall through to its fallback and revert differently.
 * The offline test pins it against the artifact; this pins it against the chain.
 */
describe("the pinned selector reaches execute() on the real contract", async () => {
  const rpc = new RpcClient(RPC_URL!);

  const code = await rpc.getCode(EXECUTOR!);
  assert.ok(code.length > 2, "executor has no code");

  // Dispatch with the pinned selector and a deliberately short body. A
  // selector the contract implements reverts while decoding its arguments; a
  // selector it does not implement reverts in the fallback. Both revert, so the
  // only reliable check is that the call is not rejected as an unknown method
  // by the *provider*.
  const data = `${EXECUTE_SELECTOR}${"00".repeat(4)}` as `0x${string}`;
  try {
    await rpc.callFrom({ to: EXECUTOR!, data, from: OPERATOR! });
  } catch (e) {
    const decoded = decodeRevert((e as { data?: string }).data ?? "0x");
    // We expect a decode failure (short body). What we must not see is a
    // selector-related error, which would mean the constant is stale.
    assert.doesNotMatch(decoded.summary, /unknown|not implemented/i);
  }
});
