/**
 * The wire: simulation, gas accounting, signing, and submission.
 *
 * This is the only module in the repo that can move funds, so it is kept small
 * and does exactly one sequence, in this order:
 *
 *   1. `eth_call` the real `execute` from the operator address, pinned to the
 *      block the route was priced against. A revert here means the route does
 *      not clear the executor's own floor; nothing is spent.
 *   2. `eth_estimateGas` for the same call, so the reported gas is measured
 *      rather than a fixed ceiling.
 *   3. Re-check the profit and gas guards against *measured* numbers.
 *   4. Sign and broadcast, with the gas limit padded from the estimate.
 *   5. Wait for the receipt and report the realised gas.
 *
 * Simulation is not skippable in either mode: it is what makes the difference
 * between an opportunity and a guess. Live mode only adds steps 4 and 5.
 */

import type { createWalletClient, Address } from "viem";
import type { privateKeyToAccount } from "viem/accounts";

import type { RpcClient, RpcLog } from "./rpc.js";
import { gasCost } from "./gas.js";
import { checkLiveGuards, SafetyError, type LiveGuards } from "./safety.js";
import { decodeSettlement, providerName, projectionGap, type Settlement } from "./settlement.js";

export interface WireInput {
  rpc: RpcClient;
  wallet: ReturnType<typeof createWalletClient> | null;
  account: ReturnType<typeof privateKeyToAccount> | null;
  executor: Address;
  operator: Address;
  /** Encoded `execute` calldata. */
  data: `0x${string}`;
  /** Block the route was priced against; simulation is pinned to it. */
  block: number;
  loanToken: Address;
  gasPriceWei: bigint;
  l1FeeWei: bigint;
  guards: LiveGuards;
  loanAmount: bigint;
  /** Scanner's predicted gross edge for this route, in wei (loan token = WETH). */
  projectedGrossWei: bigint;
  adapterAddresses: string[];
  label: string;
  /** When true, stop after simulation and report what would have happened. */
  simulationOnly: boolean;
  slippageBps: number;
}

export interface WireResult {
  simulated: boolean;
  submitted: boolean;
  /** Measured gas units, from `eth_estimateGas`. */
  gasUnits: bigint;
  /** Measured total cost in wei: gas plus the L1 data fee. */
  gasCostWei: bigint;
  txHash?: `0x${string}`;
  /** Realised gas from the receipt, when a transaction was sent. */
  gasUsed?: bigint;
  /** Projected net profit, in wei: the scanner's edge minus measured gas. */
  projectedNetWei: bigint;
  /** Decoded `ArbExecuted`, when a transaction was mined. */
  settlement?: Settlement;
  /** `settledProfit - projectedNet`, when a settlement was decoded. */
  projectionGapWei?: bigint;
}

/** Pad the estimate so a state change between simulation and inclusion still fits. */
const GAS_PAD_BPS = 12_000n; // +20%

