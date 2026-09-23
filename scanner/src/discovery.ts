/**
 * Opportunity discovery: the port of the Rust bot's `ranked_opportunities`.
 *
 * The search is a two-venue cycle over a shared loan token:
 *
 *   leg 1: loanToken --[venue A]--> quoteToken
 *   leg 2: quoteToken --[venue B]--> loanToken
 *
 * Gross profit is `leg2Out - loanAmount`. Because Morpho Blue and Balancer
 * V2/V3 flash loans are fee-free on Base, there is no loan fee term.
 *
 * Two-phase quoting is not an optimisation, it is a requirement: leg 2's input
 * is leg 1's *output*, which is unknown until leg 1 has been priced. A single
 * pass would have to guess the intermediate amount, and a guessed amount
 * prices a trade nobody will execute. So:
 *
 *   phase 1 - V2/Aero reserves and leg-1 quotes (one batch)
 *   phase 2 - leg-2 quotes for the distinct leg-1 outputs (one batch)
 *
 * Both phases are pinned to the same block, so every leg prices the same chain
 * state. If the block advances between phases the legs describe different
 * worlds, and the reported profit is fiction.
 */

import { getAmountOut, orientReserves, Unquotable } from "./math.js";
import type { RpcClient } from "./rpc.js";
import type { VenueRuntime } from "./venues.js";

/** One priced leg of a candidate cycle. */
export interface Leg {
  venue: number;
  amountIn: bigint;
  amountOut: bigint;
  /** True when priced by local reserve math rather than the on-chain quoter. */
  local: boolean;
}

export interface Opportunity {
  /** Venue index selling the loan token for the quote token. */
  first: number;
  /** Venue index buying it back. */
  second: number;
  loanAmount: bigint;
  leg1: Leg;
  leg2: Leg;
  /** `leg2Out - loanAmount`, before gas. */
  grossProfit: bigint;
}

/** Diagnostic: the best cycle even when it loses, so operators can see the spread. */
export interface Candidate {
  first: number;
  second: number;
  loanAmount: bigint;
  amountOut: bigint;
  /** Signed: negative means a loss. */
  margin: bigint;
}

interface VenueQuotes {
  venue: number;
  /** leg1 output per loan size, aligned with `loanAmounts`. null = unquotable. */
  leg1: (bigint | null)[];
  leg1Local: boolean[];
  /** leg2 outputs keyed by the quote-token amount in. */
  leg2: Map<string, bigint | null>;
  leg2Local: boolean;
}

/**
 * Enumerate every profitable two-venue cycle, largest gross profit first.
 *
 * Only ordered pairs with distinct venues are considered: `first === second`
 * is a round trip through one pool, which loses the swap fee by construction.
 */
export function rankedOpportunities(
  loanAmounts: bigint[],
  venues: VenueQuotes[],
  minProfit: bigint,
): Opportunity[] {
  const out: Opportunity[] = [];

  for (const first of venues) {
    for (let i = 0; i < loanAmounts.length; i++) {
      const loanAmount = loanAmounts[i]!;
      const quoteOut = first.leg1[i];
      if (quoteOut === null || quoteOut === undefined) continue;

      for (const second of venues) {
        if (first.venue === second.venue) continue;
        const amountOut = second.leg2.get(quoteOut.toString());
        if (amountOut === null || amountOut === undefined) continue;

        const grossProfit = amountOut - loanAmount;
        if (grossProfit <= 0n || grossProfit < minProfit) continue;

        out.push({
          first: first.venue,
          second: second.venue,
          loanAmount,
          leg1: {
            venue: first.venue,
            amountIn: loanAmount,
            amountOut: quoteOut,
            local: first.leg1Local[i] ?? false,
          },
          leg2: {
            venue: second.venue,
            amountIn: quoteOut,
            amountOut,
            local: second.leg2Local.get(quoteOut.toString()) ?? false,
          },
          grossProfit,
        });
      }
    }
  }

  out.sort((a, b) => (a.grossProfit === b.grossProfit ? 0 : a.grossProfit > b.grossProfit ? -1 : 1));
  return out;
}

/**
 * Best cycle of a scan regardless of profitability, for diagnostics.
 *
 * Distinguishing "the spread was -0.02%" from "the spread was -5%" is what
 * lets an operator tune `minProfit` and the loan sizes; a scanner that reports
 * only "no opportunity" hides both.
 */
export function bestCandidate(loanAmounts: bigint[], venues: VenueQuotes[]): Candidate | null {
  let best: Candidate | null = null;

  for (const first of venues) {
    for (let i = 0; i < loanAmounts.length; i++) {
      const loanAmount = loanAmounts[i]!;
      const quoteOut = first.leg1[i];
      if (quoteOut === null || quoteOut === undefined) continue;

      for (const second of venues) {
        if (first.venue === second.venue) continue;
        const amountOut = second.leg2.get(quoteOut.toString());
        if (amountOut === null || amountOut === undefined) continue;

        const margin = amountOut - loanAmount;
        if (best === null || margin > best.margin) {
          best = { first: first.venue, second: second.venue, loanAmount, amountOut, margin };
        }
      }
    }
  }
  return best;
}

/**
 * Run one two-phase scan and return per-venue quotes.
 *
 * `block` must be pinned by the caller and passed to both phases.
 */
