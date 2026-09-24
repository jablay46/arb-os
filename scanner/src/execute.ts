/**
 * Execution bot: scan, price, simulate, and (when armed) submit.
 *
 * Defaults to simulation. Signing requires both `LIVE=true` and
 * `I_UNDERSTAND_THIS_SIGNS_TRANSACTIONS=yes`; see `safety.ts` for why arming is
 * deliberately two-step.
 *
 * The loop is simulation-first on purpose. A discovered opportunity is a
 * *prediction*; `eth_call` of the real `execute` against the block the quote was
 * pinned to is the only thing that proves the route clears the executor's own
 * floor. A route that simulates and reverts is discarded without spending gas,
 * which is the entire value of having an on-chain profit floor.
 *
 * Usage:
 *   # simulate only (default; safe to leave running)
 *   BASE_RPC_URL=... EXECUTOR_ADDRESS=... OPERATOR_ADDRESS=... \
 *     npx tsx scanner/src/execute.ts
 *
 *   # armed: signs and broadcasts
 *   BASE_RPC_URL=... EXECUTOR_ADDRESS=... OPERATOR_ADDRESS=... \
 *   PRIVATE_KEY=... LIVE=true I_UNDERSTAND_THIS_SIGNS_TRANSACTIONS=yes \
 *     npx tsx scanner/src/execute.ts
 */

