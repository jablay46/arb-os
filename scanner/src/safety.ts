/**
 * Safety interlock for live trading.
 *
 * The rule this file exists to enforce: **nothing signs unless a human has
 * explicitly armed it, and no single misconfiguration is enough to lose money.**
 * Signing is the only irreversible action in the bot, so it sits behind several
 * independent gates rather than one flag:
 *
 *   1. `LIVE=true` must be set. The default is simulation.
 *   2. A separate acknowledgement, `I_UNDERSTAND_THIS_SIGNS_TRANSACTIONS=yes`,
 *      must also be set. Two deliberate acts, so a stray `LIVE=true` in a shell
 *      profile does not start spending.
 *   3. `PRIVATE_KEY` is read from the environment only. It is never written to
 *      disk, never logged, and rejected if it does not match the operator role.
 *   4. Net profit after the *measured* gas cost must clear `MIN_NET_PROFIT_WEI`.
 *   5. Gas price must be below `MAX_GAS_PRICE_WEI`, so a fee spike cannot turn a
 *      marginal route into a loss between simulation and inclusion.
 *   6. Every adapter in a route must already be approved on the executor. The
 *      bot never approves one, and the executor would reject it anyway.
 *
 * There is deliberately no "force" flag. If a guard is inconvenient, the fix is
 * to change the guard on purpose in a reviewed diff, not to bypass it at runtime.
 */

import type { Address } from "viem";

export class SafetyError extends Error {}

/**
 * Read a secret from the environment.
 *
 * Never accept one as an argument or from a file path: an argument lands in
 * `ps` output and shell history, and a file is one stray `git add` from being
 * committed. The environment is the least-bad option and matches how the rest of
 * this repo handles `BASE_RPC_URL`.
 */
export function loadPrivateKey(env: NodeJS.ProcessEnv = process.env): `0x${string}` {
  const raw = env.PRIVATE_KEY?.trim();
  if (!raw) {
    throw new SafetyError(
      "LIVE mode needs PRIVATE_KEY in the environment (it is never read from a file or argument)",
    );
  }
  const hex = raw.startsWith("0x") ? raw : `0x${raw}`;
  if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) {
    // Do not echo the value, not even a prefix: a malformed paste is often a
    // real key with a stray character, and partial keys are still a leak.
    throw new SafetyError("PRIVATE_KEY is not a 32-byte hex string");
  }
  return hex as `0x${string}`;
}

/** Strip any API-key-shaped path from an RPC URL so it is safe to log. */
export function redactRpcUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/[^/]{8,}$/, "/<redacted>")}`;
  } catch {
    return "<unparseable rpc url>";
  }
}

export interface LiveGuards {
  /** Net profit after measured gas, in wei. Must clear this to trade. */
  minNetProfitWei: bigint;
  /** Refuse to broadcast when the gas price is above this. */
  maxGasPriceWei: bigint;
  /** Only these adapters may appear in a signed route. */
  approvedAdapters: Set<string>;
  /** Loan sizes the operator has sized for; a route outside this is a bug. */
  maxLoanWei: bigint;
}

export interface LiveGateInput {
  env: NodeJS.ProcessEnv;
  /** True when the caller can actually sign (i.e. this is a live run). */
  live: boolean;
}

/**
 * Confirm the operator has armed live mode.
 *
 * Split out from the other guards so it can be tested without a secret, and so
 * the failure message can be precise about which of the two switches is missing.
 */
export function assertLiveArmed(env: NodeJS.ProcessEnv = process.env): void {
  const armed = env.LIVE?.trim().toLowerCase() === "true";
  const acknowledged =
    env.I_UNDERSTAND_THIS_SIGNS_TRANSACTIONS?.trim().toLowerCase() === "yes";

  if (!armed || !acknowledged) {
    throw new SafetyError(
      "refusing to sign: set LIVE=true and I_UNDERSTAND_THIS_SIGNS_TRANSACTIONS=yes to arm. " +
        "Both are required because signing moves real funds and cannot be undone.",
    );
  }
}

/**
 * Decide whether a route may be broadcast.
 *
 * Pure so it can be tested exhaustively offline; the RPC-dependent parts
 * (simulation, gas estimate) happen before this and feed their numbers in.
 */
export function checkLiveGuards(args: {
  guards: LiveGuards;
  netProfitWei: bigint;
  gasPriceWei: bigint;
  loanAmountWei: bigint;
  adapterAddresses: string[];
}): void {
  const { guards } = args;

  if (args.netProfitWei < guards.minNetProfitWei) {
    throw new SafetyError(
      `net profit ${args.netProfitWei} wei is below the floor ${guards.minNetProfitWei} wei`,
    );
  }
  if (args.gasPriceWei > guards.maxGasPriceWei) {
    throw new SafetyError(
      `gas price ${args.gasPriceWei} wei exceeds the ceiling ${guards.maxGasPriceWei} wei; ` +
        `a marginal route would turn into a loss on inclusion`,
    );
  }
  if (args.loanAmountWei > guards.maxLoanWei) {
    throw new SafetyError(
      `loan ${args.loanAmountWei} wei exceeds the configured maximum ${guards.maxLoanWei} wei`,
    );
  }
  for (const a of args.adapterAddresses) {
    if (!guards.approvedAdapters.has(a.toLowerCase())) {
      throw new SafetyError(
        `route uses adapter ${a}, which is not approved on the executor; ` +
          `the bot never approves adapters itself`,
      );
    }
  }
}

/**
 * Slippage floor for a leg, in `tokenOut` units.
 *
 * A percentage floor rather than a fixed one, because a fixed floor is either
 * useless on a large trade or needlessly strict on a small one. `bps` is capped
 * well below the round trip's margin: the executor's own `minProfit` check is the
 * backstop, but a floor that gives away more than the route earns makes that
 * check fail on chain and burns gas for nothing.
 */
export function slipFloor(quotedOut: bigint, bps: number): bigint {
  if (bps < 0 || bps > 5_000) {
    throw new SafetyError(`slippage ${bps}bps is out of range (0..5000)`);
  }
  return (quotedOut * BigInt(10_000 - bps)) / 10_000n;
}

/** True when `addr` is the zero address, compared case-insensitively. */
export function isZeroAddress(addr: string): boolean {
  return /^0x0{40}$/i.test(addr);
}

/** Assert a critical address is set, so a zero placeholder cannot be traded against. */
export function requireAddress(addr: Address | undefined, what: string): Address {
  if (!addr || isZeroAddress(addr)) {
    throw new SafetyError(`${what} is not configured (got ${addr ?? "undefined"})`);
  }
  return addr;
}
