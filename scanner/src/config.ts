/**
 * Scanner configuration: venues, loan sizes, thresholds.
 *
 * Every address here was read from Base mainnet, not copied from a docs page.
 * See AGENTS.md for the verification commands.
 */

import type { Address } from "viem";

export const BASE_CHAIN_ID = 8453;

/** Addresses verified on Base mainnet. */
export const ADDR = {
  WETH: "0x4200000000000000000000000000000000000006",
  USDC: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  USDbC: "0xd9aAEc86B65D86f6A7B5B1b0c42FFA531710b6CA",

  /** Uniswap V3 */
  UNISWAP_V3_FACTORY: "0x33128a8fC17869897dcE68Ed026d694621f6FDfD",
  UNISWAP_V3_QUOTER_V2: "0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a",
  UNISWAP_V3_ROUTER02: "0x2626664c2603336E57B271c5C0b26F421741e481",

  /** Aerodrome */
  AERODROME_FACTORY: "0x420DD381b31aEf6683db6B902084cB0FFECe40Da",
  AERODROME_ROUTER: "0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43",

  /** Aerodrome Slipstream (concentrated liquidity). Two live generations on
   * Base; each pairs its own factory with its own router and quoter. A leg
   * priced against one generation's pool must execute through the same
   * generation's router. */
  SLIPSTREAM_FACTORY_OLD: "0x5e7BB104d84c7CB9B682AaC2F3d509f5F406809A",
  SLIPSTREAM_ROUTER_OLD: "0xBE6D8f0d05cC4be24d5167a3eF062215bE6D18a5",
  SLIPSTREAM_QUOTER_OLD: "0x254cF9E1E6e233aa1AC962CB9B05b2cfeAaE15b0",
  SLIPSTREAM_FACTORY_NEW: "0xf8f2eB4940CFE7d13603DDDD87f123820Fc061Ef",
  SLIPSTREAM_ROUTER_NEW: "0x698Cb2b6dd822994581fEa6eA4Fc755d1363A92F",
  SLIPSTREAM_QUOTER_NEW: "0x514c8B5f54112481E28028F1166Bd78501089259",

  /** Executor deployed from this repo (set after deployment). */
  EXECUTOR: "0x0000000000000000000000000000000000000000",
} as const satisfies Record<string, Address>;

export type VenueKind = "uniswap-v3" | "aerodrome";

/**
 * A venue the scanner prices. `tokens` is the pair being arbitraged against
 * the loan token; the loan token itself is `loanToken` below.
 */
export interface VenueConfig {
  kind: VenueKind;
  label: string;
  /** The other token in the cycle. */
  token: Address;
  /**
   * Uniswap V3 fee tier (1e6 scale: 500 = 0.05%), or Aerodrome stable flag
   * semantics via `stable`. Unused for Aerodrome.
   */
  fee?: number;
  /** Aerodrome only: volatile (false) or stable (true) pool. */
  stable?: boolean;
  /** Aerodrome only: fee in bps, verified against the factory at startup. */
  feeBps?: number;
  /** Address of the deployed adapter contract for this venue. */
  adapter?: Address;
}

export interface ScanConfig {
  rpcUrl: string;
  chainId: number;
  /** Token borrowed and returned; the cycle's start and end. */
  loanToken: Address;
  /** Base symbol of the loan token, for logging only. */
  loanTokenSymbol: string;
  loanTokenDecimals: number;
  /** Flash-loan sizes to probe, in loan-token base units. */
  loanAmounts: bigint[];
  /** Minimum net profit to report, in loan-token base units. */
  minProfit: bigint;
  venues: VenueConfig[];
  /** Cap on RPC calls per batch, so one tick cannot blow a provider's limit. */
  maxBatchSize: number;
  /** Wall-clock gap between scans, ms. */
  scanIntervalMs: number;
  /** Log every candidate, not just the profitable ones. */
  verbose: boolean;
  dryRun: boolean;
}

/** Default venue set: two Uniswap V3 fee tiers and the Aerodrome volatile pool. */
export function defaultVenues(): VenueConfig[] {
  return [
    {
      kind: "uniswap-v3",
      label: "uniswap-v3-0.05%",
      token: ADDR.USDC,
      fee: 500,
    },
    {
      kind: "uniswap-v3",
      label: "uniswap-v3-0.3%",
      token: ADDR.USDC,
      fee: 3000,
    },
    {
      kind: "uniswap-v3",
      label: "uniswap-v3-0.01%",
      token: ADDR.USDC,
      fee: 100,
    },
    {
      kind: "aerodrome",
      label: "aerodrome-volatile",
      token: ADDR.USDC,
      stable: false,
      feeBps: 30,
    },
  ];
}

const env = (k: string): string | undefined => process.env[k]?.trim() || undefined;

export function loadConfig(): ScanConfig {
  const rpcUrl = env("BASE_RPC_URL");
  if (!rpcUrl) {
    throw new Error("BASE_RPC_URL is required (an HTTP or HTTPS Base endpoint)");
  }

  const loanAmounts = (env("LOAN_AMOUNTS") ?? "0.5,1,2,5,10")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      const [whole, frac = ""] = s.split(".");
      const padded = (frac + "0".repeat(18)).slice(0, 18);
      const v = BigInt(whole || "0") * 10n ** 18n + BigInt(padded || "0");
      if (v <= 0n) throw new Error(`LOAN_AMOUNTS entry '${s}' must be positive`);
      return v;
    });

  const minProfit = (() => {
    const raw = env("MIN_PROFIT") ?? "0.0005";
    const [whole, frac = ""] = raw.split(".");
    const padded = (frac + "0".repeat(18)).slice(0, 18);
    const v = BigInt(whole || "0") * 10n ** 18n + BigInt(padded || "0");
    if (v <= 0n) throw new Error("MIN_PROFIT must be positive");
    return v;
  })();

  return {
    rpcUrl,
    chainId: BASE_CHAIN_ID,
    loanToken: ADDR.WETH,
    loanTokenSymbol: "WETH",
    loanTokenDecimals: 18,
    loanAmounts,
    minProfit,
    venues: defaultVenues(),
    maxBatchSize: Number(env("MAX_BATCH_SIZE") ?? 100),
    scanIntervalMs: Number(env("SCAN_INTERVAL_MS") ?? 2_000),
    verbose: env("VERBOSE") === "true",
    dryRun: env("DRY_RUN") !== "false",
  };
}
