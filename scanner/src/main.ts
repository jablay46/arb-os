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
import { rankedOpportunities, bestCandidate, scanVenues } from "./discovery.js";
import { buildVenue, type VenueRuntime } from "./venues.js";
import { BASE_CHAIN_ID } from "./config.js";

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

  let scans = 0;
  const runOnce = async (): Promise<boolean> => {
    // Pin one block for both phases: legs priced against different blocks
    // describe a cycle that never existed.
    const block = await rpc.blockNumber();
    const started = Date.now();
    const quotes = await scanVenues(rpc, venues, cfg.loanAmounts, block, cfg.maxBatchSize);
    const opps = rankedOpportunities(cfg.loanAmounts, quotes, cfg.minProfit);
    const best = bestCandidate(cfg.loanAmounts, quotes);
    const elapsed = Date.now() - started;
    scans++;

    const stamp = new Date().toISOString();
    if (opps.length > 0) {
      console.log(`\n[${stamp}] block ${block} (${elapsed}ms) - ${opps.length} candidate(s)`);
      for (const o of opps.slice(0, 5)) {
        const a = venues[o.first]!.label;
        const b = venues[o.second]!.label;
        console.log(
          `  ${a} -> ${b}  loan=${fmt(o.loanAmount)}  out=${fmt(o.leg2.amountOut)}  ` +
            `gross=${fmt(o.grossProfit)} ${cfg.loanTokenSymbol}`,
        );
      }
    } else if (cfg.verbose) {
      const detail = best
        ? `${venues[best.first]!.label} -> ${venues[best.second]!.label} ` +
          `loan=${fmt(best.loanAmount)} out=${fmt(best.amountOut)} ` +
          `spread=${fmt(best.margin)} ${cfg.loanTokenSymbol}`
        : "n/a";
      console.log(`[${stamp}] block ${block} (${elapsed}ms) - no opportunity (best: ${detail})`);
    } else {
      process.stdout.write(".");
    }
    return opps.length > 0;
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
