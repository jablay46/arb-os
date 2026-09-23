/**
 * Tests for gas-aware net ranking and the L1 data-fee size calculation.
 *
 * The point of these tests is the case where ranking by net disagrees with
 * ranking by gross. A test that only checks "the biggest gross wins" would
 * pass against the old, wrong behaviour, so the central fixture below is
 * deliberately one where the largest gross is not the best trade.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  canStillWin,
  gasCost,
  pickBestNet,
  unsignedTxRlpLen,
  DRY_RUN_GAS_UNITS,
  type GasOutcome,
} from "../src/gas.js";
import type { Opportunity } from "../src/discovery.js";

const WETH = "0x4200000000000000000000000000000000000006";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

/** A candidate with only the fields the ranking reads filled in meaningfully. */
function opp(grossProfit: bigint, label = "x"): Opportunity {
  return {
    first: 0,
    second: 1,
    loanAmount: 10n ** 18n,
    leg1: { venue: 0, amountIn: 10n ** 18n, amountOut: 0n, local: true },
    leg2: { venue: 1, amountIn: 0n, amountOut: 0n, local: true },
    grossProfit,
  } as Opportunity & { label?: string };
}

const priced = (gas: bigint): GasOutcome => ({ kind: "priced", gas });
const rejected: GasOutcome = { kind: "rejected" };

// --- pickBestNet ----------------------------------------------------------

test("a larger gross with proportional gas still wins", () => {
  const a = opp(1_000n);
  const b = opp(500n);
  const best = pickBestNet(
    [
      { opportunity: a, outcome: priced(100n) }, // net 900
      { opportunity: b, outcome: priced(100n) }, // net 400
    ],
    0n,
  );
  assert.equal(best?.opportunity.grossProfit, 1_000n);
});

test("the smaller gross wins when its gas is low enough", () => {
  // This is the case the whole module exists for: ranking on gross would pick
  // A (net 100) over B (net 300), and lose 200 of profit.
  const a = opp(1_000n);
  const b = opp(900n);
  const best = pickBestNet(
    [
      { opportunity: a, outcome: priced(900n) }, // net 100
      { opportunity: b, outcome: priced(600n) }, // net 300
    ],
    0n,
  );
  assert.equal(best?.opportunity.grossProfit, 900n, "net must beat gross");
});

test("a rejected candidate is skipped, not treated as free", () => {
  const a = opp(1_000n);
  const b = opp(500n);
  const best = pickBestNet(
    [
      { opportunity: a, outcome: rejected }, // reverts: unexecutable
      { opportunity: b, outcome: priced(100n) }, // net 400
    ],
    0n,
  );
  assert.equal(best?.opportunity.grossProfit, 500n);
});

test("candidates below minProfit on net terms are dropped", () => {
  const a = opp(1_000n);
  const best = pickBestNet([{ opportunity: a, outcome: priced(950n) }], 100n);
  assert.equal(best, null, "net 50 does not clear a 100 floor");
});

test("gas exceeding gross floors net at zero rather than going negative", () => {
  // saturating_sub, mirrored from Rust: net floors at 0 instead of wrapping to
  // a huge positive bigint, which would look like the best trade on the board.
  const a = opp(100n);
  assert.equal(pickBestNet([{ opportunity: a, outcome: priced(500n) }], 1n), null);
  // The boundary is faithful to Rust's `net < min_profit` filter: a zero net
  // clears a zero floor, so it is returned rather than silently dropped.
  const zeroFloor = pickBestNet([{ opportunity: a, outcome: priced(100n) }], 0n);
  assert.equal(zeroFloor?.opportunity.grossProfit, 100n);
});

test("an empty candidate list is null, not a crash", () => {
  assert.equal(pickBestNet([], 0n), null);
});

test("ties keep the earlier candidate", () => {
  const a = opp(1_000n);
  const b = opp(1_000n);
  const best = pickBestNet(
    [
      { opportunity: a, outcome: priced(100n) },
      { opportunity: b, outcome: priced(100n) },
    ],
    0n,
  );
  assert.equal(best?.opportunity, a, "first-seen wins a tie");
});

// --- canStillWin ----------------------------------------------------------

