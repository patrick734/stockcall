const { ethers, network } = require("hardhat");
const { time } = require("@nomicfoundation/hardhat-network-helpers");

const USDG = (n) => ethers.parseUnits(String(n), 6);
const EQ = (n) => ethers.parseUnits(String(n), 18);
const FEED = (n) => ethers.parseUnits(String(n), 8);
const WAD = 10n ** 18n;
const DELAY = 48 * 3600;

// Oracle defaults used by every fixture: generous bounds, a 50% / 5-minute circuit breaker.
const BOUNDS = { min: FEED("0.01"), max: FEED(1_000_000) };
const USDG_BOUNDS = { min: FEED("0.5"), max: FEED("1.5") };
const BREAKER = { bps: 5_000, cooldown: 300 };

/** Rate for MockSwapAdapter: out = in * rate / 1e18. */
function rate(outPerInUnit, inDecimals, outDecimals) {
  return (ethers.parseUnits(String(outPerInUnit), outDecimals) * WAD) / 10n ** BigInt(inDecimals);
}

/**
 * Deploys a real OpenZeppelin TimelockController (48h, proposer/executor = `multisig`, no admin) and
 * returns it with an impersonated signer for its address. Unit tests call admin functions through that
 * signer to exercise contract logic directly; governance.test.js covers the schedule/execute path.
 */
async function deployTimelock(multisig) {
  const timelock = await ethers.deployContract("TimelockController", [DELAY, [multisig.address], [multisig.address], ethers.ZeroAddress]);
  await network.provider.send("hardhat_setBalance", [timelock.target, "0x56BC75E2D63100000"]);
  const admin = await ethers.getImpersonatedSigner(timelock.target);
  return { timelock, admin };
}

function feedInit(token, feed, maxAge = 3600, bounds = BOUNDS) {
  return { token: token.target ?? token, aggregator: feed.target ?? feed, maxAge, minAnswer: bounds.min, maxAnswer: bounds.max };
}

async function deployOracle(admin, sequencer, usdgFeed, feeds = [], breaker = BREAKER) {
  return ethers.deployContract("FountOracle", [
    admin.address ?? admin,
    sequencer,
    { feed: usdgFeed, maxAge: 90_000, decimals: 6, minAnswer: USDG_BOUNDS.min, maxAnswer: USDG_BOUNDS.max },
    breaker.bps,
    breaker.cooldown,
    feeds,
  ]);
}

async function deployFount(ctx, ticker, price) {
  const { admin, guardian, keeper, usdg, oracle, swap, feeRouter } = ctx;
  const equity = await ethers.deployContract("MockStockToken", [`${ticker} Equity Token`, ticker]);
  const feed = await ethers.deployContract("MockAggregator", [8, FEED(price)]);
  await oracle.connect(admin).setFeed(equity, feed, 3600, BOUNDS.min, BOUNDS.max);

  const position = await ethers.deployContract("MockPosition", [equity, usdg, USDG(price)]);
  const fount = await ethers.deployContract("Fount", [
    {
      usdg: await usdg.getAddress(),
      equityToken: await equity.getAddress(),
      position: await position.getAddress(),
      oracle: await oracle.getAddress(),
      swapAdapter: await swap.getAddress(),
      feeRouter: await feeRouter.getAddress(),
      admin: admin.address,
      guardian: guardian.address,
      keeper: keeper.address,
      heldValueCap: USDG(1_000_000),
    },
    `StockFount ${ticker} Fount`,
    `f${ticker}`,
  ]);
  await position.bind(fount);

  await swap.setRate(equity, usdg, rate(price, 18, 6));
  await swap.setRate(usdg, equity, rate(1 / price, 6, 18));
  await equity.mint(swap, EQ(1_000_000));
  return { equity, feed, position, fount };
}

async function baseFixture() {
  const [deployer, multisig, guardian, keeper, alice, bob, carol] = await ethers.getSigners();
  const { timelock, admin } = await deployTimelock(multisig);

  const usdg = await ethers.deployContract("MockERC20", ["Global Dollar", "USDG", 6]);
  const sequencer = await ethers.deployContract("MockAggregator", [0, 0]);
  const now = await time.latest();
  await sequencer.set(0, now - 7200, now);
  const usdgFeed = await ethers.deployContract("MockAggregator", [8, FEED(1)]);
  const oracle = await deployOracle(admin, sequencer, usdgFeed);

  const swap = await ethers.deployContract("MockSwapAdapter");
  const burnToken = await ethers.deployContract("CallToken", [admin.address, EQ(1_000_000_000)]);
  const drawdown = await ethers.deployContract("DrawdownRetire", [
    burnToken,
    swap,
    admin.address,
    guardian.address,
    keeper.address,
    3600,
    [],
    [],
  ]);
  const feeRouter = await ethers.deployContract("FeeRouter", [admin.address, drawdown]);

  await usdg.mint(swap, USDG(100_000_000));
  await burnToken.connect(admin).transfer(swap, EQ(100_000_000));
  await swap.setRate(usdg, burnToken, rate(100, 6, 18));

  for (const user of [alice, bob, carol]) await usdg.mint(user, USDG(1_000_000));

  const ctx = { deployer, multisig, timelock, admin, guardian, keeper, alice, bob, carol, usdg, usdgFeed, sequencer, oracle, swap, burnToken, drawdown, feeRouter };
  const amd = await deployFount(ctx, "AMD", 150);
  return { ...ctx, amd };
}

async function sink(ctx, fount, user, amount) {
  await ctx.usdg.connect(user).approve(fount, amount);
  await fount.connect(user).deposit(amount, user.address);
}

/** Schedules `target.fn(...args)` on the timelock from the multisig, waits the delay, executes it. */
async function viaTimelock(ctx, target, fn, args = [], salt = ethers.ZeroHash) {
  const data = target.interface.encodeFunctionData(fn, args);
  const tl = ctx.timelock.connect(ctx.multisig);
  await tl.schedule(target, 0, data, ethers.ZeroHash, salt, DELAY);
  await time.increase(DELAY);
  return tl.execute(target, 0, data, ethers.ZeroHash, salt);
}

module.exports = { USDG, EQ, FEED, WAD, DELAY, BOUNDS, USDG_BOUNDS, BREAKER, rate, deployTimelock, feedInit, deployOracle, deployFount, baseFixture, sink, viaTimelock };
