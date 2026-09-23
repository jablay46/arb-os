/**
 * Scanner entry point: a read-only opportunity detector for Base.
 *
 * This does NOT trade. It prices cycles and prints them. Execution is a
 * separate, deliberate step (`--execute`, not implemented here) because
 * submitting a transaction is the one action that can lose money, and it
 * should never be reachable by accident from a loop.
 *
 * Usage:
 *   BASE_RPC_URL=https://... npx tsx scanner/src/main.ts --once
 *   BASE_RPC_URL=https://... npx tsx scanner/src/main.ts
 */

import { loadConfig, ADDR } from "./config.js";
import { RpcClient } from "./rpc.js";
import { rankedOpportunities, bestCandidate, scanVenues, type Opportunity } from "./discovery.js";
import { buildVenue, type VenueRuntime } from "./venues.js";
import { BASE_CHAIN_ID } from "./config.js";
import {
  canStillWin,
  fetchGasPrice,
  fetchL1FeeUpperBound,
  gasCost,
  pickBestNet,
  DRY_RUN_GAS_UNITS,
  type GasOutcome,
} from "./gas.js";

/**
 * Candidates whose gas is simulated per scan, mirroring the Rust constant.
 *
 * Each simulation is an RPC round trip, so an unbounded loop turns a busy
 * block into a flood of calls. Four is the Rust bot's budget: candidates
 * arrive gross-descending, and `canStillWin` stops the loop early once no
 * later candidate can beat the incumbent anyway.
 */
const MAX_CANDIDATE_ATTEMPTS = 4;

const fmt = (v: bigint, decimals = 18, places = 6): string => {
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const scale = 10n ** BigInt(decimals);
  const whole = abs / scale;
  const frac = (abs % scale).toString().padStart(decimals, "0").slice(0, places);
  return `${neg ? "-" : ""}${whole}.${frac}`;
};

const argv = process.argv.slice(2);
const once = argv.includes("--once");

