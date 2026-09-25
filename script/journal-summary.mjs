#!/usr/bin/env node
/**
 * Summarise a scanner journal.
 *
 * The journal answers one question: over a long simulate run, does a real
 * opportunity ever appear? Counting that by hand from JSONL is tedious and
 * error-prone, so this reduces a run to the few numbers that matter:
 *
 *   - how many scan ticks happened, and over what block range
 *   - how often the best cycle was actually profitable (margin > 0)
 *   - the best margin seen, so "we nearly made it" is distinguishable
 *     from "nothing came remotely close"
 *   - every simulation and its outcome, grouped by route
 *   - every settlement, with the projected-vs-settled gap
 *
 * Dependency-free on purpose: plain node, no build step, readable a year later.
 *
 * Usage:
 *   node script/journal-summary.mjs [journal.jsonl]
 */

import { readFileSync } from "node:fs";

const path = process.argv[2] ?? process.env.JOURNAL_FILE;
if (!path) {
  console.error("usage: node script/journal-summary.mjs <journal.jsonl>");
  process.exit(2);
}

const WETH = 10n ** 18n;

/** Format wei as a fixed-point WETH string, signed. */
function weth(wei) {
  const v = BigInt(wei);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const whole = abs / WETH;
  const frac = (abs % WETH).toString().padStart(18, "0").slice(0, 6);
  return `${neg ? "-" : ""}${whole}.${frac}`;
}

const scans = [];
const sims = [];
const settled = [];
const failed = [];
let badLines = 0;

const text = readFileSync(path, "utf8");
for (const line of text.split("\n")) {
  const trimmed = line.trim();
  if (!trimmed) continue;
  let rec;
  try {
    rec = JSON.parse(trimmed);
  } catch {
    // A partially-written final line after a kill is expected; count it rather
    // than aborting, because the rest of the file is still good.
    badLines++;
    continue;
  }
  switch (rec.kind) {
    case "scan":
      scans.push(rec);
      break;
    case "simulate":
      sims.push(rec);
      break;
    case "settled":
      settled.push(rec);
      break;
    case "failed":
      failed.push(rec);
      break;
    default:
      badLines++;
  }
}

console.log(`journal: ${path}`);
console.log(`records: scans=${scans.length} simulations=${sims.length} settled=${settled.length} failed=${failed.length}`);
if (badLines > 0) console.log(`unparseable lines (truncated tail?): ${badLines}`);
if (scans.length === 0 && sims.length === 0) {
  console.log("\nnothing recorded yet.");
  process.exit(0);
}

if (scans.length > 0) {
  const blocks = scans.map((s) => s.block).filter((b) => typeof b === "number");
  const margins = scans
    .map((s) => s.bestMarginWei)
    .filter((m) => m !== null && m !== undefined)
    .map((m) => BigInt(m));

  console.log("\n--- scans ---");
  if (blocks.length > 0) {
    console.log(`blocks: ${Math.min(...blocks)}..${Math.max(...blocks)} (${new Set(blocks).size} distinct)`);
  }
  console.log(`ticks with a quotable cycle: ${margins.length}/${scans.length}`);

  if (margins.length > 0) {
    const sorted = [...margins].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const best = sorted[sorted.length - 1];
    const median = sorted[Math.floor(sorted.length / 2)];
    const profitable = sorted.filter((m) => m > 0n).length;
    const positiveCounts = new Map();
    for (const s of scans) {
      const first = s.bestFirst ?? "?";
      const second = s.bestSecond ?? "?";
      if (s.bestMarginWei !== null && s.bestMarginWei !== undefined && BigInt(s.bestMarginWei) > 0n) {
        const key = `${first} -> ${second}`;
        positiveCounts.set(key, (positiveCounts.get(key) ?? 0) + 1);
      }
    }

    console.log(`best margin:    ${weth(best)} WETH`);
    console.log(`median margin:  ${weth(median)} WETH`);
    console.log(`profitable ticks: ${profitable}/${margins.length} (${((profitable / margins.length) * 100).toFixed(1)}%)`);
    console.log(
      profitable > 0
        ? "=> the best cycle was profitable on at least one tick, but check `candidates` below: a margin that does not clear minProfit is still not tradable."
        : "=> the best cycle was never profitable across this run.",
    );
    if (positiveCounts.size > 0) {
      console.log("profitable ticks by route:");
      for (const [route, n] of [...positiveCounts].sort((a, b) => b[1] - a[1])) {
        console.log(`  ${n.toString().padStart(5)}  ${route}`);
      }
    }
  }

  const clearers = scans.filter((s) => (s.candidates ?? 0) > 0);
  console.log(`ticks with a candidate clearing minProfit: ${clearers.length}/${scans.length}`);

  const quoteTimes = scans.map((s) => s.quoteMs).filter((q) => typeof q === "number");
  if (quoteTimes.length > 0) {
    const avg = quoteTimes.reduce((a, b) => a + b, 0) / quoteTimes.length;
    console.log(`mean quote time: ${avg.toFixed(0)} ms/block`);
  }
}

if (sims.length > 0) {
  console.log("\n--- simulations ---");
  const byRoute = new Map();
  let refusals = 0;
  let accepted = 0;
  for (const s of sims) {
    const key = `${s.label}  (loan ${weth(s.loanAmountWei)} WETH)`;
    const entry = byRoute.get(key) ?? { n: 0, ok: 0, refusals: new Map() };
    entry.n++;
    if (s.ok) {
      entry.ok++;
      accepted++;
    } else {
      refusals++;
      const r = s.refusal ?? "unknown";
      entry.refusals.set(r, (entry.refusals.get(r) ?? 0) + 1);
    }
    byRoute.set(key, entry);
  }
  console.log(`accepted: ${accepted}  refused: ${refusals}`);
  for (const [route, e] of [...byRoute].sort((a, b) => b[1].n - a[1].n)) {
    const reasons = [...e.refusals].map(([r, n]) => `${r} x${n}`).join(", ");
    console.log(`  ${route}: ${e.n} tries, ${e.ok} accepted${reasons ? `, refused: ${reasons}` : ""}`);
  }
  if (accepted > 0) {
    console.log(
      "=> an accepted simulation is a route that clears the executor's own floor at that block. Those are the ticks worth looking at.",
    );
  }
}

if (settled.length > 0) {
  console.log("\n--- settlements ---");
  let total = 0n;
  for (const s of settled) {
    total += BigInt(s.settledProfitWei);
    console.log(
      `  ${s.ts}  ${s.label}  profit=${weth(s.settledProfitWei)} WETH  ` +
        `projected=${weth(s.projectedNetWei)}  gap=${weth(s.gapWei)}  provider=${s.provider}  tx=${s.txHash}`,
    );
  }
  console.log(`total settled profit: ${weth(total)} WETH`);
  const gaps = settled.map((s) => BigInt(s.gapWei));
  const worst = gaps.reduce((a, b) => (a < b ? a : b));
  console.log(`worst projection gap: ${weth(worst)} WETH (negative means the projection was optimistic)`);
}

if (failed.length > 0) {
  console.log("\n--- failures ---");
  for (const f of failed.slice(0, 20)) {
    console.log(`  ${f.ts}  ${f.label ?? "-"}  ${f.reason}`);
  }
  if (failed.length > 20) console.log(`  ... and ${failed.length - 20} more`);
}
