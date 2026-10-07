# Launching StockCall

Everything runs from the repo folder on your Mac. Nothing here ever asks you to paste a private key into a file.

> **Status:** the contracts, tests and deploy toolkit are ready. The keeper (settles Arena rounds, relays reveals,
> runs both buy-and-burns) and the website are the next build step. Do not deploy to mainnet before those exist
> and before an independent audit of the contracts in [SECURITY.md](SECURITY.md).

## What "rug-proof" means here

Three wallets matter, and none of them alone can take depositors' money:

| Wallet | What it is | Power |
|---|---|---|
| **Dev wallet** | A new MetaMask account. It pays the deploy gas and launches $CALL. | **None after deploy.** The contracts refuse to deploy if it would keep any role. |
| **Admin Safe** | A Safe multisig (for example 2 of 3 owners). | Proposes changes to the **timelock**. Every change waits **48 hours in public** before it can run. |
| **Guardian Safe** | A second Safe. | Can only **pause** deposits and **lower** limits. It cannot unpause, raise anything or move funds. |
| **Keeper** | A hot wallet whose key lives only in GitHub Actions. | Rebalances, harvests and runs buy-and-burn, within on-chain loss limits. Settling and revealing are open to anyone; the keeper just does them on time. |

The timelock is the admin of every contract. If anyone tries something bad, even the Safe owners, the change is
visible on-chain for 48 hours first. Depositors can always leave in kind (stock token plus USDG, with no price
needed), and Arena players can always withdraw their balance (withdrawals are never paused), so they have time to
exit. Run `./verify.sh` after deploying and post its output: it proves all of this
on-chain.

## Before you start

- Node.js 22 (`node -v`), git, and the GitHub CLI: `brew install gh && gh auth login`
- The repo cloned: `git clone https://github.com/patrick734/stockcall && cd stockcall`
- About 0.03 ETH on Robinhood Chain for the dev wallet, and 0.01 ETH for the keeper

## 1. Admin and guardian

Pick one:

- **Two Safes** on [app.safe.global](https://app.safe.global) (network: Robinhood Chain). Click "Activate account"
  on each, so it exists on-chain. Strongest option: you can add co-signers later without redeploying.
- **Two plain MetaMask wallets**, both new and different from the dev wallet and the keeper. Set
  `ALLOW_PLAIN_WALLETS=1` in `launch.env`, and save the admin wallet so the scripts can sign timelock actions:

  ```bash
  node tools/import-key.js stockcall-admin
  ```

  Then set `ADMIN_ACCOUNT=stockcall-admin` in `launch.env`. The guardian wallet only needs its address; you use
  it in MetaMask if you ever need to pause.

## 2. Dev wallet

In MetaMask: Add account > Create a new account. Send it 0.03 ETH on Robinhood Chain (straight from an exchange
is fine). Then save it as an encrypted keystore:

```bash
cd contracts && npm ci && cd ..
node tools/import-key.js stockcall-dev
```

Copy the key in MetaMask (Account details > Show private key) and press Enter. The tool reads it from the
clipboard, clears the clipboard, and asks for a password to encrypt it with. It shows only the address.

## 3. Keeper

```bash
node tools/wallet.js keeper-secret
```

This creates a new keeper wallet, stores its key **only** as the `KEEPER_PRIVATE_KEY` secret of your GitHub repo,
sets the repo variable `KEEPER_LIVE=0`, writes `KEEPER_ADDRESS` into `launch.env`, and prints the address. Send
that address 0.01 ETH.

## 4. Settings

```bash
cp -n launch.env.example launch.env
open -e launch.env
```

Fill in `ADMIN_MULTISIG` and `GUARDIAN_MULTISIG`, check `KEEPER_ADDRESS` and `DEPLOYER_ACCOUNT=stockcall-dev`,
and leave `CALL_TOKEN_ADDRESS` empty. If you have a private RPC (Alchemy), put it on the `ROBINHOOD_RPC_URL=`
line without the `#`.

## 5. Rehearse, then deploy

```bash
./launch.sh --rehearsal
```

This runs the complete deploy on a local copy of Robinhood Chain with your real settings and checks. It is free
and sends nothing. It must end with `REHEARSAL PASSED`.

Then, during US market hours (6:30 AM to 1:00 PM PT), run the real deploy:

```bash
./launch.sh
```

Type `DEPLOY` and enter the dev wallet's password. It ends by verifying that the deployer holds no power.

```bash
git add -A && git commit -m "Mainnet deployment" && git push
./verify.sh
```

Post the `./verify.sh` output.

## 6. Launch $CALL on Pons

Launch it on the Pons website from the dev wallet, or run `./launch-token.sh` (preflight) and then
`./launch-token.sh --launch`. Copy the token address, then:

```bash
./set-token.sh 0xTOKEN
```

This checks the token. One timelock batch sets $CALL in both burners, `DrawdownRetire` (Fount fees) and
`BuyBurn` (Arena fees and forfeits), each only once. Then:

- **Plain-wallet admin:** `./set-token.sh 0xTOKEN --schedule` now, and `./set-token.sh 0xTOKEN --execute`
  48 hours later. Each asks for the admin wallet's password.
- **Safe admin:** it writes two files to `safe-txs/`. In the Safe, open Apps > Transaction Builder, drag in
  `set-token-1-schedule.json` and sign. 48 hours later, do the same with `set-token-2-execute.json`.

`./govern.sh status` shows when it is ready.

## 7. Keeper

GitHub > Actions > **Keeper** > Run workflow. While `KEEPER_LIVE` is `0`, it only simulates and logs. When a few
runs look healthy, set the repo variable `KEEPER_LIVE` to `1` (Settings > Secrets and variables > Actions >
Variables). It then runs every 15 minutes.

## 8. After $CALL graduates on Pons

```bash
./govern.sh register-pool
```

Same flow: `--schedule`, then `--execute` 48 hours later (or the two Safe files). Once executed, the keeper starts
buying and burning $CALL with the Founts' 30% share. Until then, those fees wait safely in `DrawdownRetire`.
`BuyBurn` needs no registration: it buys straight from the $CALL / ETH Pons pool once that pool exists, and
until then Arena fees wait in `BuyBurn`.

## Troubleshooting

- **`BadRecordMac` or a dropped connection:** the public RPC is flaky. Set `ROBINHOOD_RPC_URL` in `launch.env`.
- **Prices stale in the preflight:** outside US market hours. Deploy between 6:30 AM and 1:00 PM PT.
- **`no USDG pool keeps 6300 observations`:** the Arena needs each TWAP pool to remember about 1h45m. Anyone can
  raise a pool's memory by calling `increaseObservationCardinalityNext(6300)` on it (it costs gas once).
- **`already deployed`:** `contracts/deployments/robinhood.json` exists. Use `FORCE=1 ./launch.sh` only if you
  really want a second, separate deployment.
