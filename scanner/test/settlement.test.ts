/**
 * Tests for reading `ArbExecuted` back off a receipt, and for the journal.
 *
 * Offline: no network. The event decode is tested against a log built from the
 * same field values the executor emits, because the failure it guards against is
 * a *silent* one -- reading `profit` in `loanAmount`'s slot produces a number
 * that looks like a profit and is actually a loan size.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, unlinkSync } from "node:fs";
import { join } from "node:path";

import { keccak256, toHex, encodeAbiParameters, getAbiItem } from "viem";

import {
  ARB_EXECUTED_ABI,
  decodeSettlement,
  providerName,
  projectionGap,
} from "../src/settlement.js";
import { Journal, openJournal } from "../src/journal.js";
import type { RpcLog } from "../src/rpc.js";

const REPO = join(__dirname, "..", "..");

const EXECUTOR = "0x00000000000000000000000000000000000000AA";
const OTHER = "0x00000000000000000000000000000000000000BB";
const OP = "0x00000000000000000000000000000000000000CC" as const;
const WETH = "0x4200000000000000000000000000000000000006" as const;

const TOPIC0 = keccak256(toHex("ArbExecuted(address,address,uint256,uint256,uint8)"));

/** Build the receipt log the executor emits for a settlement. */
function settleLog(
  loanAmount: bigint,
  profit: bigint,
  provider: number,
  emitter = EXECUTOR,
): RpcLog {
  const pad = (a: string) => `0x${a.slice(2).toLowerCase().padStart(64, "0")}`;
  return {
    address: emitter,
    topics: [TOPIC0, pad(OP), pad(WETH)],
    data: encodeAbiParameters(
      [{ type: "uint256" }, { type: "uint256" }, { type: "uint8" }],
      [loanAmount, profit, provider],
    ),
  };
}

test("ArbExecuted ABI matches the Solidity declaration", () => {
  const sol = readFileSync(join(REPO, "src", "MorphoArbExecutor.sol"), "utf8");
  const m = sol.match(/event\s+ArbExecuted\s*\(([\s\S]*?)\);/);
  assert.ok(m, "ArbExecuted not found in MorphoArbExecutor.sol");
  const decl = m[1]!;

  // Two indexed address words, then the three data fields in order. The order is
  // what this pins: swapping `loanAmount` and `profit` would still decode.
  assert.match(decl, /address\s+indexed\s+initiator/);
  assert.match(decl, /address\s+indexed\s+loanToken/);
  assert.match(decl, /uint256\s+loanAmount/);
  assert.match(decl, /uint256\s+profit/);
  assert.ok(
    decl.indexOf("loanAmount") < decl.indexOf("profit"),
    "loanAmount must precede profit; the decoder reads them in that order",
  );

  const item = getAbiItem({ abi: ARB_EXECUTED_ABI, name: "ArbExecuted" });
  const inputs = item.inputs as readonly { type: string; indexed?: boolean }[];
  const indexed = inputs.map((i) => i.indexed === true);
  assert.deepEqual(indexed, [true, true, false, false, false]);
  assert.deepEqual(
    inputs.map((i) => i.type),
    ["address", "address", "uint256", "uint256", "uint8"],
  );
});

test("ArbExecuted topic0 matches the canonical signature", () => {
  const item = getAbiItem({ abi: ARB_EXECUTED_ABI, name: "ArbExecuted" });
  const canonical = `ArbExecuted(${item.inputs.map((i) => i.type).join(",")})`;
  assert.equal(keccak256(toHex(canonical)), TOPIC0);
});

test("decodes a settlement and keeps profit distinct from the loan size", () => {
  // Distinct magnitudes, so a transposed read is unmistakable.
  const got = decodeSettlement([settleLog(1_000_000_000_000_000_000n, 27_405_200_000_000_000n, 0)], EXECUTOR);
  assert.ok(got);
  assert.equal(got.loanAmount, 1_000_000_000_000_000_000n);
  assert.equal(got.profit, 27_405_200_000_000_000n);
  assert.equal(got.provider, 0);
  assert.equal(got.loanToken.toLowerCase(), WETH.toLowerCase());
  assert.equal(got.initiator.toLowerCase(), OP.toLowerCase());
});

test("provider ordinals decode to names, unknown ones are named not hidden", () => {
  assert.equal(providerName(0), "Morpho");
  assert.equal(providerName(1), "BalancerV2");
  assert.equal(providerName(2), "BalancerV3");
  assert.equal(providerName(7), "provider#7");
});

test("ignores an ArbExecuted topic emitted by a different contract", () => {
  // A router could in principle emit a matching topic; only the executor's own
  // log is authoritative about settlement.
  const fromOther = settleLog(5n, 99n, 0, OTHER);
  const fromExecutor = settleLog(1_000n, 42n, 0, EXECUTOR);
  const got = decodeSettlement([fromOther, fromExecutor], EXECUTOR);
  assert.ok(got);
  assert.equal(got.profit, 42n);
});

