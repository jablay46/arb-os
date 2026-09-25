/**
 * Tests for the execution bot's encoding and safety gates.
 *
 * Offline: no network, no key, no RPC. The pieces tested here are exactly the
 * ones where a bug moves money quietly -- a mis-encoded route, a selector that
 * drifted from `Types.sol`, or a guard that let a losing trade through.
 *
 * The live path (simulation against a real executor) is covered by
 * `execute.integration.test.ts`, which needs an RPC and a deployed executor.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { keccak256, toHex, decodeAbiParameters, encodeAbiParameters, parseAbiParameters } from "viem";

import {
  EXECUTE_SELECTOR,
  Kind,
  LoanProvider,
  RouteMode,
  buildRoute,
  encodeExecute,
  encodePoolData,
  venueKind,
  type ExecutionRequest,
} from "../src/abi.js";
import { AerodromeVenue, SlipstreamVenue, UniswapV3Venue } from "../src/venues.js";
import {
  checkLiveGuards,
  assertLiveArmed,
  loadPrivateKey,
  redactRpcUrl,
  slipFloor,
  SafetyError,
} from "../src/safety.js";
import { decodeRevert, isExpectedRefusal, ERROR_ABI } from "../src/errors.js";
import { adapterEnvVar } from "../src/config.js";

const ADDR_WETH = "0x4200000000000000000000000000000000000006" as const;
const ADDR_USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
const ADDR_UNI_ADAPTER = "0x1111111111111111111111111111111111111111" as const;
const ADDR_AERO_ADAPTER = "0x2222222222222222222222222222222222222222" as const;
const ADDR_TREASURY = "0x3333333333333333333333333333333333333333" as const;
const AERO_FACTORY = "0x420DD381b31aEf6683db6B902084cB0FFECe40Da" as const;
const SLIP_FACTORY = "0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A" as const;

// `__dirname` rather than `import.meta`: tsconfig targets CommonJS output, so
// the ESM meta-property is not available here.
const REPO = join(__dirname, "..", "..");

// --- the cross-language pin ----------------------------------------------

/**
 * The `execute` selector must match the compiled Solidity.
 *
 * This is the test that matters most in this file. The first draft of `abi.ts`
 * carried a hand-written selector that was simply wrong; nothing caught it until
 * `cast` was asked. A wrong selector produces a call that reverts with no
 * recognisable error, which reads like a market problem rather than a typo.
 *
 * The selector is re-derived from the `Types.sol` struct signature and compared
 * against both the hardcoded constant and the compiled artifact, so drift in
 * either direction fails here rather than on chain.
 */
test("execute selector matches the Solidity struct layout", () => {
  // The canonical signature of the tuple, exactly as solc computes it.
  const signature =
    "execute((uint8,address,uint256,uint256,address,uint8,((address,address,address,uint256,uint256,uint8,bytes)[],uint256),(address,uint256,bytes)[]))";
  const derived = keccak256(toHex(signature)).slice(0, 10);

  assert.equal(
    derived,
    EXECUTE_SELECTOR,
    `EXECUTE_SELECTOR is stale: Solidity derives ${derived}, abi.ts says ${EXECUTE_SELECTOR}`,
  );
});

/**
 * The selector must also match what the compiler actually emitted.
 *
 * Deriving it from a string is only as good as the string. This reads the
 * artifact's `methodIdentifiers`, which is the compiler's own answer, so a
 * change to `Types.sol` that alters the tuple fails here even if nobody updates
 * the signature above.
 */
test("execute selector matches the compiled artifact", () => {
  const artifactPath = join(
    REPO,
    "out",
    "MorphoArbExecutor.sol",
    "MorphoArbExecutor.json",
  );

  let artifact: { methodIdentifiers?: Record<string, string> };
  try {
    artifact = JSON.parse(readFileSync(artifactPath, "utf8"));
  } catch {
    // The artifact only exists after `forge build`. Skipping is honest: the
    // string-derived test above still runs, and CI builds before testing.
    return;
  }

  const entry = Object.entries(artifact.methodIdentifiers ?? {}).find(([sig]) =>
    sig.startsWith("execute("),
  );
  assert.ok(entry, "no execute() found in the compiled artifact");
  const [, selector] = entry;
  assert.equal(
    `0x${selector}`,
    EXECUTE_SELECTOR,
    `artifact says 0x${selector}, abi.ts says ${EXECUTE_SELECTOR}`,
  );
});

