# StockCall keeper

A small Node.js bot (ethers v6, CommonJS) that performs the protocol's routine keeper duties on a loop:

| # | Duty | Contract call | Who may call |
|---|------|---------------|--------------|
| 1 | Keep each Fount's range around the Chainlink price | `Fount.rebalance(tickLower, tickUpper, sellUsdg, swapAmount, route)` | `KEEPER_ROLE` |
| 2 | Collect swap fees | `Fount.harvest()` | anyone |
| 3 | Forward the protocol share | `FeeRouter.routeMany(tokens)` | anyone |
| 4 | Buy and burn $CALL with Fount fees | `DrawdownRetire.drawdown(tokenIn, amountIn, minCallOut, route)` | `KEEPER_ROLE` |
| 5 | Reveal sealed Arena entries, :55 to :00 | `Arena.multicall([reveal(n, player, probs, salt), ...])` | anyone |
| 6 | Read Chainlink for the start window if no reveal did | `Arena.snapshot(n)` | anyone |
| 7 | Settle ended rounds, within 30 minutes of the hour | `Arena.settle(n)` | anyone |
| 8 | Send Arena fees and forfeits to the burn | `Arena.flushFees()` | anyone |
| 9 | Buy and burn $CALL with Arena fees | `BuyBurn.burn(ethIn, minOut)` | `KEEPER_ROLE` |

The Arena duties run first in every cycle: they are the only time-critical ones. A round's reveal window is the five
minutes before its hour, and a round whose price guard was live must be settled within 30 minutes of its end or it
is refunded.

## Sealed reveals

Players commit a hash of their forecast. To reveal for them while they are offline, the site encrypts each reveal to
the keeper's **public** key (`keeperRevealKey` in the deployment file, written by `tools/wallet.js keeper-secret`)
and keeps the ciphertext in an inbox. In the reveal window the keeper reads the inbox, opens each reveal with its
key, checks it against the on-chain commitment, and reveals in batches of 20. The inbox only ever holds ciphertext.
Format: `src/sealed.js`. Inbox: `REVEAL_INBOX_URL` (`GET ?round=n` returning `{"reveals": [...]}`) or
`REVEAL_INBOX_FILE` (a JSON file keyed by round). With neither, the relay is off and players reveal on the site.

Every call is simulated first (`staticCall` from the keeper address). A reverting simulation is logged and skipped, so one failing Fount or token never stops the rest of the cycle.



## Setup

```bash
cd contracts && npm install && npx hardhat compile     # the keeper reads ABIs from contracts/artifacts
cd ../keeper && npm install
```

**ABIs** come from `contracts/artifacts` (the Hardhat build output). That keeps the keeper in lockstep with the Solidity source and covers `FountPositionV4` and `V4SwapAdapter`, which `app/src/generated/abis.ts` does not export. Re-run `npx hardhat compile` after contract changes. Point `KEEPER_ARTIFACTS_DIR` elsewhere if you ship the keeper without the contracts folder (copy `contracts/artifacts` next to it).