test("a candidate above the incumbent's net is still worth simulating", () => {
  const incumbent = { opportunity: opp(1_000n), gas: 400n }; // net 600
  assert.equal(canStillWin(601n, incumbent), true);
});

test("the boundary is exclusive: gross equal to net cannot win", () => {
  // With equal gross the candidate's own net can be at most that gross, and
  // pickBestNet's comparison is strict, so it cannot displace the incumbent.
  const incumbent = { opportunity: opp(1_000n), gas: 400n }; // net 600
  assert.equal(canStillWin(600n, incumbent), false);
});

test("gross one wei above the incumbent's net can win", () => {
  // Guards the off-by-one: with a zero gas price this candidate keeps its full
  // gross as net and is a strict winner, so it must not be pruned.
  const incumbent = { opportunity: opp(1_000n), gas: 400n }; // net 600
  assert.equal(canStillWin(601n, incumbent), true);
  const zeroGas = { opportunity: opp(1_000n), gas: 0n }; // net 1000
  assert.equal(canStillWin(1_001n, zeroGas), true);
});

test("a small gross is pruned once the incumbent's net is high", () => {
  const incumbent = { opportunity: opp(10_000n), gas: 100n }; // net 9900
  assert.equal(canStillWin(9_000n, incumbent), false);
});

// --- gasCost --------------------------------------------------------------

test("gas cost is L2 execution plus the L1 data fee", () => {
  const cost = gasCost({
    gasUnits: 400_000n,
    gasPriceWei: 1_000_000n, // 0.001 gwei
    l1FeeWei: 7n,
    loanToken: WETH,
    wrappedNative: WETH,
  });
  assert.equal(cost, 400_000n * 1_000_000n + 7n);
});

test("a non-native loan token is refused rather than silently mispriced", () => {
  // Wei is only comparable to profit when the loan token is ETH. With USDC the
  // comparison would be wrong by the ETH/USDC rate, which is exactly the kind
  // of error that produces confident nonsense.
  assert.throws(
    () =>
      gasCost({
        gasUnits: 400_000n,
        gasPriceWei: 1_000_000n,
        l1FeeWei: 0n,
        loanToken: USDC,
        wrappedNative: WETH,
      }),
    /wrapped native/,
  );
});

test("the loan-token guard ignores address casing", () => {
  assert.doesNotThrow(() =>
    gasCost({
      gasUnits: 1n,
      gasPriceWei: 1n,
      l1FeeWei: 0n,
      loanToken: WETH.toUpperCase().replace("0X", "0x") as `0x${string}`,
      wrappedNative: WETH,
    }),
  );
});

// --- unsignedTxRlpLen ----------------------------------------------------

test("the priced transaction size covers the whole tx, not just calldata", () => {
  // Feeding the oracle a bare calldata length under-prices the L1 fee by the
  // envelope. Measured for Base: 94 bytes over the calldata. The Rust comment
  // says "~110", which is a round-up rather than the computed value -- the
  // computed value is what the oracle is fed.
  const calldata = 4 + 24 * 32; // 772
  const size = unsignedTxRlpLen(8453, calldata);
  assert.equal(size - calldata, 94);
});

test("the size is stable for Base and grows with the chain id", () => {
  const calldata = 772;
  const base = unsignedTxRlpLen(8453, calldata); // 2-byte chain id
  const sepolia = unsignedTxRlpLen(84532, calldata); // 3-byte chain id
  const ethereum = unsignedTxRlpLen(1, calldata); // 1-byte chain id
  assert.ok(sepolia > base, "a wider chain id must price a larger transaction");
  assert.ok(base > ethereum);
  // Pinned against an independent computation of the same RLP rules, so an
  // accidental change to the field widths is caught.
  assert.equal(base, 866);
  assert.equal(sepolia, 867);
  assert.equal(ethereum, 865);
});

test("the dry-run gas ceiling is the Rust constant", () => {
  assert.equal(DRY_RUN_GAS_UNITS, 400_000n);
});

test("the dry-run ceiling errs above a realistic execution", () => {
  // A Morpho flash loan plus two router swaps runs well under 400k gas. The
  // constant only needs to be conservative, but a value below the real cost
  // would let dry run report trades that live mode rejects.
  assert.ok(DRY_RUN_GAS_UNITS >= 300_000n);
});
