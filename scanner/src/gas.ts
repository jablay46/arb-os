/**
 * Gas-aware net ranking: the port of the Rust bot's `pick_best_net` /
 * `can_still_win`, plus Base's L1 data fee.
 *
 * Why this exists at all: gross profit is not what a cycle earns. A candidate
 * that clears `minProfit` on gross terms can still lose money once gas is
 * paid, so ranking by gross reports trades that would destroy capital. The
 * Rust bot simulates gas per candidate and subtracts it; this does the same.
 *
 * The pure comparison functions live here and are tested offline. The RPC
 * reads that feed them are separate, so a ranking bug and an RPC bug cannot
 * hide behind each other.
 *
 * Gas is paid in ETH and the loan token is WETH, so a wei cost is directly
 * comparable to profit in loan-token units. This is not a coincidence: the
 * Rust config enforces `loan_token == wrapped_native` for exactly this reason.
 * If the loan token ever changes to something else, every number here becomes
 * meaningless -- hence the guard in `gasCost`.
 */

import { encodeFunctionData, decodeAbiParameters, parseAbiParameters } from "viem";
import type { Address } from "viem";

import type { RpcClient } from "./rpc.js";
import type { Opportunity } from "./discovery.js";

/**
 * OP-Stack GasPriceOracle predeploy, present at this address on Base and every
 * OP-Stack chain.
 */
export const GAS_PRICE_ORACLE: Address = "0x420000000000000000000000000000000000000F";

/**
 * Conservative full size of the unsigned EIP-1559 transaction the executor
 * broadcasts, in bytes, for a 772-byte `execute` calldata.
 *
 * `4 + 24 * 32` mirrors the Rust constant: the selector plus 24 words. A
 * generous over-estimate only makes the fee bound more conservative, which is
 * the safe direction.
 */
export const EXECUTE_CALLDATA_LEN = 4 + 24 * 32;

