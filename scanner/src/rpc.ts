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
export class CallReverted extends Error {
  constructor(
    /** Hex revert payload, `0x` when the provider gave us nothing decodable. */
    readonly data: string = "0x",
    message?: string,
  ) {
    super(message ?? `call reverted (${data.slice(0, 10)})`);
    this.name = "CallReverted";
  }
}

export class RpcTransportError extends Error {}

/** A transport failure worth retrying: throttling, a 5xx, or a provider hiccup. */
export class RetryableRpcError extends RpcTransportError {}

/** JSON-RPC `execution reverted`, as both viem and the Base endpoint report it. */
const REVERT_CODE = 3;

/**
 * Whether a per-call JSON-RPC error means "this call reverted" as opposed to a
 * provider-level failure.
 *
 * The distinction is load-bearing. A reverted `eth_call` is normal -- a
 * QuoterV2 call for more than the pool holds reverts, and the scan should skip
 * that size. But a provider error returned in the same shape (Base answers a
 * throttled batch with HTTP 200 and `{"code":-32016,"message":"over rate
 * limit"}`) must NOT be mistaken for a revert, or a scan that read nothing
 * reports "no opportunities" and looks exactly like a quiet market. Only an
 * explicit revert is treated as one; everything else is raised.
 */
function isRevertError(err: { code: number; message?: string }): boolean {
  if (err.code === REVERT_CODE) return true;
  return /revert/i.test(err.message ?? "");
}

/**
 * Revert payload from a JSON-RPC error, as hex, so the caller can decode a
 * custom error from it.
 *
 * Providers differ in where they put it: some mirror geth and nest it under
 * `data`, others (and Base's endpoint) inline the whole payload in the message
 * as `execution reverted: 0x...`. Both shapes are handled, because an
 * undecoded `InsufficientProfit` is the difference between "the route lost
 * money" and "something is broken".
 */
