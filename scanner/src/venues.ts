/**
 * Venue adapters: how the scanner prices one DEX.
 *
 * Each venue knows how to fetch its state, encode a quote, and decode the
 * result. Everything here is pure encoding/decoding plus local math; the RPC
 * batching lives in discovery.ts.
 */

import { encodeFunctionData, decodeAbiParameters, parseAbiParameters } from "viem";
import type { Address } from "viem";
import { getAmountOut, orientReserves, Unquotable } from "./math.js";
import type { VenueConfig, VenueKind } from "./config.js";
import { ADDR } from "./config.js";

export interface EncodedCall {
  to: string;
  data: string;
}

/**
 * Which way a leg trades.
 *
 * Every venue must quote both directions: leg 1 sells the loan token for the
 * quote token, leg 2 buys the loan token back. A venue that only ever quotes
 * `loanToQuote` (the obvious first implementation) prices leg 2 with leg 1's
 * curve, which turns a round trip into a 100% loss and hides every real
 * opportunity.
 */
export type Direction = "loanToQuote" | "quoteToLoan";

/**
 * How a venue produces a price.
 *
 * This is what discovery dispatches on, rather than the venue's `kind`. The two
 * models need different RPC shapes: a `quoter` venue is asked per trade size and
 * its answer reverts when the pool cannot fill the size, while a `reserves`
 * venue is read once and then priced locally for every size. Uniswap V3 and
 * Slipstream are both `quoter` venues even though they are different DEXes, so
 * keying the dispatch on `kind` would make every new CL venue a copy of the
 * same branch.
 */
export type PricingModel = "quoter" | "reserves";

export interface VenueRuntime {
  kind: VenueKind;
  /** Which discovery path prices this venue. See `PricingModel`. */
  readonly pricing: PricingModel;
  label: string;
  token: Address;
  loanToken: Address;

  /**
   * A call that reads whatever state this venue needs before quoting.
   *
   * Only meaningful for `reserves` venues; a `quoter` venue has no local state
   * to seed and returns an empty call that discovery never sends.
   */
  encodeReserves(): EncodedCall;
  decodeReserves(raw: string): { reserve0: bigint; reserve1: bigint };
  /** Store fetched state so local math can run. */
  setReserves(reserve0: bigint, reserve1: bigint): void;

  /** A quoter call for `amountIn` in the given direction. `quoter` venues only. */
  encodeQuote(amountIn: bigint, direction: Direction): EncodedCall;
  /** Decode a quoter result; null when the pool cannot fill this size. */
  decodeQuote(raw: string): bigint | null;

  /** Local quote in the given direction, or null when unavailable. `reserves` venues only. */
  quoteFromReserves(amountIn: bigint, direction: Direction): bigint | null;
}

// --- Uniswap V3 -----------------------------------------------------------

