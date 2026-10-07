// Deploys StockCall: the Founts (oracle-guarded liquidity) and the Arena (hidden-entry forecast rounds), under one
// 48h timelock. Every contract is configured in its constructor and governed by the timelock from its first block:
// the deployer wallet ends with no role, no ownership and nothing pending.
//
//   Local demo (mocks, seeded):  npx hardhat run scripts/deploy.js
//   Fork dry run:                FORK=1 DEPLOY_LIVE=1 npx hardhat run scripts/deploy.js
//   Robinhood Chain:             npx hardhat run scripts/deploy.js --network robinhood
//
// Live deploys read from env:
//   ADMIN_MULTISIG       proposer/executor of the timelock (a multisig contract, or a plain wallet with
//                        ALLOW_PLAIN_WALLETS=1)
//   GUARDIAN_MULTISIG    may pause and lower caps (a different multisig or wallet)
//   KEEPER_ADDRESS       rebalances, harvests and runs buy-and-burn (a hot wallet, not the deployer)
//   CALL_TOKEN_ADDRESS  optional: $CALL if it is already launched on Pons. Usually left empty: the protocol
//                        deploys first and the timelock sets $CALL once after the Pons launch (set-token.sh).
const fs = require("fs");
const path = require("path");
const { ethers, network } = require("hardhat");
const config = require("../config/robinhood.json");
const { equityFeedInit, usdgInit } = require("./lib/oracle-config");
const cards = require("../lib/cards");
const { verifyDeployment } = require("./verify");

const LIVE = network.name === "robinhood" || process.env.DEPLOY_LIVE === "1";
// Real role addresses: always on mainnet, and in a fork rehearsal when launch.env provides them.
const REAL_ROLES = network.name === "robinhood" || (LIVE && Boolean(process.env.ADMIN_MULTISIG));
const TIMELOCK_DELAY = 48 * 3600;
const usdgUnits = (n) => ethers.parseUnits(String(n), 6);
const wad = (n) => ethers.parseEther(String(n));

async function deploy(name, args = []) {
  const c = await ethers.deployContract(name, args);
  await c.waitForDeployment();
  console.log(`  ${name.padEnd(18)} ${await c.getAddress()}`);
  return c;
}