function encodeErrorData(err: { message?: string; data?: string }): string {
  if (err.data && /^0x[0-9a-fA-F]*$/.test(err.data) && err.data.length >= 10) {
    return err.data;
  }
  const match = err.message?.match(/0x[0-9a-fA-F]{8,}/);
  return match ? match[0] : "0x";
}

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
    // `ethCalls` returns one entry per call, so `out` is always present here;
    // `noUncheckedIndexedAccess` cannot know that, and null keeps the declared
    // return honest rather than widening it with undefined.
    return out ?? null;
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
          lastError = new RetryableRpcError(`HTTP ${res.status}`);
          continue;
        }
        if (!res.ok) {
          throw new RpcTransportError(`HTTP ${res.status} ${await res.text()}`);
        }

        const body = (await res.json()) as
          | { id: number; result?: string; error?: { code: number; message: string } }[]
          | { error?: { code?: number; message?: string } };

        if (!Array.isArray(body)) {
          // Providers may answer a batch with a single error object. A
          // throttle sometimes arrives this way, so retry it rather than
          // letting it surface as a failed batch.
          throw new RetryableRpcError(body.error?.message ?? "non-array batch response");
        }

        const byId = new Map(body.map((r) => [r.id, r]));
        return payload.map((p) => {
          const r = byId.get(p.id);
          if (!r) throw new RetryableRpcError(`missing response for id ${p.id}`);
          if (r.error) {
            // A real revert is the scan's normal "skip this size" signal.
            // Anything else is a provider failure wearing the same shape
            // (Base reports throttling as code -32016 with HTTP 200), and
            // swallowing it as `null` would make a throttled scan look like a
            // market with no opportunities.
            if (isRevertError(r.error)) return null;
            throw new RetryableRpcError(
              `provider error ${r.error.code}: ${r.error.message}`,
            );
          }
          return r.result ?? null;
        });
      } catch (e) {
        if (e instanceof RpcTransportError && !(e instanceof RetryableRpcError)) {
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

  /**
   * Current L2 gas price in wei.
   *
   * Used for cost accounting, so a zero or malformed answer is thrown rather
   * than returned: a gas price of zero would make every candidate look
   * profitable.
   */
  async gasPrice(opts: { timeoutMs?: number } = {}): Promise<bigint> {
    const res = await fetch(this.url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: this.id++, method: "eth_gasPrice", params: [] }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? this.defaultTimeoutMs),
    });
    const body = (await res.json()) as { result?: string; error?: { message: string } };
    if (!body.result) throw new RpcTransportError(body.error?.message ?? "no gas price");
    return BigInt(body.result);
  }

  // -------------------------------------------------------------------
  // Write-path reads and submission
  // -------------------------------------------------------------------
  //
  // The methods below exist for the execution bot. They share one retrying
  // single-call transport so a throttled provider is retried rather than
  // surfacing as a failed trade -- except for `sendRawTransaction`, which is
  // deliberately NOT retried here: a retry of a submission that actually
  // landed would be a double-spend attempt, and nonce reuse makes the second
  // attempt fail anyway. Submission errors are the caller's to classify.

  /** One JSON-RPC call with retry on throttling and 5xx. */
  private async single<T>(method: string, params: unknown[], timeoutMs?: number): Promise<T> {
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= this.defaultMaxRetries; attempt++) {
      if (attempt > 0) {
        const backoff = Math.min(200 * 2 ** (attempt - 1), 4_000);
        await sleep(backoff + Math.random() * 200);
      }
      try {
        const res = await fetch(this.url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: this.id++, method, params }),
          signal: AbortSignal.timeout(timeoutMs ?? this.defaultTimeoutMs),
        });
        if (res.status === 429 || res.status >= 500) {
          lastError = new RetryableRpcError(`HTTP ${res.status}`);
          continue;
        }
        if (!res.ok) throw new RpcTransportError(`HTTP ${res.status} ${await res.text()}`);

        const body = (await res.json()) as {
          result?: T;
          error?: { code: number; message: string; data?: string };
        };
        if (body.error) {
          // A revert here is a legitimate answer for eth_call/estimateGas; the
          // caller decides. Provider throttling is retryable instead.
          if (isRevertError(body.error)) {
            throw new CallReverted(encodeErrorData(body.error));
          }
          throw new RetryableRpcError(`provider error ${body.error.code}: ${body.error.message}`);
        }
        return body.result as T;
      } catch (e) {
        if (e instanceof CallReverted) throw e;
        if (e instanceof RpcTransportError && !(e instanceof RetryableRpcError)) throw e;
        lastError = e as Error;
      }
    }
    throw new RpcTransportError(`${method} failed after ${this.defaultMaxRetries + 1} attempts: ${lastError?.message}`);
  }

  /**
   * `eth_call` with a `from` field, returning raw hex.
   *
   * Needed for simulation: the executor's `onlyRole(OPERATOR_ROLE)` check reads
   * `msg.sender`, so a simulation without `from` would revert with an
   * authorization error that says nothing about whether the trade makes money.
   * Throws `CallReverted` (carrying the revert data) rather than returning null,
   * because for a simulation a revert *is* the answer.
   */
  async callFrom(args: {
    to: string;
    data: string;
    from: string;
    block?: number | string;
  }): Promise<string> {
    const blockTag =
      args.block === undefined
        ? "latest"
        : typeof args.block === "number"
          ? `0x${args.block.toString(16)}`
          : args.block;
    return this.single<string>(
      "eth_call",
      [{ to: args.to, data: args.data, from: args.from }, blockTag],
      60_000,
    );
  }

  /** `eth_getCode`; `0x` or `0x0` means no contract. */
  async getCode(addr: string, block: number | string = "latest"): Promise<string> {
    const blockTag =
      typeof block === "number" ? `0x${block.toString(16)}` : block;
    return this.single<string>("eth_getCode", [addr, blockTag]);
  }

  /** `eth_estimateGas`; throws `CallReverted` when the call would fail. */
  async estimateGas(tx: {
    from: string;
    to: string;
    data: string;
  }): Promise<bigint> {
    const hex = await this.single<string>("eth_estimateGas", [tx]);
    return BigInt(hex);
  }

  /** Transaction count for an address, used for the next nonce. */
  async getTransactionCount(addr: string, block: number | string = "pending"): Promise<number> {
    const blockTag = typeof block === "number" ? `0x${block.toString(16)}` : block;
    const hex = await this.single<string>("eth_getTransactionCount", [addr, blockTag]);
    return Number(BigInt(hex));
  }

  /** Latest block header, for `baseFeePerGas`. */
  async getLatestBlock(): Promise<{ number: number; baseFeePerGas: bigint }> {
    const b = await this.single<{ number: string; baseFeePerGas?: string }>(
      "eth_getBlockByNumber",
      ["latest", false],
    );
    return {
      number: Number(BigInt(b.number)),
      baseFeePerGas: b.baseFeePerGas ? BigInt(b.baseFeePerGas) : 0n,
    };
  }

  /**
   * Broadcast a signed raw transaction. Deliberately single-shot: see the note
   * above. Returns the transaction hash.
   */
  async sendRawTransaction(raw: `0x${string}`): Promise<`0x${string}`> {
    try {
      const res = await fetch(this.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: this.id++,
          method: "eth_sendRawTransaction",
          params: [raw],
        }),
        signal: AbortSignal.timeout(this.defaultTimeoutMs),
      });
      const body = (await res.json()) as {
        result?: `0x${string}`;
        error?: { code: number; message: string; data?: string };
      };
      if (body.error) {
        throw new RpcTransportError(`sendRawTransaction: ${body.error.code} ${body.error.message}`);
      }
      if (!body.result) throw new RpcTransportError("sendRawTransaction returned no hash");
      return body.result;
    } catch (e) {
      if (e instanceof RpcTransportError) throw e;
      throw new RpcTransportError(`sendRawTransaction transport failure: ${(e as Error).message}`);
    }
  }

  /** Receipt for a transaction hash, or null while it is still pending. */
  async getTransactionReceipt(hash: string): Promise<{
    status: string;
    blockNumber: string;
    gasUsed: string;
    transactionHash: string;
  } | null> {
    return this.single(
      "eth_getTransactionReceipt",
      [hash],
    );
  }
}
