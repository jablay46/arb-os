/**
 * Tests for how the batched RPC client classifies a per-call JSON-RPC error.
 *
 * The distinction under test: a reverted `eth_call` is the scan's normal "skip
 * this size" signal, but a provider error returned in the same shape must not
 * be swallowed. Base answers a throttled batch with HTTP 200 and
 * `{"code":-32016,"message":"over rate limit"}`; treating that as a revert
 * makes a scan that read nothing look like a market with no opportunities.
 *
 * These tests stub `fetch`, so they run offline and exercise the real retry
 * loop rather than a mock of it.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { RpcClient, RetryableRpcError, RpcTransportError } from "../src/rpc.js";

const CALL = { to: "0x0000000000000000000000000000000000000001", data: "0x" };

/** Replace global fetch for the duration of one test, restoring it after. */
async function withFetch(
  handler: (init: RequestInit) => Response | Promise<Response>,
  body: () => Promise<void>,
) {
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: unknown, init?: RequestInit) => handler(init!)) as typeof fetch;
  try {
    await body();
  } finally {
    globalThis.fetch = original;
  }
}

/** A batch response containing one explicit revert. */
function revertResponse(): Response {
  return new Response(
    JSON.stringify([{ jsonrpc: "2.0", id: 0, error: { code: 3, message: "execution reverted" } }]),
    { status: 200 },
  );
}

/** A batch response containing one throttling error, as Base actually sends it. */
function throttleResponse(id = 0): Response {
  return new Response(
    JSON.stringify([{ jsonrpc: "2.0", id, error: { code: -32016, message: "over rate limit" } }]),
    { status: 200 },
  );
}

test("an explicit revert maps to null, not an error", async () => {
  const rpc = new RpcClient("http://unused", 1000, 1);
  await withFetch(revertResponse, async () => {
    const [out] = await rpc.ethCalls([CALL]);
    assert.equal(out, null, "a reverted call is a normal skip signal");
  });
});

test("throttling is retried, and succeeds once the provider recovers", async () => {
  const rpc = new RpcClient("http://unused", 1000, 3);
  let calls = 0;
  await withFetch(
    () => {
      calls += 1;
      if (calls === 1) return throttleResponse();
      return new Response(
        JSON.stringify([{ jsonrpc: "2.0", id: 0, result: "0xdeadbeef" }]),
        { status: 200 },
      );
    },
    async () => {
      const [out] = await rpc.ethCalls([CALL]);
      assert.equal(out, "0xdeadbeef", "the retry must return the real value");
      assert.equal(calls, 2, "the throttle must have triggered exactly one retry");
    },
  );
});

test("a throttle that never clears is thrown, not reported as an empty result", async () => {
  const rpc = new RpcClient("http://unused", 1000, 1);
  let calls = 0;
  await withFetch(
    () => {
      calls += 1;
      return throttleResponse();
    },
    async () => {
      await assert.rejects(
        () => rpc.ethCalls([CALL]),
        (e: Error) => e instanceof RpcTransportError,
        "a throttled scan must fail loudly rather than look like a quiet market",
      );
      assert.equal(calls, 2, "initial attempt plus one retry");
    },
  );
});

test("a batched non-array provider error is retried, not surfaced raw", async () => {
  const rpc = new RpcClient("http://unused", 1000, 2);
  let calls = 0;
  await withFetch(
    () => {
      calls += 1;
      if (calls === 1) {
        return new Response(
          JSON.stringify({ error: { code: -32016, message: "over rate limit" } }),
          { status: 200 },
        );
      }
      return new Response(
        JSON.stringify([{ jsonrpc: "2.0", id: 0, result: "0x01" }]),
        { status: 200 },
      );
    },
    async () => {
      const [out] = await rpc.ethCalls([CALL]);
      assert.equal(out, "0x01");
    },
  );
});

test("a non-throttle protocol error is raised without burning retries", async () => {
  const rpc = new RpcClient("http://unused", 1000, 3);
  let calls = 0;
  await withFetch(
    () => {
      calls += 1;
      return new Response("bad request", { status: 400 });
    },
    async () => {
      await assert.rejects(() => rpc.ethCalls([CALL]), (e: Error) => e instanceof RpcTransportError);
      assert.equal(calls, 1, "a 400 will not improve on retry");
    },
  );
});

test("a retryable error is distinguishable from a fatal one", () => {
  const retryable = new RetryableRpcError("over rate limit");
  assert.ok(retryable instanceof RpcTransportError, "retryable is a transport error");
  assert.ok(!(new RpcTransportError("HTTP 400") instanceof RetryableRpcError));
});
