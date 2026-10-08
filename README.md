# StockCall

**Call the hour. Fund the market.** Hidden-entry forecast rounds and oracle-guarded liquidity for tokenized stocks on
Robinhood Chain, under one 48-hour timelock. Every fee buys **$CALL** and burns it.

- **The Arena.** Every hour has a card of questions about NVIDIA, Alphabet and ETH. Players answer with
  probabilities and stake ETH from their Arena balance. Entries are hidden until the round locks. After the hour,
  the contract reads 5-minute Uniswap TWAPs, checks them against Chainlink, scores everyone with proper scoring
  rules, and pays the better calibrated from the worse. 5% of winners' profit, and every forfeited stake, buys and
  burns $CALL.
- **The Founts.** Deposit USDG into a Fount, and it runs concentrated stock-token / USDG liquidity on Uniswap v4.
  70% of trading fees compound for depositors; 30% buys and burns $CALL.

## What is new in the Arena (vs StockOdds v1)

| | StockOdds v1 | StockCall |
|---|---|---|
| Entries | Public the moment you enter | **Hidden**: commit a hash, reveal after the lock. Nobody can copy the room |
| Money | Send ETH on every entry; claims pay to your wallet | **Play balance**: deposit once, play from it, winnings roll back in, withdraw anytime |
| Price check | Uniswap TWAP only | TWAP **guarded by Chainlink** (StockFount oracle): a pushed pool voids the round and refunds everyone |
| Not revealed | n/a | The stake is forfeited to the burn, so selective revealing never pays |
| Batching | none | `multicall`: claim and enter the next round in one transaction |
| Burn | $ODDS | $CALL, shared with the Founts |

## Layout

```
contracts/   Hardhat project (Solidity 0.8.26, OpenZeppelin 5.1, Uniswap v4 MIT files only)
  src/Arena.sol            forecast rounds: commit-reveal, play balance, Chainlink price guard, scoring
  src/BuyBurn.sol          Arena fees and forfeits -> $CALL (Pons pool) -> burned
  src/Fount*.sol, src/v4/  the Founts (from StockFount), DrawdownRetire burns $CALL
  src/governance/          GovernanceChecks (constructor checks), Timelock (OZ TimelockController)
  src/StockCall.sol        the deployed names: StockCallArena, StockCallFount, StockCallBuyBurn, StockCallBurn,
                           StockCallOracle, StockCallFeeRouter, StockCallRegistry, StockCallPosition,
                           StockCallSwapAdapter, StockCallTimelock (each adds nothing to the contract it names)
  lib/score.js             reference round math, to the wei with Arena.sol
  test/unit/               212 unit tests: Arena, BuyBurn, parity, the real oracle, and the Fount suite
  scripts/deploy.js        deploys both products under one timelock, then verifies
  scripts/verify.js        read-only on-chain proof that the deployer holds no power
  scripts/publish-source.js  publishes the source on Blockscout, so the explorer shows the StockCall names
launch/      launches $CALL on the Pons V2 launchpad from the dev wallet
tools/       encrypted keystores for wallets imported from MetaMask (~/.stockcall/keystores)
keeper/      keeper bot: reveals sealed Arena entries, settles rounds, flushes and burns, Fount upkeep (GitHub Actions)
app/         Next.js site: Play (hidden entries, balance, reveal, settle, claim), Founts, Burn, Safety, How it works,
             and /api/reveals, the sealed-reveal inbox the keeper reads (Vercel + Upstash Redis)
docs/        LAUNCH.md (step by step), SECURITY.md (trust model and audit scope)
```


## Commands

```bash
cd contracts && npm ci
npx hardhat test                    # 212 tests
npx hardhat run scripts/deploy.js   # local deploy with mocks, ends with on-chain verification
```

Launch: [docs/LAUNCH.md](docs/LAUNCH.md). Security model: [docs/SECURITY.md](docs/SECURITY.md).

**Do not open the Arena or the Founts to real money before an independent audit.** Forecast rounds with stakes may
not be allowed where you live. Nothing here is financial advice. Not affiliated with Robinhood, Uniswap, Chainlink
or Pons.

The Fount contracts derive from the MIT-licensed [Stonkwell](https://github.com/lilkiddo-d/StonkWell) contracts.
The round design follows the public description of an independent builders-camp project; this is an original
implementation.