const GAS_ORACLE_ABI = [
  {
    type: "function",
    name: "getL1FeeUpperBound",
    stateMutability: "view",
    inputs: [{ name: "_unsignedTxSize", type: "uint256" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

// --- RLP size, ported from dex.rs ----------------------------------------

/** Bytes needed to hold `v` as a big-endian integer. Zero needs none. */
function rlpWidth(v: number): number {
  if (v === 0) return 0;
  return Math.ceil(Math.ceil(Math.log2(v + 1)) / 8);
}

/**
 * RLP length of a string holding `len` bytes.
 *
 * A 1-byte value is priced as `0x81 || byte` even when the byte is below 0x80
 * and would encode as a single byte. That over-estimates, which is the safe
 * direction.
 */
function rlpStringLen(len: number): number {
  if (len === 0) return 1; // 0x80
  if (len === 1) return 2; // 0x81 || byte
  if (len <= 55) return 1 + len; // 0x80+len || bytes
  return 1 + rlpWidth(len) + len; // long string prefix
}

/** RLP length of a list whose payload is `payloadLen` bytes. */
function rlpListLen(payloadLen: number): number {
  if (payloadLen <= 55) return 1 + payloadLen;
  return 1 + rlpWidth(payloadLen) + payloadLen;
}

/**
 * Conservative byte size of the unsigned EIP-1559 transaction for a
 * `calldataLen`-byte call on `chainId`.
 *
 * `getL1FeeUpperBound` prices a *complete* unsigned RLP transaction and adds
 * its own frame, so this must be the whole transaction, not the calldata. The
 * scalar fields are priced at their widest plausible encoding rather than
 * today's small values, so the result bounds the real transaction.
 */
export function unsignedTxRlpLen(chainId: number, calldataLen: number): number {
  const fields = [
    rlpStringLen(rlpWidth(chainId)), // chainId, minimal width
    rlpStringLen(8), // nonce (u64)
    rlpStringLen(16), // maxPriorityFeePerGas (u128)
    rlpStringLen(16), // maxFeePerGas (u128)
    rlpStringLen(8), // gasLimit (u64)
    rlpStringLen(20), // to
    rlpStringLen(8), // value
    rlpStringLen(calldataLen), // data
    rlpStringLen(1), // accessList, empty -> 0xc0
  ];
  const payload = fields.reduce((a, b) => a + b, 0);
  return 1 /* EIP-1559 type byte */ + rlpListLen(payload);
}

// --- pure ranking, ported from arbitrage.rs ------------------------------

/**
 * The result of pricing one candidate's gas.
 *
 * `Rejected` is not an error: a simulation that reverts means that candidate
 * cannot execute (its `minOut` is unattainable, or the pool moved), so it is
 * dropped and the next one is tried.
 */
export type GasOutcome =
  | { kind: "priced"; gas: bigint }
  | { kind: "rejected" };

/** `a - b`, floored at zero. Mirrors Rust's `saturating_sub`. */
function satSub(a: bigint, b: bigint): bigint {
  return a > b ? a - b : 0n;
}

/**
 * Highest net-profit (gross - gas) candidate clearing `minProfit`.
 *
 * `results` are expected gross-descending, as `rankedOpportunities` returns
 * them, though the function is correct for any order. Ties keep the earlier
 * candidate, which under gross-descending input means the larger gross -- a
 * deliberate tie-break, not an accident of iteration order.
 */
export function pickBestNet(
  results: Iterable<{ opportunity: Opportunity; outcome: GasOutcome }>,
  minProfit: bigint,
): { opportunity: Opportunity; gas: bigint } | null {
  let best: { opportunity: Opportunity; gas: bigint } | null = null;
  for (const { opportunity, outcome } of results) {
    if (outcome.kind !== "priced") continue;
    const net = satSub(opportunity.grossProfit, outcome.gas);
    if (net < minProfit) continue;
    if (best === null || net > satSub(best.opportunity.grossProfit, best.gas)) {
      best = { opportunity, gas: outcome.gas };
    }
  }
  return best;
}

/**
 * True when `candidateGross` can still beat the incumbent's net even at zero
 * gas, so its simulation is worth paying for.
 *
 * Net never exceeds gross (gas is non-negative), so once a gross-sorted
 * candidate's gross is at or below the incumbent's net it cannot displace the
 * incumbent and can be skipped. The boundary is `>` and not `> incumbentNet +
 * 1`: with a zero effective gas price, a candidate whose gross is exactly one
 * wei above the incumbent's net keeps that gross as net and does win.
 */
export function canStillWin(
  candidateGross: bigint,
  incumbent: { opportunity: Opportunity; gas: bigint },
): boolean {
  const incumbentNet = satSub(incumbent.opportunity.grossProfit, incumbent.gas);
  return candidateGross > incumbentNet;
}

// --- RPC reads ------------------------------------------------------------

/** Current L2 gas price in wei, from `eth_gasPrice`. */
export async function fetchGasPrice(rpc: RpcClient): Promise<bigint> {
  const wei = await rpc.gasPrice();
  if (wei <= 0n) throw new Error(`implausible gas price from eth_gasPrice: ${wei}`);
  return wei;
}

/**
 * L1 data fee bound in wei, priced by the GasPriceOracle for the worst-case
 * unsigned `execute` transaction.
 *
 * Base is a rollup, so a transaction's real cost is the L2 execution fee
 * *plus* a fee for publishing its calldata to Ethereum. Omitting the second
 * term understates cost exactly when the L1 fee is high, which is when
 * unprofitable trades are most likely to slip through.
 *
 * Returns null when the oracle cannot be read. Callers must treat null as
 * "cost unknown" and skip the block, not as zero: every broadcast still pays
 * this fee, so pricing it at zero would defeat the gate this exists to
 * enforce.
 */
export async function fetchL1FeeUpperBound(
  rpc: RpcClient,
  chainId: number,
  block: number,
  calldataLen: number = EXECUTE_CALLDATA_LEN,
): Promise<bigint | null> {
  const size = unsignedTxRlpLen(chainId, calldataLen);
  const data = encodeFunctionData({
    abi: GAS_ORACLE_ABI,
    functionName: "getL1FeeUpperBound",
    args: [BigInt(size)],
  });
  const raw = await rpc.ethCall({ to: GAS_PRICE_ORACLE, data }, { block });
  if (raw === null || raw === "0x") return null;
  const [fee] = decodeAbiParameters(parseAbiParameters("uint256"), raw as `0x${string}`);
  return fee ?? null;
}

/**
 * Total cost in wei of executing a candidate: L2 gas plus the L1 data fee.
 *
 * Both terms are wei and the loan token is WETH, so the sum is directly
 * comparable to `grossProfit`. The guard below is the load-bearing part: with
 * any other loan token the comparison would be silently wrong by the exchange
 * rate between that token and ETH.
 */
export function gasCost(args: {
  gasUnits: bigint;
  gasPriceWei: bigint;
  l1FeeWei: bigint;
  loanToken: Address;
  wrappedNative: Address;
}): bigint {
  if (args.loanToken.toLowerCase() !== args.wrappedNative.toLowerCase()) {
    throw new Error(
      `gas is priced in ETH but the loan token is ${args.loanToken}; ` +
        `wei is only comparable to profit when the loan token is the wrapped native token`,
    );
  }
  return args.gasUnits * args.gasPriceWei + args.l1FeeWei;
}

/**
 * Gas units assumed in dry run, mirroring the Rust constant.
 *
 * Dry run has no transaction to simulate, so gas is estimated at a fixed
 * ceiling for the Morpho flash loan plus two router swaps. Applying *some*
 * cost matters: with gas priced at zero the `minProfit` filter runs against
 * gross profit, so dry run would report opportunities that live mode always
 * rejects -- a scanner that lies in the direction of optimism.
 */
export const DRY_RUN_GAS_UNITS = 400_000n;
