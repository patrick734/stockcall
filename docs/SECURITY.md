# StockCall security model

StockCall is two products under one 48h timelock:

- **The Arena** (`Arena`, `BuyBurn`): hourly forecast rounds on tokenized stocks and ETH, with hidden entries, a play
  balance and a Chainlink price guard. Fees and forfeits buy and burn $CALL.
- **The Founts** (`Fount`, `FountOracle`, `FeeRouter`, `DrawdownRetire`, `FountRegistry`, `v4/*`): oracle-guarded
  stock / USDG liquidity on Uniswap v4. 30% of trading fees buy and burn $CALL.

The Fount contracts are the StockFount contracts (themselves built on the MIT-licensed Stonkwell contracts), with
$FOUNT replaced by $CALL. The Arena is a new version of the StockOdds round engine.

## Roles

| Role | Holder | Can | Cannot |
|---|---|---|---|
| Admin | OpenZeppelin `TimelockController`, 48h delay, proposer and executor = admin Safe, no external admin | add new Arena cards and assets (existing ones are permanent), change the schedule, limits and fee for future rounds (within code caps; a fee change also waits 24h in the contract), tune the price guard (50 to 2,000 ticks, never off), unpause, set $CALL once in each burner; for the Founts, everything in the StockFount model | move any player balance or stake; change a card, asset, fee or guard for a round already in play; send fees anywhere but `BuyBurn`; withdraw from `BuyBurn` or `DrawdownRetire`; switch off the oracle's circuit breaker |
| Guardian | A second Safe or wallet | pause new Arena deposits and commits, halt the burn; pause Founts and lower their caps | unpause, raise anything, block reveals, settling, claims or withdrawals |
| Keeper | Hot wallet, key only in GitHub Actions | run buy-and-burn within per-run caps and a minimum interval; Fount rebalances and harvests | anything else. Revealing, settling and flushing are open to anyone |
| Deployer | Fresh wallet | launch $CALL on Pons | **nothing after deployment** |

Every contract with roles runs `GovernanceChecks` in its constructor: the admin must be a timelock with at least
48h delay that the deployer cannot use, and the roles must be distinct. `scripts/verify.js` checks the timelock's
bytecode against OpenZeppelin's and replays every role event, for both products.

## Arena

**Money paths.** ETH sits in three places: player balances (`balanceOf`, summed in `totalBalances`), stakes in
rounds, and `feesAccrued`. It leaves only through `withdraw` (or `claim(..., true)`) to the wallet that owns the
balance, and through `flushFees` to the immutable `feeSink` (`BuyBurn`). There is no admin transfer function.
`BuyBurn` has no withdraw function: ETH leaves it only as $CALL bought in the Pons pool, and $CALL only as a burn.

**Hidden entries (commit and reveal).** From `opens` to `locks` (five minutes before the hour) players commit
`keccak256(chainid, arena, round, player, probs, salt)` with their stake. From `locks` to the start of the hour
anyone holding the preimage can reveal, so a relay can reveal for a player who is offline. Before the lock the
room's forecasts are hidden, so nobody can copy them or shade toward them.

**Forfeits.** A stake whose entry is not revealed by the start of the hour is forfeited to `BuyBurn`, in every
outcome (including a void round). This is what makes commit-reveal safe: a player who commits several forecasts
from several wallets and reveals only the ones that look good loses the full stake of every hidden one, which is
always more than those entries could lose by being revealed. The reveal window closes before the hour starts, so
there is almost no outcome information to act on anyway. Forfeited stakes never change other players' payouts:
scoring uses only revealed entries and their pot.

**Play balance.** Deposits, winnings and refunds sit in the balance; commits draw from it. `multicall` lets a
player claim and commit in one transaction. `multicall` is not payable, so ETH sent with it cannot be counted
twice.

**Pause never traps funds.** The guardian's pause stops deposits and commits only. Reveals, settling, claims,
withdrawals and fee flushes always work, so a pause can never cause a forfeit.