async function main() {
  const [deployer, ...rest] = await ethers.getSigners();
  const roles = REAL_ROLES
    ? { admin: required("ADMIN_MULTISIG"), guardian: required("GUARDIAN_MULTISIG"), keeper: required("KEEPER_ADDRESS") }
    : { admin: rest[0].address, guardian: rest[1].address, keeper: rest[2].address };
  await checkRoles(roles, deployer.address);

  console.log(`Deploying StockCall to ${network.name} from ${deployer.address}`);
  const chainId = Number((await ethers.provider.getNetwork()).chainId);
  const out = { network: network.name, chainId, deployer: deployer.address, roles, startBlock: await ethers.provider.getBlockNumber(), founts: {} };

  const timelock = await deploy("TimelockController", [TIMELOCK_DELAY, [roles.admin], [roles.admin], ethers.ZeroAddress]);
  out.timelock = await timelock.getAddress();

  const env = LIVE ? liveEnv() : await localEnv(out.timelock);
  out.usdg = env.usdg;

  // DEPLOY_WITHOUT_TOKEN=1 makes the local demo start without $CALL too, to rehearse set-token.sh.
  const burnToken = LIVE
    ? process.env.CALL_TOKEN_ADDRESS
      ? await existingCallToken(required("CALL_TOKEN_ADDRESS"))
      : null
    : process.env.DEPLOY_WITHOUT_TOKEN === "1"
      ? null
      : env.burnToken;
  out.burnToken = burnToken ? await burnToken.getAddress() : null;
  if (!burnToken) console.log(`  ${"$CALL".padEnd(18)} not launched yet: set it after the Pons launch with ./set-token.sh`);

  const tickers = config.launch.founts;
  // The oracle prices every Fount's stock and every stock the Arena guards.
  const priced = [...new Set([...tickers, ...cards.guardedTickers()])];
  const feedInits = [];
  for (const ticker of priced) {
    const t = env.equity[ticker];
    feedInits.push(LIVE ? await equityFeedInit(ethers, ticker) : localFeedInit(t));
  }
  const oracle = await deploy("FountOracle", [
    out.timelock,
    env.sequencerFeed,
    LIVE ? await usdgInit(ethers) : localUsdgInit(env.usdgFeed),
    config.oracle.maxJumpBps,
    config.oracle.jumpCooldownSeconds,
    feedInits,
  ]);
  out.oracle = await oracle.getAddress();

  let swap;
  if (LIVE) {
    // Buy-and-burn route: fee token -> USDG -> native ETH -> $CALL. The $CALL / ETH pool is a Pons launchpad
    // pool behind the Pons hook; it exists only after graduation and is registered through the timelock with
    // scripts/register-fount-pool.js. The hook and every hookless pool the Founts use are set here.
    const eth = config.uniswap.ethUsdgPool;
    const pools = [
      { currency0: ethers.ZeroAddress, currency1: env.usdg, fee: eth.fee, tickSpacing: eth.tickSpacing, hooks: ethers.ZeroAddress },
      ...tickers.map((ticker) => poolKey(env.equity[ticker].address, env.usdg, env.equity[ticker].fee, env.equity[ticker].tickSpacing)),
    ];
    swap = await deploy("V4SwapAdapter", [out.timelock, config.uniswap.poolManager, env.usdg, [config.pons.hook], pools]);
  } else {
    swap = env.swap;
  }
  out.swapAdapter = await swap.getAddress();
  if (!LIVE) out.swapAdapterIsMock = true;

  // Small per-run buys: a fresh Pons pool holds a few ETH, so large buys move its price a lot.
  const inputTokens = [env.usdg, ...tickers.map((t) => env.equity[t].address)];
  const inputLimits = [usdgUnits(config.launch.drawdownMaxUsdgPerRun), ...tickers.map(() => wad(config.launch.drawdownMaxEquityPerRun))];
  const drawdown = await deploy("DrawdownRetire", [
    out.burnToken ?? ethers.ZeroAddress,
    out.swapAdapter,
    out.timelock,
    roles.guardian,
    roles.keeper,
    config.launch.drawdownMinIntervalSeconds,
    inputTokens,
    inputLimits,
  ]);
  out.drawdownRetire = await drawdown.getAddress();

  const feeRouter = await deploy("FeeRouter", [out.timelock, out.drawdownRetire]);
  out.feeRouter = await feeRouter.getAddress();

  const listings = [];
  for (const ticker of tickers) {
    const t = env.equity[ticker];
    const position = LIVE
      ? await deploy("FountPositionV4", [
          config.uniswap.poolManager,
          config.uniswap.positionManager,
          config.uniswap.permit2,
          out.oracle,
          poolKey(t.address, env.usdg, t.fee, t.tickSpacing),
          t.address,
          env.usdg,
        ])
      : await deploy("MockPosition", [t.address, env.usdg, usdgUnits(t.price)]);

    const fount = await deploy("Fount", [
      {
        usdg: env.usdg,
        equityToken: t.address,
        position: await position.getAddress(),
        oracle: out.oracle,
        swapAdapter: out.swapAdapter,
        feeRouter: out.feeRouter,
        admin: out.timelock,
        guardian: roles.guardian,
        keeper: roles.keeper,
        heldValueCap: usdgUnits(config.launch.heldValueCapUsdg),
      },
      `StockCall ${ticker} Fount`,
      `f${ticker}`,
    ]);
    // The position's one-time bind is the deployer's last act; verify.js checks it points at this Fount.
    await (await position.bind(fount)).wait();
    listings.push({ target: await fount.getAddress(), kind: 0, ticker });
    out.founts[ticker] = { fount: await fount.getAddress(), position: await position.getAddress(), equityToken: t.address, name: t.name };
  }

  const registry = await deploy("FountRegistry", [out.timelock, listings]);
  out.registry = await registry.getAddress();

  // ---------------------------------------------------------------- Arena
  const a = config.arena;
  const arenaEnv = LIVE ? await liveArenaEnv() : await localArenaEnv(env, out.oracle);
  Object.assign(out, { v3Factory: arenaEnv.v3Factory, poolManager: arenaEnv.poolManager, ponsHook: arenaEnv.ponsHook, assets: arenaEnv.assets });
  const buyBurn = await deploy("BuyBurn", [
    arenaEnv.poolManager,
    arenaEnv.ponsHook,
    config.pons.poolFee,
    config.pons.poolTickSpacing,
    out.timelock,
    roles.guardian,
    roles.keeper,
    wad(a.burn.maxEthPerRun),
    a.burn.minIntervalSeconds,
    out.burnToken ?? ethers.ZeroAddress,
  ]);
  out.buyBurn = await buyBurn.getAddress();
  const arena = await deploy("Arena", [
    {
      admin: out.timelock,
      guardian: roles.guardian,
      v3Factory: arenaEnv.v3Factory,
      usdg: env.usdg,
      oracle: out.oracle,
      feeSink: out.buyBurn,
      feeBps: a.feeBps,
      guardTicks: a.guardTicks,
      minStake: wad(a.minStake),
      maxStake: wad(a.maxStake),
      roundCap: wad(a.roundCap),
      weekdaySchema: a.cards.weekday.id,
      weekendSchema: a.cards.weekend.id,
      weekdayHours: cards.weekdayBitmap(),
      assets: cards.assetInits(arenaEnv.assets),
      schemas: cards.schemas(),
    },
  ]);
  out.arena = await arena.getAddress();

  if (!LIVE) await seedLocal(out, env, rest);

  // Only a real mainnet deploy may write robinhood.json; a fork rehearsal always writes fork.json.
  const label = network.name === "robinhood" ? "robinhood" : LIVE ? "fork" : network.name;
  const file = path.join(__dirname, "..", "deployments", `${label}.json`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
  console.log(`\nWrote ${path.relative(process.cwd(), file)}\n`);

  let failures;
  try {
    failures = await verifyDeployment(ethers, out, { requireMultisigs: REAL_ROLES && process.env.ALLOW_PLAIN_WALLETS !== "1" });
  } catch (e) {
    console.error(`\nThe contracts ARE deployed (${path.relative(process.cwd(), file)}), but verification could not finish:`);
    console.error(`  ${e.shortMessage || e.message}`);
    console.error("Do NOT deploy again. Run ./verify.sh to finish the checks.");
    process.exit(3);
  }
  if (failures) {
    console.error(`\n${failures} verification check(s) failed. Do not announce this deployment.`);
    process.exitCode = 1;
  } else if (network.name === "robinhood") {
    console.log("\nNext: launch $CALL on Pons, then ./set-token.sh <address>; after graduation, ./govern.sh register-pool");
  }
}

async function checkRoles(roles, deployer) {
  const all = [roles.admin, roles.guardian, roles.keeper].map((a) => a.toLowerCase());
  if (new Set(all).size !== all.length) throw new Error("admin, guardian and keeper must be three different addresses");
  if (all.includes(deployer.toLowerCase())) throw new Error("the deployer must not hold any role: use a fresh wallet for deploying");
  if (REAL_ROLES && process.env.ALLOW_PLAIN_WALLETS !== "1") {
    for (const name of ["admin", "guardian"]) {
      if ((await ethers.provider.getCode(roles[name])) === "0x") throw new Error(`${name} ${roles[name]} must be a multisig contract, not a plain wallet`);
    }
  }
}

// DrawdownRetire stores the token immutably and calls burn(uint256) on it, so reject anything that can't burn.
async function existingCallToken(address) {
  if ((await ethers.provider.getCode(address)) === "0x") throw new Error(`No contract at CALL_TOKEN_ADDRESS ${address}`);
  const token = await ethers.getContractAt("CallToken", address);
  const [symbol, decimals, supply] = await Promise.all([token.symbol(), token.decimals(), token.totalSupply()]);
  if (decimals !== 18n) throw new Error(`$CALL must have 18 decimals, got ${decimals}`);
  try {
    await token.burn.staticCall(0);
  } catch {
    throw new Error(`Token at ${address} does not support burn(uint256), which DrawdownRetire requires`);
  }
  console.log(`  ${"$CALL".padEnd(18)} ${address} (${symbol}, supply ${ethers.formatEther(supply)})`);
  return token;
}

function required(name) {
  const v = process.env[name];
  if (!v || !ethers.isAddress(v)) throw new Error(`${name} must be set to an address for live deploys`);
  return ethers.getAddress(v);
}

function poolKey(equity, usdg, fee, tickSpacing) {
  const [currency0, currency1] = BigInt(equity) < BigInt(usdg) ? [equity, usdg] : [usdg, equity];
  return { currency0, currency1, fee, tickSpacing, hooks: ethers.ZeroAddress };
}

function liveEnv() {
  const pools = require("../config/robinhood.pools.json");
  const equity = {};
  for (const [ticker, t] of Object.entries(config.equityTokens)) {
    const p = pools[ticker] && pools[ticker].pool;
    equity[ticker] = {
      address: t.address,
      feed: t.chainlinkFeed,
      name: t.name,
      fee: p ? p.fee : config.uniswap.defaultFee,
      tickSpacing: p ? p.tickSpacing : config.uniswap.defaultTickSpacing,
    };
  }
  return {
    usdg: config.tokens.usdg.address,
    sequencerFeed: config.chainlink.sequencerUptimeFeed || ethers.ZeroAddress,
    equity,
  };
}

async function liveArenaEnv() {
  // On a fork, reads at the forked block itself fail ("no known hardfork for execution on historical block"):
  // mine one local block first so every read runs on a block the local node owns.
  if (network.name === "hardhat") await network.provider.send("hardhat_mine", ["0x1"]);
  const found = await cards.findPools(ethers, ethers.provider);
  const assets = {};
  const min = config.arena.minObservations;
  for (const [sym, f] of Object.entries(found)) {
    if (!f.best || f.best.cardinality < min) {
      throw new Error(`${sym}: no USDG pool keeps ${min} observations (best: ${f.best ? f.best.cardinality : "none"}). Anyone can raise it with increaseObservationCardinalityNext on the pool.`);
    }
    assets[sym] = { token: f.token, pool: f.best.pool, fee: f.best.fee, observations: f.best.cardinality };
    console.log(`  ${(sym + " pool").padEnd(18)} ${f.best.pool} (${f.best.fee / 10000}% fee, ${f.best.cardinality} observations)`);
  }
  return {
    v3Factory: ethers.getAddress(config.uniswap.v3Factory),
    poolManager: ethers.getAddress(config.uniswap.poolManager),
    ponsHook: ethers.getAddress(config.pons.hook),
    assets,
  };
}

// ---------------------------------------------------------------- local demo

const DEMO_PRICES = { TSLA: 378.34, NVDA: 224.41, AAPL: 336.31, PLTR: 191.53, META: 778.25, GOOGL: 342.66, SPY: 766.89 };

function localFeedInit(t) {
  const answer = BigInt(Math.round(t.price * 1e8));
  return { token: t.address, aggregator: t.feed, maxAge: config.chainlink.equityMaxAge, minAnswer: answer / 10n, maxAnswer: answer * 10n };
}

function localUsdgInit(feed) {
  return { feed, maxAge: config.chainlink.usdgMaxAge, decimals: 6, minAnswer: ethers.parseUnits(config.oracle.usdgMinUsd, 8), maxAnswer: ethers.parseUnits(config.oracle.usdgMaxUsd, 8) };
}

async function localEnv(timelock) {
  console.log("Local demo: deploying mock USDG, $CALL, Equity Tokens, feeds and swap venue");
  const usdg = await deploy("MockERC20", ["Global Dollar", "USDG", 6]);
  const usdgFeed = await deploy("MockAggregator", [8, 100_000_000]);
  const swap = await deploy("MockSwapAdapter");
  // On mainnet $CALL comes from Pons; locally a stand-in is minted to the swap venue so buy-and-burn works.
  const [deployer] = await ethers.getSigners();
  const burnToken = await deploy("CallToken", [deployer.address, wad(2_000_000_000)]);
  await (await burnToken.transfer(swap, wad(1_000_000_000))).wait();
  await (await usdg.mint(swap, usdgUnits(100_000_000))).wait();
  await (await swap.setRate(usdg, burnToken, wad(100) * 10n ** 18n / 10n ** 6n)).wait();
  const equity = {};
  for (const ticker of [...new Set([...config.launch.founts, ...cards.guardedTickers()])]) {
    const price = DEMO_PRICES[ticker];
    const token = await deploy("MockStockToken", [`${config.equityTokens[ticker].name} Equity Token`, ticker]);
    const feed = await deploy("MockAggregator", [8, Math.round(price * 1e8)]);
    await (await token.mint(swap, wad(1_000_000))).wait();
    await (await swap.setRate(token, usdg, (usdgUnits(price) * 10n ** 18n) / 10n ** 18n)).wait();
    await (await swap.setRate(usdg, token, (10n ** 36n) / usdgUnits(price))).wait();
    equity[ticker] = { address: await token.getAddress(), feed: await feed.getAddress(), name: config.equityTokens[ticker].name, price, token };
  }
  return { usdg: await usdg.getAddress(), usdgToken: usdg, usdgFeed: await usdgFeed.getAddress(), sequencerFeed: ethers.ZeroAddress, swap, equity, burnToken, timelock };
}

/** Local Uniswap stand-ins for the Arena: TWAP pools at the oracle's prices and a v4 pool for $CALL. */
async function localArenaEnv(env, oracleAddress) {
  const factory = await deploy("MockV3Factory");
  const pm = await deploy("MockPoolManager");
  const ponsHook = "0x0000000000000000000000000000000000000044";
  const oracle = await ethers.getContractAt("FountOracle", oracleAddress);
  const now = (await ethers.provider.getBlock("latest")).timestamp;
  const assets = {};
  for (const [sym, cfg] of Object.entries(config.arena.assets)) {
    const token = cfg.token === "weth" ? await deploy("MockERC20", ["Wrapped Ether", "WETH", 18]) : env.equity[cfg.token].token;
    const pool = await deploy("MockOraclePool", [token, env.usdg, 500]);
    await (await factory.register(pool, token, env.usdg, 500)).wait();
    // Flat at the oracle's price (ETH at tick 0), from two days ago; the demo keeper can add moves.
    let tick = 0;
    if (cfg.token !== "weth") {
      const value = await oracle.usdgValue(token, wad(1));
      const assetTick = Math.round(Math.log(Number(value) / 1e18) / Math.log(1.0001));
      tick = (await pool.token0()) === (await token.getAddress()) ? assetTick : -assetTick;
    }
    await (await pool.setTickAt(now - 2 * 86400, tick)).wait();
    assets[sym] = { token: await token.getAddress(), pool: await pool.getAddress(), fee: 500, observations: 10000 };
  }
  const key = { currency0: ethers.ZeroAddress, currency1: await env.burnToken.getAddress(), fee: config.pons.poolFee, tickSpacing: config.pons.poolTickSpacing, hooks: ponsHook };
  await (await env.burnToken.transfer(pm, wad(1_000_000_000))).wait();
  await (await pm.setPool(key, wad(1_000_000), wad("0.000001"))).wait();
  return { v3Factory: await factory.getAddress(), poolManager: await pm.getAddress(), ponsHook, assets };
}

async function seedLocal(out, env, [, , keeper, demoUser]) {
  console.log("Seeding demo balances and positions");
  const usdg = env.usdgToken;
  await (await usdg.mint(demoUser.address, usdgUnits(250_000))).wait();
  for (const [ticker, w] of Object.entries(out.founts)) {
    const fount = await ethers.getContractAt("Fount", w.fount);
    await (await usdg.connect(demoUser).approve(fount, usdgUnits(5_000))).wait();
    await (await fount.connect(demoUser).deposit(usdgUnits(5_000), demoUser.address)).wait();
    await (await fount.connect(keeper).rebalance(-600, 600, true, usdgUnits(2_500), "0x")).wait();
    const position = await ethers.getContractAt("MockPosition", w.position);
    const price = env.equity[ticker].price;
    await (await position.accrueFees(wad((25 / price).toFixed(6)), usdgUnits(25))).wait();
    await (await fount.harvest()).wait();
  }
  out.demoUser = demoUser.address;
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { main };
