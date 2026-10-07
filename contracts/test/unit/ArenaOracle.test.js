// The price guard against the real StockFount oracle (Chainlink-style feeds, bounds and circuit breaker).
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { ETH, GUARD, ASSET, pack, baseFixture, deployArena, openWeekdayRound, setMoves, play, endRound } = require("./arena-fixtures");

const FEED = (n) => ethers.parseUnits(String(n), 8);
const A = pack([6000, 4000, 3500, 4000, 2500, 2000, 4500, 2500, 1000]);
const B = pack([9500, 500, 7000, 1500, 1500, 500, 500, 1000, 8000]);
// $100 for one 18-decimal token in 6-decimal USDG: 1e8 raw per 1e18 raw.
const TICK_100 = Math.round(Math.log(1e8 / 1e18) / Math.log(1.0001));

describe("Arena with the StockFount oracle", function () {
  async function oracleFixture() {
    const ctx = await baseFixture();
    const usdgFeed = await ethers.deployContract("MockAggregator", [8, FEED(1)]);
    const oracle = await ethers.deployContract("FountOracle", [
      ctx.timelock.target,
      ethers.ZeroAddress,
      { feed: usdgFeed, maxAge: 90_000, decimals: 6, minAnswer: FEED("0.95"), maxAnswer: FEED("1.05") },
      1500,
      1800,
      [],
    ]);
    const feeds = {};
    for (const sym of ["NVDA", "GOOGL"]) {
      feeds[sym] = await ethers.deployContract("MockAggregator", [8, FEED(100)]);
      await oracle.connect(ctx.admin).setFeed(ctx.pools[sym].asset, feeds[sym], 7200, FEED(1), FEED(10_000));
    }
    const arena = await deployArena({ ...ctx, oracle });
    return { ...ctx, oracle, arena, feeds, usdgFeed };
  }

  async function liveRound() {
    const ctx = await oracleFixture();
    const n = await openWeekdayRound(ctx.arena);
    for (const f of [ctx.usdgFeed, ctx.feeds.NVDA, ctx.feeds.GOOGL]) await f.setAnswer(await f.answer()); // fresh now
    await setMoves(ctx, n, { NVDA: 1800, GOOGL: 3600, ETH: -4800 }, { NVDA: TICK_100, GOOGL: TICK_100, ETH: 0 });
    await play(ctx.arena, n, 1, [[ctx.alice, A, ETH("0.01")], [ctx.bob, B, ETH("0.02")]]);
    return { ...ctx, n };
  }

  it("reads $100 as the matching tick", async function () {
    const { arena } = await loadFixture(liveRound);
    const [priced, tick] = await arena.oracleTick(ASSET.NVDA);
    expect(priced).to.equal(true);
    expect(Number(tick)).to.be.closeTo(TICK_100, 1);
  });

  it("settles when Chainlink agrees with the pools", async function () {
    const { arena, feeds, n } = await loadFixture(liveRound);
    await feeds.NVDA.setAnswer(FEED("100.06")); // +6 ticks
    await feeds.GOOGL.setAnswer(FEED("100.12"));
    await endRound(n);
    await expect(arena.settle(n)).to.emit(arena, "Settled").withArgs(n, () => true, false, 0);
  });

  it("voids when the pool closed 5% away from Chainlink", async function () {
    const { arena, feeds, n, alice } = await loadFixture(liveRound);
    await feeds.NVDA.setAnswer(FEED(95));
    await endRound(n);
    await expect(arena.settle(n)).to.emit(arena, "Settled").withArgs(n, () => true, true, 4);
    await expect(arena.connect(alice).claim([n], true)).to.changeEtherBalance(alice, ETH("0.01"));
  });

  it("voids when the feed tripped its circuit breaker at the close of a required asset", async function () {
    const ctx = await loadFixture(oracleFixture);
    const { arena, admin, pools, feeds, alice } = ctx;
    await arena.connect(admin).setAsset(9, pools.NVDA, GUARD.REQUIRED);
    const { q, NOUL } = require("./arena-fixtures");
    await arena.connect(admin).setSchema(7, [q(NOUL, 2, [9], [0], 12)]);
    await arena.connect(admin).setSchedule(7, 7, 0);
    const n = await openWeekdayRound(arena);
    for (const f of [ctx.usdgFeed, feeds.NVDA]) await f.setAnswer(await f.answer());
    await setMoves(ctx, n, { NVDA: 1800 }, { NVDA: TICK_100 });
    await play(arena, n, 7, [[alice, pack([5000, 5000]), ETH("0.001")]]);
    await endRound(n);
    await feeds.NVDA.setAnswer(FEED(130)); // +30% in one round: the breaker holds it as unpriced
    expect(await ctx.oracle.isFresh(pools.NVDA.asset)).to.equal(false);
    await expect(arena.settle(n)).to.emit(arena, "Settled").withArgs(n, () => true, true, 4);
  });
});