const QUOTER_V2_ABI = [
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
          { name: "fee", type: "uint24" },
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

export class UniswapV3Venue implements VenueRuntime {
  readonly kind = "uniswap-v3" as const;
  readonly pricing = "quoter" as const;
  readonly token: Address;
  readonly loanToken: Address;

  constructor(
    readonly label: string,
    loanToken: Address,
    token: Address,
    readonly fee: number,
    private readonly quoter: Address = ADDR.UNISWAP_V3_QUOTER_V2,
  ) {
    this.loanToken = loanToken;
    this.token = token;
  }

  encodeReserves(): EncodedCall {
    // V3 has no reserve getter; its state is tick/liquidity, and QuoterV2 does
    // the traversal on chain. Returning an empty call keeps the batch shape
    // uniform and costs nothing (discovery filters by kind).
    return { to: this.quoter, data: "0x" };
  }

  decodeReserves(): { reserve0: bigint; reserve1: bigint } {
    throw new Unquotable("V3 has no reserves");
  }

  setReserves(): void {
    /* no local state */
  }

  encodeQuote(amountIn: bigint, direction: Direction): EncodedCall {
    const [tokenIn, tokenOut] =
      direction === "loanToQuote" ? [this.loanToken, this.token] : [this.token, this.loanToken];
    const data = encodeFunctionData({
      abi: QUOTER_V2_ABI,
      functionName: "quoteExactInputSingle",
      args: [
        {
          tokenIn,
          tokenOut,
          amountIn,
          fee: this.fee,
          sqrtPriceLimitX96: 0n,
        },
      ],
    });
    return { to: this.quoter, data };
  }

  /**
   * QuoterV2 returns four words; only the first is amountOut.
   *
   * Reading the whole return blob as one integer (the obvious mistake) yields
   * a number around 1e75, which then flows into profit math as if it were a
   * real quote. Decode the first word, and require all four to be present so a
   * truncated return is rejected rather than misread.
   */
  decodeQuote(raw: string): bigint | null {
    if (!raw || raw === "0x") return null;
    const body = raw.slice(2);
    if (body.length < 64 * 4) return null;
    const [amountOut] = decodeAbiParameters(
      parseAbiParameters("uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate"),
      `0x${body}`,
    );
    return amountOut;
  }

  quoteFromReserves(): bigint | null {
    return null; // no local V3 math yet; the quoter is authoritative
  }
}

// --- Aerodrome (volatile) -------------------------------------------------

const AERO_POOL_ABI = [
  { type: "function", name: "getReserves", stateMutability: "view", inputs: [], outputs: [
    { name: "reserve0", type: "uint256" }, { name: "reserve1", type: "uint256" }, { name: "blockTimestampLast", type: "uint256" }] },
  { type: "function", name: "token0", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "token1", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;

export class AerodromeVenue implements VenueRuntime {
  readonly kind = "aerodrome" as const;
  readonly pricing = "reserves" as const;
  readonly token: Address;
  readonly loanToken: Address;

  private reserve0 = 0n;
  private reserve1 = 0n;
  private token0: string | null = null;
  private token1: string | null = null;

  constructor(
    readonly label: string,
    loanToken: Address,
    token: Address,
    readonly pool: Address,
    readonly stable: boolean,
    readonly feeBps: bigint,
  ) {
    this.loanToken = loanToken;
    this.token = token;
    if (stable) {
      // The stable curve (x^3y + xy^3 = k) is not constant-product, so the
      // local math below would misprice it. Refusing is the honest option:
      // a wrong quote here looks exactly like a real opportunity.
      throw new Unquotable(
        "Aerodrome stable pools are not supported by local constant-product math; " +
          "use the router's getAmountsOut or a dedicated stable-curve implementation",
      );
    }
  }

  encodeReserves(): EncodedCall {
    return { to: this.pool, data: encodeFunctionData({ abi: AERO_POOL_ABI, functionName: "getReserves" }) };
  }

  decodeReserves(raw: string): { reserve0: bigint; reserve1: bigint } {
    const [r0, r1] = decodeAbiParameters(
      parseAbiParameters("uint256 reserve0, uint256 reserve1, uint256 blockTimestampLast"),
      raw as `0x${string}`,
    );
    return { reserve0: r0, reserve1: r1 };
  }

  setReserves(reserve0: bigint, reserve1: bigint): void {
    this.reserve0 = reserve0;
    this.reserve1 = reserve1;
  }

  encodeQuote(): EncodedCall {
    return { to: this.pool, data: "0x" }; // priced locally
  }

  decodeQuote(): bigint | null {
    return null;
  }

  /**
   * Exact constant-product output against the cached reserves.
   *
   * Requires token0/token1, which the caller must load; without them the
   * orientation would be a guess.
   */
  quoteFromReserves(amountIn: bigint, direction: Direction): bigint | null {
    if (this.token0 === null || this.token1 === null) return null;
    if (this.reserve0 === 0n || this.reserve1 === 0n) return null;
    const tokenIn = direction === "loanToQuote" ? this.loanToken : this.token;
    try {
      const { reserveIn, reserveOut } = orientReserves(
        this.reserve0,
        this.reserve1,
        this.token0,
        this.token1,
        tokenIn,
        this.pool,
      );
      return getAmountOut(amountIn, reserveIn, reserveOut, this.feeBps);
    } catch {
      return null;
    }
  }

  setTokens(token0: string, token1: string): void {
    this.token0 = token0;
    this.token1 = token1;
  }
}

// --- Aerodrome Slipstream (concentrated liquidity) ------------------------

/**
 * Slipstream `QuoterV2`.
 *
 * Same shape as Uniswap's QuoterV2: `tickSpacing` replaces `fee`, and the
 * result is four words whose first is `amountOut`. It is NOT `view` -- it
 * returns by reverting internally -- so it is only ever reached through
 * `eth_call`, which is fine here because that is all the scanner does.
 */
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
  { type: "function", name: "factory", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
] as const;

/**
 * A Slipstream CL venue, priced by the generation's own `QuoterV2`.
 *
 * Slipstream is a CL DEX like Uniswap V3, so it is priced the same way: the
 * quoter traverses the ticks for the exact trade size, and a size the pool
 * cannot fill reverts (which discovery reads as "skip this size"). There is no
 * local math, so `encodeReserves` returns an empty call discovery never sends.
 *
 * The `factory` stored here is whichever factory the quoter itself reports. It
 * is not a parameter, because Aerodrome runs two Slipstream generations on Base
 * and a quoter belongs to exactly one of them. Passing a factory in would allow
 * the pair `(new quoter, old factory)` -- which does not revert, it silently
 * prices the *old* generation's pool of the same tick spacing and returns a
 * plausible number. Reading it from the quoter makes that state unrepresentable.
 */
export class SlipstreamVenue implements VenueRuntime {
  readonly kind = "slipstream" as const;
  readonly pricing = "quoter" as const;
  readonly token: Address;
  readonly loanToken: Address;

  constructor(
    readonly label: string,
    loanToken: Address,
    token: Address,
    readonly tickSpacing: number,
    readonly quoter: Address,
    readonly factory: Address,
  ) {
    this.loanToken = loanToken;
    this.token = token;
  }

  encodeReserves(): EncodedCall {
    return { to: this.quoter, data: "0x" };
  }

  decodeReserves(): { reserve0: bigint; reserve1: bigint } {
    throw new Unquotable("Slipstream is priced by its quoter, not by reserves");
  }

  setReserves(): void {
    /* no local state */
  }

  encodeQuote(amountIn: bigint, direction: Direction): EncodedCall {
    const [tokenIn, tokenOut] =
      direction === "loanToQuote" ? [this.loanToken, this.token] : [this.token, this.loanToken];
    const data = encodeFunctionData({
      abi: SLIP_QUOTER_ABI,
      functionName: "quoteExactInputSingle",
      args: [{ tokenIn, tokenOut, amountIn, tickSpacing: this.tickSpacing, sqrtPriceLimitX96: 0n }],
    });
    return { to: this.quoter, data };
  }

  /** Four words, first is `amountOut`. See `UniswapV3Venue.decodeQuote`. */
  decodeQuote(raw: string): bigint | null {
    if (!raw || raw === "0x") return null;
    const body = raw.slice(2);
    if (body.length < 64 * 4) return null;
    const [amountOut] = decodeAbiParameters(
      parseAbiParameters(
        "uint256 amountOut, uint160 sqrtPriceX96After, uint32 initializedTicksCrossed, uint256 gasEstimate",
      ),
      `0x${body}`,
    );
    return amountOut;
  }

  quoteFromReserves(): bigint | null {
    return null; // quoter-only
  }
}

// --- Factory resolution ---------------------------------------------------

const AERO_FACTORY_ABI = [
  { type: "function", name: "getPool", stateMutability: "view", inputs: [
    { name: "tokenA", type: "address" }, { name: "tokenB", type: "address" }, { name: "stable", type: "bool" }],
    outputs: [{ type: "address" }] },
  { type: "function", name: "isPool", stateMutability: "view", inputs: [{ name: "pool", type: "address" }], outputs: [{ type: "bool" }] },
  { type: "function", name: "getFee", stateMutability: "view", inputs: [
    { name: "pool", type: "address" }, { name: "stable", type: "bool" }], outputs: [{ type: "uint256" }] },
] as const;

export function encodeAerodromeResolve(tokenA: Address, tokenB: Address, stable: boolean): EncodedCall {
  return {
    to: ADDR.AERODROME_FACTORY,
    data: encodeFunctionData({ abi: AERO_FACTORY_ABI, functionName: "getPool", args: [tokenA, tokenB, stable] }),
  };
}

export function encodeAerodromeIsPool(pool: Address): EncodedCall {
  return {
    to: ADDR.AERODROME_FACTORY,
    data: encodeFunctionData({ abi: AERO_FACTORY_ABI, functionName: "isPool", args: [pool] }),
  };
}

/**
 * Encode the pool-fee read. The fee lives on the FACTORY, not the pool: calling
 * `getFee()` or `fee()` on the pool itself reverts. A factory-wide default is
 * also not the pool's fee -- verified on Base, the WETH/USDC volatile pool is
 * 30bps while the stable pool of the same pair is 5bps.
 */
export function encodeAerodromeFee(pool: Address, stable: boolean): EncodedCall {
  return {
    to: ADDR.AERODROME_FACTORY,
    data: encodeFunctionData({ abi: AERO_FACTORY_ABI, functionName: "getFee", args: [pool, stable] }),
  };
}

export function decodeAddress(raw: string): Address {
  const [a] = decodeAbiParameters(parseAbiParameters("address"), raw as `0x${string}`);
  return a;
}

export function decodeUint(raw: string): bigint {
  const [v] = decodeAbiParameters(parseAbiParameters("uint256"), raw as `0x${string}`);
  return v;
}

export function decodeBool(raw: string): boolean {
  const [v] = decodeAbiParameters(parseAbiParameters("bool"), raw as `0x${string}`);
  return v;
}

/** Build a runtime venue from config, resolving Aerodrome pool + fee on chain. */
export async function buildVenue(
  cfg: VenueConfig,
  loanToken: Address,
  rpc: { ethCalls: (c: EncodedCall[], o?: { block?: number }) => Promise<(string | null)[]> },
  block: number,
): Promise<VenueRuntime> {
  if (cfg.kind === "uniswap-v3") {
    if (cfg.fee === undefined) throw new Error(`venue ${cfg.label} needs a fee tier`);
    return new UniswapV3Venue(cfg.label, loanToken, cfg.token, cfg.fee);
  }

  if (cfg.kind === "slipstream") {
    return buildSlipstreamVenue(cfg, loanToken, rpc, block);
  }

  const stable = cfg.stable ?? false;
  const [poolRaw, ] = await rpc.ethCalls([encodeAerodromeResolve(loanToken, cfg.token, stable)], { block });
  if (!poolRaw) throw new Error(`Aerodrome factory could not resolve ${cfg.label}`);
  const pool = decodeAddress(poolRaw);
  if (pool === "0x0000000000000000000000000000000000000000") {
    throw new Error(`Aerodrome has no stable=${stable} pool for ${cfg.label}`);
  }

  const [isPoolRaw, feeRaw] = await rpc.ethCalls(
    [encodeAerodromeIsPool(pool), encodeAerodromeFee(pool, stable)],
    { block },
  );
  if (!isPoolRaw || !decodeBool(isPoolRaw)) {
    throw new Error(`Aerodrome factory does not own pool ${pool} for ${cfg.label}`);
  }
  if (!feeRaw) throw new Error(`Aerodrome fee read failed for ${pool}`);
  const feeBps = decodeUint(feeRaw);
  if (feeBps >= 10_000n) throw new Error(`Aerodrome returned an implausible fee ${feeBps} for ${pool}`);

  if (cfg.feeBps !== undefined && BigInt(cfg.feeBps) !== feeBps) {
    throw new Error(
      `venue ${cfg.label}: config fee ${cfg.feeBps}bps but the factory reports ${feeBps}bps for ${pool}; ` +
        `refusing to scan with a fee that disagrees with the chain`,
    );
  }

  const venue = new AerodromeVenue(cfg.label, loanToken, cfg.token, pool, stable, feeBps);
  await attachAerodromeTokens(venue, pool, rpc, block);
  return venue;
}

async function attachAerodromeTokens(
  venue: AerodromeVenue,
  pool: Address,
  rpc: { ethCalls: (c: EncodedCall[], o?: { block?: number }) => Promise<(string | null)[]> },
  block: number,
): Promise<void> {
  const [t0, t1] = await rpc.ethCalls(
    [
      { to: pool, data: encodeFunctionData({ abi: AERO_POOL_ABI, functionName: "token0" }) },
      { to: pool, data: encodeFunctionData({ abi: AERO_POOL_ABI, functionName: "token1" }) },
    ],
    { block },
  );
  if (!t0 || !t1) throw new Error(`could not read token0/token1 for Aerodrome pool ${pool}`);
  venue.setTokens(decodeAddress(t0), decodeAddress(t1));
}

// --- Slipstream resolution ------------------------------------------------

const SLIP_FACTORY_ABI = [
  { type: "function", name: "getPool", stateMutability: "view", inputs: [
    { name: "tokenA", type: "address" }, { name: "tokenB", type: "address" },
    { name: "tickSpacing", type: "int24" }], outputs: [{ type: "address" }] },
  { type: "function", name: "isPool", stateMutability: "view", inputs: [{ name: "pool", type: "address" }], outputs: [{ type: "bool" }] },
] as const;

/**
 * Resolve a Slipstream venue and prove the generation pairing.
 *
 * The factory comes from the quoter, never from config, and the pool must be
 * owned by that factory (`isPool`). Both checks exist because the failure they
 * catch is silent: point the new generation's quoter at a tick spacing that only
 * the old generation has a deep pool for, and the old quoter's answer is a
 * plausible price from the wrong pool, not a revert. `isPool` closes the
 * remaining gap -- a factory that does not own the pool would mean the quoter
 * is answering about a pool the executor's adapter will refuse to trade.
 */
async function buildSlipstreamVenue(
  cfg: VenueConfig,
  loanToken: Address,
  rpc: { ethCalls: (c: EncodedCall[], o?: { block?: number }) => Promise<(string | null)[]> },
  block: number,
): Promise<VenueRuntime> {
  if (cfg.tickSpacing === undefined) throw new Error(`venue ${cfg.label} needs a tickSpacing`);
  if (cfg.quoter === undefined) throw new Error(`venue ${cfg.label} needs a quoter`);

  const [factoryRaw] = await rpc.ethCalls(
    [{ to: cfg.quoter, data: encodeFunctionData({ abi: SLIP_QUOTER_ABI, functionName: "factory" }) }],
    { block },
  );
  if (!factoryRaw) throw new Error(`venue ${cfg.label}: quoter ${cfg.quoter} has no factory()`);
  const factory = decodeAddress(factoryRaw);
  if (factory === "0x0000000000000000000000000000000000000000") {
    throw new Error(`venue ${cfg.label}: quoter ${cfg.quoter} reports no factory`);
  }

  const [poolRaw] = await rpc.ethCalls(
    [
      {
        to: factory,
        data: encodeFunctionData({
          abi: SLIP_FACTORY_ABI,
          functionName: "getPool",
          args: [loanToken, cfg.token, cfg.tickSpacing],
        }),
      },
    ],
    { block },
  );
  if (!poolRaw) throw new Error(`venue ${cfg.label}: factory ${factory} could not resolve the pool`);
  const pool = decodeAddress(poolRaw);
  if (pool === "0x0000000000000000000000000000000000000000") {
    throw new Error(
      `venue ${cfg.label}: generation ${factory} has no tickSpacing=${cfg.tickSpacing} pool for this pair`,
    );
  }

  const [isPoolRaw] = await rpc.ethCalls(
    [
      {
        to: factory,
        data: encodeFunctionData({ abi: SLIP_FACTORY_ABI, functionName: "isPool", args: [pool] }),
      },
    ],
    { block },
  );
  if (!isPoolRaw || !decodeBool(isPoolRaw)) {
    throw new Error(`venue ${cfg.label}: factory ${factory} does not own pool ${pool}`);
  }

  return new SlipstreamVenue(cfg.label, loanToken, cfg.token, cfg.tickSpacing, cfg.quoter, factory);
}
