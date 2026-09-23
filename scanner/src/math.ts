/**
 * Constant-product swap math, mirroring the executor's expectations.
 *
 * Kept separate from the DEX adapters so the arithmetic can be tested without
 * a node.
 */

const BPS = 10_000n;

/** Thrown when a quote is impossible rather than merely unprofitable. */
export class Unquotable extends Error {}

/**
 * Exact Uniswap V2 / Aerodrome-volatile output for `amountIn`.
 *
 * `feeBps` is in basis points: 30 = 0.3%, 5 = 0.05%. Aerodrome reports pool
 * fees on this scale (the factory's `getFee`), NOT as the 1e6-scaled `fee`
 * used by Uniswap V3 pools -- mixing the two silently misprices every leg.
 */
export function getAmountOut(
  amountIn: bigint,
  reserveIn: bigint,
  reserveOut: bigint,
  feeBps: bigint,
): bigint {
  if (feeBps >= BPS) throw new Unquotable(`fee ${feeBps}bps is not a valid rate`);
  if (amountIn <= 0n || reserveIn <= 0n || reserveOut <= 0n) {
    throw new Unquotable("zero input or empty reserves");
  }
  const amountInWithFee = amountIn * (BPS - feeBps);
  const numerator = amountInWithFee * reserveOut;
  const denominator = reserveIn * BPS + amountInWithFee;
  return numerator / denominator;
}

/**
 * Orient reserves relative to `tokenIn`, or throw.
 *
 * Silently assuming an orientation is how a scanner produces confident,
 * wrong quotes for every pool where token0 is the output token. The pool
 * either contains `tokenIn` or the venue is misconfigured.
 */
export function orientReserves(
  reserve0: bigint,
  reserve1: bigint,
  token0: string,
  token1: string,
  tokenIn: string,
  pair: string,
): { reserveIn: bigint; reserveOut: bigint } {
  const a = tokenIn.toLowerCase();
  if (a === token0.toLowerCase()) return { reserveIn: reserve0, reserveOut: reserve1 };
  if (a === token1.toLowerCase()) return { reserveIn: reserve1, reserveOut: reserve0 };
  throw new Unquotable(
    `pool ${pair} does not contain ${tokenIn} (token0=${token0}, token1=${token1})`,
  );
}

/** Convert a loan-token amount into the quote token at `price`, for gas costing. */
export function toLoanToken(amount: bigint, priceNum: bigint, priceDen: bigint): bigint {
  if (priceDen === 0n) throw new Unquotable("zero price denominator");
  return (amount * priceNum) / priceDen;
}