test("returns null when no settlement is present", () => {
  assert.equal(decodeSettlement([], EXECUTOR), null);
  const unrelated: RpcLog = {
    address: EXECUTOR,
    topics: [keccak256(toHex("SomethingElse(uint256)"))],
    data: encodeAbiParameters([{ type: "uint256" }], [1n]),
  };
  assert.equal(decodeSettlement([unrelated], EXECUTOR), null);
});

test("tolerates a malformed log without throwing", () => {
  const bad: RpcLog = { address: EXECUTOR, topics: [TOPIC0], data: "0x00" };
  assert.equal(decodeSettlement([bad], EXECUTOR), null);
});

test("projection gap is signed", () => {
  // Settled above projection: positive.
  assert.equal(projectionGap(100n, 120n), 20n);
  // Settled below: negative, which is the case worth flagging.
  assert.equal(projectionGap(100n, 80n), -20n);
  assert.equal(projectionGap(100n, 100n), 0n);
});

// --- journal ---------------------------------------------------------------

test("journal is inert when disabled", () => {
  const j = new Journal(null);
  assert.equal(j.enabled, false);
  // Must not throw even with no path.
  j.write({ kind: "failed", ts: "t", reason: "x" });
});

test("openJournal treats unset and blank paths as disabled", () => {
  assert.equal(openJournal(undefined).enabled, false);
  assert.equal(openJournal("").enabled, false);
  assert.equal(openJournal("   ").enabled, false);
  assert.equal(openJournal("/tmp/x.jsonl").enabled, true);
});

test("journal appends one self-describing JSON line per record", () => {
  const path = join(__dirname, `journal-test-${process.pid}.jsonl`);
  const j = openJournal(path);
  j.write({
    kind: "scan",
    ts: "2026-01-01T00:00:00.000Z",
    block: 123,
    venues: 6,
    bestMarginWei: "-366000000000000",
    bestFirst: "slipstream-new-ts50",
    bestSecond: "uniswap-v3-0.01%",
    candidates: 0,
    quoteMs: 316,
  });
  j.write({
    kind: "settled",
    ts: "2026-01-01T00:00:01.000Z",
    label: "a -> b",
    txHash: "0xabc",
    loanAmountWei: "1000",
    projectedNetWei: "100",
    settledProfitWei: "80",
    gapWei: "-20",
    provider: "Morpho",
    gasUsed: "21000",
    blockNumber: "123",
  });

  const lines = readFileSync(path, "utf8").trim().split("\n");
  assert.equal(lines.length, 2);
  const first = JSON.parse(lines[0]!);
  assert.equal(first.kind, "scan");
  assert.equal(first.venues, 6);
  // Amounts are decimal strings, not numbers: a wei value overflows a double.
  assert.equal(typeof first.bestMarginWei, "string");
  const second = JSON.parse(lines[1]!);
  assert.equal(second.kind, "settled");
  assert.equal(second.gapWei, "-20");

  // Append, not overwrite: a second writer to the same path adds lines.
  const j2 = openJournal(path);
  j2.write({ kind: "failed", ts: "t", reason: "rpc down" });
  assert.equal(readFileSync(path, "utf8").trim().split("\n").length, 3);

  if (existsSync(path)) unlinkSync(path);
});

/**
 * Pin the exact record shapes `execute.ts` writes, including the refusal path.
 *
 * These are the shapes the summary script parses. A field renamed in one place
 * and not the other would make a run look empty rather than fail, so the round
 * trip is asserted rather than assumed.
 */
test("journal round-trips the simulate and failed records execute.ts emits", () => {
  const path = join(__dirname, `journal-shapes-${process.pid}.jsonl`);
  const j = openJournal(path);

  const refused = {
    kind: "simulate" as const,
    ts: "2026-01-01T00:00:00.000Z",
    block: 100,
    label: "slipstream-new-ts50 -> aerodrome-volatile",
    loanAmountWei: "1000000000000000000",
    projectedGrossWei: "5000000000000000",
    projectedNetWei: "0",
    gasUnits: "0",
    gasCostWei: "0",
    ok: false,
    refusal: "InsufficientProfit",
  };
  const accepted = {
    kind: "simulate" as const,
    ts: "2026-01-01T00:00:02.000Z",
    block: 101,
    label: "slipstream-new-ts50 -> aerodrome-volatile",
    loanAmountWei: "2000000000000000000",
    projectedGrossWei: "8000000000000000",
    projectedNetWei: "7000000000000000",
    gasUnits: "210000",
    gasCostWei: "1000000000000000",
    ok: true,
    refusal: null,
  };
  j.write(refused);
  j.write(accepted);
  j.write({ kind: "failed", ts: "2026-01-01T00:00:03.000Z", label: "x -> y", reason: "rpc down" });

  const lines = readFileSync(path, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.equal(lines.length, 3);
  assert.equal(lines[0].refusal, "InsufficientProfit");
  assert.equal(lines[1].ok, true);
  assert.equal(lines[1].refusal, null);
  assert.equal(lines[2].kind, "failed");

  if (existsSync(path)) unlinkSync(path);
});
