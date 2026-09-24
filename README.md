# Morpho + Balancer Flash-Loan Arbitrage Executor (Base)

A single Solidity executor that merges the useful parts of three earlier attempts
(`morpho-arbitrage-bot`, `morpho-arbitrage-rust`, `morpho-flash-arb`) and fixes the
accounting bugs they shared.

The design goal is narrow and deliberate: **borrow for free, run an operator-supplied
route, and refuse to settle unless the route cleared a profit floor the operator chose
before the transaction was sent.** Every other feature was left out on purpose.

## Why this exists

The three predecessor repos each got one piece right and had one piece wrong:

| Repo | Stack | What was right | What was wrong |
|---|---|---|---|
| `morpho-arbitrage-bot` | TypeScript + Hardhat | Broad adapter coverage, liquidation path | Off-chain profit math never reconciled with on-chain reality |
| `morpho-arbitrage-rust` | Rust | Fast scanning, clean route model | Swept only `profit`, stranding pre-existing balance; no floor enforcement on-chain |
| `morpho-flash-arb` | Solidity | On-chain executor, role separation intent | Granted all four roles at construction; relied on a setup script to revoke `OPERATOR_ROLE` |

This repo keeps the on-chain executor from `morpho-flash-arb`, the route model from the
Rust version, and the adapter ambition from the TypeScript version -- with the accounting
and role problems fixed rather than documented.

See `ANALISIS-DAN-RENCANA-MERGE.md` for the full comparison and the merge rationale.

## Flash-loan providers

All three are free on Base, which is the entire reason the strategy is viable at small size.

| Provider | Address on Base | Repayment mechanism |
|---|---|---|
| Morpho Blue | `0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb` | `transferFrom` after callback returns |
| Balancer V2 Vault | `0xBA12222222228d8Ba445958a75a0704d566BF2C8` | balance check inside `receiveFlashLoan` |
| Balancer V3 Vault | `0xbA1333333333a1BA1108E8412f11850A5C319bA9` | `unlock` -> `settle` transient accounting |

The three differ in *when* the debt leaves the contract, and getting that wrong is the
single easiest way to report a loss as a profit. `_settleProfit` handles each case
explicitly; the tests assert the exact profit for all three.

### Where the fees actually live

Neither Balancer Vault charges a flash-loan fee on Base, but for different reasons, and
the difference matters when writing the interface:

- **V2** does have a fee concept. It is a *protocol* fee read from the
  `ProtocolFeesCollector` (`0xce88686553686DA562CE7Cea497CE749DA109f9F` on Base), reported
  to the borrower through `feeAmounts` in the callback. It currently returns `0`.
- **V3** has no flash-loan fee concept at all -- there is no `getFlashLoanFeePercentage`
  anywhere in the V3 monorepo. A flash loan is just a transient delta that is rebalanced
  before the lock is released, so the cost is structurally zero.

V3's `unlock` is also a raw `msg.sender.functionCall(data)`: the `data` you pass must be a
complete call to your own callback, not a bag of arguments the Vault decodes for you.
Passing bare request bytes is dispatched as an empty call and reverts with `FailedInnerCall`.


## Design decisions worth knowing

**Profit is measured as a balance delta, not from the adapter's return value.** An
adapter that reports more than it delivered cannot satisfy the floor.

**A losing route reverts instead of clamping to zero.** Reporting zero profit on a loss
would let a losing transaction look successful.

**Everything the contract owns is returned, not just `profit`.** Pre-existing dust is
swept to the receiver, so a stuck balance from a prior partial run cannot accumulate
unnoticed.

**`OPERATOR_ROLE` is not granted at construction.** The admin is a cold key; the operator
is a hot key. The predecessor granted both and depended on a follow-up script to revoke
the operator role -- a missed step meant the cold wallet could move funds forever.

**The whitelisted-call route is the only escape hatch.** It exists for liquidations, where
the sequence cannot be expressed as a token cycle. `transfer`/`approve`-style selectors
are refused at whitelist time, and a call with non-zero `value` is rejected at execution.

## Layout