**Addresses** come from `contracts/deployments/<KEEPER_NETWORK>.json`, written by `contracts/scripts/deploy.js`. The keeper checks that the RPC's chainId matches the file.

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `KEEPER_PRIVATE_KEY` | none | Keeper wallet key (hex, with or without `0x`). Only read from the environment, never logged. Required when `DRY_RUN=0`. |
| `DRY_RUN` | dry run | **Only `DRY_RUN=0` sends transactions.** Anything else simulates every call and logs what it would send. |
| `RPC_URL` | `https://rpc.mainnet.chain.robinhood.com` | JSON-RPC endpoint. |
| `KEEPER_NETWORK` | `robinhood` | Picks `contracts/deployments/<name>.json`. |
| `KEEPER_ADDRESS` | `roles.keeper` from the deployment | Address to simulate from in a dry run without a key. |
| `KEEPER_CONFIG` | none | JSON file deep-merged over `config.json`. |
| `LOOP_INTERVAL_SECONDS` | `loopIntervalSeconds` in config | Seconds between cycles. |
| `REVEAL_INBOX_URL`, `REVEAL_INBOX_TOKEN` | none | The site's sealed-reveal inbox and its bearer token. |
| `REVEAL_INBOX_FILE` | none | A local inbox file instead (tests, self-hosting). |
| `HOUR_MODE_SECONDS` | `1500` | How long `--hour` stays up. |
| `LOG_JSON` | off | `1` prints one JSON object per line instead of text. |
| `LOG_LEVEL` | `info` | `debug` shows extra detail (e.g. harvest interval skips). |
| `KEEPER_DEPLOYMENTS_DIR`, `KEEPER_ARTIFACTS_DIR` | contracts folder | Override where deployments and ABIs are read from. |

## Running

```bash
# Dry run against mainnet (no key needed; simulates from roles.keeper)
node src/index.js --once

# Live, looping every loopIntervalSeconds
DRY_RUN=0 KEEPER_PRIVATE_KEY=0x... npm start
```

PowerShell (recommended, on Windows): `.\start.ps1` for a dry run, `.\start.ps1 -Live` to send. It asks for the key with
hidden input, so the key never lands in shell history or a file. Add `-Once` for a single cycle.

`--hour` stays up to `HOUR_MODE_SECONDS` and wakes for the next reveal window and again just after the hour. GitHub
Actions starts it at :45 every hour and runs a plain `--once` at :10 as a backup settle. GitHub can start scheduled
runs late, so for guaranteed reveals and settles also run the loop (`npm start`) on a machine that stays on.

`--once` (or `KEEPER_ONCE=1`) runs one cycle and exits with status 0, which also suits cron or a systemd timer. `SIGINT`/`SIGTERM` stop the loop after the current step.

### As a background service

Keep the key in a root-only env file, not in the unit or the repo.

**systemd** (`/etc/systemd/system/stockcall-keeper.service`):

```ini
[Unit]
Description=StockCall keeper
After=network-online.target

[Service]
WorkingDirectory=/opt/stockcall/keeper
EnvironmentFile=/etc/stockcall/keeper.env     # chmod 600: KEEPER_PRIVATE_KEY=..., DRY_RUN=0, RPC_URL=...
ExecStart=/usr/bin/node src/index.js
Restart=always
RestartSec=30
User=stockcall

[Install]
WantedBy=multi-user.target
```

`sudo systemctl enable --now stockcall-keeper && journalctl -u stockcall-keeper -f`

**pm2**: `pm2 start src/index.js --name stockcall-keeper` with the variables exported in that shell (or an ecosystem file outside the repo), then `pm2 save`.

## Configuration (`config.json`)

| Key | Default | Meaning |
|---|---|---|
| `loopIntervalSeconds` | 300 | Pause between cycles. |
| `txConfirmations`, `txTimeoutSeconds` | 1, 180 | How long to wait for each transaction. |
| `founts.only` | `[]` (all) | Restrict to these tickers. |
| `rebalance.halfWidthTicks` | 1200 | New range is about ±this many ticks (±12.7%) around the oracle price, snapped out to the pool's tick spacing. |
| `rebalance.edgeThresholdPct` | 15 | Rebalance when the pool tick is within this % of the range width from either edge, or outside it. |
| `rebalance.maxIdlePct` | 25 | Also rebalance when USDG/equity idle in the Fount (e.g. new deposits, which are not placed automatically) exceeds this % of Held Value. `0` disables. |
| `rebalance.minIdleUsdg` | 10 | Ignore idle value below this. |
| `rebalance.minSwapUsdg` | 5 | Skip the pre-rebalance swap when smaller than this. |
| `rebalance.routes` | `{}` | Per ticker, a hop list written USDG → … → equity (reversed for equity sales). Empty = the adapter's registered direct pool. |
| `harvest.intervalSeconds` | 21600 | Minimum time between harvests of one Fount. |
| `harvest.minFeesUsdg` | 0 | Wait until pending fees are worth at least this. |
| `feeRouter.enabled` | true | Route every non-zero fee token each cycle. |
| `drawdown.slippageBps` | 200 | `minCallOut = quote × (1 − slippage)`. |
| `drawdown.defaultRoute` | `["IN","USDG","ETH","CALL"]` | Hop list for every fee token (see below). |
| `drawdown.routes` | `{}` | Per-token override, keyed by ticker (`"META"`), `"USDG"` or token address. |

