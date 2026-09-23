/**
 * Integration test: the scanner's local Aerodrome math must agree with the
 * venue's own router.
 *
 * The local constant-product path is the one place the scanner computes a
 * price instead of asking the chain, so it is the one place a wrong fee or a
 * wrong curve assumption produces confident, wrong quotes. Reading the fee
 * from the factory is not enough on its own -- the fee could be right and the
 * curve still wrong. Only a comparison against the router's own
 * `getAmountsOut` closes that gap.
 *
 * Requires BASE_RPC_URL. Skipped otherwise so the unit suite stays offline.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData, decodeAbiParameters, parseAbiParameters } from "viem";

import { RpcClient } from "../src/rpc.js";
import { getAmountOut, orientReserves } from "../src/math.js";
import {
  encodeAerodromeResolve,
  encodeAerodromeFee,
  decodeAddress,
  decodeUint,
} from "../src/venues.js";
import { ADDR } from "../src/config.js";

const rpcUrl = process.env.BASE_RPC_URL;
const skip = rpcUrl ? false : "BASE_RPC_URL not set";

const ROUTER_GET_AMOUNTS_OUT_ABI = [
  {
    type: "function",
    name: "getAmountsOut",
    stateMutability: "view",
    inputs: [
      { name: "amountIn", type: "uint256" },
      {
        name: "routes",
        type: "tuple[]",
        components: [
          { name: "from", type: "address" },
          { name: "to", type: "address" },
          { name: "stable", type: "bool" },
          { name: "factory", type: "address" },
        ],
      },
    ],
    outputs: [{ name: "amounts", type: "uint256[]" }],
  },
] as const;

const POOL_ABI = [
  { type: "function", name: "getReserves", stateMutability: "view", inputs: [], outputs: [
    { type: "uint256" }, { type: "uint256" }, { type: "uint256" }] },
  { type: "function", name: "token0", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "token1", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;

test("local Aerodrome math reproduces the router's quote", { skip }, async () => {
  const rpc = new RpcClient(rpcUrl!);
  const block = await rpc.blockNumber();
  const WETH = ADDR.WETH;
  const USDC = ADDR.USDC;

  // Resolve pool and fee the same way the scanner does: from the factory.
  const [poolRaw] = await rpc.ethCalls([encodeAerodromeResolve(WETH, USDC, false)], { block });
  assert.ok(poolRaw, "factory must resolve the WETH/USDC volatile pool");
  const pool = decodeAddress(poolRaw);

  const [feeRaw] = await rpc.ethCalls([encodeAerodromeFee(pool, false)], { block });
  assert.ok(feeRaw, "factory must report the pool fee");
  const feeBps = decodeUint(feeRaw);
  assert.ok(feeBps > 0n && feeBps < 10_000n, `implausible fee ${feeBps}`);

  const [reservesRaw, t0Raw, t1Raw] = await rpc.ethCalls(
    [
      { to: pool, data: encodeFunctionData({ abi: POOL_ABI, functionName: "getReserves" }) },
      { to: pool, data: encodeFunctionData({ abi: POOL_ABI, functionName: "token0" }) },
      { to: pool, data: encodeFunctionData({ abi: POOL_ABI, functionName: "token1" }) },
    ],
    { block },
  );
  assert.ok(reservesRaw && t0Raw && t1Raw, "pool state must be readable");

  const [r0, r1] = decodeAbiParameters(
    parseAbiParameters("uint256, uint256, uint256"),
    reservesRaw as `0x${string}`,
  );
  const token0 = decodeAddress(t0Raw);
  const token1 = decodeAddress(t1Raw);

  const amountIn = 10n ** 18n; // 1 WETH

  // The venue's own answer.
  const routerData = encodeFunctionData({
    abi: ROUTER_GET_AMOUNTS_OUT_ABI,
    functionName: "getAmountsOut",
    args: [amountIn, [{ from: WETH, to: USDC, stable: false, factory: ADDR.AERODROME_FACTORY }]],
  });
  const [routerRaw] = await rpc.ethCalls([{ to: ADDR.AERODROME_ROUTER, data: routerData }], { block });
  assert.ok(routerRaw, "router getAmountsOut must succeed");
  const [routerOut] = decodeAbiParameters(
    parseAbiParameters("uint256[]"),
    routerRaw as `0x${string}`,
  );
  const expected = routerOut[routerOut.length - 1]!;

  // The scanner's local answer.
  const { reserveIn, reserveOut } = orientReserves(r0, r1, token0, token1, WETH, pool);
  const local = getAmountOut(amountIn, reserveIn, reserveOut, feeBps);

  // Exact agreement is expected: both apply the same x*y=k formula with the
  // same integer division. A mismatch means the fee or the curve assumption is
  // wrong, which is precisely the failure this test exists to catch.
  assert.equal(
    local,
    expected,
    `local math disagrees with the router: local=${local} router=${expected} (fee=${feeBps}bps, pool=${pool})`,
  );
});

test("the volatile and stable pools of a pair have different fees", { skip }, async () => {
  // The reason the fee must be read per pool rather than assumed from the
  // factory default: on Base the same pair carries 30bps volatile and 5bps
  // stable. Using one for the other misprices every leg.
  const rpc = new RpcClient(rpcUrl!);
  const block = await rpc.blockNumber();

  const [volRaw, stableRaw] = await rpc.ethCalls(
    [
      encodeAerodromeResolve(ADDR.WETH, ADDR.USDC, false),
      encodeAerodromeResolve(ADDR.WETH, ADDR.USDC, true),
    ],
    { block },
  );
  assert.ok(volRaw && stableRaw, "both pool flavours must resolve");

  const volatile = decodeAddress(volRaw);
  const stable = decodeAddress(stableRaw);
  assert.notEqual(volatile, stable, "the two flavours must be distinct pools");

  const [volFeeRaw, stableFeeRaw] = await rpc.ethCalls(
    [encodeAerodromeFee(volatile, false), encodeAerodromeFee(stable, true)],
    { block },
  );
  const volFee = decodeUint(volFeeRaw!);
  const stableFee = decodeUint(stableFeeRaw!);

  assert.notEqual(
    volFee,
    stableFee,
    `expected different fees per pool, both reported ${volFee}bps`,
  );
});
