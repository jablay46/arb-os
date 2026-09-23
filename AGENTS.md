# AGENTS.md

Repo-specific knowledge for `arb-os`. Read this before changing anything.

## What this is

A Foundry project: a single flash-loan arbitrage executor for Base mainnet, merged from three
predecessor repos (see `ANALISIS-DAN-RENCANA-MERGE.md` for the comparison and roadmap).
`README.md` documents the contracts and adapters.

## Build and test

```bash
./script/bootstrap-foundry.sh    # if forge is missing; see below
forge install foundry-rs/forge-std@v1.16.2 --no-git   # lib/ is gitignored
npm ci

forge test --no-match-path "test/fork/*"   # 25 unit tests, no network
npx tsc --noEmit                           # scanner types; needs tsconfig.json
npm run test:scanner                       # 42 offline scanner tests
```

CI (`.github/workflows/ci.yml`) runs exactly the four commands above. It never runs the fork or
live suites: those need `BASE_RPC_URL`, and a secret in CI is readable by a pull request from a
fork. Run them locally.

`tsc --noEmit` is only meaningful with `tsconfig.json` present — without it, `tsc` prints its
help text and exits 0, so a type-check job would be green without checking anything.

## The profit invariant

`test/MorphoArbProperty.t.sol` asserts the rule that has to hold on every route, for all three
providers: either the transaction settles having paid exactly its realised profit and left
nothing behind, or it reverts for a known reason. The named tests in `MorphoArbExecutor.t.sol`
only cover routes someone thought of; a new adapter with a misencoded parameter still produces a
plausible number, and only this shape of test catches that.

Two things about these tests are load-bearing and easy to undo by accident:

- **The mock is allowed to lie.** `MockLyingAdapter` reports an output unrelated to what it
  delivered, because that is the failure the balance-delta measurement exists to stop. If you
  "simplify" the mocks to honest adapters, the sabotage tests become vacuous.
- **Reverted state is not observable.** A test that tries to read a mock's counter after an
  expected revert reads zero, because the revert undid it. To assert on which amount the
  executor carried forward, arrange the route to succeed.

Both traps were hit while writing this file. Verify any change to it by planting a mutation:
replace the measured `amountOut` in `_executeAdapterRoute` with the adapter's return value and
confirm `test_lying_adapter_*` fail. If they still pass, the tests have stopped testing.

Foundry is at `/home/openhands/.foundry/bin`; add it to `PATH` if `forge` is missing. It is
**not** installed by default in a fresh environment — the toolchain is ephemeral and vanishes
between sessions while the checkout survives, so `forge test` failing with "command not found"
means the environment was recycled, not that the repo is broken. Run
`./script/bootstrap-foundry.sh`, which downloads the pinned release tarball and refuses to
extract it unless the SHA-256 from the same release matches. Do not pipe a remote install
script into a shell.

## Fork tests: read this first

Fork tests run against **live Base state**, and several traps are specific to that:

- **The fork block is pinned** in `setUp` via `vm.createSelectFork(rpc, BASE_FORK_BLOCK)`.
  Do not remove the pin. An unpinned fork head made the suite flaky in two ways: a moving head
  changes pool depth, so a dislocation sized for one block is too small for the next; and
  unpinned forks fetch more state, which trips the public endpoint's rate limit and makes
  `setUp` itself revert.
- **A flaky fork test that fails with tiny gas (20–30k) failed in `setUp`, not in the test
  logic.** That is the signature of RPC throttling, not a real assertion failure. Check the
  gas number before debugging the route.
- **The default RPC is the public Base endpoint**, which rate-limits aggressively (HTTP 429).
  Set `BASE_RPC_URL` to a private node for anything beyond a single run.

## How to write a fork test that actually tests something

The hard part is that a profitable opportunity does not exist at an arbitrary block. The
working pattern here is to **manufacture the dislocation**, the same way it appears in
production — push a large trade through a thin pool:

```solidity
deal(WETH, address(this), wethIn);           // self-contained; no live opportunity needed
router.exactInputSingle(... amountIn: wethIn ...);
```

Two lessons that cost real debugging time:

- **Size the dislocation against the pool's depth, not in absolute terms.** 400 WETH through
  Base's 0.3% WETH/USDC pool moves the price ~0.1% because that pool holds ~18,000 WETH;
  30 WETH through the 0.01% pool moves it a lot because that pool holds ~47 WETH. Query the
  pool's balances first (`cast call <token> "balanceOf(address)" <pool>`).