**Route hops** are addresses or names: `IN` (the token being sold), `USDG`, `ETH`/`NATIVE` (address(0), native ETH in Uniswap v4), `CALL`, or a Fount ticker such as `META`. Consecutive duplicates collapse, so the default route is `USDG → ETH → CALL` for USDG and `META → USDG → ETH → CALL` for META. `"default"` or `[]` sends an empty route (`0x`), which makes the swap adapter use its registered direct pool (or two hops via USDG). A route is sent as `abi.encode(address[])`, the format `V4SwapAdapter.swap` decodes.

## What each duty does

### 1. Rebalance (per Fount, needs `KEEPER_ROLE`)

Skipped (logged) when the Fount is paused, the keeper lacks the role, or the position is a mock without v4 views. Otherwise:

1. `Fount.priceFresh()` false → **log and skip**. This is normal outside US market hours and on weekends: the Chainlink equity feeds stop and `rebalance` would revert `Unpriced`.
2. Pool vs oracle: `FountPositionV4.spotUsdgValue(1 unit)` vs `FountOracle.usdgValue(1 unit)`. If the gap is above `Fount.maxPoolDeviationBps` (default 2%), `rebalance` would revert `PoolDeviation`, so the keeper logs a warning and skips. It cannot fix this itself: the pool must be arbitraged back.
3. Trigger: no active range with value to place, pool tick outside the range or within `edgeThresholdPct` of an edge, or idle balance above `maxIdlePct`. If the oracle-centred range equals the current range, it skips rather than churning.
4. New range: centred on the oracle price's tick, ±`halfWidthTicks`, aligned to the pool's `tickSpacing`.
5. Swap size: the value split the new range needs at the pool price, from `Fount.holdings()` valued by the oracle. `Fount` enforces `maxSwapLossBps` (default 1%) against the oracle on that swap, so the keeper simulates the full swap, then 1/2, 1/4 and finally no swap, and sends the first size that passes.

`rebalance` harvests first, so the harvest timer resets.

### 2. Harvest (per Fount)

There is no pending-fee view, so the keeper simulates `position.collectFees()` as the Fount (an `eth_call` with `from = Fount`), which returns exactly what `harvest()` would collect. It harvests when that is non-zero (and above `minFeesUsdg`), at most once per `intervalSeconds`. If the simulation fails it harvests unconditionally on the interval.

### 3. FeeRouter

Checks the router's balance of USDG and every Fount's Equity Token and calls `routeMany` with the non-zero ones. Runs after harvests so the same cycle forwards them.

### 4. Drawdown and retire (needs `KEEPER_ROLE`)

- Skips while `halted()`, and while `block.timestamp < lastDrawdown + minInterval`. **`lastDrawdown` is shared by every input token**, so only one drawdown can happen per `minInterval` (1 hour at launch) in total.
- Candidates: every fee token DrawdownRetire holds with a non-zero `maxInputPerRun`, sized `min(balance, maxInputPerRun)`, largest oracle value first. A held token with no input limit is logged as a governance to-do.
- Quote: `drawdown.staticCall(token, amount, 1, route)` from the keeper returns the $CALL the real swap delivers; `minCallOut = quote × (1 − slippageBps)`. The keeper then sends `drawdown(token, amount, minCallOut, route)`. If a token's quote reverts it logs the reason and tries the next one.

