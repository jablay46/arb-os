/**
 * Append-only JSONL journal of what the bot saw and decided.
 *
 * The question a long simulate run has to answer is "does anything real exist
 * here?", and a console log cannot answer it: it is lossy (a `.` per quiet
 * block), it dies with the terminal, and it cannot be counted. A JSONL file is
 * one line per event, append-only, so a run that is killed mid-flight keeps
 * everything written so far, and any editor or `jq` can summarise it.
 *
 * Deliberately dumb: no rotation, no schema versioning, no batching. It opens a
 * file, appends a line, flushes. The cost of a write is nothing next to the RPC
 * calls in a scan, so simplicity wins.
 *
 * What is never written: the RPC URL (it carries an API key), the private key,
 * or calldata. Addresses and amounts are public chain data.
 */

import { appendFileSync } from "node:fs";

/** One observation. Every record carries `kind` and `ts` so lines are self-describing. */
export type JournalRecord =
  | {
      kind: "scan";
      ts: string;
      block: number;
      /** Venues actually quoted this tick. */
      venues: number;
      /** Best signed spread seen, in wei; null when nothing was quotable. */
      bestMarginWei: string | null;
      /** Best sign/venue pair, for context. */
      bestFirst: string | null;
      bestSecond: string | null;
      /** Candidates that cleared `minProfit`. */
      candidates: number;
      /** Milliseconds spent quoting. */
      quoteMs: number;
    }
  | {
      kind: "simulate";
      ts: string;
      block: number;
      label: string;
      loanAmountWei: string;
      projectedGrossWei: string;
      projectedNetWei: string;
      gasUnits: string;
      gasCostWei: string;
      /** null when the executor refused the route. */
      ok: boolean;
      /** Set when refused: the decoded error name, or "unknown". */
      refusal: string | null;
    }
  | {
      kind: "settled";
      ts: string;
      label: string;
      txHash: string;
      loanAmountWei: string;
      projectedNetWei: string;
      /** Profit measured on chain from `ArbExecuted`. */
      settledProfitWei: string;
      /** `settled - projected`; negative means the projection was optimistic. */
      gapWei: string;
      provider: string;
      gasUsed: string;
      blockNumber: string;
    }
  | {
      kind: "failed";
      ts: string;
      label?: string;
      reason: string;
    };

export class Journal {
  constructor(private readonly path: string | null) {}

  /** True when a path was configured; callers can skip building records otherwise. */
  get enabled(): boolean {
    return this.path !== null;
  }

  /**
   * Append one record. A journal write must never take down the bot: the bot's
   * job is to find opportunities, and losing a log line is not a reason to stop
   * trading. Errors are reported once per write and swallowed.
   */
  write(record: JournalRecord): void {
    if (this.path === null) return;
    try {
      appendFileSync(this.path, `${JSON.stringify(record)}\n`, "utf8");
    } catch (e) {
      console.error(`  warning: could not write journal: ${(e as Error).message}`);
    }
  }
}

/**
 * Open the journal named by `JOURNAL_FILE`, or a disabled one when unset.
 *
 * Unset rather than defaulted-on means an ordinary `--once` run writes no files,
 * so adding this did not change the behaviour of the existing commands.
 */
export function openJournal(path: string | undefined): Journal {
  const trimmed = path?.trim();
  return new Journal(trimmed ? trimmed : null);
}