/**
 * Every error the bot decodes must exist in `Errors.sol`.
 *
 * A typo in a signature makes `decodeRevert` fall through to "unrecognised
 * revert", which is how a clear `InsufficientProfit` turns into a mystery.
 */
test("error ABI names all match Errors.sol", () => {
  const sol = readFileSync(join(REPO, "src", "libraries", "Errors.sol"), "utf8");
  const declared = new Set(
    [...sol.matchAll(/error\s+(\w+)\s*\(/g)].map((m) => m[1]!),
  );
  const inAbi = new Set(
    ERROR_ABI.filter((e) => e.type === "error").map((e) => e.name),
  );

  for (const name of inAbi) {
    assert.ok(declared.has(name), `${name} is in ERROR_ABI but not in Errors.sol`);
  }
  for (const name of declared) {
    assert.ok(
      (inAbi as Set<string>).has(name),
      `${name} is declared in Errors.sol but not decodable`,
    );
  }
});

// --- poolData encodings ---------------------------------------------------

test("Uniswap V3 poolData encodes a uint24 fee, not a tick spacing", () => {
  const venue = new UniswapV3Venue("uniswap-v3-0.3%", ADDR_WETH, ADDR_USDC, 3000);
  const data = encodePoolData(venue);
  // A single uint24 is one 32-byte word, right-aligned.
  assert.equal(
    data,
    "0x0000000000000000000000000000000000000000000000000000000000000bb8",
  );
});

test("Slipstream poolData encodes (int24 tickSpacing, address factory)", () => {
  const venue = new SlipstreamVenue(
    "slipstream-old-ts100",
    ADDR_WETH,
    ADDR_USDC,
    100,
    "0x254cF9E1E6e233aa1AC962CB9B05b2cfeAaE15b0",
    SLIP_FACTORY,
  );
  const data = encodePoolData(venue);

  // Decoding it back with the adapter's own type list is the real assertion:
  // `(int24, address)` match means the adapter will read the right fields.
  const [ts, factory] = decodeTuple("int24, address", data);
  assert.equal(Number(ts), 100);
  assert.equal(String(factory).toLowerCase(), SLIP_FACTORY.toLowerCase());

  // This is the subtle part, and the assertion above is not enough on its own.
  // Decoding the same bytes as a V3 `uint24` does not throw -- viem ignores the
  // trailing word -- and yields *100*, the tick spacing read as a fee tier. So
  // a decoder that used the wrong type list would produce a valid-looking fee of
  // 100 (0.01%) for a pool whose real identity is ts=100. Silent, plausible,
  // wrong: the same shape of failure as the cross-generation quoter bug.
  const [asFee] = decodeTuple("uint24", data);
  assert.equal(
    Number(asFee),
    100,
    "the tick spacing decodes as a fee tier; this is why poolData must be typed per adapter",
  );
});

test("Aerodrome poolData encodes (bool stable, address factory)", () => {
  const venue = new AerodromeVenue(
    "aerodrome-volatile",
    ADDR_WETH,
    ADDR_USDC,
    "0x0000000000000000000000000000000000000099",
    false,
    30n,
    AERO_FACTORY,
  );
  const data = encodePoolData(venue);
  const [stable, factory] = decodeTuple("bool, address", data);
  assert.equal(stable, false);
  assert.equal(String(factory).toLowerCase(), AERO_FACTORY.toLowerCase());
});

test("venueKind maps each venue to its Solidity constant", () => {
  assert.equal(venueKind(new UniswapV3Venue("v3", ADDR_WETH, ADDR_USDC, 500)), Kind.UniswapV3);
  assert.equal(
    venueKind(
      new SlipstreamVenue("sl", ADDR_WETH, ADDR_USDC, 100, "0x00", SLIP_FACTORY),
    ),
    Kind.Slipstream,
  );
  assert.equal(
    venueKind(
      new AerodromeVenue("ae", ADDR_WETH, ADDR_USDC, "0x00", false, 30n),
    ),
    Kind.Aerodrome,
  );
});

/**
 * The adapter env var name must be derivable from the venue label.
 *
 * Found the hard way: `"uniswap-v3-0.05%"` ends in a non-alphanumeric character,
 * so a naive slug produced `ADAPTER_UNISWAP_V3_0_05_` with a trailing
 * underscore. The deploy script printed the same wrong name, both agreed, and
 * the venue silently fell out of the tradable set -- a configuration mistake
 * that produced no error at all. These are the exact names the deploy script
 * prints, so a change to one without the other fails here.
 */
test("adapter env var names match the documented slugs", () => {
  const cases: [string, string][] = [
    ["uniswap-v3-0.05%", "ADAPTER_UNISWAP_V3_0_05"],
    ["uniswap-v3-0.3%", "ADAPTER_UNISWAP_V3_0_3"],
    ["uniswap-v3-0.01%", "ADAPTER_UNISWAP_V3_0_01"],
    ["aerodrome-volatile", "ADAPTER_AERODROME_VOLATILE"],
    ["slipstream-old-ts100", "ADAPTER_SLIPSTREAM_OLD_TS100"],
    ["slipstream-new-ts50", "ADAPTER_SLIPSTREAM_NEW_TS50"],
  ];
  for (const [label, expected] of cases) {
    assert.equal(
      adapterEnvVar(label),
      expected,
      `${label} would look up the wrong env var`,
    );
  }
  // The slug must not contain a doubled or trailing underscore: both are the
  // tell-tale of an untrimmed, uncollapsed slug.
  for (const [label] of cases) {
    const slug = adapterEnvVar(label).slice("ADAPTER_".length);
    assert.doesNotMatch(slug, /__|_$/, `${label} produced a malformed slug`);
  }
});

// --- request encoding -----------------------------------------------------

function sampleRequest(overrides: Partial<ExecutionRequest> = {}): ExecutionRequest {
  return {
    loanProvider: LoanProvider.Morpho,
    loanToken: ADDR_WETH,
    loanAmount: 10n ** 18n,
    minProfit: 10n ** 14n,
    profitReceiver: ADDR_TREASURY,
    swaps: [
      {
        adapter: ADDR_UNI_ADAPTER,
        tokenIn: ADDR_WETH,
        tokenOut: ADDR_USDC,
        amountIn: 10n ** 18n,
        minAmountOut: 2500n * 10n ** 6n,
        kind: Kind.UniswapV3,
        poolData: encodeAbiParameters(parseAbiParameters("uint24"), [3000]),
      },
      {
        adapter: ADDR_AERO_ADAPTER,
        tokenIn: ADDR_USDC,
        tokenOut: ADDR_WETH,
        amountIn: 0n,
        minAmountOut: 10n ** 18n,
        kind: Kind.Aerodrome,
        poolData: encodeAbiParameters(parseAbiParameters("bool,address"), [
          false,
          AERO_FACTORY,
        ]),
      },
    ],
    ...overrides,
  };
}

test("encodeExecute produces calldata with the pinned selector", () => {
  const data = encodeExecute(sampleRequest());
  assert.ok(data.startsWith(EXECUTE_SELECTOR), `expected ${EXECUTE_SELECTOR}, got ${data.slice(0, 10)}`);
  // selector + at least the head words of the request tuple
  assert.ok(data.length > 2 + 64 * 7, "calldata is implausibly short");
});

test("encodeExecute round-trips through the request ABI", () => {
  const req = sampleRequest();
  const data = encodeExecute(req);

  // Reconstruct the tuple and compare, proving the fields landed where the
  // Solidity decoder will look for them.
  const decoded = decodeTuple(
    "uint8,address,uint256,uint256,address,uint8,((address,address,address,uint256,uint256,uint8,bytes)[],uint256),(address,uint256,bytes)[]",
    `0x${data.slice(10)}`,
  );

  assert.equal(Number(decoded[0]), LoanProvider.Morpho);
  assert.equal(String(decoded[1]).toLowerCase(), ADDR_WETH.toLowerCase());
  assert.equal(decoded[2], 10n ** 18n);
  assert.equal(decoded[3], 10n ** 14n);
  assert.equal(String(decoded[4]).toLowerCase(), ADDR_TREASURY.toLowerCase());
  assert.equal(Number(decoded[5]), RouteMode.AdapterRoute);

  const route = decoded[6] as readonly [readonly unknown[], bigint];
  assert.equal(route[1], 10n ** 14n, "route.minProfit must mirror request.minProfit");
  const swaps = route[0] as readonly (readonly unknown[])[];
  assert.equal(swaps.length, 2);
  assert.equal(Number(swaps[0]![5]), Kind.UniswapV3);
  assert.equal(Number(swaps[1]![5]), Kind.Aerodrome);
  assert.equal(swaps[1]![3], 0n, "leg 2 must leave amountIn at 0 for the executor to resolve");
});

test("encodeExecute refuses a zero minProfit", () => {
  // Mirrors Errors.InvalidMinProfit. A zero floor removes the only on-chain
  // backstop, so this must fail here rather than on chain.
  assert.throws(() => encodeExecute(sampleRequest({ minProfit: 0n })), /minProfit must be positive/);
});

test("encodeExecute refuses a zero per-leg slippage floor", () => {
  const req = sampleRequest();
  req.swaps[0]!.minAmountOut = 0n;
  assert.throws(() => encodeExecute(req), /minAmountOut must be positive/);
});

test("encodeExecute refuses an empty route", () => {
  assert.throws(() => encodeExecute(sampleRequest({ swaps: [] })), /at least one leg/);
});

test("encodeExecute refuses a leg that swaps a token for itself", () => {
  const req = sampleRequest();
  req.swaps[0]!.tokenOut = req.swaps[0]!.tokenIn;
  assert.throws(() => encodeExecute(req), /tokenIn == tokenOut/);
});

test("buildRoute leaves leg 2 dynamic and carries the resolved factory", () => {
  const uni = new UniswapV3Venue("uniswap-v3-0.3%", ADDR_WETH, ADDR_USDC, 3000);
  const slip = new SlipstreamVenue(
    "slipstream-old-ts100",
    ADDR_WETH,
    ADDR_USDC,
    100,
    "0x254cF9E1E6e233aa1AC962CB9B05b2cfeAaE15b0",
    SLIP_FACTORY,
  );

  const swaps = buildRoute({
    firstVenue: uni,
    secondVenue: slip,
    firstAdapter: ADDR_UNI_ADAPTER,
    secondAdapter: ADDR_AERO_ADAPTER,
    loanToken: ADDR_WETH,
    quoteToken: ADDR_USDC,
    loanAmount: 10n ** 18n,
    leg1MinAmountOut: 2500n * 10n ** 6n,
    leg2MinAmountOut: 99n * 10n ** 16n,
  });

  assert.equal(swaps.length, 2);
  assert.equal(swaps[0]!.amountIn, 10n ** 18n);
  assert.equal(swaps[1]!.amountIn, 0n, "leg 2 input must be resolved from leg 1's output");
  assert.equal(swaps[0]!.kind, Kind.UniswapV3);
  assert.equal(swaps[1]!.kind, Kind.Slipstream);

  // The Slipstream leg must name the generation the *venue* was resolved
  // against, not whatever happened to be in config.
  const [, factory] = decodeTuple("int24, address", swaps[1]!.poolData);
  assert.equal(String(factory).toLowerCase(), SLIP_FACTORY.toLowerCase());
});

// --- safety gates ---------------------------------------------------------

test("live mode requires both switches, not one", () => {
  assert.throws(() => assertLiveArmed({}), SafetyError);
  assert.throws(() => assertLiveArmed({ LIVE: "true" }), SafetyError);
  assert.throws(
    () => assertLiveArmed({ I_UNDERSTAND_THIS_SIGNS_TRANSACTIONS: "yes" }),
    SafetyError,
  );
  // Only both together arm it.
  assert.doesNotThrow(() =>
    assertLiveArmed({ LIVE: "true", I_UNDERSTAND_THIS_SIGNS_TRANSACTIONS: "yes" }),
  );
});

test("live mode rejects a malformed private key without echoing it", () => {
  assert.throws(() => loadPrivateKey({}), /PRIVATE_KEY/);
  let caught: Error | null = null;
  try {
    loadPrivateKey({ PRIVATE_KEY: "0xabc" });
  } catch (e) {
    caught = e as Error;
  }
  assert.ok(caught, "expected a throw");
  assert.ok(!caught!.message.includes("abc"), "the error must not echo any part of the key");
});

test("redactRpcUrl strips an API key from a URL", () => {
  const out = redactRpcUrl("https://base-mainnet.g.alchemy.com/v2/supersecretkey123");
  assert.ok(!out.includes("supersecretkey123"), `key leaked: ${out}`);
  assert.ok(out.includes("base-mainnet.g.alchemy.com"), "host should survive for diagnosis");
});

test("net profit below the floor is refused", () => {
  const guards = {
    minNetProfitWei: 1000n,
    maxGasPriceWei: 10n ** 11n,
    approvedAdapters: new Set([ADDR_UNI_ADAPTER.toLowerCase()]),
    maxLoanWei: 10n ** 19n,
  };
  assert.throws(
    () =>
      checkLiveGuards({
        guards,
        netProfitWei: 999n,
        gasPriceWei: 1n,
        loanAmountWei: 1n,
        adapterAddresses: [],
      }),
    /below the floor/,
  );
  assert.doesNotThrow(() =>
    checkLiveGuards({
      guards,
      netProfitWei: 1000n,
      gasPriceWei: 1n,
      loanAmountWei: 1n,
      adapterAddresses: [],
    }),
  );
});

test("a gas spike above the ceiling is refused", () => {
  // The point of the ceiling: a marginal route priced at a low gas price must
  // not be broadcast into a spike, where it becomes a loss on inclusion.
  const guards = {
    minNetProfitWei: 1n,
    maxGasPriceWei: 100n,
    approvedAdapters: new Set<string>(),
    maxLoanWei: 10n ** 19n,
  };
  assert.throws(
    () =>
      checkLiveGuards({
        guards,
        netProfitWei: 10n ** 6n,
        gasPriceWei: 101n,
        loanAmountWei: 1n,
        adapterAddresses: [],
      }),
    /exceeds the ceiling/,
  );
});

test("an unapproved adapter in a route is refused", () => {
  const guards = {
    minNetProfitWei: 1n,
    maxGasPriceWei: 10n ** 11n,
    approvedAdapters: new Set([ADDR_UNI_ADAPTER.toLowerCase()]),
    maxLoanWei: 10n ** 19n,
  };
  assert.throws(
    () =>
      checkLiveGuards({
        guards,
        netProfitWei: 10n ** 6n,
        gasPriceWei: 1n,
        loanAmountWei: 1n,
        adapterAddresses: [ADDR_AERO_ADAPTER],
      }),
    /not approved/,
  );
});

test("a loan above the configured maximum is refused", () => {
  const guards = {
    minNetProfitWei: 1n,
    maxGasPriceWei: 10n ** 11n,
    approvedAdapters: new Set<string>(),
    maxLoanWei: 10n ** 18n,
  };
  assert.throws(
    () =>
      checkLiveGuards({
        guards,
        netProfitWei: 10n ** 6n,
        gasPriceWei: 1n,
        loanAmountWei: 10n ** 18n + 1n,
        adapterAddresses: [],
      }),
    /exceeds the configured maximum/,
  );
});

test("slipFloor applies the haircut and refuses an absurd bps", () => {
  assert.equal(slipFloor(10_000n, 100), 9_900n); // 1% off
  assert.equal(slipFloor(10_000n, 0), 10_000n);
  assert.throws(() => slipFloor(10_000n, 5_001), SafetyError);
  assert.throws(() => slipFloor(10_000n, -1), SafetyError);
});

// --- revert decoding ------------------------------------------------------

test("InsufficientProfit decodes with both figures", () => {
  // Hand-built from the signature so the test does not depend on the encoder
  // under test.
  const data = encodeAbiParameters(parseAbiParameters("uint256, uint256"), [500n, 123n]);
  const payload = `0x${keccak256(toHex("InsufficientProfit(uint256,uint256)")).slice(2, 10)}${data.slice(2)}` as const;

  const d = decodeRevert(payload);
  assert.equal(d.name, "InsufficientProfit");
  assert.equal(d.args.required, 500n);
  assert.equal(d.args.actual, 123n);
  assert.match(d.summary, /needed 500 wei, had 123 wei/);
  assert.equal(isExpectedRefusal(d.name), true, "a failed floor is a normal refusal");
});

test("an empty revert is named rather than reported as unknown", () => {
  const d = decodeRevert("0x");
  assert.equal(d.name, null);
  assert.match(d.summary, /empty revert/);
});

test("an unrecognised selector is still diagnosable", () => {
  const d = decodeRevert("0xdeadbeef" + "00".repeat(32));
  assert.equal(d.name, null);
  assert.match(d.summary, /0xdeadbeef/);
  assert.equal(isExpectedRefusal(d.name), false, "an unknown revert is not a market refusal");
});

test("a configuration error is not treated as an expected refusal", () => {
  const data = encodeAbiParameters(parseAbiParameters("bytes32,address"), [
    `0x${"00".repeat(32)}`,
    ADDR_TREASURY,
  ]);
  const payload = `0x${keccak256(toHex("Unauthorized()")).slice(2, 10)}` as const;
  const d = decodeRevert(payload);
  assert.equal(d.name, "Unauthorized");
  assert.equal(isExpectedRefusal(d.name), false);
  assert.match(d.summary, /role/);
  void data;
});

// --- helper ---------------------------------------------------------------

function decodeTuple(types: string, data: string): readonly unknown[] {
  return decodeAbiParameters(parseAbiParameters(types), data as `0x${string}`);
}
