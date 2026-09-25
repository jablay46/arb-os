/**
 * Decode the executor's `ArbExecuted` settlement event from a receipt.
 *
 * Why this exists: `wire.ts` reports a *projected* net profit -- the scanner's own
 * edge estimate minus measured gas. That number is a prediction, and until this
 * module existed nothing checked it against what the transaction actually
 * settled. The on-chain `minProfit` floor still prevents settling at a loss, so
 * the projection was never a fund-safety hole; it was an unchecked claim, which
 * is the failure mode this repo keeps running into.
 *
 * Reading the event back makes the reported figure measured rather than
 * predicted, and turns "predicted X, settled Y" into a number an operator can
 * act on: a persistent gap means the pricing model is wrong somewhere upstream.
 */

import { decodeEventLog, parseAbi } from "viem";

import type { RpcLog } from "./rpc.js";

/**
 * Signature taken verbatim from `MorphoArbExecutor`:
 *
 *   event ArbExecuted(
 *     address indexed initiator, address indexed loanToken,
 *     uint256 loanAmount, uint256 profit, Types.LoanProvider provider
 *   );
 *
 * Order matters: `loanAmount` and `profit` are the two non-indexed data words, so
 * reading them in the wrong order silently swaps a loan size for a profit.
 */
export const ARB_EXECUTED_ABI = parseAbi([
  "event ArbExecuted(address indexed initiator, address indexed loanToken, uint256 loanAmount, uint256 profit, uint8 provider)",
]);

export interface Settlement {
  /** Who called `execute`; must be the operator. */
  initiator: `0x${string}`;
  loanToken: `0x${string}`;
  loanAmount: bigint;
  /** Profit the executor measured and moved to the treasury, in loan-token units. */
  profit: bigint;
  /** `Types.LoanProvider` ordinal. */
  provider: number;
}

/** The provider ordinal as a name, for logs. Unknown values are named, not hidden. */
export function providerName(provider: number): string {
  switch (provider) {
    case 0:
      return "Morpho";
    case 1:
      return "BalancerV2";
    case 2:
      return "BalancerV3";
    default:
      return `provider#${provider}`;
  }
}

/**
 * Find and decode `ArbExecuted` among a receipt's logs.
 *
 * Filters on the emitting address. The executor calls out to routers and
 * adapters, so a log with our topic can in principle come from a contract we do
 * not control; only the executor's own event is authoritative about settlement.
 *
 * Returns `null` when the event is absent -- which is information, not an error.
 * A successful `execute` with no `ArbExecuted` would mean profit settled without
 * being reported, so callers should treat `null` on a status-1 receipt as worth
 * surfacing rather than silently ignoring.
 */
export function decodeSettlement(logs: readonly RpcLog[], executor: string): Settlement | null {
  const target = executor.toLowerCase();

  for (const log of logs) {
    if (log.address.toLowerCase() !== target) continue;
    if (!log.topics || log.topics.length === 0) continue;
    try {
      const decoded = decodeEventLog({
        abi: ARB_EXECUTED_ABI,
        data: log.data as `0x${string}`,
        topics: log.topics as unknown as [signature: `0x${string}`, ...args: `0x${string}`[]],
      });
      if (decoded.eventName !== "ArbExecuted") continue;
      const a = decoded.args as unknown as {
        initiator: `0x${string}`;
        loanToken: `0x${string}`;
        loanAmount: bigint;
        profit: bigint;
        provider: number;
      };
      return {
        initiator: a.initiator,
        loanToken: a.loanToken,
        loanAmount: a.loanAmount,
        profit: a.profit,
        provider: Number(a.provider),
      };
    } catch {
      // A log from the executor that is not this event, or not decodable. Keep
      // looking rather than failing the settlement read.
      continue;
    }
  }

  return null;
}

/** Signed difference between what was predicted and what settled, in wei. */
export function projectionGap(projectedWei: bigint, settledWei: bigint): bigint {
  return settledWei - projectedWei;
}