- **Quote a direction, then execute the direction you quoted.** A helper that picks the best
  of two directions and a caller that hardcodes one of them will apply the wrong floor and
  revert with "too little received". Return which direction won and branch on it.

Assert the revert **by selector and arguments**, not with a bare `vm.expectRevert()`. A bare
expectation passes for the wrong reason, which is how a test can look green while proving
nothing.

## Adapters

`IAdapter` is deliberately tiny. To add a venue, implement `name()` and `swap()`, encode the
pool in `poolData`, and read the venue's real interface from the chain before writing it:

```bash
cast call <router> "defaultFactory()(address)" --rpc-url https://mainnet.base.org
cast sig "swapExactTokensForTokens(uint256,uint256,(address,address,bool,address)[],address,uint256)"
```

Venue-specific traps already hit once:

- **Uniswap V3 on Base is `SwapRouter02`**, whose `ExactInputSingleParams` has **no
  `deadline`** (selector `0x04e45aaf`). The older `SwapRouter` variant has one
  (`0x414bf389`). Different contract, different encoding.
- **Aerodrome pools are `(from, to, stable, factory)`, not fee tiers.** A pair can exist twice
  — volatile and stable — so `stable` is part of the pool identity. WETH/USDC has both on
  Base, and the stable one holds ~2 WETH against ~1,657 in the volatile pool.

## Flash-loan providers

Three providers, each settling differently. Getting these wrong is the main source of
subtle bugs:

- **Morpho**: repayment is pulled with `transferFrom` *after* the callback returns.
- **Balancer V2**: the Vault re-reads its own balance, so repayment must be a `transfer`, not
  an approval.
- **Balancer V3**: `unlock` performs `Address.functionCall(msg.sender, data)`, so `data` must
  be **full callback calldata**, not raw arguments. The loan is pulled inside the `unlock`
  window, and the Vault tracks a transient per-token delta that must be declared with
  `settle`.

The profit floor is checked *before* money moves on the Balancer paths
(`_requireRepayable`), because a bare `transfer` of an unaffordable amount reverts with an
empty ERC20 error and hides the cause. Keep the `required`/`available` figures in
`_requireRepayable` identical to `_settleProfit`'s so a violation reports the same numbers
whichever check catches it.

## Scanner (TypeScript)

`scanner/` ports the Rust bot's discovery. It is read-only by construction.

The port covers three functions, and the test fixtures are shared between them:
`rankedOpportunities` and `bestCandidate` from `arbitrage.rs`, and `pickBestNet`
plus `canStillWin` from the same file, which decide which candidate is worth
simulating. `canStillWin`'s boundary is deliberately `>` and not `> net + 1`:
with a zero effective gas price a candidate one wei above the incumbent's net
wins outright, so pruning at `net + 1` would discard real opportunities. Both
sides of that boundary have a test.

Port coverage is a risk in itself: the Rust original tests a four-venue market
routing through the dislocated pool, a dead venue not poisoning the others, and
leg provenance reaching the opportunity. Those cases had no TypeScript
equivalent until they were added, so the port looked complete while three
behaviours were untested. When porting a function, port its tests too -- the
tests encode which cases the original author considered load-bearing.

```bash
BASE_RPC_URL=https://... npm run scan:once
npm run test:scanner                            # 42 unit tests, no network
BASE_RPC_URL=https://... npm run test:scanner:live   # fork + live tests
```

Key facts that cost debugging time:

- **The anvil fork must be mined explicitly.** The scanner's fork test relied on
  anvil's auto-mining and a swap would sit unmined while the approve before it
  landed, so the test failed with "tx ... was not mined" -- which reads like a
  viem or anvil bug. Call `anvil_mine` after sending and poll for the receipt.
- **Never hard-code a fork port.** A fixed port lets the test talk to whatever
  else is listening on it: anvil fails to start with "Address already in use",
  the test's RPC calls go to the *other* anvil, and the failure looks like a
  transaction that was not mined. Bind an ephemeral port instead, and assert the
  fork's `chainId` before using it.
- **Two phases, one block.** Leg 2's input is leg 1's output, so a single pass
  would have to guess the intermediate amount. Both phases must be pinned to the
  same block; legs priced across blocks describe a cycle that never existed.