async function main(): Promise<void> {
  const cfg = loadConfig();
  const rpc = new RpcClient(cfg.rpcUrl);

  // Fail fast and loudly: pointing the scanner at the wrong chain would
  // produce confident quotes for contracts that do not exist.
  const chainId = await rpc.chainId();
  if (chainId !== BASE_CHAIN_ID) {
    throw new Error(`expected Base (chainId ${BASE_CHAIN_ID}) but the RPC reports ${chainId}`);
  }
  const startBlock = await rpc.blockNumber();
  console.log(`connected: chainId=${chainId} block=${startBlock} rpc=${new URL(cfg.rpcUrl).host}`);
  console.log(`loan token: ${cfg.loanTokenSymbol} (${cfg.loanToken})`);
  console.log(`loan sizes: ${cfg.loanAmounts.map((a) => fmt(a)).join(", ")} ${cfg.loanTokenSymbol}`);
  console.log(`min profit: ${fmt(cfg.minProfit)} ${cfg.loanTokenSymbol}`);
  console.log(`mode: ${cfg.dryRun ? "DRY RUN (read-only)" : "DRY RUN off, but this build never submits"}`);

  // Resolve venues once, against a pinned block. Aerodrome's pool address and
  // fee come from the factory here, so a config/chain mismatch stops the scan
  // instead of mispricing every leg.
  const venues: VenueRuntime[] = [];
  for (const v of cfg.venues) {
    try {
      venues.push(await buildVenue(v, cfg.loanToken, rpc, startBlock));
    } catch (e) {
      console.warn(`  venue ${v.label} skipped: ${(e as Error).message}`);
    }
  }
  if (venues.length < 2) {
    throw new Error(`need at least 2 usable venues to form a cycle, got ${venues.length}`);
  }
  console.log(`venues (${venues.length}):`);
  for (const v of venues) console.log(`  ${v.kind.padEnd(12)} ${v.label}`);

  /**
   * Price the gas of the top candidates and pick the best net-profit one.
   *
   * This is the step that keeps the scanner honest. Ranking on gross profit
   * reports cycles that lose money once gas is paid; on a busy block that is
   * most of them. The loop is bounded and stops early because a later
   * candidate's net can never exceed its gross, so once gross falls to or
   * below the incumbent's net it cannot win.
   *
   * Dry run has no transaction to simulate, so gas is a fixed ceiling rather
   * than zero. Pricing it at zero would make the `minProfit` filter run
   * against gross and report trades that live mode always rejects.
   */
  const evaluateNet = async (
    opps: Opportunity[],
    l1FeeWei: bigint,
    gasPriceWei: bigint,
  ): Promise<{ best: { opportunity: Opportunity; gas: bigint } | null; evaluated: number }> => {
    const results: { opportunity: Opportunity; outcome: GasOutcome }[] = [];
    let incumbent: { opportunity: Opportunity; gas: bigint } | null = null;

    for (let i = 0; i < opps.length && i < MAX_CANDIDATE_ATTEMPTS; i++) {
      const opp = opps[i]!;
      if (incumbent && !canStillWin(opp.grossProfit, incumbent)) break;

      // No per-candidate simulation yet: simulating the real `execute` call
      // needs the executor deployed and an encoded route, neither of which
      // exists in this read-only build. The fixed ceiling errs high, so the
      // gate errs toward rejecting candidates rather than admitting them.
      const gas = gasCost({
        gasUnits: DRY_RUN_GAS_UNITS,
        gasPriceWei,
        l1FeeWei,
        loanToken: cfg.loanToken,
        wrappedNative: ADDR.WETH,
      });
      results.push({ opportunity: opp, outcome: { kind: "priced", gas } });

      const net = opp.grossProfit > gas ? opp.grossProfit - gas : 0n;
      if (
        net >= cfg.minProfit &&
        (incumbent === null || net > incumbent.opportunity.grossProfit - incumbent.gas)
      ) {
        incumbent = { opportunity: opp, gas };
      }
    }

    return { best: pickBestNet(results, cfg.minProfit), evaluated: results.length };
  };

  let scans = 0;
  const runOnce = async (): Promise<boolean> => {
    // Pin one block for both phases: legs priced against different blocks
    // describe a cycle that never existed.
    const block = await rpc.blockNumber();
    const started = Date.now();

    // Gas price and L1 fee are read once per scan, before quoting: they gate
    // whether any candidate is worth reporting, and a missing L1 fee means
    // cost is unknown, which must skip the block rather than price it at zero.
    const [gasPriceWei, l1FeeWei] = await Promise.all([
      fetchGasPrice(rpc),
      fetchL1FeeUpperBound(rpc, cfg.chainId, block),
    ]);
    if (l1FeeWei === null) {
      throw new Error("L1 data-fee oracle unreadable; skipping block rather than pricing it at zero");
    }

    const quotes = await scanVenues(rpc, venues, cfg.loanAmounts, block, cfg.maxBatchSize);
    const candidates = rankedOpportunities(cfg.loanAmounts, quotes, cfg.minProfit);
    const best = bestCandidate(cfg.loanAmounts, quotes);
    const net = await evaluateNet(candidates, l1FeeWei, gasPriceWei);
    const elapsed = Date.now() - started;
    scans++;

    const stamp = new Date().toISOString();
    if (net.best) {
      const o = net.best.opportunity;
      const a = venues[o.first]!.label;
      const b = venues[o.second]!.label;
      const netProfit = o.grossProfit - net.best.gas;
      console.log(
        `\n[${stamp}] block ${block} (${elapsed}ms) - NET OPPORTUNITY\n` +
          `  ${a} -> ${b}  loan=${fmt(o.loanAmount)}\n` +
          `  gross=${fmt(o.grossProfit)}  gas=${fmt(net.best.gas)}  ` +
          `net=${fmt(netProfit)} ${cfg.loanTokenSymbol}`,
      );
      if (candidates.length > 1) {
        console.log(`  (${candidates.length} gross candidates, ${net.evaluated} gas-priced)`);
      }
      return true;
    }

    if (cfg.verbose) {
      const grossTop = candidates[0];
      const detail = grossTop
        ? `top gross ${venues[grossTop.first]!.label} -> ${venues[grossTop.second]!.label} ` +
          `loan=${fmt(grossTop.loanAmount)} gross=${fmt(grossTop.grossProfit)} ` +
          `gas=${fmt(net.evaluated > 0 ? l1FeeWei + DRY_RUN_GAS_UNITS * gasPriceWei : 0n)} ` +
          `-> no net opportunity`
        : best
          ? `${venues[best.first]!.label} -> ${venues[best.second]!.label} ` +
            `loan=${fmt(best.loanAmount)} spread=${fmt(best.margin)} ${cfg.loanTokenSymbol}`
          : "n/a";
      console.log(`[${stamp}] block ${block} (${elapsed}ms) - no opportunity (${detail})`);
    } else {
      process.stdout.write(".");
    }
    return false;
  };

  if (once) {
    await runOnce();
    console.log("");
    return;
  }

  // Scan loop. A wall-clock timer rather than newHeads: header subscriptions
  // are billed per byte by most providers, and a 2s block cadence does not
  // need the extra precision.
  for (;;) {
    try {
      await runOnce();
    } catch (e) {
      console.error(`\nscan failed (continuing): ${(e as Error).message}`);
    }
    await new Promise((r) => setTimeout(r, cfg.scanIntervalMs));
  }
}

main().catch((e) => {
  console.error(`fatal: ${(e as Error).message}`);
  process.exit(1);
});

export { ADDR };
