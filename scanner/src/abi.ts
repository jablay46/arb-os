/**
 * ABI encoding for `MorphoArbExecutor.execute`, mirroring `src/libraries/Types.sol`.
 *
 * This is the one place where a bug costs money quietly: a mis-encoded route does
 * not necessarily revert, it can encode a valid-looking request that trades a
 * different pair or a different pool. So the struct layouts here are asserted
 * against the Solidity source rather than eyeballed, and `abi.test.ts` pins the
 * encode selector and the `execute` selector against values computed by `cast`.
 *
 * The struct shapes are:
 *
 *   ExecutionRequest {
 *     uint8 loanProvider; address loanToken; uint256 loanAmount; uint256 minProfit;
 *     address profitReceiver; uint8 mode; AdapterRoute route; Call[] calls;
 *   }
 *   AdapterRoute { SwapStep[] swaps; uint256 minProfit; }
 *   SwapStep {
 *     address adapter; address tokenIn; address tokenOut; uint256 amountIn;
 *     uint256 minAmountOut; uint8 kind; bytes poolData;
 *   }
 *
 * `Call[]` is always empty on the adapter path, but it is a dynamic array in the
 * struct so its head word must still be encoded.
 */

import { encodeAbiParameters, parseAbiParameters, type Address } from "viem";
import type { VenueRuntime } from "./venues.js";
import { AerodromeVenue, SlipstreamVenue, UniswapV3Venue } from "./venues.js";

/** Mirrors `Types.LoanProvider`. Order is load-bearing: it is the enum's ordinal. */
export const LoanProvider = {
  Morpho: 0,
  BalancerV2: 1,
  BalancerV3: 2,
} as const;
export type LoanProviderValue = (typeof LoanProvider)[keyof typeof LoanProvider];

/** Mirrors `Types.RouteMode`. */
export const RouteMode = {
  AdapterRoute: 0,
  WhitelistedCalls: 1,
} as const;

/** Mirrors the `Types.KIND_*` constants. */
export const Kind = {
  UniswapV2: 0,
  Aerodrome: 1,
  UniswapV3: 2,
  UniswapV4: 3,
  Slipstream: 4,
} as const;

export interface SwapStep {
  adapter: Address;
  tokenIn: Address;
  tokenOut: Address;
  /** Exact input; `0` means "use the full output of the previous leg". */
  amountIn: bigint;
  /** Slippage floor in `tokenOut` units. The executor rejects zero. */
  minAmountOut: bigint;
  kind: number;
  /** Adapter-specific pool descriptor, see `encodePoolData`. */
  poolData: `0x${string}`;
}

export interface ExecutionRequest {
  loanProvider: LoanProviderValue;
  loanToken: Address;
  loanAmount: bigint;
  /** On-chain profit floor in loan-token units. The executor rejects zero. */
  minProfit: bigint;
  profitReceiver: Address;
  swaps: SwapStep[];
}

const REQUEST_ABI = parseAbiParameters(
  "uint8 loanProvider, address loanToken, uint256 loanAmount, uint256 minProfit, address profitReceiver, uint8 mode, ((address,address,address,uint256,uint256,uint8,bytes)[] swaps, uint256 routeMinProfit) route, (address,uint256,bytes)[] calls",
);

/**
 * `execute((...))` selector.
 *
 * Taken from the compiled artifact's `methodIdentifiers` and pinned by
 * `abi.test.ts`, which re-derives it from `out/MorphoArbExecutor.sol` so a
 * change to `Types.sol` cannot leave this stale. The first draft of this file
 * carried a hand-written selector that was wrong; the test exists because of it.
 */
export const EXECUTE_SELECTOR = "0xe4e5f48f" as const;