export async function scanVenues(
  rpc: RpcClient,
  venues: VenueRuntime[],
  loanAmounts: bigint[],
  block: number,
  maxBatchSize: number,
): Promise<VenueQuotes[]> {
  const quotes: VenueQuotes[] = venues.map((_, venue) => ({
    venue,
    leg1: new Array(loanAmounts.length).fill(null),
    leg1Local: new Array(loanAmounts.length).fill(false),
    leg2: new Map(),
    leg2Local: new Map(),
  }));

  // ---- Phase 1: reserves (V2/Aero) + leg-1 quotes (V3) -------------------
  const reserveReqs = venues
    .map((v, i) => ({ v, i }))
    .filter(({ v }) => v.kind === "aerodrome");

  const leg1Reqs: { venue: number; sizeIdx: number; req: { to: string; data: string } }[] = [];
  for (let i = 0; i < venues.length; i++) {
    const v = venues[i]!;
    if (v.kind !== "uniswap-v3") continue;
    for (let s = 0; s < loanAmounts.length; s++) {
      leg1Reqs.push({ venue: i, sizeIdx: s, req: v.encodeQuote(loanAmounts[s]!, "loanToQuote") });
    }
  }

  const reserveCalls = reserveReqs.map(({ v }) => v.encodeReserves());
  const allCalls = [...reserveCalls, ...leg1Reqs.map((r) => r.req)];
  const results = await batchCall(rpc, allCalls, block, maxBatchSize);

  reserveReqs.forEach(({ v, i }, n) => {
    const raw = results[n];
    if (!raw) return;
    try {
      const { reserve0, reserve1 } = v.decodeReserves(raw);
      v.setReserves(reserve0, reserve1);
    } catch {
      // Leave reserves unset; the venue is skipped rather than mispriced.
    }
  });

  const leg1Results = results.slice(reserveCalls.length);
  leg1Reqs.forEach((r, n) => {
    const raw = leg1Results[n];
    if (!raw) return;
    const amountOut = venues[r.venue]!.decodeQuote(raw);
    if (amountOut === null) return;
    quotes[r.venue]!.leg1[r.sizeIdx] = amountOut;
    quotes[r.venue]!.leg1Local[r.sizeIdx] = false;
  });

  // V2/Aerodrome legs are priced locally from reserves: exact, and no RPC.
  for (const { v, i } of reserveReqs) {
    const q = quotes[i]!;
    for (let s = 0; s < loanAmounts.length; s++) {
      const amountOut = v.quoteFromReserves(loanAmounts[s]!, "loanToQuote");
      if (amountOut === null) continue;
      q.leg1[s] = amountOut;
      q.leg1Local[s] = true;
    }
  }

  // ---- Phase 2: leg-2 quotes for the distinct leg-1 outputs --------------
  const leg2Inputs = new Set<string>();
  for (const q of quotes) {
    for (const out of q.leg1) if (out !== null && out !== undefined) leg2Inputs.add(out.toString());
  }

  if (leg2Inputs.size > 0) {
    const inputs = [...leg2Inputs].map((s) => BigInt(s));

    // V2/Aerodrome leg 2 is local math, in the quote -> loan direction.
    for (const { v, i } of reserveReqs) {
      const q = quotes[i]!;
      for (const amountIn of inputs) {
        const amountOut = v.quoteFromReserves(amountIn, "quoteToLoan");
        q.leg2.set(amountIn.toString(), amountOut);
        q.leg2Local.set(amountIn.toString(), true);
      }
    }

    // V3 leg 2 needs the quoter, in the quote -> loan direction.
    const leg2Reqs: { venue: number; amountIn: bigint; req: { to: string; data: string } }[] = [];
    for (let i = 0; i < venues.length; i++) {
      const v = venues[i]!;
      if (v.kind !== "uniswap-v3") continue;
      for (const amountIn of inputs) {
        leg2Reqs.push({ venue: i, amountIn, req: v.encodeQuote(amountIn, "quoteToLoan") });
      }
    }
    if (leg2Reqs.length > 0) {
      const leg2Results = await batchCall(rpc, leg2Reqs.map((r) => r.req), block, maxBatchSize);
      leg2Reqs.forEach((r, n) => {
        const raw = leg2Results[n];
        const q = quotes[r.venue]!;
        if (!raw) {
          q.leg2.set(r.amountIn.toString(), null);
          return;
        }
        const amountOut = venues[r.venue]!.decodeQuote(raw);
        q.leg2.set(r.amountIn.toString(), amountOut);
        q.leg2Local.set(r.amountIn.toString(), false);
      });
    }
  }

  return quotes;
}

/** Split a large call list into provider-sized batches and concatenate results. */
async function batchCall(
  rpc: RpcClient,
  calls: { to: string; data: string }[],
  block: number,
  maxBatchSize: number,
): Promise<(string | null)[]> {
  if (calls.length === 0) return [];
  const out: (string | null)[] = [];
  for (let i = 0; i < calls.length; i += maxBatchSize) {
    const chunk = calls.slice(i, i + maxBatchSize);
    out.push(...(await rpc.ethCalls(chunk, { block })));
  }
  return out;
}

export { getAmountOut, orientReserves, Unquotable };
