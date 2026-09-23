/**
 * End-to-end test of the net-profit gate against a live-fork dislocation.
 *
 * This is the test that distinguishes a working scanner from a plausible one.
 * The unit tests prove the arithmetic and the integration tests prove the RPC
 * reads, but neither proves that a real, large spread is admitted and that a
 * thin one is rejected. Those are the two behaviours an operator actually
 * depends on, and they only exist end to end.
 *
 * The dislocation is manufactured on an Anvil fork for determinism: a fixed
 * dump into the 0.01% pool, then scan. Requires BASE_RPC_URL for the initial
 * fork. Skipped otherwise.
 *
 * Run: BASE_RPC_URL=https://... npx tsx --test scanner/test/net.e2e.test.ts
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { encodeFunctionData } from "viem";

import { RpcClient } from "../src/rpc.js";
import { ADDR, loadConfig } from "../src/config.js";
import { buildVenue } from "../src/venues.js";
import { scanVenues, rankedOpportunities } from "../src/discovery.js";
import {
  fetchGasPrice,
  fetchL1FeeUpperBound,
  gasCost,
  pickBestNet,
  DRY_RUN_GAS_UNITS,
} from "../src/gas.js";

const rpcUrl = process.env.BASE_RPC_URL;
const skip = rpcUrl ? false : "BASE_RPC_URL not set";

const IMPERSONATED = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266";

/** The 0.01% WETH/USDC pool, deliberately thin relative to the dump. */
const THIN_POOL = "0xd0b53D9277642d899DF5C87A3966A349A798F224";

let anvil: ChildProcess | null = null;
let forkRpc = "";

/**
 * Recent anvil output, kept for the "not mined" error.
 *
 * anvil used to be spawned with `stdio: "ignore"`, so the message that was
 * supposed to carry its output had nothing to carry -- and referenced an
 * undefined helper besides. Capturing stderr is what makes that message
 * diagnostic instead of decorative: a failed fork fetch or a rejected
 * transaction shows up here, not in the test's own assertions.
 */
const anvilOutput: string[] = [];

function anvilLog(): string {
  return anvilOutput.join("").trim() || "(anvil produced no output)";
}

function captureAnvil(stream: NodeJS.ReadableStream | null): void {
  stream?.on("data", (chunk: Buffer) => {
    anvilOutput.push(chunk.toString());
    // Only the tail matters, and a --silent anvil that hits a bad block can
    // otherwise grow this without bound over a long run.
    if (anvilOutput.length > 200) anvilOutput.shift();
  });
}

/**
 * Pick a free port instead of hard-coding one.
 *
 * A fixed port makes this test silently talk to whatever else is listening on
 * it. That failure is nasty: anvil refuses to start with "Address already in
 * use", the test's RPC calls go to the *other* anvil, and the symptom is a
 * transaction that "was not mined" -- which looks like an anvil or viem bug
 * rather than a port collision.
 */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (typeof addr === "object" && addr) {
        const port = addr.port;
        srv.close(() => resolve(port));
      } else {
        srv.close(() => reject(new Error("could not determine a free port")));
      }
    });
  });
}

async function waitForRpc(rpc: RpcClient, attempts = 60): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    try {
      const id = await rpc.chainId();
      if (id === 8453) return;
      throw new Error(`fork reports chainId ${id}, expected 8453`);
    } catch {
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  throw new Error(`anvil did not become ready on ${forkRpc}\n--- anvil output ---\n${anvilLog()}`);
}

