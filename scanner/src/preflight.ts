/**
 * Preflight: verify the executor is actually usable before any route is built.
 *
 * Every check here corresponds to a way a run can look healthy in simulation and
 * still be impossible to execute -- wrong key, missing role, unapproved adapter,
 * paused contract, zero treasury. Finding them here costs one RPC round trip;
 * finding them at submission costs a wasted simulation and a confusing revert.
 *
 * The bot deliberately does **not** repair any of this. It will not grant roles,
 * approve adapters, or unpause: those are admin actions that move trust, and a
 * trading loop that can grant itself permissions is a worse artefact than one
 * that refuses to start.
 */

import { encodeFunctionData, parseAbi } from "viem";
import type { Address } from "viem";

import type { RpcClient } from "./rpc.js";
import { SafetyError } from "./safety.js";

export const EXECUTOR_ABI = parseAbi([
  "function execute((uint8,address,uint256,uint256,address,uint8,((address,address,address,uint256,uint256,uint8,bytes)[],uint256),(address,uint256,bytes)[]))",
  "function paused() view returns (bool)",
  "function treasury() view returns (address)",
  "function approvedAdapter(address) view returns (bool)",
  "function hasRole(bytes32, address) view returns (bool)",
  "function OPERATOR_ROLE() view returns (bytes32)",
  "function minLoanSize(address) view returns (uint256)",
  "function maxLoanSize(address) view returns (uint256)",
]);

export interface PreflightResult {
  executor: Address;
  operator: Address;
  treasury: Address;
  mlLoanMin: bigint;
  mlLoanMax: bigint;
  /** Adapters approved on chain, lowercased. */
  approvedAdapters: Set<string>;
  operatorHasRole: boolean;
}

export interface PreflightInput {
  rpc: RpcClient;
  executor: Address;
  operator: Address;
  loanToken: Address;
  /** Adapter addresses the venue set will use; all must be approved. */
  requiredAdapters: Address[];
  block?: number;
}

const enc = (fn: string, args: unknown[] = []): string =>
  encodeFunctionData({ abi: EXECUTOR_ABI, functionName: fn, args } as never);

function decodeBool(raw: string): boolean {
  return BigInt(raw) !== 0n;
}
function decodeAddress(raw: string): Address {
  return `0x${raw.slice(-40)}` as Address;
}
function decodeUint(raw: string): bigint {
  return BigInt(raw);
}

/**
 * Run every check and throw a `SafetyError` naming the first failure.
 *
 * Checks run as one batched read, so preflight costs a single round trip.
 */
export async function preflight(input: PreflightInput): Promise<PreflightResult> {
  const { rpc, executor, operator, loanToken, requiredAdapters } = input;

  // A zero executor would make every subsequent call a no-op against the empty
  // address, which "succeeds" and returns empty data. Catch it first.
  const code = await rpc.getCode(executor, input.block ?? "latest");
  if (code === "0x" || code === "0x0") {
    throw new SafetyError(
      `no contract at executor ${executor}; deploy it or set EXECUTOR_ADDRESS`,
    );
  }

  const roleData = enc("OPERATOR_ROLE");
  const calls = [
    { to: executor, data: enc("paused") },
    { to: executor, data: enc("treasury") },
    { to: executor, data: enc("minLoanSize", [loanToken]) },
    { to: executor, data: enc("maxLoanSize", [loanToken]) },
    { to: executor, data: roleData },
    ...requiredAdapters.map((a) => ({ to: executor, data: enc("approvedAdapter", [a]) })),
  ];

  const res = await rpc.ethCalls(calls, { block: input.block });
  const [pausedRaw, treasuryRaw, minRaw, maxRaw, roleRaw] = res;
  if (!pausedRaw || !treasuryRaw || !minRaw || !maxRaw || !roleRaw) {
    throw new SafetyError("preflight reads failed; the executor may be on a different chain");
  }

  const paused = decodeBool(pausedRaw);
  if (paused) {
    throw new SafetyError(`executor ${executor} is paused; an admin must unpause it`);
  }

  const treasury = decodeAddress(treasuryRaw);
  if (/^0x0{40}$/i.test(treasury)) {
    throw new SafetyError("executor treasury is the zero address; profit would be burned");
  }

  const operatorRole = roleRaw;

  // `hasRole` depends on the role word, so it is a second round trip.
  const [hasRoleRaw] = await rpc.ethCalls(
    [{ to: executor, data: encodeFunctionData({
      abi: EXECUTOR_ABI,
      functionName: "hasRole",
      args: [operatorRole, operator],
    } as never) }],
    { block: input.block },
  );
  const operatorHasRole = hasRoleRaw ? decodeBool(hasRoleRaw) : false;
  if (!operatorHasRole) {
    throw new SafetyError(
      `operator ${operator} does not hold OPERATOR_ROLE on ${executor}; ` +
        `execute() would revert with Unauthorized`,
    );
  }

  const approvedAdapters = new Set<string>();
  for (const [i, adapter] of requiredAdapters.entries()) {
    const raw = res[5 + i];
    if (!raw || !decodeBool(raw)) {
      throw new SafetyError(
        `adapter ${adapter} is not approved on ${executor}; ` +
          `an admin must call setApprovedAdapter before this venue can trade`,
      );
    }
    approvedAdapters.add(adapter.toLowerCase());
  }

  return {
    executor,
    operator,
    treasury,
    mlLoanMin: decodeUint(minRaw),
    mlLoanMax: decodeUint(maxRaw),
    approvedAdapters,
    operatorHasRole,
  };
}