```
src/
  MorphoArbExecutor.sol        main executor
  adapters/
    UniswapV3Adapter.sol       live Uniswap V3 SwapRouter02 adapter
    AerodromeAdapter.sol       live Aerodrome router adapter (stable + volatile)
    SlipstreamAdapter.sol      live Aerodrome Slipstream CL adapter (one per router generation)
  interfaces/                  IMorpho, IBalancer (V2 + V3), IUniswapV3, IAerodrome,
                               ISlipstream, IAdapter
  libraries/Types.sol          request/route/step structs
  libraries/Errors.sol         custom errors
test/
  MorphoArbExecutor.t.sol      25 unit tests across all three providers
  MorphoArbProperty.t.sol      9 property + sabotage tests for the profit invariant
  SlipstreamAdapter.t.sol      11 offline Slipstream encoding + generation tests
  fork/MorphoArbFork.t.sol     13 tests against live Base deployments
  fork/CrossDexFork.t.sol      4 cross-DEX tests (Aerodrome <-> Uniswap V3)
  fork/SlipstreamFork.t.sol    7 Slipstream tests, including both live router generations
  mocks/                       ERC20, provider stand-ins, mock adapters, mock Slipstream router
scanner/
  src/config.ts                venues, loan sizes, thresholds
  src/rpc.ts                   batched JSON-RPC with retry
  src/math.ts                  constant-product math
  src/venues.ts                per-DEX quoting (Uniswap V3, Aerodrome, Slipstream CL)
  src/discovery.ts             two-phase cycle search
  src/main.ts                  scan loop
  test/                        unit tests + live Aerodrome/Slipstream cross-checks
script/
  Deploy.s.sol                 env-driven deployment
```

## Adapters

`IAdapter` is deliberately tiny: pull `amountIn`, swap through your own router, send the
output back to the executor, revert below `minAmountOut`. The executor approves exactly
`amountIn` and clears the allowance afterwards, and measures the output as a balance delta,
so an adapter cannot overstate what it delivered.

`poolData` is adapter-specific and opaque to the executor:

| Adapter | `poolData` | Live on Base |
|---|---|---|
| `UniswapV3Adapter` | `abi.encode(uint24 fee)` | `0x2626664c2603336E57B271c5C0b26F421741e481` (SwapRouter02) |
| `AerodromeAdapter` | `abi.encode(bool stable, address factory)` | `0xcF77a3Ba9A5CA399B7c97c74d54e5b1Beb874E43` (Router) |

Base runs `SwapRouter02`, whose `ExactInputSingleParams` has **no `deadline`** field
(selector `0x04e45aaf`). The older `SwapRouter` variant has a deadline and a different
selector (`0x414bf389`); sending the wrong encoding reverts rather than mispricing, but it
is still worth knowing which one you are talking to.

Aerodrome encodes a pool as `(from, to, stable, factory)`, not as a fee tier, because a pair
can exist **twice** -- once as a volatile (constant-product) pool and once as a stable
(x*y + y*x = k) pool. `stable` is therefore part of the pool identity, not a routing hint. This is
not academic on Base: WETH/USDC has both, and the stable one holds ~2 WETH against ~1,657 in
the volatile pool, so routing to the wrong one is an expensive mistake. Pass
`factory = address(0)` to use the router's `defaultFactory()`.

`deadline` is not part of the step encoding. A profitable route has to land in the block it
was priced for, so a deadline adds no protection a block builder cannot already give itself;
the adapter passes `block.timestamp` to satisfy the router's own check.

Slipstream is wired up, and it is the one venue that needs **two** adapters on Base. Aerodrome
runs two concentrated-liquidity router generations, both live, each with its own factory and
router. The two routers share the `exactInputSingle` selector (`0xa026383e`), so a leg's
generation is decided purely by which router address it is mounted on; the adapter reads the
router's own `factory()` in its constructor, and `poolData` carries
`abi.encode(int24 tickSpacing, address factory)` so a leg that names the other generation's
factory reverts instead of silently filling from the other generation's pool. Uniswap V4 is not
wired up yet; `Types.KIND_UNISWAP_V4` already carries its discriminator from the Rust bot so
off-chain encoders keep working.

### Does it actually arbitrage?

Yes, and it is tested against live Base liquidity, not mocks. Two tests manufacture a
dislocation the way one appears in production -- by pushing a large trade through a thin pool
-- then borrow 1 WETH and settle a real profit:

| Route | Dislocation | Profit on a 1 WETH loan |
|---|---|---|
| Uniswap V3 0.05% -> 0.01% | 30 WETH through the 0.01% pool (~47 WETH deep) | ~0.079 WETH |
| Uniswap V3 -> Aerodrome volatile | 250 WETH through Aerodrome (~1,657 WETH deep) | ~0.314 WETH |
| Uniswap V3 0.01% -> Slipstream ts=100 | 30 WETH through the 0.01% pool | ~0.079 WETH |

The same suites prove the opposite: a round trip with no dislocation loses ~0.2% and the
executor reverts with `InsufficientProfit` rather than reporting a zero-profit success.
The cross-DEX case additionally proves the executor dispatches to two different adapters
within one route.

## Build and test

