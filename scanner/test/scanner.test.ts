/**
 * Tests for the scanner's math and discovery logic.
 *
 * Run with: npx tsx --test scanner/test/scanner.test.ts
 *
 * Pure-logic tests with no network dependency, so they run without an RPC.
 * On-chain behaviour is covered by the Foundry fork tests.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { getAmountOut, orientReserves, Unquotable } from "../src/math.js";
import { rankedOpportunities, bestCandidate } from "../src/discovery.js";

const WETH = "0x4200000000000000000000000000000000000006";
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";

test("getAmountOut reproduces the constant-product formula", () => {
  // 1 WETH into a 10/10 pool at 30bps, checked against the formula computed
  // independently: (1e18 * 9970 * 10e18) / (10e18 * 10000 + 1e18 * 9970).
  const out = getAmountOut(10n ** 18n, 10n * 10n ** 18n, 10n * 10n ** 18n, 30n);
  assert.equal(out, 906610893880149131n);
});

test("a lower fee yields strictly more output", () => {
  const args = [10n ** 18n, 10n * 10n ** 18n, 10n * 10n ** 18n] as const;
  const five = getAmountOut(...args, 5n);
  const thirty = getAmountOut(...args, 30n);
  assert.ok(five > thirty, "0.05% must beat 0.3% on identical reserves");
});

test("an invalid fee rate is rejected rather than silently clamped", () => {
  assert.throws(() => getAmountOut(10n ** 18n, 10n ** 18n, 10n ** 18n, 10_000n), Unquotable);
});

test("zero input and empty reserves are unquotable, not zero", () => {
  assert.throws(() => getAmountOut(0n, 10n ** 18n, 10n ** 18n, 30n), Unquotable);
  assert.throws(() => getAmountOut(10n ** 18n, 0n, 10n ** 18n, 30n), Unquotable);
  assert.throws(() => getAmountOut(10n ** 18n, 10n ** 18n, 0n, 30n), Unquotable);
});

test("orientReserves flips when the input token is token1", () => {
  const a = orientReserves(100n, 200n, WETH, USDC, WETH, "0xpool");
  assert.deepEqual(a, { reserveIn: 100n, reserveOut: 200n });
  const b = orientReserves(100n, 200n, WETH, USDC, USDC, "0xpool");
  assert.deepEqual(b, { reserveIn: 200n, reserveOut: 100n });
});

test("orientReserves refuses a pool that lacks the input token", () => {
  assert.throws(() => orientReserves(100n, 200n, WETH, USDC, "0xdead", "0xpool"), Unquotable);
});

// --- discovery ------------------------------------------------------------

/**
 * Build venue quotes for a cycle.
 *
 * `leg1` is indexed by loan size and holds the *quote-token output* of that
 * leg (not the loan amount). `leg2` maps a quote-token amount in to the
 * loan-token amount out. The key must be an input the other venue actually
 * produced, or the fixture describes a cycle nobody would execute.
 */
function venueQuotes(
  venue: number,
  leg1: (bigint | null)[],
  leg2: Map<string, bigint | null>,
) {
  return {
    venue,
    leg1,
    leg1Local: leg1.map(() => true),
    leg2,
    leg2Local: new Map([...leg2.keys()].map((k) => [k, true] as [string, boolean])),
  };
}

/**
 * A dislocated fixture where only ONE direction is profitable.
 *
 * venue0 is the cheap place to buy the quote token (100 loan -> 110 quote) but
 * a bad place to sell it (110 quote -> only 100 loan back). venue1 is the
 * reverse. So the cycle loan -> quote on venue0, quote -> loan on venue1 turns
 * 100 into 120: a gross profit of 20.
 *
 * The asymmetry matters. With two identical venues both directions are equally
 * profitable and the engine correctly reports two candidates, which makes a
 * "found the right direction" assertion meaningless. Here venue1's leg-1 output
 * is 100, a key venue0 has no leg-2 price for, so the reverse cycle is not
 * pricable at all.
 */
function dislocated(): ReturnType<typeof venueQuotes>[] {
  return [
    venueQuotes(0, [110n], new Map([["110", 100n]])),
    venueQuotes(1, [100n], new Map([["110", 120n]])),
  ];
}