> **$CALL on Pons.** $CALL trades in a Uniswap v4 pool paired with **native ETH** behind the **Pons launchpad hook**. The swap adapter allows that hook and the ETH hop, and the deploy script registers the ETH/USDG leg, but the $CALL/ETH pool itself only exists once $CALL graduates on Pons. Until it is registered (`contracts/scripts/register-fount-pool.js`), the quote for the default route `… → ETH → CALL` reverts (`InvalidRoute()`), and the keeper logs `quote failed, skipping this token` on each cycle and carries on; nothing is sent. Once the pool is registered, drawdowns start on the next cycle without keeper changes. Pons pools are small at graduation, so keep `DrawdownRetire.maxInputPerRun` modest: on a fork, a 500 USDG buy moved a fresh Pons pool ~23% off spot.

## Not automated

- **Timelock/governance actions** (input limits, risk limits, unpausing). The keeper warns when it sees one is needed (e.g. `maxInputPerRun` is 0 for a held token).

## Testing

```bash
npm test          # offline unit tests: tick math, rebalance planning, routes, revert decoding
```

End-to-end against a local Hardhat node with the mock demo deploy (uses port 8547 so it does not clash with a node on 8545):

```bash
cd contracts
npx hardhat node --port 8547                                   # separate terminal
npx hardhat run scripts/deploy.js --network keeper             # writes deployments/keeper.json
cd ../keeper
npm run smoke
```

`npm run smoke` accrues fees on the mock positions, sets the mock swap venue's $CALL rates, advances a day, then runs the keeper with `DRY_RUN=1` (asserts nothing changed) and `DRY_RUN=0` (asserts every Fount harvested, FeeRouter emptied, $CALL retired, exactly one drawdown per interval, the key never printed), plus a rate-limit rerun and a next-interval drawdown. It refuses to run on anything but chainId 31337 and uses Hardhat's public dev account #3 (the local keeper).

`npm run arena-smoke` then plays one Arena round: three players commit, two hand the keeper sealed reveals (plus junk), and it checks that nothing is revealed before the lock, the dry run sends nothing, the live run reveals both in one batch and takes the Chainlink snapshot, the round settles after the hour, the fees and the third player's forfeited stake reach BuyBurn, and $CALL is bought and burned. Run `smoke` first, then `arena-smoke`: the Arena run's live cycles also do Fount upkeep. Delete `contracts/deployments/keeper.json` afterwards if you do not want it around.

The local demo uses `MockPosition`, which has no Uniswap v4 views, so rebalancing is covered by the unit tests only. Try it on a mainnet fork or testnet deployment in `DRY_RUN` before going live.

## Safety notes

- Default is dry run. Nothing is sent unless `DRY_RUN=0` is set explicitly.
- The keeper key only holds `KEEPER_ROLE` (rebalance, drawdown) plus gas money. Keep little ETH on it. On-chain limits bound what a compromised keeper can do: registered pools only, `maxSwapLossBps` on rebalances, `maxInputPerRun` and `minInterval` on drawdowns, and the guardian can pause Founts and halt drawdowns.
- The key is read only from `KEEPER_PRIVATE_KEY` and never logged. The RPC URL's credentials (`https://user:pass@...`) are masked in the startup log, but prefer a URL without secrets in it.
- `minCallOut` comes from a simulation in the same block the transaction is built in, so it protects against the price moving before inclusion, not against a pool that is already manipulated. `maxInputPerRun` is the real bound on drawdown losses; keep it small relative to the $CALL pool's depth.
- Stale prices on weekends are expected and logged at info level; persistent `PoolDeviation` or quote failures during market hours are worth an alert.
- Nonces are managed locally (ethers `NonceManager`) and resynced after any failed send. Run only one live keeper per key.