/** Encode `execute` calldata for an adapter route. */
export function encodeExecute(request: ExecutionRequest): `0x${string}` {
  if (request.loanAmount <= 0n) throw new Error("loanAmount must be positive");
  if (request.minProfit <= 0n) {
    // Mirrors `Errors.InvalidMinProfit`: a zero floor removes the only on-chain
    // backstop, so refuse it here rather than burning a revert on chain.
    throw new Error("minProfit must be positive");
  }
  if (request.swaps.length === 0) throw new Error("route must have at least one leg");

  for (const [i, s] of request.swaps.entries()) {
    if (s.minAmountOut <= 0n) {
      throw new Error(`leg ${i}: minAmountOut must be positive (executor rejects zero)`);
    }
    if (s.tokenIn.toLowerCase() === s.tokenOut.toLowerCase()) {
      throw new Error(`leg ${i}: tokenIn == tokenOut`);
    }
  }

  const encoded = encodeAbiParameters(REQUEST_ABI, [
    request.loanProvider,
    request.loanToken,
    request.loanAmount,
    request.minProfit,
    request.profitReceiver,
    RouteMode.AdapterRoute,
    {
      swaps: request.swaps.map(
        (s) =>
          [
            s.adapter,
            s.tokenIn,
            s.tokenOut,
            s.amountIn,
            s.minAmountOut,
            s.kind,
            s.poolData,
          ] as const,
      ),
      routeMinProfit: request.minProfit,
    },
    [],
  ]);

  return `${EXECUTE_SELECTOR}${encoded.slice(2)}` as `0x${string}`;
}

/**
 * Encode a venue's `poolData`, matching what its adapter decodes.
 *
 * Each adapter has its own shape, and getting the pair wrong is exactly the
 * cross-generation bug the adapters were written to catch:
 *
 *   UniswapV3Adapter  -> abi.encode(uint24 fee)
 *   AerodromeAdapter  -> abi.encode(bool stable, address factory)
 *   SlipstreamAdapter -> abi.encode(int24 tickSpacing, address factory)
 *
 * The Slipstream factory is taken from the *venue's resolved* factory (read from
 * the quoter at startup), not from config, so a leg can only ever name the
 * generation the pool was priced against. The adapter re-checks it against its
 * router's own `factory()`, so this is defence in depth rather than the only
 * check.
 */
export function encodePoolData(venue: VenueRuntime): `0x${string}` {
  if (venue instanceof UniswapV3Venue) {
    return encodeAbiParameters(parseAbiParameters("uint24"), [venue.fee]);
  }
  if (venue instanceof AerodromeVenue) {
    return encodeAbiParameters(parseAbiParameters("bool, address"), [
      venue.stable,
      venue.factory,
    ]);
  }
  if (venue instanceof SlipstreamVenue) {
    return encodeAbiParameters(parseAbiParameters("int24, address"), [
      venue.tickSpacing,
      venue.factory,
    ]);
  }
  throw new Error(`no poolData encoding for venue ${venue.label} (kind ${venue.kind})`);
}

/** The `kind` constant a venue's legs must carry. */
export function venueKind(venue: VenueRuntime): number {
  switch (venue.kind) {
    case "uniswap-v3":
      return Kind.UniswapV3;
    case "aerodrome":
      return Kind.Aerodrome;
    case "slipstream":
      return Kind.Slipstream;
    default: {
      const exhaustive: never = venue.kind;
      throw new Error(`unhandled venue kind ${String(exhaustive)}`);
    }
  }
}

/**
 * Build a two-leg closed-cycle request from a discovered opportunity.
 *
 * `leg1.amountIn` is the loan amount and `leg2.amountIn` is left at `0`, which
 * the executor resolves to leg 1's realised output. That is deliberate: the
 * scanner's phase-2 leg-2 quote was computed for a *predicted* intermediate
 * amount, and if leg 1 executes at even a slightly different rate, a hardcoded
 * leg-2 input would either strand tokens or ask to swap more than is held.
 * Leaving it dynamic makes the route self-consistent by construction.
 */
export function buildRoute(args: {
  firstVenue: VenueRuntime;
  secondVenue: VenueRuntime;
  firstAdapter: Address;
  secondAdapter: Address;
  loanToken: Address;
  quoteToken: Address;
  loanAmount: bigint;
  /** Realised leg-1 output from simulation, used to size the slippage floors. */
  leg2MinAmountOut: bigint;
  /** Floor for leg 1, in quote-token units. */
  leg1MinAmountOut: bigint;
}): SwapStep[] {
  return [
    {
      adapter: args.firstAdapter,
      tokenIn: args.loanToken,
      tokenOut: args.quoteToken,
      amountIn: args.loanAmount,
      minAmountOut: args.leg1MinAmountOut,
      kind: venueKind(args.firstVenue),
      poolData: encodePoolData(args.firstVenue),
    },
    {
      adapter: args.secondAdapter,
      tokenIn: args.quoteToken,
      tokenOut: args.loanToken,
      amountIn: 0n,
      minAmountOut: args.leg2MinAmountOut,
      kind: venueKind(args.secondVenue),
      poolData: encodePoolData(args.secondVenue),
    },
  ];
}
