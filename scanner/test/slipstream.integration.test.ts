/**
 * Integration test: Slipstream venue resolution and the generation guard.
 *
 * Aerodrome runs two Slipstream CL generations on Base and both are live. They
 * share a QuoterV2 ABI and a router selector, so a mismatched pair does not
 * revert -- it returns a plausible price from the *other* generation's pool of
 * the same tick spacing. That is the failure these tests pin down: not that the
 * addresses are wrong, but that using the wrong pairing is invisible.
 *
 * Requires BASE_RPC_URL. Skipped otherwise so the unit suite stays offline.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { encodeFunctionData, decodeAbiParameters, parseAbiParameters } from "viem";

import { RpcClient } from "../src/rpc.js";
import { buildVenue, SlipstreamVenue } from "../src/venues.js";
import { ADDR, type VenueConfig } from "../src/config.js";

const rpcUrl = process.env.BASE_RPC_URL;
const skip = rpcUrl ? false : "BASE_RPC_URL not set";

const SLIP_QUOTER_ABI = [
  {
    type: "function",
    name: "quoteExactInputSingle",
    stateMutability: "nonpayable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "tickSpacing", type: "int24" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [
      { name: "amountOut", type: "uint256" },
      { name: "sqrtPriceX96After", type: "uint160" },
      { name: "initializedTicksCrossed", type: "uint32" },
      { name: "gasEstimate", type: "uint256" },
    ],
  },
] as const;

/** Raw QuoterV2 call, bypassing the venue, so a test can deliberately mismatch. */
async function rawQuote(
  rpc: RpcClient,
  quoter: string,
  tokenIn: string,
  tokenOut: string,
  amountIn: bigint,
  tickSpacing: number,
  block: number,
): Promise<bigint | null> {
  const data = encodeFunctionData({
    abi: SLIP_QUOTER_ABI,
    functionName: "quoteExactInputSingle",
    args: [{ tokenIn: tokenIn as `0x${string}`, tokenOut: tokenOut as `0x${string}`, amountIn, tickSpacing, sqrtPriceLimitX96: 0n }],
  });
  const [raw] = await rpc.ethCalls([{ to: quoter, data }], { block });
  if (!raw || raw === "0x") return null;
  const [amountOut] = decodeAbiParameters(
    parseAbiParameters("uint256, uint160, uint32, uint256"),
    raw as `0x${string}`,
  );
  return amountOut;
}

const slipCfg = (label: string, tickSpacing: number, quoter: string): VenueConfig => ({
  kind: "slipstream",
  label,
  token: ADDR.USDC,
  tickSpacing,
  quoter: quoter as `0x${string}`,
});

const DEEP_OLD = slipCfg("slipstream-old-ts100", 100, ADDR.SLIPSTREAM_QUOTER_OLD);
const DEEP_NEW = slipCfg("slipstream-new-ts50", 50, ADDR.SLIPSTREAM_QUOTER_NEW);
const THIN_OLD = slipCfg("slipstream-old-ts10", 10, ADDR.SLIPSTREAM_QUOTER_OLD);

test("the factory is taken from the quoter, not from config", { skip }, async () => {
  const rpc = new RpcClient(rpcUrl!);
  const block = await rpc.blockNumber();

  const oldVenue = (await buildVenue(DEEP_OLD, ADDR.WETH, rpc, block)) as SlipstreamVenue;
  const newVenue = (await buildVenue(DEEP_NEW, ADDR.WETH, rpc, block)) as SlipstreamVenue;

  assert.equal(oldVenue.factory, ADDR.SLIPSTREAM_FACTORY_OLD, "old quoter must report the old factory");
  assert.equal(newVenue.factory, ADDR.SLIPSTREAM_FACTORY_NEW, "new quoter must report the new factory");
  assert.notEqual(oldVenue.factory, newVenue.factory, "the two generations must not share a factory");
});

test("a tick spacing the generation does not have is refused, not mispriced", { skip }, async () => {
  const rpc = new RpcClient(rpcUrl!);
  const block = await rpc.blockNumber();

  // ts=100 exists only on the old generation; the new factory resolves nothing.
  await assert.rejects(
    () => buildVenue(slipCfg("slipstream-new-ts100", 100, ADDR.SLIPSTREAM_QUOTER_NEW), ADDR.WETH, rpc, block),
    /no tickSpacing=100 pool/,
  );
});