before(async () => {
  if (!rpcUrl) return;
  const port = await freePort();
  forkRpc = `http://127.0.0.1:${port}`;
  // No --silent: it suppresses exactly the fetch and revert errors that the
  // failure messages below exist to surface. The buffer is bounded, so noise
  // costs nothing unless a test actually fails.
  anvil = spawn("anvil", ["--fork-url", rpcUrl, "--port", String(port)], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  captureAnvil(anvil.stdout);
  captureAnvil(anvil.stderr);
  await waitForRpc(new RpcClient(forkRpc));
});

after(() => {
  anvil?.kill();
});

/** Send a raw JSON-RPC call, since the scanner's client only does reads. */
async function rpcCall<T = unknown>(method: string, params: unknown[]): Promise<T> {
  const res = await fetch(forkRpc, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const body = (await res.json()) as { result?: T; error?: { message: string } };
  if (body.error) throw new Error(`${method}: ${body.error.message}`);
  return body.result as T;
}

/**
 * Force a block, so a tx is definitely included before the next read.
 *
 * Relying on anvil's auto-mining left transactions sitting in no block: the
 * approve would land and the swap would not, which looks like a viem or anvil
 * bug. Asking for a block explicitly removes the ambiguity.
 */
async function mine(): Promise<void> {
  await rpcCall("anvil_mine", ["0x1"]);
}

/** Wait for a transaction to be mined, so the next scan sees its effect. */
async function waitForReceipt(hash: string, attempts = 40): Promise<void> {
  for (let i = 0; i < attempts; i++) {
    const receipt = await rpcCall<{ status?: string } | null>("eth_getTransactionReceipt", [hash]);
    if (receipt) {
      if (receipt.status !== "0x1") throw new Error(`tx ${hash} reverted`);
      return;
    }
    await mine();
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`tx ${hash} was not mined.\n--- anvil output ---\n${anvilLog()}`);
}

const ROUTER_EXACT_INPUT_ABI = [
  {
    type: "function",
    name: "exactInputSingle",
    stateMutability: "payable",
    inputs: [
      {
        name: "params",
        type: "tuple",
        components: [
          { name: "tokenIn", type: "address" },
          { name: "tokenOut", type: "address" },
          { name: "fee", type: "uint24" },
          { name: "recipient", type: "address" },
          { name: "amountIn", type: "uint256" },
          { name: "amountOutMinimum", type: "uint256" },
          { name: "sqrtPriceLimitX96", type: "uint160" },
        ],
      },
    ],
    outputs: [{ type: "uint256" }],
  },
] as const;

/**
 * Manufacture a large dislocation: dump `weth` into the thin 0.01% pool.
 *
 * The size is chosen to be violent on purpose. A subtle dislocation would make
 * a passing test ambiguous -- it could be passing because the gate works or
 * because nothing was found.
 */
async function manufactureDislocation(weth: bigint): Promise<void> {
  // WETH balance slot 3, verified by probe against Base.
  const slot = BigInt(
    "0xc651ee22c6951bb8b5bd29e8210fb394645a94315fe10eff2cc73de1aa75c137",
  );
  await rpcCall("anvil_setStorageAt", [
    ADDR.WETH,
    `0x${slot.toString(16).padStart(64, "0")}`,
    `0x${(10n ** 21n).toString(16).padStart(64, "0")}`,
  ]);
  await rpcCall("anvil_impersonateAccount", [IMPERSONATED]);
  await rpcCall("anvil_setBalance", [IMPERSONATED, "0x21e19e0c9bab2400000"]);

  // approve + swap, through anvil_sendTransaction with impersonation
  const approveData = encodeFunctionData({
    abi: [
      {
        type: "function",
        name: "approve",
        stateMutability: "nonpayable",
        inputs: [{ type: "address" }, { type: "uint256" }],
        outputs: [{ type: "bool" }],
      },
    ] as const,
    functionName: "approve",
    args: [ADDR.UNISWAP_V3_ROUTER02, weth * 3n],
  });
  const approveHash = await rpcCall<string>("eth_sendTransaction", [
    { from: IMPERSONATED, to: ADDR.WETH, data: approveData, gas: "0x989680" },
  ]);
  await waitForReceipt(approveHash);

  const swapData = encodeFunctionData({
    abi: ROUTER_EXACT_INPUT_ABI,
    functionName: "exactInputSingle",
    args: [
      {
        tokenIn: ADDR.WETH,
        tokenOut: ADDR.USDC,
        fee: 100, // the thin 0.01% pool
        recipient: IMPERSONATED,
        amountIn: weth,
        amountOutMinimum: 0n,
        sqrtPriceLimitX96: 0n,
      },
    ],
  });
  const swapHash = await rpcCall<string>("eth_sendTransaction", [
    { from: IMPERSONATED, to: ADDR.UNISWAP_V3_ROUTER02, data: swapData, gas: "0x1c9c380" },
  ]);
  await waitForReceipt(swapHash);
}

/** Scan the fork the way main.ts does, returning gross and gas cost. */
async function scanFork(config: ReturnType<typeof loadConfig>) {
  const rpc = new RpcClient(forkRpc);
  const block = await rpc.blockNumber();
  const venues = [];
  for (const v of config.venues) venues.push(await buildVenue(v, config.loanToken, rpc, block));

  const quotes = await scanVenues(rpc, venues, config.loanAmounts, block, config.maxBatchSize);
  const candidates = rankedOpportunities(config.loanAmounts, quotes, 0n);

  const gasPrice = await fetchGasPrice(rpc);
  const l1Fee = await fetchL1FeeUpperBound(rpc, config.chainId, block);
  assert.notEqual(l1Fee, null, "the L1 fee oracle must be readable");

  const gas = gasCost({
    gasUnits: DRY_RUN_GAS_UNITS,
    gasPriceWei: gasPrice,
    l1FeeWei: l1Fee!,
    loanToken: config.loanToken,
    wrappedNative: ADDR.WETH,
  });
  return { candidates, gas, venues, block };
}

test("a manufactured dislocation produces a net-positive candidate", { skip }, async () => {
  const config = loadConfig();
  await manufactureDislocation(300n * 10n ** 18n);
  const { candidates, gas } = await scanFork(config);

  assert.ok(candidates.length > 0, "the dislocation must produce at least one gross candidate");
  const top = candidates[0]!;
  const net = top.grossProfit - gas;
  assert.ok(
    net > 0n,
    `top candidate must be net-positive: gross ${top.grossProfit} - gas ${gas} = ${net}`,
  );

  // "Net-positive" has to mean the gate admits it, not just that the arithmetic
  // works out. A candidate that clears zero but not the configured floor is
  // still not a trade.
  const admitted = pickBestNet(
    [{ opportunity: top, outcome: { kind: "priced", gas } }],
    config.minProfit,
  );
  assert.notEqual(
    admitted,
    null,
    `net ${net} must clear the minProfit floor ${config.minProfit}`,
  );
});

test("a real gas cost is non-zero, so the gate has something to subtract", { skip }, async () => {
  const config = loadConfig();
  const { gas } = await scanFork(config);
  assert.ok(gas > 0n, `gas cost must be positive, got ${gas}`);
  // Both terms are present: gas price alone would leave the L1 term at zero.
  const rpc = new RpcClient(forkRpc);
  const gasPrice = await fetchGasPrice(rpc);
  assert.ok(gas > DRY_RUN_GAS_UNITS * gasPrice, "the L1 data fee must be included on top of L2 gas");
});

test("the net gate rejects a candidate its gross would pass", { skip }, async () => {
  // The load-bearing assertion, and the one that would have caught the bug
  // this module exists to fix.
  //
  // `rankedOpportunities` filters on GROSS; `pickBestNet` filters on NET. So
  // the way to prove the net gate is real is to take the top candidate, set
  // minProfit between its net and its gross, and check that the two functions
  // disagree. If they agree, one of them is filtering on the wrong number.
  const config = loadConfig();
  const rpc = new RpcClient(forkRpc);
  const block = await rpc.blockNumber();
  const venues = [];
  for (const v of config.venues) venues.push(await buildVenue(v, config.loanToken, rpc, block));
  const quotes = await scanVenues(rpc, venues, config.loanAmounts, block, config.maxBatchSize);

  const { gas } = await scanFork(config);
  const grossCandidates = rankedOpportunities(config.loanAmounts, quotes, 0n);
  assert.ok(grossCandidates.length > 0, "the dislocation must produce a gross candidate");
  const top = grossCandidates[0]!;
  const gross = top.grossProfit;
  const net = gross - gas;
  assert.ok(gross > net, "gas must be non-zero for this test to mean anything");

  // A threshold strictly between net and gross.
  const midpoint = net + (gross - net) / 2n;

  const grossPasses = rankedOpportunities(config.loanAmounts, quotes, midpoint);
  assert.ok(
    grossPasses.length > 0,
    "the gross filter must pass this candidate -- otherwise the fixture is wrong",
  );

  const netBest = pickBestNet(
    [{ opportunity: top, outcome: { kind: "priced", gas } }],
    midpoint,
  );
  assert.equal(
    netBest,
    null,
    `net ${net} is below the midpoint ${midpoint} while gross ${gross} is above it; ` +
      `a gate that compared gross would wrongly admit this trade`,
  );

  // And the same candidate survives when the threshold is at its net.
  const netAtNet = pickBestNet([{ opportunity: top, outcome: { kind: "priced", gas } }], net);
  assert.notEqual(netAtNet, null, "a threshold at net must admit the candidate");
});