Two RPC requirements that are easy to conflate: the scanner needs batch
support, while the fork tests pin a historical block and therefore need
archive access. A free-tier endpoint can satisfy the first and refuse the
second with `403 Archive, Debug and Trace requests are not available`, which
Foundry reports as `could not instantiate forked environment` -- a message that
reads like a broken URL rather than a plan limit. Use an archive-capable
endpoint for `forge test --match-path "test/fork/*"`; that requirement only
bites for a block older than the node's retention, and the default fork block
is recent enough that a public endpoint ran all 24 tests.

A public endpoint that accepts batches can still throttle a burst of them,
answering with HTTP 200 and a per-call `-32016 over rate limit`. The scanner
now retries that and, if it persists, fails loudly rather than reporting a scan
that read nothing as a market with no opportunities. `test:scanner:live`
against `mainnet.base.org` is therefore flaky by construction; a private RPC
runs the whole suite cleanly.

```bash
# Dependencies are not vendored; install them first.
# Pin the forge-std tag. Without one, `forge install` takes the default branch,
# so the build can break without this repo changing.
forge install foundry-rs/forge-std@v1.16.2
npm install

forge build
forge test --no-match-path "test/fork/*"   # unit tests, no network needed
forge test                                 # everything, needs an archive RPC
```

### Fork tests

The fork suite exercises all three providers against live Base bytecode. It is the only
check that the repayment mechanisms are wired to reality rather than to what the mocks
believe reality is -- it is what caught the V3 callback-encoding bug.

```bash
forge test                        # all 51: fork tests use Base's public RPC by default
forge test --match-path 'test/fork/*' -vv
```

Set `BASE_RPC_URL` to use a private or archive node instead of the public endpoint.

Fork tests are pinned to a block (`BASE_FORK_BLOCK` overrides it) for two reasons. A moving
fork head makes pool depth depend on when the suite ran, so a dislocation sized for one block
can be far too small for the next. It also collapses state fetching to a single block, which
matters because the public Base endpoint rate-limits hard enough to fail `setUp` outright --
that is what the pin fixed.

Loans are sized at 1 WETH because Balancer V3 holds only ~4 WETH on Base; a loan sized for
Morpho's depth would revert on the Balancer side.

Gas on the hot path (`execute` with a two-leg adapter route) is roughly 370k on Morpho
and 445k on Balancer V3, dominated by the two swaps rather than by the loan plumbing.

## Deploying

See the header of `script/Deploy.s.sol` for the environment variables. Passing
`address(0)` for a provider disables it, so a staged rollout that wires only Morpho first
is supported.

## Scanner

`scanner/` is the port of the Rust bot's opportunity discovery. It is
read-only: it prices cycles and prints them, and it cannot submit a
transaction. Execution stays a separate, deliberate step.

```bash
BASE_RPC_URL=https://... npm run scan:once      # one scan
BASE_RPC_URL=https://... npm run scan           # loop every 2s
npm run test:scanner                            # 46 unit tests, no network
BASE_RPC_URL=https://... npm run test:scanner:live   # 13 tests against Base
```

The search is a two-venue cycle over a shared loan token:

```
leg 1: loanToken --[venue A]--> quoteToken
leg 2: quoteToken --[venue B]--> loanToken
```

Two-phase quoting is a requirement, not an optimisation. Leg 2's input is leg
1's *output*, which is unknown until leg 1 is priced; guessing the intermediate
amount would price a trade nobody will execute. Both phases are pinned to the
same block, because legs priced against different blocks describe a cycle that
never existed.

Loan fees are absent from the profit math on purpose: Morpho Blue and Balancer
V2/V3 charge nothing on Base, so a cycle's gross profit is just
`leg2Out - loanAmount`.

Venues are dispatched by pricing model, not by DEX name: `quoter` venues
(Uniswap V3, Slipstream) are asked the chain for each trade size, and
`reserves` venues (Aerodrome) are read once and priced locally. The configured
set is three Uniswap V3 fee tiers, Aerodrome's volatile pool, and the two deep
Slipstream pools -- old generation ts=100 and new generation ts=50.

**Slipstream's two generations are a scanner problem too, not just an executor
one.** The two quoters share an ABI, so pointing one generation's quoter at a
tick spacing that only the other has a pool for does not revert: it prices the
wrong pool and returns a plausible number (measured ~12% off at ts=50). The
scanner therefore reads the factory from the quoter itself rather than trusting
config, and checks `factory.isPool`. It also ignores pools that exist but hold
no liquidity -- on WETH/USDC, old/ts=10 and several others answer the quoter
while holding well under a WETH, and a 1 WETH trade through them quotes a
fraction of market, which the profit math would report as an opportunity.

### Ranking on net, not gross