export async function execute(input: WireInput): Promise<WireResult> {
  const { rpc, executor, operator, data } = input;

  // 1. Simulate against the priced block, from the operator address so the role
  //    check is exercised. A revert propagates as `CallReverted` with the
  //    payload intact for the caller to decode.
  await rpc.callFrom({ to: executor, data, from: operator, block: input.block });

  // 2. Measure gas. `eth_estimateGas` also reverts when the call would fail, so
  //    reaching here means the simulation agreed twice.
  const gasUnits = await rpc.estimateGas({ from: operator, to: executor, data });

  const measuredCostWei = gasCost({
    gasUnits,
    gasPriceWei: input.gasPriceWei,
    l1FeeWei: input.l1FeeWei,
    loanToken: input.loanToken,
    wrappedNative: input.loanToken,
  });

  // 3. Guards on measured numbers. In simulate mode the profit guard is still
  //    applied, so a run reported as "would trade" is one that would also pass
  //    the live gate -- otherwise simulation would be optimistically permissive
  //    and useless as a rehearsal.
  const projectedNet = projectedNetWei(input, measuredCostWei);
  checkLiveGuards({
    guards: input.guards,
    netProfitWei: projectedNet,
    gasPriceWei: input.gasPriceWei,
    loanAmountWei: input.loanAmount,
    adapterAddresses: input.adapterAddresses,
  });

  const stamp = new Date().toISOString();
  console.log(
    `\n[${stamp}] SIMULATED OK ${input.label}\n` +
      `  loan=${(Number(input.loanAmount) / 1e18).toFixed(4)} ` +
      `gasUnits=${gasUnits} gasCost=${measuredCostWei} wei ` +
      `projectedNet=${projectedNet} wei`,
  );

  if (input.simulationOnly) {
    console.log(`  (simulate-only: set LIVE=true to broadcast)`);
    return {
      simulated: true,
      submitted: false,
      gasUnits,
      gasCostWei: measuredCostWei,
      projectedNetWei: projectedNet,
    };
  }

  if (!input.wallet || !input.account) {
    throw new SafetyError("live mode requires a wallet and account");
  }

  // 4. Sign and send. Nonce is read fresh, and the fee is EIP-1559 with a tip
  //    sized from the current gas price, so the transaction is attractive
  //    without overpaying.
  const nonce = await rpc.getTransactionCount(input.operator, "pending");
  const blockData = await rpc.getLatestBlock();
  const maxPriorityFeePerGas = input.gasPriceWei < 1_000_000n ? input.gasPriceWei : 1_000_000n;
  const maxFeePerGas =
    blockData.baseFeePerGas > 0n
      ? blockData.baseFeePerGas * 2n + maxPriorityFeePerGas
      : input.gasPriceWei * 2n;

  const gasLimit = (gasUnits * GAS_PAD_BPS) / 10_000n;

  const txHash = await input.wallet.sendTransaction({
    account: input.account,
    chain: null,
    to: executor,
    data,
    gas: gasLimit,
    maxFeePerGas,
    maxPriorityFeePerGas,
    nonce,
  });

  console.log(`  BROADCAST ${txHash}`);

  // 5. Wait for inclusion. A dropped transaction is not a loss, but it must be
  //    reported rather than silently treated as success.
  const receipt = await waitForReceipt(rpc, txHash, 60_000);
  if (!receipt) {
    console.log(`  no receipt after 60s; the transaction may still be pending: ${txHash}`);
    return {
      simulated: true,
      submitted: true,
      gasUnits,
      gasCostWei: measuredCostWei,
      txHash,
      projectedNetWei: projectedNet,
    };
  }

  const gasUsed = BigInt(receipt.gasUsed);
  const status = BigInt(receipt.status) === 1n;
  console.log(
    `  ${status ? "MINED" : "REVERTED"} block=${BigInt(receipt.blockNumber)} gasUsed=${gasUsed}`,
  );
  if (!status) {
    throw new SafetyError(
      `transaction ${txHash} reverted on chain despite simulating successfully; ` +
        `state moved between simulation and inclusion`,
    );
  }

  // Read what actually settled off the receipt rather than reporting the
  // projection as if it were the outcome. A status-1 receipt with no
  // `ArbExecuted` means profit moved without being reported, which is worth
  // saying out loud rather than glossing over.
  const settlement = decodeSettlement(receipt.logs ?? [], executor) ?? undefined;
  let projectionGapWei: bigint | undefined;
  if (settlement) {
    projectionGapWei = projectionGap(projectedNet, settlement.profit);
    console.log(
      `  SETTLED profit=${settlement.profit} wei provider=${providerName(settlement.provider)} ` +
        `projected=${projectedNet} wei gap=${projectionGapWei} wei`,
    );
    if (projectionGapWei < 0n) {
      console.log(`  note: settled below projection; the pricing model is optimistic here`);
    }
  } else {
    console.log(
      `  note: no ArbExecuted in the receipt; the realised profit was not reported on chain`,
    );
  }

  return {
    simulated: true,
    submitted: true,
    gasUnits,
    gasCostWei: measuredCostWei,
    txHash,
    gasUsed,
    projectedNetWei: projectedNet,
    settlement,
    projectionGapWei,
  };
}

/**
 * Net profit to expect, in wei.
 *
 * `projectedGrossWei` is the scanner's predicted edge before gas; this subtracts
 * the *measured* cost. It is an estimate of realised profit, not a guarantee:
 * actual settlement is whatever `execute` achieves, and the on-chain `minProfit`
 * floor is the only hard guarantee.
 */
function projectedNetWei(input: WireInput, measuredCostWei: bigint): bigint {
  return input.projectedGrossWei > measuredCostWei
    ? input.projectedGrossWei - measuredCostWei
    : 0n;
}

async function waitForReceipt(
  rpc: RpcClient,
  hash: `0x${string}`,
  timeoutMs: number,
): Promise<{
  status: string;
  blockNumber: string;
  gasUsed: string;
  logs?: RpcLog[];
} | null> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const r = await rpc.getTransactionReceipt(hash);
    if (r) return r;
    await new Promise((res) => setTimeout(res, 1_000));
  }
  return null;
}
