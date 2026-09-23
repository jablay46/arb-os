/**
 * Batched JSON-RPC client.
 *
 * The scan loop needs dozens of pool reads per tick, so collapsing them into
 * one HTTP round trip is the difference between a usable scan rate and one
 * throttled by request latency. JSON-RPC batching is used rather than
 * Multicall3 because QuoterV2 cannot be multicalled: it returns its result by
 * *reverting*, which would revert an enclosing multicall.
 */

export interface RpcCall {
  to: string;
  data: string;
}

export interface RpcOptions {
  /** Block tag or number. Pin to one block so every leg prices the same state. */
  block?: string | number;
  timeoutMs?: number;
  maxRetries?: number;
}

/** A per-call failure (reverted call, bad params). Distinct from transport failure. */
export class CallReverted extends Error {}

export class RpcTransportError extends Error {}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class RpcClient {
  private id = 0;

  constructor(
    readonly url: string,
    private readonly defaultTimeoutMs = 20_000,
    private readonly defaultMaxRetries = 4,
  ) {}

  /** Single eth_call, returning raw hex or null when the call reverted. */
  async ethCall(call: RpcCall, opts: RpcOptions = {}): Promise<string | null> {
    const [out] = await this.ethCalls([call], opts);
    return out;
  }

  /**
   * Batch of eth_calls. Returns one entry per call, in order: hex on success,
   * null when that individual call reverted.
   *
   * A reverted call is a normal, expected outcome here -- a QuoterV2 call for
   * a trade larger than the pool's liquidity reverts, and the scan should skip
   * that size rather than abort the tick. Transport-level failures are
   * different and are retried, then thrown, because a silently empty batch
   * would look exactly like "no opportunities found".
   */
  async ethCalls(calls: RpcCall[], opts: RpcOptions = {}): Promise<(string | null)[]> {
    if (calls.length === 0) return [];

    const block = opts.block ?? "latest";
    const blockTag = typeof block === "number" ? `0x${block.toString(16)}` : block;
    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;
    const maxRetries = opts.maxRetries ?? this.defaultMaxRetries;

    const payload = calls.map((c) => ({
      jsonrpc: "2.0",
      id: this.id++,
      method: "eth_call",
      params: [{ to: c.to, data: c.data }, blockTag],
    }));

    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        // Exponential backoff with jitter: a throttled provider recovers, and
        // retrying instantly just deepens the throttle.
        const backoff = Math.min(200 * 2 ** (attempt - 1), 4_000);
        await sleep(backoff + Math.random() * 200);
      }
      try {
        const res = await fetch(this.url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(timeoutMs),
        });

        if (res.status === 429 || res.status >= 500) {
          lastError = new RpcTransportError(`HTTP ${res.status}`);
          continue;
        }
        if (!res.ok) {
          throw new RpcTransportError(`HTTP ${res.status} ${await res.text()}`);
        }

        const body = (await res.json()) as
          | { id: number; result?: string; error?: { code: number; message: string } }[]
          | { error?: { message: string } };

        if (!Array.isArray(body)) {
          // Providers may answer a batch with a single error object.
          throw new RpcTransportError(body.error?.message ?? "non-array batch response");
        }

        const byId = new Map(body.map((r) => [r.id, r]));
        return payload.map((p) => {
          const r = byId.get(p.id);
          if (!r) throw new RpcTransportError(`missing response for id ${p.id}`);
          if (r.error) return null; // reverted / unquotable call
          return r.result ?? null;
        });
      } catch (e) {
        if (e instanceof RpcTransportError && !String(e.message).startsWith("HTTP 429") &&
            !String(e.message).startsWith("HTTP 5")) {
          throw e; // a real protocol error, not worth retrying
        }
        lastError = e as Error;
      }
    }
    throw new RpcTransportError(
      `batch of ${calls.length} eth_calls failed after ${maxRetries + 1} attempts: ${lastError?.message}`,
    );
  }

  /** Latest block number. */
  async blockNumber(opts: { timeoutMs?: number } = {}): Promise<number> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: this.id++, method: "eth_blockNumber", params: [] }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? this.defaultTimeoutMs),
    });
    const body = (await res.json()) as { result?: string; error?: { message: string } };
    if (!body.result) throw new RpcTransportError(body.error?.message ?? "no block number");
    return Number(BigInt(body.result));
  }

  /** Chain id, used as a cheap liveness and wrong-endpoint check at startup. */
  async chainId(opts: { timeoutMs?: number } = {}): Promise<number> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: this.id++, method: "eth_chainId", params: [] }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? this.defaultTimeoutMs),
    });
    const body = (await res.json()) as { result?: string; error?: { message: string } };
    if (!body.result) throw new RpcTransportError(body.error?.message ?? "no chain id");
    return Number(BigInt(body.result));
  }
}
