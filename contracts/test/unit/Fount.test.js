const { expect } = require("chai");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { USDG, EQ, rate, baseFixture, sink } = require("./fixtures");

describe("Fount", function () {
  it("mints shares when USDG is sunk and reports Held Value", async function () {
    const ctx = await loadFixture(baseFixture);
    const { fount } = ctx.amd;
    await sink(ctx, fount, ctx.alice, USDG(10_000));
    expect(await fount.totalAssets()).to.equal(USDG(10_000));
    expect(await fount.convertToAssets(await fount.balanceOf(ctx.alice))).to.be.closeTo(USDG(10_000), 1n);
  });

  it("enforces the Held Value cap", async function () {
    const ctx = await loadFixture(baseFixture);
    const { fount } = ctx.amd;
    await fount.connect(ctx.admin).setHeldValueCap(USDG(5_000));
    await ctx.usdg.connect(ctx.alice).approve(fount, USDG(6_000));
    await expect(fount.connect(ctx.alice).deposit(USDG(6_000), ctx.alice.address)).to.be.revertedWithCustomError(
      fount,
      "ERC4626ExceededMaxDeposit"
    );
  });

  it("closes sinking when the Equity Token price is stale, but in-kind exits still work", async function () {
    const ctx = await loadFixture(baseFixture);
    const { fount } = ctx.amd;
    await sink(ctx, fount, ctx.alice, USDG(1_000));
    await time.increase(3601);

    expect(await fount.priceFresh()).to.equal(false);
    expect(await fount.maxDeposit(ctx.alice)).to.equal(0);
    expect(await fount.maxRedeem(ctx.alice)).to.equal(0);
    await ctx.usdg.connect(ctx.alice).approve(fount, USDG(1));
    await expect(fount.connect(ctx.alice).deposit(USDG(1), ctx.alice.address)).to.be.reverted;

    const shares = await fount.balanceOf(ctx.alice);
    const before = await ctx.usdg.balanceOf(ctx.alice);
    await fount.connect(ctx.alice).redeemInKind(shares, ctx.alice.address, ctx.alice.address, 0, 0);
    expect((await ctx.usdg.balanceOf(ctx.alice)) - before).to.be.closeTo(USDG(1_000), 1n);
  });

  it("rejects sinking when the pool price strays from Chainlink", async function () {
    const ctx = await loadFixture(baseFixture);
    const { fount, position } = ctx.amd;
    await position.setSpot(USDG(160));
    await ctx.usdg.connect(ctx.alice).approve(fount, USDG(100));
    await expect(fount.connect(ctx.alice).deposit(USDG(100), ctx.alice.address)).to.be.revertedWithCustomError(
      fount,
      "PoolDeviation"
    );
  });

  it("lets only the keeper rebalance, checking the swap against the oracle", async function () {
    const ctx = await loadFixture(baseFixture);
    const { fount, position, equity } = ctx.amd;
    await sink(ctx, fount, ctx.alice, USDG(10_000));

    await expect(fount.connect(ctx.alice).rebalance(-600, 600, true, USDG(5_000), "0x")).to.be.reverted;
    await fount.connect(ctx.keeper).rebalance(-600, 600, true, USDG(5_000), "0x");

    expect(await ctx.usdg.balanceOf(position)).to.equal(USDG(5_000));
    expect(await equity.balanceOf(position)).to.be.closeTo(EQ(5_000 / 150), EQ(0.0001));
    expect(await fount.totalAssets()).to.be.closeTo(USDG(10_000), USDG(0.01));

    await ctx.swap.setRate(ctx.usdg, equity, ((10n ** 18n) * 10n ** 18n) / USDG(160));
    await expect(fount.connect(ctx.keeper).rebalance(-600, 600, true, USDG(1_000), "0x")).to.be.reverted;
  });

  it("splits harvested fees 70% to depositors and 30% to the FeeRouter", async function () {
    const ctx = await loadFixture(baseFixture);
    const { fount, position, equity } = ctx.amd;
    await sink(ctx, fount, ctx.alice, USDG(10_000));
    await fount.connect(ctx.keeper).rebalance(-600, 600, true, USDG(5_000), "0x");

    await position.accrueFees(EQ(1), USDG(100));
    const before = await fount.totalAssets();
    await fount.harvest();

    expect(await equity.balanceOf(ctx.feeRouter)).to.equal(EQ(0.3));
    expect(await ctx.usdg.balanceOf(ctx.feeRouter)).to.equal(USDG(30));
    expect((await fount.totalAssets()) - before).to.be.closeTo(USDG(175), 1n);
    expect(await fount.grossUsdgFees()).to.equal(USDG(100));
  });

  it("raises USDG from the range for a USDG exit", async function () {
    const ctx = await loadFixture(baseFixture);
    const { fount } = ctx.amd;
    await sink(ctx, fount, ctx.alice, USDG(10_000));
    await fount.connect(ctx.keeper).rebalance(-600, 600, true, USDG(5_000), "0x");

    const before = await ctx.usdg.balanceOf(ctx.alice);
    await fount.connect(ctx.alice).withdraw(USDG(3_000), ctx.alice.address, ctx.alice.address);
    expect((await ctx.usdg.balanceOf(ctx.alice)) - before).to.equal(USDG(3_000));
    expect(await fount.totalAssets()).to.be.closeTo(USDG(7_000), USDG(0.01));
  });

  it("covers a USDG exit when compounded fees already sit idle in the Fount", async function () {
    const ctx = await loadFixture(baseFixture);
    const { fount, position } = ctx.amd;
    await sink(ctx, fount, ctx.alice, USDG(10_000));
    await fount.connect(ctx.keeper).rebalance(-600, 600, true, USDG(5_000), "0x");
    await position.accrueFees(0, USDG(500));
    await fount.harvest();
    expect(await ctx.usdg.balanceOf(fount)).to.equal(USDG(350));

    const max = await fount.maxWithdraw(ctx.alice);
    const before = await ctx.usdg.balanceOf(ctx.alice);
    await fount.connect(ctx.alice).withdraw(max / 2n, ctx.alice.address, ctx.alice.address);
    expect((await ctx.usdg.balanceOf(ctx.alice)) - before).to.equal(max / 2n);
  });

  it("charges the swap loss of a USDG exit to the exiting holder, not the ones who stay", async function () {
    const ctx = await loadFixture(baseFixture);
    const { fount, equity } = ctx.amd;
    await sink(ctx, fount, ctx.alice, USDG(10_000));
    await sink(ctx, fount, ctx.bob, USDG(10_000));
    await fount.connect(ctx.keeper).rebalance(-600, 600, true, USDG(10_000), "0x");
    await ctx.swap.setRate(equity, ctx.usdg, rate(150 * 0.995, 18, 6));

    const bobValue = async () => fount.convertToAssets(await fount.balanceOf(ctx.bob));
    const bobBefore = await bobValue();

    const sharesBefore = await fount.balanceOf(ctx.alice);
    const preview = await fount.previewWithdraw(USDG(8_000));
    await fount.connect(ctx.alice).withdraw(USDG(8_000), ctx.alice.address, ctx.alice.address);
    expect(sharesBefore - (await fount.balanceOf(ctx.alice))).to.be.gt(preview);
    expect(await bobValue()).to.be.closeTo(bobBefore, 2n);

    const rest = await fount.balanceOf(ctx.alice);
    const expected = await fount.previewRedeem(rest);
    const usdgBefore = await ctx.usdg.balanceOf(ctx.alice);
    await fount.connect(ctx.alice).redeem(rest, ctx.alice.address, ctx.alice.address);
    const received = (await ctx.usdg.balanceOf(ctx.alice)) - usdgBefore;
    expect(received).to.be.lt(expected);
    expect(received).to.be.gt((expected * 99n) / 100n);
    expect(await bobValue()).to.be.closeTo(bobBefore, 2n);
  });

  it("pauses sinking via the guardian while exits stay open; only the admin unpauses", async function () {
    const ctx = await loadFixture(baseFixture);
    const { fount } = ctx.amd;
    await sink(ctx, fount, ctx.alice, USDG(1_000));
    await fount.connect(ctx.guardian).pause();

    await ctx.usdg.connect(ctx.alice).approve(fount, USDG(1));
    await expect(fount.connect(ctx.alice).deposit(USDG(1), ctx.alice.address)).to.be.revertedWithCustomError(
      fount,
      "EnforcedPause"
    );
    await fount.connect(ctx.alice).redeem(await fount.balanceOf(ctx.alice) / 2n, ctx.alice.address, ctx.alice.address);

    await expect(fount.connect(ctx.guardian).unpause()).to.be.reverted;
    await fount.connect(ctx.admin).unpause();
  });

  it("caps the protocol share at 30% and lets the guardian only lower caps", async function () {
    const ctx = await loadFixture(baseFixture);
    const { fount } = ctx.amd;
    await expect(fount.connect(ctx.admin).setProtocolShareBps(3001)).to.be.revertedWithCustomError(fount, "InvalidConfig");
    await expect(fount.connect(ctx.guardian).lowerHeldValueCap(USDG(2_000_000))).to.be.revertedWithCustomError(
      fount,
      "InvalidConfig"
    );
    await fount.connect(ctx.guardian).lowerHeldValueCap(USDG(10));
    expect(await fount.heldValueCap()).to.equal(USDG(10));
  });
});