**Price guard.** Each asset has a guard mode: off (ETH, which has no Chainlink feed), if-priced (the stocks), or
required. For a guarded asset:

- At the first reveal (or a public `snapshot`), during the start TWAP window, the Arena reads the asset's price
  from the StockFount oracle as a tick.
- At settlement it compares the start TWAP with that snapshot, and the end TWAP with the oracle's price then. A
  gap above the round's guard (300 ticks, about 3%) voids the round: every revealed entry is refunded in full and
  no fee is taken.
- The oracle's own protections apply: per-feed bounds, USDG within $0.95 to $1.05, and the circuit breaker (an
  answer that jumped more than 15% is unpriced for 30 minutes). An unpriced asset is skipped in if-priced mode
  and voids the round in required mode.
- A round whose guard was live at the start must settle within 30 minutes of its end, or it is voided, because
  a late oracle read no longer describes the end window. The keeper settles within minutes, and anyone can.

This turns v1's main accepted risk, a trader holding a pool off its fair price through a 5-minute window, into
a refund instead of a payout, whenever the push is larger than the guard.

**Prices and timing** are unchanged from v1: one `observe` per asset at settlement, factory-verified USDG pools
only, timing from the clock with no keeper needed. Pools must keep at least 6,300 observations (P + W + 30 min +
10 min margin). A failing `observe` voids the round. `settle` reverts instead of voiding when it has under
200k gas left before a read.

**Math.** Identical to v1: exact integer Brier and ranked probability losses, payouts with floor division,
checked to the wei against the documented worked example and against `lib/score.js` on random rounds. Payouts
never exceed the revealed pot; at most 1 wei of dust per entry stays in the contract.

## Founts

See the StockFount model: timelock-owned from the constructor, hardened Chainlink oracle with bounds and a
circuit breaker, in-kind exits that never need a price, launch caps of $25,000 per Fount. The only change is the
burned token ($CALL instead of $FOUNT), which `DrawdownRetire` takes at construction or once from the timelock.

## Accepted risks

- **Small pushes.** A push smaller than the guard, or on ETH (no feed), is still possible. Soft margins, the
  weekday/weekend schedule and small caps (0.1 ETH per entry, 1 ETH per round) keep it unprofitable in most rounds.
- **Late settlement voids.** If nobody settles a guarded round within 30 minutes it is refunded. GitHub Actions
  schedules can run late, so the keeper should run at least every 15 minutes and the site should offer a Settle
  button.
- **Missed reveals forfeit.** A player who commits and neither reveals nor uses a relay loses the stake. The app
  must reveal automatically and warn clearly.
- **A relay sees forecasts after the lock.** Entries are closed by then, so it cannot copy them into the round.
- **Chainlink equity feeds pause when US markets close.** If-priced assets then play without the guard.
- **Wagering law.** Staked forecast rounds may be restricted in some jurisdictions.
- **No external audit yet.**

## Deployed names

`src/StockCall.sol` gives every deployed contract its StockCall name (`StockCallArena is Arena`, `StockCallFount is
Fount`, and so on). Each only passes its constructor arguments through and adds no code, so audit the contract it
names. `StockCallTimelock` is OpenZeppelin's `TimelockController` unchanged, and `verify.js` checks its bytecode.

## Audit scope

In scope: `src/StockCall.sol`, `src/Arena.sol`, `src/BuyBurn.sol`, `src/Fount.sol`, `src/FountOracle.sol`, `src/DrawdownRetire.sol`,
`src/FeeRouter.sol`, `src/FountRegistry.sol`, `src/governance/GovernanceChecks.sol`, `src/v4/*`, and the deploy
order in `scripts/deploy.js`.

Out of scope: mocks, tests, scripts other than deploy, and third-party contracts (Uniswap v3 and v4, Permit2,
Chainlink, USDG, Equity Tokens, Pons).