Gross profit is not what a cycle earns. A candidate that clears `minProfit` on
gross terms can still lose money once gas is paid, so the scanner subtracts
cost before it reports anything.

On Base that cost has two terms, and omitting the second understates it exactly
when fees are high. The L2 execution fee is `gas_used * gas_price`. On top of
that, every transaction pays an **L1 data fee** for publishing its calldata to
Ethereum, read from the OP-Stack GasPriceOracle via `getL1FeeUpperBound` and
priced for the conservative worst-case unsigned `execute` transaction. If the
oracle cannot be read the block is skipped rather than the fee priced at zero,
because every broadcast pays it and a zero would let unprofitable trades
through.

Two behaviours are ported from the Rust bot:

- `pickBestNet` compares net (gross - gas) against `minProfit`.
- `canStillWin` stops simulating once a later candidate's gross falls to or
  below the incumbent's net. Net can never exceed gross, so such a candidate
  cannot win and the remaining simulations are wasted RPC calls. On a real
  dislocation, 15 gross candidates reduced to 1 gas-priced.

`rankedOpportunities` and `bestCandidate` are ported too, and their tests along
with them: the Rust original covers a four-venue market where parity venues
neither create nor remove the edge, a venue that cannot quote being skipped
without poisoning the others, and leg provenance reaching the opportunity per
leg. That last one is load-bearing -- `local=true` is what tells the executor
to re-validate a leg against the on-chain quoter, so collapsing the two leg
flags would silently skip re-validation.

The pure comparisons live in `scanner/src/gas.ts` and are unit-tested offline;
the RPC reads are tested separately against Base. A ranking bug and an RPC bug
otherwise hide behind each other, and both produce the same symptom: a
plausible net number that is wrong.

The RPC client itself has offline tests because the failure mode is silent. A
provider that throttles a burst of `eth_call`s answers with HTTP 200 and a
per-call `-32016 over rate limit` -- the same shape as a legitimate
`execution reverted`, which is a normal "skip this size" signal. Treating the
throttle as a revert makes a scan that read nothing look like a quiet market,
so only an explicit revert maps to `null`; anything else is retried and then
raised.

Dry run has no transaction to simulate, so gas is a fixed 400k-unit ceiling
rather than zero. Pricing it at zero would make the `minProfit` filter run
against gross and report trades that live mode always rejects.

### What it found on a real dislocation

Verified on a local fork of Base: dumping 300 WETH into the 0.01% WETH/USDC
pool (which holds ~47 WETH) moves it hard enough to produce a large spread.
The scanner then reports, for a 10 WETH loan:

```
uniswap-v3-0.05% -> uniswap-v3-0.01%
loan=10.000000  gross=200.231770  gas=0.000402  net=200.231368 WETH
```

An independent `cast` call against the same pool reproduces the gross exactly.
The size of that profit is an artifact of the deliberately violent dislocation,
not a claim about live markets: the honest baseline is the same scan before the
dump, which reports a spread of about `-0.0005 WETH` -- a round-trip cost of
~0.14%, consistent with the pool fees.

Those numbers come from `scanner/test/net.e2e.test.ts`, which runs this exact
scenario, so they cannot drift from the code without the test failing.

### Trusting the local math

Only Aerodrome-volatile legs are priced locally; Uniswap V3 goes through
QuoterV2. That local path is the one place the scanner computes a price
instead of asking the chain, so it is the one place a wrong fee or curve
assumption yields confident, wrong quotes.

`scanner/test/aerodrome.integration.test.ts` closes that gap by comparing the
local result against the venue's own `getAmountsOut`. They agree exactly, and a
second test asserts the volatile and stable pools of WETH/USDC carry different
fees -- which is why the fee is read per pool from the factory rather than
assumed from the factory default.

Aerodrome **stable** pools are refused rather than approximated: their curve
(x*y + y*x = k) is not constant-product, so the local math would misprice them.
The Rust bot refuses them too.

### Not implemented yet

These are deliberate gaps, not oversights:

- **No transaction submission from the scanner.** It finds and prices; nothing
  signs. `--execute` does not exist.
- **Uniswap V4 adapter.** `Types.KIND_UNISWAP_V4` already carries its
  discriminator so off-chain encoders keep working, but the V4 singleton
  architecture needs its own `unlock`/`settle` handling.
- **The scanner does not price Slipstream yet.** `scanner/src/config.ts` records
  both router generations' addresses; the venue adapter itself is not written.
- **`treasury` is a plain admin-set address**, not a splitter or a contract with
  its own withdrawal logic.

## Warning

This is unaudited code that moves borrowed funds. Deploying it with real capital before it
has been reviewed and fork-tested is how the predecessor repos lost money.