test("a balanced market has no opportunity", () => {
  // 100 loan out to 110 quote, and 110 quote back to exactly 100 loan: the
  // cycle is a wash and must not be reported.
  const venues = [
    venueQuotes(0, [110n], new Map([["110", 100n]])),
    venueQuotes(1, [100n], new Map([["110", 100n]])),
  ];
  assert.equal(rankedOpportunities([100n], venues, 0n).length, 0);
});

test("a dislocation is found in the profitable direction", () => {
  const venues = dislocated();
  const opps = rankedOpportunities([100n], venues, 0n);
  assert.equal(opps.length, 1);
  assert.equal(opps[0]!.first, 0);
  assert.equal(opps[0]!.second, 1);
  assert.equal(opps[0]!.grossProfit, 20n);
  assert.equal(opps[0]!.leg1.amountOut, 110n);
  assert.equal(opps[0]!.leg2.amountOut, 120n);
});

test("the mirror direction is found when the venues are swapped", () => {
  // Swapping which venue sits at which index must mirror the discovered
  // direction while the profit stays the same: the same dislocation, reported
  // from the other side.
  const mirrored = [
    venueQuotes(1, [110n], new Map([["110", 100n]])),
    venueQuotes(0, [100n], new Map([["110", 120n]])),
  ];
  const opps = rankedOpportunities([100n], mirrored, 0n);
  assert.equal(opps.length, 1);
  assert.equal(opps[0]!.first, 1);
  assert.equal(opps[0]!.second, 0);
  assert.equal(opps[0]!.grossProfit, 20n);
});

test("the same venue twice is not a cycle", () => {
  // A round trip through one pool always pays the fee twice.
  const venues = [venueQuotes(0, [110n], new Map([["110", 120n]]))];
  assert.equal(rankedOpportunities([100n], venues, 0n).length, 0);
});

test("min profit filters small gains", () => {
  const venues = dislocated();
  assert.equal(rankedOpportunities([100n], venues, 20n).length, 1, "20 profit clears a 20 floor");
  assert.equal(rankedOpportunities([100n], venues, 21n).length, 0, "20 profit does not clear 21");
});

test("unquotable sizes skip only their own candidate", () => {
  // Size index 1 is unquotable on venue 0, so no candidate may come from it,
  // while size index 0 still yields one.
  const venues = [
    venueQuotes(0, [110n, null], new Map([["110", 100n]])),
    venueQuotes(1, [100n, 200n], new Map([["110", 120n]])),
  ];
  const opps = rankedOpportunities([100n, 200n], venues, 0n);
  assert.equal(opps.length, 1, "the null size must not produce a candidate");
  assert.equal(opps[0]!.loanAmount, 100n);
});

test("candidates are sorted by gross profit descending", () => {
  // Two loan sizes, both profitable in the same direction, by 40 and 20.
  const venues = [
    venueQuotes(0, [110n, 220n], new Map([["110", 100n], ["220", 200n]])),
    venueQuotes(1, [100n, 100n], new Map([["110", 120n], ["220", 240n]])),
  ];
  const opps = rankedOpportunities([100n, 200n], venues, 0n);
  assert.equal(opps.length, 2);
  assert.equal(opps[0]!.grossProfit, 40n);
  assert.equal(opps[1]!.grossProfit, 20n);
  for (let i = 1; i < opps.length; i++) {
    assert.ok(opps[i - 1]!.grossProfit >= opps[i]!.grossProfit, "must be gross-descending");
  }
});

test("bestCandidate reports a loss instead of hiding it", () => {
  // Every cycle loses; the diagnostic must still say by how much, so an
  // operator can tell a -0.02% spread from a -5% one. Here 100 loan returns
  // 99: a margin of -1.
  const venues = [
    venueQuotes(0, [110n], new Map([["110", 99n]])),
    venueQuotes(1, [100n], new Map([["110", 99n]])),
  ];
  assert.equal(rankedOpportunities([100n], venues, 0n).length, 0);
  const best = bestCandidate([100n], venues);
  assert.ok(best);
  assert.equal(best.margin, -1n);
});

test("bestCandidate is null when nothing is pricable", () => {
  const venues = [venueQuotes(0, [null], new Map())];
  assert.equal(bestCandidate([100n], venues), null);
});
