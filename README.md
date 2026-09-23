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
Rust version, and the adapter ambition from the TypeScript version — with the accounting
and role problems fixed rather than documented.

See `ANALISIS-DAN-RENCANA-MERGE.md` for the full comparison and the merge rationale.

## Flash-loan providers

All three are free on Base, which is the entire reason the strategy is viable at small size.

| Provider | Address on Base | Repayment mechanism |
|---|---|---|
| Morpho Blue | `0xBBBBBbbBBb9cC5e90e3b3Af64bdAF62C37EEFFCb` | `transferFrom` after callback returns |
| Balancer V2 Vault | `0xBA12222222228d8Ba445958a75a0704d566BF2C8` | balance check inside `receiveFlashLoan` |
| Balancer V3 Vault | `0xbA1333333333a1BA1108E8412f11850A5C319bA9` | `unlock` → `settle` transient accounting |

The three differ in *when* the debt leaves the contract, and getting that wrong is the
single easiest way to report a loss as a profit. `_settleProfit` handles each case
explicitly; the tests assert the exact profit for all three.

### Where the fees actually live

Neither Balancer Vault charges a flash-loan fee on Base, but for different reasons, and
the difference matters when writing the interface:

- **V2** does have a fee concept. It is a *protocol* fee read from the
  `ProtocolFeesCollector` (`0xce88686553686DA562CE7Cea497CE749DA109f9F` on Base), reported
  to the borrower through `feeAmounts` in the callback. It currently returns `0`.
- **V3** has no flash-loan fee concept at all — there is no `getFlashLoanFeePercentage`
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
the operator role — a missed step meant the cold wallet could move funds forever.

**The whitelisted-call route is the only escape hatch.** It exists for liquidations, where
the sequence cannot be expressed as a token cycle. `transfer`/`approve`-style selectors
are refused at whitelist time, and a call with non-zero `value` is rejected at execution.

## Layout

```
src/
  MorphoArbExecutor.sol        main executor
  adapters/
    UniswapV3Adapter.sol       live Uniswap V3 / Slipstream-style router adapter
  interfaces/                  IMorpho, IBalancer (V2 + V3), IUniswapV3, IAdapter
  libraries/Types.sol          request/route/step structs
  libraries/Errors.sol         custom errors
test/
  MorphoArbExecutor.t.sol      25 unit tests across all three providers
  fork/MorphoArbFork.t.sol     13 tests against live Base deployments
  mocks/                       ERC20, provider stand-ins, mock adapter
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

Base runs `SwapRouter02`, whose `ExactInputSingleParams` has **no `deadline`** field
(selector `0x04e45aaf`). The older `SwapRouter` variant has a deadline and a different
selector (`0x414bf389`); sending the wrong encoding reverts rather than mispricing, but it
is still worth knowing which one you are talking to.

Aerodrome, Slipstream and Uniswap V4 are not wired up yet. `Types.KIND_*` already carries
their discriminators from the Rust bot so off-chain encoders keep working.

### Does it actually arbitrage?

Yes, and it is tested. `test_real_profitable_route_settles_through_live_pools` creates a
real cross-tier dislocation on chain — it pushes 30 WETH through Base's thin 0.01% WETH/USDC
pool (~47 WETH deep, against ~18,000 in the 0.3% pool), which is exactly how a dislocation
appears in production — then borrows 1 WETH, buys the cheap tier, sells the expensive one,
and settles. It clears ~0.077 WETH profit on a 1 WETH loan.

The same suite proves the opposite: a WETH→USDC→WETH round trip with no dislocation loses
~0.2%, and the executor reverts with `InsufficientProfit` rather than reporting a
zero-profit success.

## Build and test

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
believe reality is — it is what caught the V3 callback-encoding bug.

```bash
forge test                        # all 38: fork tests use Base's public RPC by default
forge test --match-path 'test/fork/*' -vv
```

Set `BASE_RPC_URL` to use a private or archive node instead of the public endpoint. Loans
are sized at 1 WETH because Balancer V3 holds only ~4 WETH on Base; a loan sized for
Morpho's depth would revert on the Balancer side.

Gas on the hot path (`execute` with a two-leg adapter route) is roughly 370k on Morpho
and 445k on Balancer V3, dominated by the two swaps rather than by the loan plumbing.

## Deploying

See the header of `script/Deploy.s.sol` for the environment variables. Passing
`address(0)` for a provider disables it, so a staged rollout that wires only Morpho first
is supported.

## Not implemented yet

These are deliberate gaps, not oversights:

- **No adapters.** `IAdapter` is defined and the mock proves the executor calls it
  correctly, but Uniswap V3, Aerodrome, PancakeSwap V3, and 1inch adapters are not
  written. Nothing can be executed on a live chain until at least one exists.
- **No off-chain scanner.** The Rust repo's scanner is not ported; routes must be supplied
  by the operator. The executor is the settlement layer, not the strategy layer.
- **No fork tests.** The mocks encode the provider semantics that matter for repayment
  ordering, but a Base fork test against the real vaults is the next real confidence step.
- **`treasury` is a plain admin-set address**, not a splitter or a contract with its own
  withdrawal logic.

## Warning

This is unaudited code that moves borrowed funds. Deploying it with real capital before it
has been reviewed and fork-tested is how the predecessor repos lost money.
