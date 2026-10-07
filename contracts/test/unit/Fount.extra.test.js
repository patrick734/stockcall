const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const { USDG, EQ, FEED, baseFixture, sink } = require("./fixtures");

describe("Fount (extra coverage)", function () {
  function config(ctx, overrides = {}) {
    return {
      usdg: ctx.usdg.target,
      equityToken: ctx.amd.equity.target,
      position: ctx.amd.position.target,
      oracle: ctx.oracle.target,
      swapAdapter: ctx.swap.target,
      feeRouter: ctx.feeRouter.target,
      admin: ctx.admin.address,
      guardian: ctx.guardian.address,
      keeper: ctx.keeper.address,
      heldValueCap: USDG(1_000_000),
      ...overrides,
    };
  }

  describe("constructor", function () {
    for (const field of ["equityToken", "position", "oracle", "swapAdapter", "feeRouter"]) {
      it(`rejects a zero ${field}`, async function () {
        const ctx = await loadFixture(baseFixture);
        const Fount = await ethers.getContractFactory("Fount");
        await expect(
          Fount.deploy(config(ctx, { [field]: ethers.ZeroAddress }), "w", "w")
        ).to.be.revertedWithCustomError(Fount, "InvalidConfig");
      });
    }

    it("rejects an admin that is not a timelock", async function () {
      const ctx = await loadFixture(baseFixture);
      const Fount = await ethers.getContractFactory("Fount");
      for (const admin of [ethers.ZeroAddress, ctx.alice.address, ctx.usdg.target]) {
        await expect(Fount.deploy(config(ctx, { admin }), "w", "w")).to.be.revertedWithCustomError(Fount, "AdminNotTimelock");
      }
    });

    it("rejects zero, shared or deployer-held guardian and keeper roles", async function () {
      const ctx = await loadFixture(baseFixture);
      const Fount = await ethers.getContractFactory("Fount");
      for (const overrides of [
        { guardian: ethers.ZeroAddress },
        { keeper: ethers.ZeroAddress },
        { guardian: ctx.admin.address },
        { keeper: ctx.admin.address },
        { keeper: ctx.guardian.address },
        { guardian: ctx.deployer.address },
        { keeper: ctx.deployer.address },
      ]) {
        await expect(Fount.deploy(config(ctx, overrides), "w", "w")).to.be.revertedWithCustomError(Fount, "RoleCollision");
      }
    });

    it("stores its wiring and default risk parameters", async function () {
      const ctx = await loadFixture(baseFixture);
      const { fount, equity, position } = ctx.amd;
      expect(await fount.asset()).to.equal(ctx.usdg.target);
      expect(await fount.equityToken()).to.equal(equity.target);
      expect(await fount.position()).to.equal(position.target);
      expect(await fount.feeRouter()).to.equal(ctx.feeRouter.target);
      expect(await fount.protocolShareBps()).to.equal(3000);
      expect(await fount.maxPoolDeviationBps()).to.equal(200);
      expect(await fount.maxSwapLossBps()).to.equal(100);
      expect(await fount.decimals()).to.equal(12); // 6 USDG decimals + 6 offset
      expect(await fount.hasRole(await fount.GUARDIAN_ROLE(), ctx.admin.address)).to.equal(false);
    });
  });

  describe("caps and max views", function () {
    it("maxDeposit / maxMint drop to zero once Held Value reaches the cap", async function () {
      const ctx = await loadFixture(baseFixture);
      const { fount } = ctx.amd;
      await fount.connect(ctx.admin).setHeldValueCap(USDG(1_000));
      expect(await fount.maxMint(ctx.alice)).to.be.gt(0);
      await sink(ctx, fount, ctx.alice, USDG(1_000));
      expect(await fount.maxDeposit(ctx.alice)).to.equal(0);
      expect(await fount.maxMint(ctx.alice)).to.equal(0);

      await ctx.usdg.connect(ctx.alice).approve(fount, USDG(10));
      await expect(fount.connect(ctx.alice).mint(1n, ctx.alice.address)).to.be.revertedWithCustomError(
        fount,
        "ERC4626ExceededMaxMint"
      );

      // Lowering the cap below Held Value keeps it closed rather than underflowing.
      await fount.connect(ctx.guardian).lowerHeldValueCap(USDG(500));
      expect(await fount.maxDeposit(ctx.alice)).to.equal(0);
    });

    it("mints an exact share amount for USDG", async function () {
      const ctx = await loadFixture(baseFixture);
      const { fount } = ctx.amd;
      const shares = await fount.previewDeposit(USDG(100));
      const assets = await fount.previewMint(shares);
      await ctx.usdg.connect(ctx.alice).approve(fount, assets);
      await expect(fount.connect(ctx.alice).mint(shares, ctx.alice.address)).to.emit(fount, "Deposit");
      expect(await fount.balanceOf(ctx.alice)).to.equal(shares);
      expect(await fount.totalAssets()).to.equal(assets);
    });

    it("rejects USDG exits above maxWithdraw / maxRedeem", async function () {
      const ctx = await loadFixture(baseFixture);
      const { fount } = ctx.amd;
      await sink(ctx, fount, ctx.alice, USDG(1_000));
      const shares = await fount.balanceOf(ctx.alice);
      await expect(
        fount.connect(ctx.alice).withdraw(USDG(1_001), ctx.alice.address, ctx.alice.address)
      ).to.be.revertedWithCustomError(fount, "ERC4626ExceededMaxWithdraw");
      await expect(
        fount.connect(ctx.alice).redeem(shares + 1n, ctx.alice.address, ctx.alice.address)
      ).to.be.revertedWithCustomError(fount, "ERC4626ExceededMaxRedeem");
    });

    it("blocks USDG exits while the price is stale", async function () {
      const ctx = await loadFixture(baseFixture);
      const { fount } = ctx.amd;
      await sink(ctx, fount, ctx.alice, USDG(1_000));
      await time.increase(3601);
      expect(await fount.maxWithdraw(ctx.alice)).to.equal(0);
      await expect(fount.connect(ctx.alice).withdraw(1n, ctx.alice.address, ctx.alice.address)).to.be.reverted;
      await expect(fount.connect(ctx.alice).redeem(1n, ctx.alice.address, ctx.alice.address)).to.be.reverted;
    });

    it("lets a spender withdraw on the owner's behalf only with allowance", async function () {
      const ctx = await loadFixture(baseFixture);
      const { fount } = ctx.amd;
      await sink(ctx, fount, ctx.alice, USDG(1_000));
      await expect(
        fount.connect(ctx.bob).withdraw(USDG(100), ctx.bob.address, ctx.alice.address)
      ).to.be.revertedWithCustomError(fount, "ERC20InsufficientAllowance");
      await fount.connect(ctx.alice).approve(ctx.bob, await fount.balanceOf(ctx.alice));
      const before = await ctx.usdg.balanceOf(ctx.bob);
      await fount.connect(ctx.bob).withdraw(USDG(100), ctx.bob.address, ctx.alice.address);
      expect((await ctx.usdg.balanceOf(ctx.bob)) - before).to.equal(USDG(100));
    });
  });

  describe("pool deviation", function () {
    it("rejects when pool spot is below the oracle beyond the limit, accepts at the edge", async function () {
      const ctx = await loadFixture(baseFixture);
      const { fount, position } = ctx.amd;
      await ctx.usdg.connect(ctx.alice).approve(fount, USDG(200));

      await position.setSpot(USDG(140));
      await expect(fount.connect(ctx.alice).deposit(USDG(100), ctx.alice.address))
        .to.be.revertedWithCustomError(fount, "PoolDeviation")
        .withArgs(USDG(140), USDG(150));

      // exactly 2% away is allowed (strict >)
      await position.setSpot(USDG(147));
      await fount.connect(ctx.alice).deposit(USDG(100), ctx.alice.address);
      await position.setSpot(USDG(153));
      await fount.connect(ctx.alice).deposit(USDG(100), ctx.alice.address);
    });

    it("also guards withdraw, redeem and rebalance but not redeemInKind", async function () {
      const ctx = await loadFixture(baseFixture);
      const { fount, position } = ctx.amd;
      await sink(ctx, fount, ctx.alice, USDG(1_000));
      await position.setSpot(USDG(100));
      await expect(fount.connect(ctx.alice).withdraw(1n, ctx.alice.address, ctx.alice.address)).to.be.revertedWithCustomError(
        fount,
        "PoolDeviation"
      );
      await expect(fount.connect(ctx.alice).redeem(1n, ctx.alice.address, ctx.alice.address)).to.be.revertedWithCustomError(
        fount,
        "PoolDeviation"
      );
      await expect(fount.connect(ctx.keeper).rebalance(-60, 60, false, 0, "0x")).to.be.revertedWithCustomError(
        fount,
        "PoolDeviation"
      );
      await expect(fount.connect(ctx.alice).mint(1n, ctx.alice.address)).to.be.revertedWithCustomError(fount, "PoolDeviation");
      const shares = await fount.balanceOf(ctx.alice);
      await fount.connect(ctx.alice).redeemInKind(shares, ctx.alice.address, ctx.alice.address, 0, 0);
      expect(await fount.totalSupply()).to.equal(0);
    });
  });

  describe("pause matrix", function () {
    it("only the guardian pauses; only the admin unpauses", async function () {
      const ctx = await loadFixture(baseFixture);
      const { fount } = ctx.amd;
      for (const s of [ctx.admin, ctx.keeper, ctx.alice]) {
        await expect(fount.connect(s).pause()).to.be.revertedWithCustomError(fount, "AccessControlUnauthorizedAccount");
      }
      await expect(fount.connect(ctx.guardian).pause()).to.emit(fount, "Paused");
      for (const s of [ctx.guardian, ctx.keeper, ctx.alice]) {
        await expect(fount.connect(s).unpause()).to.be.revertedWithCustomError(fount, "AccessControlUnauthorizedAccount");
      }
      await expect(fount.connect(ctx.admin).unpause()).to.emit(fount, "Unpaused");
    });

    it("while paused: sinking, minting and rebalancing stop; every exit and harvest stays open", async function () {
      const ctx = await loadFixture(baseFixture);
      const { fount, position } = ctx.amd;
      await sink(ctx, fount, ctx.alice, USDG(3_000));
      await fount.connect(ctx.keeper).rebalance(-600, 600, true, USDG(1_000), "0x");
      await fount.connect(ctx.guardian).pause();

      expect(await fount.maxDeposit(ctx.alice)).to.equal(0);
      expect(await fount.maxMint(ctx.alice)).to.equal(0);
      await ctx.usdg.connect(ctx.alice).approve(fount, USDG(10));
      await expect(fount.connect(ctx.alice).deposit(USDG(1), ctx.alice.address)).to.be.revertedWithCustomError(fount, "EnforcedPause");
      await expect(fount.connect(ctx.alice).mint(1n, ctx.alice.address)).to.be.revertedWithCustomError(fount, "EnforcedPause");
      await expect(fount.connect(ctx.keeper).rebalance(-600, 600, false, 0, "0x")).to.be.revertedWithCustomError(
        fount,
        "EnforcedPause"
      );

      await position.accrueFees(0, USDG(10));
      await fount.harvest();
      await fount.connect(ctx.alice).withdraw(USDG(500), ctx.alice.address, ctx.alice.address);
      await fount.connect(ctx.alice).redeem((await fount.balanceOf(ctx.alice)) / 3n, ctx.alice.address, ctx.alice.address);
      await fount.connect(ctx.alice).redeemInKind(await fount.balanceOf(ctx.alice), ctx.alice.address, ctx.alice.address, 0, 0);
      expect(await fount.totalSupply()).to.equal(0);
    });
  });

  describe("governance setters", function () {
    it("restricts every setter to its role", async function () {
      const ctx = await loadFixture(baseFixture);
      const { fount } = ctx.amd;
      const E = "AccessControlUnauthorizedAccount";
      await expect(fount.connect(ctx.guardian).setHeldValueCap(1)).to.be.revertedWithCustomError(fount, E);
      await expect(fount.connect(ctx.keeper).setHeldValueCap(1)).to.be.revertedWithCustomError(fount, E);
      await expect(fount.connect(ctx.admin).lowerHeldValueCap(1)).to.be.revertedWithCustomError(fount, E);
      await expect(fount.connect(ctx.guardian).setProtocolShareBps(1)).to.be.revertedWithCustomError(fount, E);
      await expect(fount.connect(ctx.guardian).setRiskLimits(100, 100)).to.be.revertedWithCustomError(fount, E);
      await expect(fount.connect(ctx.admin).rebalance(0, 60, false, 0, "0x")).to.be.revertedWithCustomError(fount, E);
    });

    it("lowerHeldValueCap accepts an equal cap and emits", async function () {
      const ctx = await loadFixture(baseFixture);
      const { fount } = ctx.amd;
      await expect(fount.connect(ctx.guardian).lowerHeldValueCap(USDG(1_000_000)))
        .to.emit(fount, "HeldValueCapSet")
        .withArgs(USDG(1_000_000));
      await expect(fount.connect(ctx.admin).setHeldValueCap(USDG(2_000_000)))
        .to.emit(fount, "HeldValueCapSet")
        .withArgs(USDG(2_000_000));
    });

    it("validates risk limits against hard maxima", async function () {
      const ctx = await loadFixture(baseFixture);
      const { fount } = ctx.amd;
      const a = fount.connect(ctx.admin);
      for (const [dev, loss] of [
        [0, 100],
        [501, 100],
        [200, 0],
        [200, 301],
      ]) {
        await expect(a.setRiskLimits(dev, loss)).to.be.revertedWithCustomError(fount, "InvalidConfig");
      }
      await expect(a.setRiskLimits(500, 300)).to.emit(fount, "RiskLimitsSet").withArgs(500, 300);
      expect(await fount.maxPoolDeviationBps()).to.equal(500);
      expect(await fount.maxSwapLossBps()).to.equal(300);
      await a.setRiskLimits(1, 1);
      expect(await fount.maxPoolDeviationBps()).to.equal(1);
    });

    it("fee split: accepts exactly 30%, harvests pending fees at the old share before changing it", async function () {
      const ctx = await loadFixture(baseFixture);
      const { fount, position } = ctx.amd;
      await sink(ctx, fount, ctx.alice, USDG(1_000));
      await expect(fount.connect(ctx.admin).setProtocolShareBps(3000)).to.emit(fount, "ProtocolShareSet").withArgs(3000);

      await position.accrueFees(0, USDG(100));
      await fount.connect(ctx.admin).setProtocolShareBps(0);
      expect(await ctx.usdg.balanceOf(ctx.feeRouter)).to.equal(USDG(30));
      expect(await fount.protocolShareBps()).to.equal(0);

      // With a 0% share nothing leaves for the FeeRouter, but gross fees are still tracked.
      await position.accrueFees(EQ(1), USDG(100));
      await expect(fount.harvest()).to.emit(fount, "FeesHarvested").withArgs(EQ(1), USDG(100), 0, 0);
      expect(await ctx.usdg.balanceOf(ctx.feeRouter)).to.equal(USDG(30));
      expect(await ctx.amd.equity.balanceOf(ctx.feeRouter)).to.equal(0);
      expect(await fount.grossEquityFees()).to.equal(EQ(1));
      expect(await fount.grossUsdgFees()).to.equal(USDG(200));
    });

    it("harvest with no pending fees is a no-op", async function () {
      const ctx = await loadFixture(baseFixture);
      await expect(ctx.amd.fount.harvest()).not.to.emit(ctx.amd.fount, "FeesHarvested");
    });

    it("harvest forwards an equity-only fee share", async function () {
      const ctx = await loadFixture(baseFixture);
      const { fount, position, equity } = ctx.amd;
      await position.accrueFees(EQ(10), 0);
      await expect(fount.harvest()).to.emit(fount, "FeesHarvested").withArgs(EQ(10), 0, EQ(3), 0);
      expect(await equity.balanceOf(ctx.feeRouter)).to.equal(EQ(3));
      expect(await ctx.usdg.balanceOf(ctx.feeRouter)).to.equal(0);
    });
  });

  describe("rebalance", function () {
    it("can sell Equity Token, or skip the swap entirely", async function () {
      const ctx = await loadFixture(baseFixture);
      const { fount, position, equity } = ctx.amd;
      await sink(ctx, fount, ctx.alice, USDG(3_000));
      await fount.connect(ctx.keeper).rebalance(-600, 600, true, USDG(3_000), "0x");
      expect(await ctx.usdg.balanceOf(position)).to.equal(0);
      const eq = await equity.balanceOf(position);
      expect(eq).to.be.closeTo(EQ(20), EQ(0.000001));

      await expect(fount.connect(ctx.keeper).rebalance(-120, 120, false, EQ(10), "0x"))
        .to.emit(fount, "Rebalanced")
        .withArgs(-120, 120, 1);
      expect(await ctx.usdg.balanceOf(position)).to.equal(USDG(1_500));
      expect(await equity.balanceOf(position)).to.equal(eq - EQ(10));

      await fount.connect(ctx.keeper).rebalance(-60, 60, false, 0, "0x");
      expect(await ctx.usdg.balanceOf(position)).to.equal(USDG(1_500));
      expect(await position.entries()).to.equal(3);
    });

    it("reverts when the price is stale", async function () {
      const ctx = await loadFixture(baseFixture);
      await time.increase(3601);
      await expect(ctx.amd.fount.connect(ctx.keeper).rebalance(-60, 60, false, 0, "0x")).to.be.reverted;
    });

    it("bounds the swap with the oracle minOut (adapter under-delivers -> reverts)", async function () {
      const ctx = await loadFixture(baseFixture);
      const { fount, equity } = ctx.amd;
      await sink(ctx, fount, ctx.alice, USDG(3_000));
      await fount.connect(ctx.keeper).rebalance(-600, 600, true, USDG(1_500), "0x");
      // 2% worse than oracle on the sell side; limit is 1%.
      await ctx.swap.setRate(equity, ctx.usdg, ((USDG(147) * 10n ** 18n) / EQ(1)));
      await expect(fount.connect(ctx.keeper).rebalance(-600, 600, false, EQ(5), "0x")).to.be.reverted;
    });
  });

  describe("USDG exits that sell idle Equity Token", function () {
    it("sells idle Equity Token when the range is empty", async function () {
      const ctx = await loadFixture(baseFixture);
      const { fount, equity } = ctx.amd;
      await sink(ctx, fount, ctx.alice, USDG(10_000));
      // Idle equity in the Fount with an empty range (e.g. donated / compounded).
      await equity.mint(fount, EQ(10));
      expect(await fount.totalAssets()).to.equal(USDG(11_500));

      const before = await ctx.usdg.balanceOf(ctx.alice);
      await fount.connect(ctx.alice).withdraw(USDG(11_000), ctx.alice.address, ctx.alice.address);
      expect((await ctx.usdg.balanceOf(ctx.alice)) - before).to.equal(USDG(11_000));
      expect(await equity.balanceOf(fount)).to.be.lt(EQ(10));
      expect(await equity.balanceOf(fount)).to.be.gt(EQ(3));
    });

    it("pulls only USDG from a USDG-only range without swapping", async function () {
      const ctx = await loadFixture(baseFixture);
      const { fount, position } = ctx.amd;
      await sink(ctx, fount, ctx.alice, USDG(10_000));
      await fount.connect(ctx.keeper).rebalance(-600, 600, false, 0, "0x");
      expect(await ctx.usdg.balanceOf(position)).to.equal(USDG(10_000));
      const before = await ctx.usdg.balanceOf(ctx.alice);
      await fount.connect(ctx.alice).redeem((await fount.balanceOf(ctx.alice)) / 2n, ctx.alice.address, ctx.alice.address);
      expect((await ctx.usdg.balanceOf(ctx.alice)) - before).to.be.closeTo(USDG(5_000), 1n);
    });
  });

  describe("redeemInKind", function () {
    it("rejects zero shares", async function () {
      const ctx = await loadFixture(baseFixture);
      await expect(
        ctx.amd.fount.connect(ctx.alice).redeemInKind(0, ctx.alice.address, ctx.alice.address, 0, 0)
      ).to.be.revertedWithCustomError(ctx.amd.fount, "InvalidConfig");
    });

    it("needs allowance for a third party and spends it", async function () {
      const ctx = await loadFixture(baseFixture);
      const { fount } = ctx.amd;
      await sink(ctx, fount, ctx.alice, USDG(1_000));
      const shares = await fount.balanceOf(ctx.alice);
      await expect(
        fount.connect(ctx.bob).redeemInKind(shares, ctx.bob.address, ctx.alice.address, 0, 0)
      ).to.be.revertedWithCustomError(fount, "ERC20InsufficientAllowance");
      await fount.connect(ctx.alice).approve(ctx.bob, shares);
      const before = await ctx.usdg.balanceOf(ctx.bob);
      await expect(fount.connect(ctx.bob).redeemInKind(shares, ctx.bob.address, ctx.alice.address, 0, 0)).to.emit(
        fount,
        "RedeemedInKind"
      );
      expect((await ctx.usdg.balanceOf(ctx.bob)) - before).to.equal(USDG(1_000));
      expect(await fount.allowance(ctx.alice, ctx.bob)).to.equal(0);
    });

    it("enforces minEquity and minUsdg slippage bounds", async function () {
      const ctx = await loadFixture(baseFixture);
      const { fount } = ctx.amd;
      await sink(ctx, fount, ctx.alice, USDG(3_000));
      await fount.connect(ctx.keeper).rebalance(-600, 600, true, USDG(1_500), "0x");
      const shares = await fount.balanceOf(ctx.alice);
      const [he, hu] = await fount.holdings();
      expect(hu).to.equal(USDG(1_500));
      const a = fount.connect(ctx.alice);
      await expect(a.redeemInKind(shares, ctx.alice.address, ctx.alice.address, he + 1n, 0)).to.be.revertedWithCustomError(
        fount,
        "Slippage"
      );
      await expect(a.redeemInKind(shares, ctx.alice.address, ctx.alice.address, 0, USDG(1_500) + 1n)).to.be.revertedWithCustomError(
        fount,
        "Slippage"
      );
      await expect(a.redeemInKind(shares, ctx.alice.address, ctx.alice.address, he, hu))
        .to.emit(fount, "RedeemedInKind")
        .withArgs(ctx.alice.address, ctx.alice.address, ctx.alice.address, shares, he, hu);
    });

    it("rounds down in favour of remaining holders and returns idle plus range balances", async function () {
      const ctx = await loadFixture(baseFixture);
      const { fount, equity } = ctx.amd;
      await sink(ctx, fount, ctx.alice, USDG(3_000));
      await sink(ctx, fount, ctx.bob, USDG(3_000));
      await fount.connect(ctx.keeper).rebalance(-600, 600, true, USDG(3_000), "0x");
      await equity.mint(fount, EQ(1)); // idle equity on top of the range
      await ctx.usdg.mint(fount, USDG(7)); // idle USDG on top of the range

      // A dust redemption pays no USDG (rounds to zero) but still burns the share.
      const [heD, huD] = await fount.holdings();
      const supplyD = await fount.totalSupply();
      const eD = await equity.balanceOf(ctx.alice);
      const uD = await ctx.usdg.balanceOf(ctx.alice);
      const s0 = await fount.balanceOf(ctx.alice);
      await fount.connect(ctx.alice).redeemInKind(1n, ctx.alice.address, ctx.alice.address, 0, 0);
      expect(await fount.balanceOf(ctx.alice)).to.equal(s0 - 1n);
      expect(await ctx.usdg.balanceOf(ctx.alice)).to.equal(uD);
      expect(huD / supplyD).to.equal(0);
      expect((await equity.balanceOf(ctx.alice)) - eD).to.be.lte(heD / supplyD);

      // An odd share count: outputs never exceed the exact pro-rata amount.
      const e0 = await equity.balanceOf(ctx.alice);
      const u0 = await ctx.usdg.balanceOf(ctx.alice);
      const [heB, huB] = await fount.holdings();
      const supply = await fount.totalSupply();
      const odd = (await fount.balanceOf(ctx.alice)) - 12345n;
      await fount.connect(ctx.alice).redeemInKind(odd, ctx.alice.address, ctx.alice.address, 0, 0);
      const gotE = (await equity.balanceOf(ctx.alice)) - e0;
      const gotU = (await ctx.usdg.balanceOf(ctx.alice)) - u0;
      expect(gotE).to.be.lte((heB * odd) / supply);
      expect(gotU).to.be.lte((huB * odd) / supply);
      expect(gotE).to.be.gte((heB * odd) / supply - 2n);
      expect(gotU).to.be.gte((huB * odd) / supply - 2n);

      // Bob, who stayed, is not diluted.
      const [heA, huA] = await fount.holdings();
      const bobShares = await fount.balanceOf(ctx.bob);
      const supplyA = await fount.totalSupply();
      expect((heA * 10n ** 18n) / supplyA).to.be.gte((heB * 10n ** 18n) / supply);
      expect((huA * 10n ** 18n) / supplyA).to.be.gte((huB * 10n ** 18n) / supply);
      expect(bobShares).to.be.gt(0);
    });

    it("works while the price is stale and while paused, harvesting first", async function () {
      const ctx = await loadFixture(baseFixture);
      const { fount, position } = ctx.amd;
      await sink(ctx, fount, ctx.alice, USDG(1_000));
      await position.accrueFees(0, USDG(100));
      await fount.connect(ctx.guardian).pause();
      await ctx.amd.feed.set(FEED(150), 1, 1);
      expect(await fount.priceFresh()).to.equal(false);
      const before = await ctx.usdg.balanceOf(ctx.alice);
      await fount.connect(ctx.alice).redeemInKind(await fount.balanceOf(ctx.alice), ctx.alice.address, ctx.alice.address, 0, 0);
      expect((await ctx.usdg.balanceOf(ctx.alice)) - before).to.equal(USDG(1_070));
      expect(await ctx.usdg.balanceOf(ctx.feeRouter)).to.equal(USDG(30));
    });
  });
});
