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
Rust version, and the adapter ambition from the TypeScript version ﻗ with the accounting
and role problems fixed rather than documented.

See `ANALISIS-DAN-RENCANA-MERGE.md` for the full comparison and the merge rationale.

## Flash-loan providers

All three are free on Base, which is the entire reason the strategy is viable at small size.

| Provider | Address on Base | Repayment mechanism |
|---|---|---|
| Morpho Blue | `0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb` | `transferFrom` after callback returns |
| Balancer V2 Vault | `0xBA12222222228d8Ba445958a75a0704d566BF2C8` | balance check inside `receiveFlashLoan` |
| Balancer V3 Vault | `0xbA1333333333a1BA1108E8412f11850A5C319bA9` | `unlock` ﻗ `settle` transient accounting |

The three differ in *when* the debt leaves the contract, and getting that wrong is the
single easiest way to report a loss as a profit. `_settleProfit` handles each case
explicitly; the tests assert the exact profit for all three.

### Where the fees actually live

Neither Balancer Vault charges a flash-loan fee on Base, but for different reasons, and
the difference matters when writing the interface:

- **V2** does have a fee concept. It is a *protocol* fee read from the
  `ProtocolFeesCollector` (`0xce88686553686DA562CE7Cea497CE749DA109f9F` on Base), reported
  to the borrower through `feeAmounts` in the callback. It currently returns `0`.
- **V3** has no flash-loan fee concept at all ﻗ there is no `getFlashLoanFeePercentage`
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
the operator role ﻗ a missed step meant the cold wallet could move funds forever.

**The whitelisted-call route is the only escape hatch.** It exists for liquidations, where
the sequence cannot be expressed as a token cycle. `transfer`/`approve`-style selectors
are refused at whitelist time, and a call with non-zero `value` is rejected at execution.

## Layout

```
src/
  MorphoArbExecutor.sol        main executor
  adapters/
    UniswapV3Adapter.sol       live Uniswap V3 / Slipstream-style router adapter
    AerodromeAdapter.sol       live Aerodrome router adapter (stable + volatile)
  interfaces/                  IMorpho, IBalancer (V2 + V3), IUniswapV3, IAerodrome, IAdapter
  libraries/Types.sol          request/route/step structs
  libraries/Errors.sol         custom errors
test/
  MorphoArbExecutor.t.sol      25 unit tests across all three providers
  fork/MorphoArbFork.t.sol     13 tests against live Base deployments
  fork/CrossDexFork.t.sol      4 cross-DEX tests (Aerodrome <-> Uniswap V3)
  mocks/                       ERC20, provider stand-ins, mock adapter
scanner/
  src/config.ts                venues, loan sizes, thresholds
  src/rpc.ts                   batched JSON-RPC with retry
  src/math.ts                  constant-product math
  src/venues.ts                per-DEX quoting (Uniswap V3, Aerodrome)
  src/discovery.ts             two-phase cycle search
  src/main.ts                  scan loop
  test/                        unit tests + live Aerodrome cross-check
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
can exist **twice** ﻗ once as a volatile (constant-product) pool and once as a stable
(xﺡﺏ+yﺡﺏ=k) pool. `stable` is therefore part of the pool identity, not a routing hint. This is
not academic on Base: WETH/USDC has both, and the stable one holds ~2 WETH against ~1,657 in
the volatile pool, so routing to the wrong one is an expensive mistake. Pass
`factory = address(0)` to use the router's `defaultFactory()`.

`deadline` is not part of the step encoding. A profitable route has to land in the block it
was priced for, so a deadline adds no protection a block builder cannot already give itself;
the adapter passes `block.timestamp` to satisfy the router's own check.

Slipstream and Uniswap V4 are not wired up yet. `Types.KIND_*` already carries their
discriminators from the Rust bot so off-chain encoders keep working.

### Does it actually arbitrage?

Yes, and it is tested against live Base liquidity, not mocks. Two tests manufacture a
dislocation the way one appears in production ﻗ by pushing a large trade through a thin pool
ﻗ then borrow 1 WETH and settle a real profit:

| Route | Dislocation | Profit on a 1 WETH loan |
|---|---|---|
| Uniswap V3 0.05% ﻗ 0.01% | 30 WETH through the 0.01% pool (~47 WETH deep) | ~0.079 WETH |
| Uniswap V3 ﻗ Aerodrome volatile | 250 WETH through Aerodrome (~1,657 WETH deep) | ~0.314 WETH |

The same suites prove the opposite: a round trip with no dislocation loses ~0.2% and the
executor reverts with `InsufficientProfit` rather than reporting a zero-profit success.
The cross-DEX case additionally proves the executor dispatches to two different adapters
within one route.

## Build and test

Two RPC requirements that are easy to conflate: the scanner needs batch
support, while the fork tests pin a historical block and therefore need
archive access. A free-tier endpoint can satisfy the first and refuse the
second with `403 Archive, Debug and Trace requests are not available`, which
Foundry reports as `could not instantiate forked environment` — a message that
reads like a broken URL rather than a plan limit. Use an archive-capable
endpoint for `forge test --match-path "test/fork/*"`.

```bash
# Dependencies are not vendored; install them first.
forge install foundry-rs/forge-std
npm install