test("the wrong-generation quoter answers a plausible price instead of reverting", { skip }, async () => {
  // This is the whole reason the venue derives its factory from the quoter. A
  // new-generation ts=50 pool priced by the OLD generation's quoter does not
  // fail -- it silently prices the old generation's *different* ts=50 pool. The
  // two answers differ materially while neither call errors, so nothing short of
  // pinning the pairing catches it.
  const rpc = new RpcClient(rpcUrl!);
  const block = await rpc.blockNumber();
  const amountIn = 10n ** 18n; // 1 WETH

  const correct = await rawQuote(rpc, ADDR.SLIPSTREAM_QUOTER_NEW, ADDR.WETH, ADDR.USDC, amountIn, 50, block);
  const wrong = await rawQuote(rpc, ADDR.SLIPSTREAM_QUOTER_OLD, ADDR.WETH, ADDR.USDC, amountIn, 50, block);

  assert.ok(correct, "the correct-generation quoter must answer");
  assert.ok(wrong, "the wrong-generation quoter must also answer, not revert");

  const delta = correct! > wrong! ? correct! - wrong! : wrong! - correct!;
  assert.ok(
    delta * 100n > correct!,
    `expected the wrong-generation quote to differ materially, got correct=${correct} wrong=${wrong}`,
  );
});

test("a deep Slipstream venue prices close to the other generation's deep pool", { skip }, async () => {
  // Both are WETH/USDC at market, so they must agree to within a normal spread.
  // A large gap would mean one venue is pricing a stale or thin pool.
  const rpc = new RpcClient(rpcUrl!);
  const block = await rpc.blockNumber();
  const amountIn = 10n ** 18n;

  const oldVenue = (await buildVenue(DEEP_OLD, ADDR.WETH, rpc, block)) as SlipstreamVenue;
  const newVenue = (await buildVenue(DEEP_NEW, ADDR.WETH, rpc, block)) as SlipstreamVenue;

  const [oldRaw] = await rpc.ethCalls([oldVenue.encodeQuote(amountIn, "loanToQuote")], { block });
  const [newRaw] = await rpc.ethCalls([newVenue.encodeQuote(amountIn, "loanToQuote")], { block });
  const oldOut = oldVenue.decodeQuote(oldRaw!);
  const newOut = newVenue.decodeQuote(newRaw!);

  assert.ok(oldOut && newOut, "both deep venues must quote 1 WETH");
  const spread = oldOut! > newOut! ? oldOut! - newOut! : newOut! - oldOut!;
  assert.ok(
    spread * 100n < newOut!,
    `deep venues should track each other within 1%, got old=${oldOut} new=${newOut}`,
  );
});

test("a thin pool is visibly off-market, which is why it is not a default venue", { skip }, async () => {
  // The docs exclude old ts=10 for holding well under a WETH. This asserts the
  // exclusion is load-bearing: the pool answers, and its answer is far from the
  // deep venue's. Configuring it would report that gap as an arbitrage.
  const rpc = new RpcClient(rpcUrl!);
  const block = await rpc.blockNumber();
  const amountIn = 10n ** 18n;

  const deep = (await buildVenue(DEEP_OLD, ADDR.WETH, rpc, block)) as SlipstreamVenue;
  const thin = (await buildVenue(THIN_OLD, ADDR.WETH, rpc, block)) as SlipstreamVenue;

  const [deepRaw] = await rpc.ethCalls([deep.encodeQuote(amountIn, "loanToQuote")], { block });
  const [thinRaw] = await rpc.ethCalls([thin.encodeQuote(amountIn, "loanToQuote")], { block });
  const deepOut = deep.decodeQuote(deepRaw!);
  const thinOut = thin.decodeQuote(thinRaw!);

  assert.ok(thinOut, "the thin pool does answer; that is the trap");
  assert.ok(
    thinOut! * 2n < deepOut!,
    `expected the thin pool to be far below the deep one, got thin=${thinOut} deep=${deepOut}`,
  );
});