- **Every venue must quote both directions.** The first implementation only
  quoted `loanToQuote`, so leg 2 was priced on leg 1's curve. The symptom was a
  "best spread" of -100% of the loan, which is impossible and is the tell that a
  direction is reversed rather than that markets are bad.
- **`eth_call` batching, not Multicall3.** QuoterV2 returns its answer by
  *reverting*, which would revert an enclosing multicall. Use JSON-RPC batches.
- **QuoterV2 returns four words; decode the first.** Reading the whole return
  blob as one integer yields ~1e75, which flows into profit math looking like a
  real quote.
- **A reverted call in a batch is normal** (a size larger than the pool's
  liquidity), so it maps to `null` and skips that size. A transport failure is
  different and must be retried and then thrown — a silently empty batch is
  indistinguishable from "no opportunities found".
- **A provider error looks exactly like a revert, and is not one.** Base answers
  a throttled batch with HTTP 200 and a *per-call* error,
  `{"code":-32016,"message":"over rate limit"}`, in the same array position and
  the same shape as an `execution reverted`. The first implementation mapped
  every per-call error to `null`, so a throttled scan reported "no
  opportunities" — the scan could not tell a quiet market from an endpoint
  refusing to answer. Only code `3` (or a message containing "revert") is a
  revert; anything else is raised as `RetryableRpcError` and retried. This is
  why `test:scanner:live` against `https://mainnet.base.org` is flaky: the
  public endpoint throttles a burst of `eth_call`s, and the retry budget is
  small. Use a private RPC for a full live run; a flaky live test here is the
  endpoint, not the scanner.
- **The local Aerodrome math must be cross-checked against the router.**
  `scanner/test/aerodrome.integration.test.ts` does exactly that, and it is the
  test that would catch a wrong fee or curve assumption. Reading the fee from
  the factory is not sufficient on its own.

Aerodrome **stable** pools are refused, not approximated: their curve
(x³y + y³x = k) is not constant-product. The Rust bot refuses them too.

## RPC endpoints

Base RPCs used in this repo. A token in a URL is a secret: keep it in
`BASE_RPC_URL`, never in a committed file.

| Endpoint | HTTP | WSS | Batch | `pending` | Archive |
|---|---|---|---|---|---|
| Chainstack (private) | 200 | OK | OK | +1 block | **no** (403) |
| Alchemy (private) | 200 | OK | OK | +1 block | yes |
| `mainnet.base.org` (public) | 200 | - | OK | +1 block | **throttles bursts** (-32016) |
| `base-rpc.publicnode.com` (public) | 200 | - | OK | - | **no** (403, needs token) |
| `1rpc.io/base` (public) | 200 | - | OK | - | - |

Two different requirements, and mixing them up produces a confusing failure:

- **The scanner** needs batch support and a pinned block, which all three
  endpoints can serve. Chainstack is fine here.
- **The fork tests** pin a historical block, which needs archive access.
  Chainstack answers `403 Archive, Debug and Trace requests are not available
  on your current plan`, and Foundry reports that as `could not instantiate
  forked environment` - which reads like a broken URL rather than a plan limit.
  Use Alchemy for `forge test --match-path "test/fork/*"`.

  "Historical" is relative: the default `BASE_FORK_BLOCK` (51668376) sits well
  inside a pruned full node's window, so `mainnet.base.org` ran all 17 fork
  tests against it without archive access. Only a block older than the node's
  retention needs an archive endpoint, so raise `BASE_FORK_BLOCK` deliberately
  if you raise it at all.

`mainnet.base.org` answers a burst of batched `eth_call`s with HTTP 200 and a
per-call `-32016 over rate limit`, so `test:scanner:live` against it is flaky by
construction; the retry budget covers a brief swallow, not sustained throttling.
`base-rpc.publicnode.com` serves that suite cleanly except the two tests that
fork a historical block, and it refuses archive reads without a token. Neither
public endpoint can run the full live suite; a private RPC can.

The public `mainnet.base.org` endpoint used to reject batch requests outright,
which broke the unpinned Foundry fork suite. It accepts them now.

## Mocks

`test/mocks/MockFlashLoanProviders.sol` mirrors the real Vaults' settlement mechanics
deliberately. A mock that forgives a mistake is worse than no mock, because it creates false
confidence — this is exactly how the V3 callback-encoding bug survived. When a provider
changes, update the mock to match reality, and prefer a fork test to prove the wiring.
