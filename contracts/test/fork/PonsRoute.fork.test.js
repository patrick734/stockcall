// Fork test: buy-and-burn through a Pons launchpad pool (USDG → native ETH → token). $CALL isn't launched
// yet, so a graduated Pons token (APES) stands in; its pool has the same hook, fee 0 and tickSpacing 200.
// Run with: FORK=1 npx hardhat test test/fork/PonsRoute.fork.test.js
const { expect } = require("chai");
const { ethers, network } = require("hardhat");
const config = require("../../config/robinhood.json");
const { deployTimelock } = require("../unit/fixtures");

const USDG_WHALE = "0x4B431ec432CC11ebd4E460D8eC12057F07b2FFf6";
const APES = "0x521586b19419d50a8238cc6d8b291dca0abc5e5f";
const ETH = ethers.ZeroAddress;
const USDG = config.tokens.usdg.address;
const usdgAmt = (n) => ethers.parseUnits(String(n), 6);
const route = (path) => ethers.AbiCoder.defaultAbiCoder().encode(["address[]"], [path]);

describe("Buy-and-burn through a Pons launchpad pool on a Robinhood Chain fork", function () {
  let admin, guardian, keeper, usdg, apes, swap, drawdown;
  const ethUsdgKey = { currency0: ETH, currency1: USDG, fee: config.uniswap.ethUsdgPool.fee, tickSpacing: config.uniswap.ethUsdgPool.tickSpacing, hooks: ETH };
  const ponsKey = { currency0: ETH, currency1: APES, fee: config.pons.poolFee, tickSpacing: config.pons.poolTickSpacing, hooks: config.pons.hook };

  before(async function () {
    let multisig;
    [, multisig, guardian, keeper] = await ethers.getSigners();
    ({ admin } = await deployTimelock(multisig));
    usdg = await ethers.getContractAt("IERC20", USDG);
    apes = await ethers.getContractAt("CallToken", APES); // ERC20Burnable-shaped ABI for balanceOf/totalSupply
    await network.provider.request({ method: "hardhat_impersonateAccount", params: [USDG_WHALE] });
    await network.provider.send("hardhat_setBalance", [USDG_WHALE, "0x56BC75E2D63100000"]);
    const whale = await ethers.getSigner(USDG_WHALE);
    await usdg.connect(whale).transfer(admin, usdgAmt(2_000));

    swap = (await ethers.deployContract("V4SwapAdapter", [admin.address, config.uniswap.poolManager, USDG, [], [ethUsdgKey]])).connect(admin);
    drawdown = await ethers.deployContract("DrawdownRetire", [APES, swap, admin.address, guardian.address, keeper.address, 0, [USDG], [usdgAmt(1_000)]]);
  });

  it("rejects the Pons pool until its hook is allowlisted", async function () {
    await expect(swap.setPool(ponsKey)).to.be.revertedWithCustomError(swap, "InvalidPool");
    await swap.setHookAllowed(config.pons.hook, true);
    await swap.setPool(ponsKey);
    const [, exists] = await swap.poolFor(ETH, APES);
    expect(exists).to.equal(true);
  });

  it("swaps USDG into the Pons token through native ETH and keeps nothing behind", async function () {
    await usdg.connect(admin).approve(swap, usdgAmt(100));
    // The default path is direct or via USDG only; the ETH hop must be explicit, which is what the keeper sends.
    await expect(swap.swap(USDG, APES, usdgAmt(100), 1n, admin.address, "0x")).to.be.revertedWithCustomError(swap, "InvalidRoute");
    const before = await apes.balanceOf(admin);
    const out = await swap.swap.staticCall(USDG, APES, usdgAmt(100), 1n, admin.address, route([USDG, ETH, APES]));
    await swap.swap(USDG, APES, usdgAmt(100), 1n, admin.address, route([USDG, ETH, APES]));
    const got = (await apes.balanceOf(admin)) - before;
    console.log(`      100 USDG → ${ethers.formatEther(got)} APES`);
    expect(got).to.equal(out);
    expect(got).to.be.gt(0n);
    expect(await ethers.provider.getBalance(swap)).to.equal(0n);
    expect(await usdg.balanceOf(swap)).to.equal(0n);
    expect(await apes.balanceOf(swap)).to.equal(0n);
  });

  it("enforces minOut", async function () {
    await usdg.connect(admin).approve(swap, usdgAmt(10));
    await expect(swap.swap(USDG, APES, usdgAmt(10), ethers.MaxUint256 / 2n, admin.address, route([USDG, ETH, APES])))
      .to.be.revertedWithCustomError(swap, "InsufficientOutput");
  });

  it("DrawdownRetire buys the token with USDG fees and retires it", async function () {
    await usdg.connect(admin).transfer(drawdown, usdgAmt(500));
    const path = route([USDG, ETH, APES]);
    const quote = await drawdown.connect(keeper).drawdown.staticCall(USDG, usdgAmt(500), 1n, path);
    const minOut = (quote * 98n) / 100n;
    const supplyBefore = await apes.totalSupply();
    await expect(drawdown.connect(keeper).drawdown(USDG, usdgAmt(500), minOut, path)).to.emit(drawdown, "Retired");
    const retired = await drawdown.totalRetired();
    console.log(`      500 USDG → ${ethers.formatEther(retired)} APES retired (supply fell by ${ethers.formatEther(supplyBefore - (await apes.totalSupply()))})`);
    expect(retired).to.be.gte(minOut);
    expect(await apes.balanceOf(drawdown)).to.equal(0n);
    expect(await usdg.balanceOf(drawdown)).to.equal(0n);
    expect(await apes.totalSupply()).to.equal(supplyBefore - retired);
  });

  it("blocks the route again once the hook is revoked", async function () {
    await swap.setHookAllowed(config.pons.hook, false);
    await usdg.connect(admin).approve(swap, usdgAmt(10));
    await expect(swap.swap(USDG, APES, usdgAmt(10), 1n, admin.address, route([USDG, ETH, APES])))
      .to.be.revertedWithCustomError(swap, "InvalidRoute");
  });
});
