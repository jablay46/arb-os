/**
 * Decode `MorphoArbExecutor` custom errors from revert data.
 *
 * Without this, every refusal reads as "execution reverted" and sends an
 * operator hunting for a pricing bug when the real answer is "the floor was not
 * met" or "the adapter is not approved". The selectors are derived from
 * `Errors.sol` at test time rather than typed by hand, for the same reason the
 * `execute` selector is: the first hand-written selector in this repo was wrong.
 */

import { decodeErrorResult, parseAbi } from "viem";

/**
 * Signatures taken verbatim from `src/libraries/Errors.sol`.
 *
 * `InsufficientProfit` carries both figures, which is the one that matters most:
 * it reports `required` and `actual`, so a refusal says *how far* the route was
 * from clearing its floor rather than merely that it failed.
 */
export const ERROR_ABI = parseAbi([
  "error Unauthorized()",
  "error InvalidAddress()",
  "error InvalidState()",
  "error Paused()",
  "error InvalidToken()",
  "error InvalidAmount()",
  "error InvalidMinProfit()",
  "error InvalidRoute()",
  "error InvalidAdapter()",
  "error InvalidSlippage()",
  "error InvalidProvider()",
  "error InvalidRecipient()",
  "error CallbackNotAuthorized()",
  "error CallbackNotInvoked()",
  "error LoanNotActive()",
  "error InProgress()",
  "error RepaymentFailed()",
  "error InsufficientProfit(uint256 required, uint256 actual)",
  "error InsufficientBalance()",
  "error SwapFailed(uint256 index, uint256 amountOut, uint256 minAmountOut)",
  "error UnsupportedLegKind(uint8 kind)",
  "error InvalidCallsLength(uint256 length)",
  "error InvalidTarget(address target)",
  "error InvalidSelector(address target, bytes4 selector)",
  "error ForbiddenSelector(address target, bytes4 selector)",
  "error NonZeroCallValue(uint256 value)",
  "error CallFailed(uint256 index, bytes returnData)",
  "error ErrorCodeReturned(uint256 index, uint256 errorCode)",
  "error LoanSizeOutOfBounds(uint256 amount, uint256 minimum, uint256 maximum)",
  "error RescueFailed()",
]);

export interface DecodedRevert {
  /** Error name, or null when the payload is not one of ours. */
  name: string | null;
  /** Decoded arguments, keyed by name. */
  args: Record<string, unknown>;
  /** A one-line human explanation suitable for a log. */
  summary: string;
  /** The original payload, so nothing is lost when decoding fails. */
  raw: string;
}

/**
 * Whether a decoded revert means "this route was correctly refused" rather than
 * "the bot is misconfigured".
 *
 * The distinction drives retry behaviour: a route that fails its profit floor is
 * expected on a competitive market and the next scan simply moves on, whereas an
 * `InvalidAdapter` or `Unauthorized` means nothing will succeed until an operator
 * fixes the setup, and continuing to hammer the RPC is pointless.
 *
 * Takes `string | null` rather than the decoded union because callers may be
 * holding a name from a payload this decoder did not produce.
 */
export function isExpectedRefusal(name: string | null): boolean {
  return name === "InsufficientProfit" || name === "SwapFailed";
}


const KNOWN_ERROR_NAMES = new Set(
  ERROR_ABI.filter((e) => e.type === "error").map((e) => e.name),
);

/** Decode a hex revert payload, tolerating the shapes providers return. */
export function decodeRevert(data: string): DecodedRevert {
  const raw = data || "0x";

  // `Error(string)` and empty reverts are not ours but are worth naming: an
  // empty revert is what a bare ERC20 failure looks like, and the repo already
  // has a guard for exactly that case on the Balancer paths.
  if (raw === "0x") {
    return {
      name: null,
      args: {},
      summary: "empty revert (no reason returned)",
      raw,
    };
  }

  try {
    const decoded = decodeErrorResult({
      abi: ERROR_ABI,
      data: raw as `0x${string}`,
    });
    const name = decoded.errorName;
    const args: Record<string, unknown> = {};
    for (const [i, input] of (decoded.abiItem?.inputs ?? []).entries()) {
      if (input.name) args[input.name] = decoded.args?.[i];
    }
    return { name, args, summary: explain(name, args), raw };
  } catch {
    // Not one of ours: standard Error(string), a panic, or a selector we do not
    // know. Report the selector so it is still diagnosable.
    const selector = raw.length >= 10 ? raw.slice(0, 10) : raw;
    return {
      name: null,
      args: {},
      summary: `unrecognised revert ${selector}`,
      raw,
    };
  }
}


function explain(name: string | null, args: Record<string, unknown>): string {
  if (name === "InsufficientProfit") {
    return `InsufficientProfit: needed ${args.required} wei, had ${args.actual} wei`;
  }
  if (name === "SwapFailed") {
    return `SwapFailed on leg ${args.index}: got ${args.amountOut}, floor ${args.minAmountOut}`;
  }
  if (name === "LoanSizeOutOfBounds") {
    return `LoanSizeOutOfBounds: loan ${args.amount}, allowed ${args.minimum}..${args.maximum}`;
  }
  if (name === "Paused") {
    return "Paused: the executor is paused; an admin must unpause it";
  }
  if (name === "Unauthorized") {
    return "Unauthorized: the signing key does not hold the role this call needs";
  }
  if (name === "InvalidAdapter") {
    return "InvalidAdapter: the adapter is not approved on the executor";
  }
  if (name === "InvalidMinProfit" || name === "InvalidSlippage") {
    return `${name}: a zero floor was submitted`;
  }
  return name ?? "unknown error";
}


/** Every known error name, for tests that assert the ABI matches `Errors.sol`. */
export function knownErrorNames(): string[] {
  return [...KNOWN_ERROR_NAMES];
}