import { createWalletClient, http, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { base } from "viem/chains";

import { loadConfig, ADDR, adapterEnvVar, adapterFor, type VenueConfig } from "./config.js";
import { RpcClient, CallReverted } from "./rpc.js";
import { buildVenue, type VenueRuntime } from "./venues.js";
import { rankedOpportunities, scanVenues, bestCandidate, type Opportunity } from "./discovery.js";
import { fetchGasPrice, fetchL1FeeUpperBound } from "./gas.js";
import { buildRoute, encodeExecute, type ExecutionRequest } from "./abi.js";
import { decodeRevert, isExpectedRefusal } from "./errors.js";
import { preflight, type PreflightResult } from "./preflight.js";
import { openJournal, type Journal } from "./journal.js";
import { providerName } from "./settlement.js";
import { execute } from "./wire.js";
import {
  assertLiveArmed,
  checkLiveGuards,
  loadPrivateKey,
  redactRpcUrl,
  requireAddress,
  slipFloor,
  type LiveGuards,
} from "./safety.js";

const argv = process.argv.slice(2);
const once = argv.includes("--once");

/** Slippage applied to each leg's quoted output. */
const SLIPPAGE_BPS = Number(process.env.SLIPPAGE_BPS ?? "50");
/** Candidates simulated per scan. Each costs two RPC calls. */
const MAX_SIMULATIONS = 4;

const fmt = (v: bigint, places = 6): string => {
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const whole = abs / 10n ** 18n;
  const frac = (abs % 10n ** 18n).toString().padStart(18, "0").slice(0, places);
  return `${neg ? "-" : ""}${whole}.${frac}`;
};

/** A venue that has an adapter configured, i.e. one that can actually be traded. */
interface TradableVenue {
  runtime: VenueRuntime;
  config: VenueConfig;
  adapter: Address;
}

async function main(): Promise<void> {
  const cfg = loadConfig();
  const live = process.env.LIVE?.trim().toLowerCase() === "true";
  const rpc = new RpcClient(cfg.rpcUrl);

  const chainId = await rpc.chainId();
  if (chainId !== 8453) throw new Error(`expected Base (8453) but RPC reports ${chainId}`);

  const executorAddr = requireAddress(
    (process.env.EXECUTOR_ADDRESS ?? ADDR.EXECUTOR) as Address,
    "EXECUTOR_ADDRESS",
  );
  const operatorEnv = process.env.OPERATOR_ADDRESS?.trim();
  if (!operatorEnv) throw new Error("OPERATOR_ADDRESS is required");

  console.log(`rpc: ${redactRpcUrl(cfg.rpcUrl)}`);
  console.log(`executor: ${executorAddr}`);
  console.log(`mode: ${live ? "LIVE (signs and broadcasts)" : "SIMULATE ONLY"}`);
  console.log(`slippage: ${SLIPPAGE_BPS}bps per leg`);

  // In live mode the operator address is derived from the key rather than
  // trusted from the environment: a mismatch would simulate as one address and
  // sign as another, and the role check would fail only at submission.
  let operator: Address;
  let account: ReturnType<typeof privateKeyToAccount> | null = null;
  if (live) {
    assertLiveArmed();
    account = privateKeyToAccount(loadPrivateKey());
    operator = account.address;
    if (operatorEnv.toLowerCase() !== operator.toLowerCase()) {
      throw new Error(
        `OPERATOR_ADDRESS (${operatorEnv}) does not match the address derived from PRIVATE_KEY ` +
          `(${operator}); refusing to run with a mismatched operator`,
      );
    }
    console.log(`operator: ${operator} (derived from PRIVATE_KEY)`);
  } else {
    operator = operatorEnv as Address;
    console.log(`operator: ${operator} (from OPERATOR_ADDRESS; simulated only)`);
  }

  const startBlock = await rpc.blockNumber();
  const venues: VenueRuntime[] = [];
  for (const v of cfg.venues) {
    try {
      venues.push(await buildVenue(v, cfg.loanToken, rpc, startBlock));
    } catch (e) {
      console.warn(`  venue ${v.label} skipped: ${(e as Error).message}`);
    }
  }

  // Pair each resolved venue with its config and adapter. A venue without an
  // adapter can be scanned but never traded: building a step for it would use a
  // zero adapter, which the executor rejects with InvalidAdapter.
  const adapterByLabel = new Map<string, Address>(
    cfg.venues.filter((v) => v.adapter).map((v) => [v.label, v.adapter as Address]),
  );
  const tradable: TradableVenue[] = venues
    .filter((v) => adapterByLabel.has(v.label))
    .map((v) => ({
      runtime: v,
      config: cfg.venues.find((c) => c.label === v.label)!,
      adapter: adapterByLabel.get(v.label)!,
    }));

  if (tradable.length < 2) {
    throw new Error(
      `need at least 2 venues with a configured adapter to form a cycle; have ${tradable.length}. ` +
        `Set these env vars: ${cfg.venues.map((v) => adapterEnvVar(v.label)).join(", ")}`,
    );
  }
  console.log(
    `tradable venues (${tradable.length}): ${tradable.map((t) => t.runtime.label).join(", ")}`,
  );

  // A venue that resolved but has no adapter is scannable-yet-untradable. Say so
  // explicitly: as a silent omission it looks like a thin market rather than a
  // missing env var.
  for (const v of cfg.venues) {
    if (!adapterFor(v.label) && venues.some((r) => r.label === v.label)) {
      console.warn(
        `  note: ${v.label} has no adapter (${adapterEnvVar(v.label)} unset); ` +
          `it will be priced but never traded`,
      );
    }
  }

  const requiredAdapters = [...new Set(tradable.map((t) => t.adapter))];
  const pf = await preflight({
    rpc,
    executor: executorAddr,
    operator,
    loanToken: cfg.loanToken,
    requiredAdapters,
  });
  console.log(
    `preflight ok: treasury=${pf.treasury} on-chain loan range=[${pf.mlLoanMin}, ${pf.mlLoanMax}]`,
  );
  if (pf.mlLoanMax > 0n) {
    const maxConfigured = cfg.loanAmounts.reduce((a, b) => (a > b ? a : b), 0n);
    if (maxConfigured > pf.mlLoanMax) {
      console.warn(
        `  warning: configured loan size ${fmt(maxConfigured)} exceeds the executor's ` +
          `maxLoanSize ${fmt(pf.mlLoanMax)}; those sizes will revert`,
      );
    }
  }

  const guards: LiveGuards = {
    minNetProfitWei: BigInt(process.env.MIN_NET_PROFIT_WEI ?? "100000000000000"),
    maxGasPriceWei: BigInt(process.env.MAX_GAS_PRICE_WEI ?? "100000000000"),
    approvedAdapters: pf.approvedAdapters,
    maxLoanWei: BigInt(process.env.MAX_LOAN_WEI ?? "10000000000000000000"),
  };
  console.log(
    `guards: minNetProfit=${guards.minNetProfitWei} wei maxGasPrice=${guards.maxGasPriceWei} wei ` +
      `maxLoan=${fmt(guards.maxLoanWei)} WETH`,
  );

  const wallet = account
    ? createWalletClient({ account, chain: base, transport: http(cfg.rpcUrl) })
    : null;

  const journal = openJournal(cfg.journalFile);
  if (journal.enabled) {
    console.log(`journal: ${cfg.journalFile} (append-only JSONL)`);
  }

  const runOnce = async (): Promise<boolean> => {
    const block = await rpc.blockNumber();
    const [gasPriceWei, l1FeeWei] = await Promise.all([
      fetchGasPrice(rpc),
      fetchL1FeeUpperBound(rpc, cfg.chainId, block),
    ]);
    if (l1FeeWei === null) throw new Error("L1 fee oracle unreadable; skipping block");

    const runtimes = tradable.map((t) => t.runtime);
    const quoteStart = Date.now();
    const quotes = await scanVenues(rpc, runtimes, cfg.loanAmounts, block, cfg.maxBatchSize);
    const quoteMs = Date.now() - quoteStart;
    const candidates = rankedOpportunities(cfg.loanAmounts, quotes, cfg.minProfit);

    if (journal.enabled) {
      const best = bestCandidate(cfg.loanAmounts, quotes);
      journal.write({
        kind: "scan",
        ts: new Date().toISOString(),
        block,
        venues: quotes.length,
        bestMarginWei: best ? best.margin.toString() : null,
        bestFirst: best ? (runtimes[best.first]?.label ?? null) : null,
        bestSecond: best ? (runtimes[best.second]?.label ?? null) : null,
        candidates: candidates.length,
        quoteMs,
      });
    }

    if (candidates.length === 0) {
      if (cfg.verbose) {
        const stamp = new Date().toISOString();
        console.log(`[${stamp}] block ${block} - no candidate clearing minProfit`);
      } else {
        process.stdout.write(".");
      }
      return false;
    }

    // Gross-descending, so the first route that clears its floor is very likely
    // the best. Bounded because each attempt costs a simulation round trip.
    for (const opp of candidates.slice(0, MAX_SIMULATIONS)) {
      const done = await tryOpportunity({
        opp,
        block,
        gasPriceWei,
        l1FeeWei,
        guards,
        wallet,
        account,
        operator,
        executorAddr,
        pf,
        loanToken: cfg.loanToken,
        tradable,
        rpc,
        journal,
      });
      if (done) return true;
    }
    return false;
  };

  if (once) {
    await runOnce();
    console.log("");
    return;
  }

  for (;;) {
    try {
      await runOnce();
    } catch (e) {
      console.error(`\nscan failed (continuing): ${(e as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, cfg.scanIntervalMs));
  }
}

/**
 * Build, simulate, and optionally submit one opportunity.
 *
 * Returns true when the route simulated successfully (or was broadcast), so the
 * caller stops looking at worse candidates. A route the executor refuses returns
 * false and the next candidate is tried, because on a competitive market a
 * refusal is the normal outcome rather than an error.
 */
async function tryOpportunity(args: {
  opp: Opportunity;
  block: number;
  gasPriceWei: bigint;
  l1FeeWei: bigint;
  guards: LiveGuards;
  wallet: ReturnType<typeof createWalletClient> | null;
  account: ReturnType<typeof privateKeyToAccount> | null;
  operator: Address;
  executorAddr: Address;
  pf: PreflightResult;
  loanToken: Address;
  tradable: TradableVenue[];
  rpc: RpcClient;
  journal: Journal;
}): Promise<boolean> {
  const { opp, tradable, loanToken, rpc, operator, executorAddr, pf, journal } = args;

  const first = tradable[opp.first];
  const second = tradable[opp.second];
  if (!first || !second) return false;

  const quoteToken = first.runtime.token;

  // Floors come from the *quoted* outputs, with a haircut. Leg 2's quote is for
  // the predicted intermediate amount; the executor resolves leg 2's real input
  // from leg 1's realised output, so a floor expressed against the prediction is
  // a lower bound on what leg 2 must produce, not an exact expectation.
  const swaps = buildRoute({
    firstVenue: first.runtime,
    secondVenue: second.runtime,
    firstAdapter: first.adapter,
    secondAdapter: second.adapter,
    loanToken,
    quoteToken,
    loanAmount: opp.loanAmount,
    leg1MinAmountOut: slipFloor(opp.leg1.amountOut, SLIPPAGE_BPS),
    leg2MinAmountOut: slipFloor(opp.leg2.amountOut, SLIPPAGE_BPS),
  });

  // The on-chain floor is a fraction of the predicted edge, not the whole of it.
  // The prediction is already discounted by the per-leg floors above, so
  // demanding all of it on chain would revert on ordinary slippage. A tenth is
  // small but real: it still refuses a route whose edge a sandwich took, and
  // `_settleProfit` measures the true delta regardless.
  const onChainFloor = opp.grossProfit / 10n;

  const request: ExecutionRequest = {
    loanProvider: 0, // Morpho: fee-free on Base, pulled via transferFrom after the callback
    loanToken,
    loanAmount: opp.loanAmount,
    minProfit: onChainFloor > 0n ? onChainFloor : 1n,
    profitReceiver: pf.treasury,
    swaps,
  };

  const label = `${first.runtime.label} -> ${second.runtime.label}`;

  try {
    const result = await execute({
      rpc,
      wallet: args.wallet,
      account: args.account,
      executor: executorAddr,
      operator,
      data: encodeExecute(request),
      block: args.block,
      loanToken,
      gasPriceWei: args.gasPriceWei,
      l1FeeWei: args.l1FeeWei,
      guards: args.guards,
      loanAmount: opp.loanAmount,
      projectedGrossWei: opp.grossProfit,
      adapterAddresses: swaps.map((s) => s.adapter),
      label,
      simulationOnly: args.wallet === null,
      slippageBps: SLIPPAGE_BPS,
    });
    journal.write({
      kind: "simulate",
      ts: new Date().toISOString(),
      block: args.block,
      label,
      loanAmountWei: opp.loanAmount.toString(),
      projectedGrossWei: opp.grossProfit.toString(),
      projectedNetWei: result.projectedNetWei.toString(),
      gasUnits: result.gasUnits.toString(),
      gasCostWei: result.gasCostWei.toString(),
      ok: true,
      refusal: null,
    });
    if (result.settlement) {
      journal.write({
        kind: "settled",
        ts: new Date().toISOString(),
        label,
        txHash: result.txHash ?? "",
        loanAmountWei: opp.loanAmount.toString(),
        projectedNetWei: result.projectedNetWei.toString(),
        settledProfitWei: result.settlement.profit.toString(),
        gapWei: (result.projectionGapWei ?? 0n).toString(),
        provider: providerName(result.settlement.provider),
        gasUsed: (result.gasUsed ?? 0n).toString(),
        blockNumber: args.block.toString(),
      });
    }
    return result.simulated;
  } catch (e) {
    if (e instanceof CallReverted) {
      const d = decodeRevert(e.data);
      const expected = isExpectedRefusal(d.name);
      console.log(`  ${label}: ${expected ? "refused" : "FAILED"} - ${d.summary}`);
      if (!expected) {
        console.error(
          `  ^ a configuration problem, not a market one; check the operator role, ` +
            `adapter approvals, and loan-size limits`,
        );
      }
      journal.write({
        kind: "simulate",
        ts: new Date().toISOString(),
        block: args.block,
        label,
        loanAmountWei: opp.loanAmount.toString(),
        projectedGrossWei: opp.grossProfit.toString(),
        projectedNetWei: "0",
        gasUnits: "0",
        gasCostWei: "0",
        ok: false,
        refusal: d.name ?? "unknown",
      });
      return false;
    }
    throw e;
  }
}

main().catch((e) => {
  console.error(`fatal: ${(e as Error).message}`);
  process.exit(1);
});
