// Offline unit tests for the keeper's pure logic: tick math, rebalance planning, routes, revert decoding.
// Run: npm test   (no node or RPC needed; needs contracts/artifacts for the ABIs)
const assert = require("assert/strict");
const { ethers } = require("ethers");
const v4 = require("../src/v4math");
const { planRebalance } = require("../src/plan");
const { buildRoute } = require("../src/routes");
const { reason } = require("../src/chain");
const abis = require("../src/abis");
const arenaPlan = require("../src/arenaPlan");
const sealed = require("../src/sealed");

let passed = 0;
function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  PASS ${name}`);
  } catch (e) {
    console.log(`  FAIL ${name}\n       ${e.message}`);
    process.exitCode = 1;
  }
}

const CFG = { halfWidthTicks: 1200, edgeThresholdPct: 15, minSwapUsdg: "5", minIdleUsdg: "10", maxIdlePct: 25 };
const E18 = 10n ** 18n;
const usdg = (n) => ethers.parseUnits(String(n), 6);

/// Pool state for an Equity Token at `price` USDG, as the v4 pool would store it.
function pool(price, equityIsToken0) {
  const raw = equityIsToken0 ? (price * 1e6) / 1e18 : 1e18 / (price * 1e6);
  const sqrtPriceX96 = BigInt(Math.floor(Math.sqrt(raw) * 2 ** 96));
  return { sqrtPriceX96, poolTick: v4.tickFromPrice(raw), fair: usdg(price) };
}

function base(price, equityIsToken0, over = {}) {
  const pl = pool(price, equityIsToken0);
  return {
    cfg: CFG,
    fair: pl.fair,
    equityUnit: E18,
    equityIsToken0,
    spacing: 60,
    sqrtPriceX96: pl.sqrtPriceX96,
    poolTick: pl.poolTick,
    liquidity: 0n,
    lower: 0,
    upper: 0,
    heldE: 0n,
    heldU: 0n,
    idleE: 0n,
    idleU: 0n,
    ...over,
  };
}

const near = (a, b, tolBps) => {
  const d = a > b ? a - b : b - a;
  return d * 10_000n <= b * BigInt(tolBps);
};

console.log("v4math");
test("tickFromPrice(1) = 0 and sign follows price", () => {
  assert.equal(v4.tickFromPrice(1), 0);
  assert.ok(v4.tickFromPrice(1.01) > 0 && v4.tickFromPrice(0.99) < 0);
});
test("rangeAround snaps outward to the spacing", () => {
  const r = v4.rangeAround(123, 1200, 60);
  assert.ok(r.lower % 60 === 0);
  assert.ok(r.upper % 60 === 0);
  assert.ok(r.lower <= 123 - 1200 && r.upper >= 123 + 1200);
  assert.deepEqual(v4.rangeAround(-123, 1200, 60), { lower: -1380, upper: 1080 });
});
test("range centred on price holds about half its value in each token", () => {
  const r = v4.rangeAround(0, 1200, 60);
  assert.ok(Math.abs(v4.token1ValueShare(1, r.lower, r.upper) - 0.5) < 0.01);
  assert.equal(v4.token1ValueShare(v4.sqrtFromX96(2n ** 96n), 60, 120), 0);
  assert.equal(v4.token1ValueShare(v4.sqrtFromX96(2n ** 96n), -120, -60), 1);
});

console.log("planRebalance");
for (const equityIsToken0 of [false, true]) {
  const side = equityIsToken0 ? "equity=token0" : "equity=token1";
  test(`${side}: no range + idle USDG -> place range, sell about half the USDG`, () => {
    const p = planRebalance(base(778.25, equityIsToken0, { heldU: usdg(10_000), idleU: usdg(10_000) }));
    assert.equal(p.action, "rebalance");
    assert.equal(p.why, "no active range");
    assert.equal(p.sellUsdg, true);
    assert.ok(near(p.amount, usdg(5_000), 200), `amount ${p.amount}`);
    assert.ok(p.target.lower <= p.status.oracleTick && p.status.oracleTick < p.target.upper);
  });
  test(`${side}: no range + equity only -> sell about half the equity`, () => {
    const heldE = ethers.parseEther("10");
    const p = planRebalance(base(224.41, equityIsToken0, { heldE, idleE: heldE }));
    assert.equal(p.action, "rebalance");
    assert.equal(p.sellUsdg, false);
    assert.ok(near(p.amount, ethers.parseEther("5"), 200), `amount ${p.amount}`);
  });
  test(`${side}: centred range -> nothing to do`, () => {
    const b = base(336.31, equityIsToken0);
    const r = v4.rangeAround(b.poolTick, 1200, 60);
    const p = planRebalance({ ...b, liquidity: 1n, lower: r.lower, upper: r.upper, heldU: usdg(5000), heldE: ethers.parseEther("15") });
    assert.equal(p.action, "none");
  });
  test(`${side}: price moved 20% -> out of range, new range around the oracle`, () => {
    const old = base(100, equityIsToken0);
    const r = v4.rangeAround(old.poolTick, 1200, 60);
    const now = base(120, equityIsToken0);
    const p = planRebalance({ ...now, liquidity: 1n, lower: r.lower, upper: r.upper, heldU: usdg(5000), heldE: ethers.parseEther("40") });
    assert.equal(p.action, "rebalance");
    assert.equal(p.why, "pool tick out of range");
    assert.ok(p.target.lower <= now.poolTick && now.poolTick < p.target.upper);
  });
  test(`${side}: price moved 10% -> near edge triggers`, () => {
    const old = base(100, equityIsToken0);
    const r = v4.rangeAround(old.poolTick, 1200, 60);
    const now = base(110, equityIsToken0);
    const p = planRebalance({ ...now, liquidity: 1n, lower: r.lower, upper: r.upper, heldU: usdg(5000), heldE: ethers.parseEther("50") });
    assert.equal(p.action, "rebalance");
    assert.equal(p.why, "pool tick near range edge");
  });
}
test("pool at edge but oracle centred on the current range -> skip, not a pointless rebalance", () => {
  const b = base(100, false);
  const r = v4.rangeAround(b.poolTick, 1200, 60);
  const p = planRebalance({ ...b, poolTick: r.upper - 10, liquidity: 1n, lower: r.lower, upper: r.upper, heldU: usdg(5000), heldE: ethers.parseEther("50") });
  assert.equal(p.action, "skip");
});
test("large idle balance in an otherwise healthy range -> rebalance to deploy it", () => {
  const b = base(100, false);
  const r = v4.rangeAround(b.poolTick, 1200, 60);
  const p = planRebalance({ ...b, liquidity: 1n, lower: r.lower, upper: r.upper, heldU: usdg(8000), heldE: ethers.parseEther("20"), idleU: usdg(4000) });
  assert.equal(p.action, "rebalance");
  assert.equal(p.why, "idle balance above maxIdlePct");
});
test("tiny imbalance below minSwapUsdg -> no swap", () => {
  const p = planRebalance(base(100, false, { heldU: usdg(10), heldE: ethers.parseEther("0.1"), idleU: usdg(10), cfg: { ...CFG, minSwapUsdg: "50" } }));
  assert.equal(p.action, "rebalance");
  assert.equal(p.amount, 0n);
});
test("dust with no range -> nothing", () => {
  assert.equal(planRebalance(base(100, false, { heldU: usdg(1), idleU: usdg(1) })).action, "none");
});

console.log("routes");
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const META = "0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35";
const CALL = "0x1111111111111111111111111111111111111111";
const ctx = { dep: { usdg: USDG, burnToken: CALL, founts: { META: { equityToken: META } } } };
const decode = (r) => ethers.AbiCoder.defaultAbiCoder().decode(["address[]"], r)[0].map(String);
test("default route for USDG collapses IN/USDG: USDG -> ETH -> CALL", () => {
  const { route, path } = buildRoute(ctx, ["IN", "USDG", "ETH", "CALL"], USDG, CALL);
  assert.deepEqual(path, [ethers.getAddress(USDG), ethers.ZeroAddress, CALL]);
  assert.deepEqual(decode(route), path);
});
test("default route for an Equity Token: META -> USDG -> ETH -> CALL", () => {
  const { path } = buildRoute(ctx, ["IN", "USDG", "ETH", "CALL"], META, CALL);
  assert.deepEqual(path, [ethers.getAddress(META), ethers.getAddress(USDG), ethers.ZeroAddress, CALL]);
});
test('"default" and [] mean the adapter default path (0x)', () => {
  assert.equal(buildRoute(ctx, "default", USDG, CALL).route, "0x");
  assert.equal(buildRoute(ctx, [], USDG, CALL).route, "0x");
});
test("a route that does not end at CALL is rejected", () => {
  assert.throws(() => buildRoute(ctx, ["IN", "ETH"], USDG, CALL));
  assert.throws(() => buildRoute(ctx, ["IN", "NOPE", "CALL"], USDG, CALL));
});

console.log("revert decoding");
test("custom errors decode by name, including nested ones", () => {
  const dd = new ethers.Interface(abis.DrawdownRetire);
  assert.equal(reason({ data: dd.encodeErrorResult("TooSoon", []) }), "TooSoon()");
  const ad = new ethers.Interface(abis.V4SwapAdapter);
  assert.equal(reason({ error: { data: ad.encodeErrorResult("InvalidRoute", []) } }), "InvalidRoute()");
  const fount = new ethers.Interface(abis.Fount);
  assert.equal(reason({ data: fount.encodeErrorResult("SwapLoss", [1, 2]) }), "SwapLoss(1, 2)");
});

console.log("arena timing");
const H = 3600 * 500000; // the start of some hour; round n = H / 3600 starts here
test("the reveal window is the five minutes before the hour, for the round starting then", () => {
  assert.equal(arenaPlan.revealRound(H - 301), null);
  assert.equal(arenaPlan.revealRound(H - 300), H / 3600);
  assert.equal(arenaPlan.revealRound(H - 1), H / 3600);
  assert.equal(arenaPlan.revealRound(H), null);
});
test("ended rounds are the ones whose hour is over, newest first", () => {
  assert.deepEqual(arenaPlan.endedRounds(H + 10, 3), [H / 3600 - 1, H / 3600 - 2, H / 3600 - 3]);
});
test("hour mode wakes just inside the reveal window, then just after the round ends", () => {
  assert.equal(arenaPlan.nextWake(H - 1200), 1200 - 300 + 10);
  assert.equal(arenaPlan.nextWake(H - 200), 200 + 10);
  assert.equal(arenaPlan.nextWake(H + 5), 5);
  assert.equal(arenaPlan.nextWake(H + 10), 20);
  assert.equal(arenaPlan.nextWake(H + 31), 3600 - 300 + 10 - 31);
});
test("burns are capped per run and skip dust", () => {
  assert.equal(arenaPlan.burnAmount(10n, 4n, 1n), 4n);
  assert.equal(arenaPlan.burnAmount(3n, 4n, 1n), 3n);
  assert.equal(arenaPlan.burnAmount(3n, 4n, 5n), 0n);
  assert.equal(arenaPlan.minOut(10_000n, 500), 9_500n);
});

console.log("sealed reveals");
const keeperWallet = ethers.Wallet.createRandom();
const reveal = { n: 123456, player: ethers.Wallet.createRandom().address, probs: 2n ** 140n + 12345n, salt: ethers.hexlify(ethers.randomBytes(32)) };
test("seal to the keeper's public key and open with its private key", () => {
  const box = sealed.seal(sealed.publicKeyOf(keeperWallet.privateKey), reveal);
  assert.deepEqual(sealed.open(keeperWallet.privateKey, box), reveal);
});
test("a reveal sealed for the address-derived key opens too (uncompressed key form)", () => {
  const box = sealed.seal(keeperWallet.signingKey.publicKey, reveal);
  assert.deepEqual(sealed.open(keeperWallet.privateKey, box), reveal);
});
test("another key cannot open it, and a flipped byte is rejected", () => {
  const box = sealed.seal(sealed.publicKeyOf(keeperWallet.privateKey), reveal);
  assert.throws(() => sealed.open(ethers.Wallet.createRandom().privateKey, box));
  const b = ethers.getBytes(box);
  b[60] ^= 1;
  assert.throws(() => sealed.open(keeperWallet.privateKey, ethers.hexlify(b)));
});

console.log(process.exitCode ? "\nunit tests FAILED" : `\nall ${passed} unit tests passed`);