forge build
forge test                        # unit tests, no network needed
```

### Fork tests

The fork suite exercises all three providers against live Base bytecode. It is the only
check that the repayment mechanisms are wired to reality rather than to what the mocks
believe reality is ﻗ it is what caught the V3 callback-encoding bug.

```bash
forge test                        # all 42: fork tests use Base's public RPC by default
forge test --match-path 'test/fork/*' -vv
```

Set `BASE_RPC_URL` to use a private or archive node instead of the public endpoint.

Fork tests are pinned to a block (`BASE_FORK_BLOCK` overrides it) for two reasons. A moving
fork head makes pool depth depend on when the suite ran, so a dislocation sized for one block
can be far too small for the next. It also collapses state fetching to a single block, which
matters because the public Base endpoint rate-limits hard enough to fail `setUp` outright ﻗ
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
BASE_RPC_URL=https://... npm run test:scanner   # 15 unit tests, no network
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

### What it found on a real dislocation

Verified on a local fork of Base: dumping 300 WETH into the 0.01% WETH/USDC
pool (which holds ~47 WETH) moves it hard enough to produce a large spread.
The scanner then reports, for a 10 WETH loan through 0.3% -> 0.01%:

```
uniswap-v3-0.3% -> uniswap-v3-0.01%  loan=10.000000  out=212.183657  gross=202.183657 WETH
```

An independent `cast` call against the same pool reproduces `+202.183658 WETH`
exactly. The size of that profit is an artifact of the deliberately violent
dislocation, not a claim about live markets: the honest baseline is the same
scan before the dump, which reports a spread of about `-0.0005 WETH` ﻗ a
round-trip cost of ~0.14%, consistent with the 0.3% + 0.01% fees.

### Trusting the local math

Only Aerodrome-volatile legs are priced locally; Uniswap V3 goes through
QuoterV2. That local path is the one place the scanner computes a price
instead of asking the chain, so it is the one place a wrong fee or curve
assumption yields confident, wrong quotes.

`scanner/test/aerodrome.integration.test.ts` closes that gap by comparing the
local result against the venue's own `getAmountsOut`. They agree exactly, and a
second test asserts the volatile and stable pools of WETH/USDC carry different
fees ﻗ which is why the fee is read per pool from the factory rather than
assumed from the factory default.

Aerodrome **stable** pools are refused rather than approximated: their curve
(xﺡﺏy + yﺡﺏx = k) is not constant-product, so the local math would misprice them.
The Rust bot refuses them too.

### Not implemented yet

These are deliberate gaps, not oversights:

- **No transaction submission from the scanner.** It finds and prices; nothing
  signs. `--execute` does not exist.
- **Slipstream and Uniswap V4 adapters.** `Types.KIND_*` already carries their
  discriminators so off-chain encoders keep working.
- **No gas-aware net ranking.** Candidates are ranked by gross profit. The Rust
  bot simulates gas per candidate and stops early once a later candidate cannot
  beat the incumbent's net (`can_still_win`); that is not ported yet, so the
  scanner can report a candidate that gas would erase.
- **`treasury` is a plain admin-set address**, not a splitter or a contract with
  its own withdrawal logic.

## Warning

This is unaudited code that moves borrowed funds. Deploying it with real capital before it
has been reviewed and fork-tested is how the predecessor repos lost money.
