// Pool registration rules of V4SwapAdapter. Swaps themselves run against the live PoolManager in test/fork.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-toolbox/network-helpers");
const { deployTimelock } = require("./fixtures");

const A = "0x1000000000000000000000000000000000000001";
const B = "0x2000000000000000000000000000000000000002";
const HOOK = "0xE5e702641Ea86F4ae6cC3cDaeD2B886f976Be044";
const key = (c0, c1, hooks = ethers.ZeroAddress, fee = 3000, tickSpacing = 60) => ({ currency0: c0, currency1: c1, fee, tickSpacing, hooks });

async function fixture() {
  const [, multisig, other] = await ethers.getSigners();
  const { admin: owner } = await deployTimelock(multisig);
  // setPool and setHookAllowed never touch the PoolManager, so any non-zero address will do here.
  const adapter = (await ethers.deployContract("V4SwapAdapter", [owner.address, A, B, [], []])).connect(owner);
  return { owner, other, adapter };
}

describe("V4SwapAdapter pool registration", function () {
  it("is owned by a timelock and configured in its constructor", async function () {
    const { owner, other } = await loadFixture(fixture);
    const F = await ethers.getContractFactory("V4SwapAdapter");
    await expect(F.deploy(other.address, A, B, [], [])).to.be.revertedWithCustomError(F, "AdminNotTimelock");
    await expect(F.deploy(owner.address, ethers.ZeroAddress, B, [], [])).to.be.revertedWithCustomError(F, "InvalidPool");
    const hooked = key(ethers.ZeroAddress, A, HOOK, 0, 200);
    const adapter = await F.deploy(owner.address, A, B, [HOOK], [key(ethers.ZeroAddress, B, ethers.ZeroAddress, 100, 1), hooked]);
    expect(await adapter.hookAllowed(HOOK)).to.equal(true);
    expect((await adapter.poolFor(A, ethers.ZeroAddress))[1]).to.equal(true);
    expect((await adapter.poolFor(B, ethers.ZeroAddress))[1]).to.equal(true);
    // A hooked pool is refused when its hook is not in the same constructor call.
    await expect(F.deploy(owner.address, A, B, [], [hooked])).to.be.revertedWithCustomError(F, "InvalidPool");
  });

  it("rejects a zero tick spacing", async function () {
    const { adapter } = await loadFixture(fixture);
    await expect(adapter.setPool(key(A, B, ethers.ZeroAddress, 3000, 0))).to.be.revertedWithCustomError(adapter, "InvalidPool");
  });

  it("accepts hookless pools, including native ETH as currency0", async function () {
    const { adapter } = await loadFixture(fixture);
    await expect(adapter.setPool(key(A, B))).to.emit(adapter, "PoolSet").withArgs(A, B, 3000, 60);
    await expect(adapter.setPool(key(ethers.ZeroAddress, B, ethers.ZeroAddress, 100, 1))).to.emit(adapter, "PoolSet");
    const [k, exists] = await adapter.poolFor(B, ethers.ZeroAddress);
    expect(exists).to.equal(true);
    expect(k.tickSpacing).to.equal(1);
  });

  it("rejects unordered currencies", async function () {
    const { adapter } = await loadFixture(fixture);
    await expect(adapter.setPool(key(B, A))).to.be.revertedWithCustomError(adapter, "InvalidPool");
    await expect(adapter.setPool(key(A, A))).to.be.revertedWithCustomError(adapter, "InvalidPool");
  });

  it("rejects a hooked pool until its hook is allowlisted, and again once revoked", async function () {
    const { adapter } = await loadFixture(fixture);
    const hooked = key(ethers.ZeroAddress, A, HOOK, 0, 200);
    await expect(adapter.setPool(hooked)).to.be.revertedWithCustomError(adapter, "InvalidPool");
    await expect(adapter.setHookAllowed(HOOK, true)).to.emit(adapter, "HookAllowed").withArgs(HOOK, true);
    await expect(adapter.setPool(hooked)).to.emit(adapter, "PoolSet").withArgs(ethers.ZeroAddress, A, 0, 200);
    // A different hook stays blocked.
    await expect(adapter.setPool(key(ethers.ZeroAddress, B, B, 0, 200))).to.be.revertedWithCustomError(adapter, "InvalidPool");
    await adapter.setHookAllowed(HOOK, false);
    expect(await adapter.hookAllowed(HOOK)).to.equal(false);
    await expect(adapter.setPool(key(ethers.ZeroAddress, B, HOOK, 0, 200))).to.be.revertedWithCustomError(adapter, "InvalidPool");
  });

  it("limits allowlisting and registration to the owner, and rejects the zero hook", async function () {
    const { adapter, other } = await loadFixture(fixture);
    await expect(adapter.connect(other).setHookAllowed(HOOK, true)).to.be.revertedWithCustomError(adapter, "OwnableUnauthorizedAccount");
    await expect(adapter.connect(other).setPool(key(A, B))).to.be.revertedWithCustomError(adapter, "OwnableUnauthorizedAccount");
    await expect(adapter.setHookAllowed(ethers.ZeroAddress, true)).to.be.revertedWithCustomError(adapter, "InvalidPool");
  });

  it("never lets native ETH be the input or output of a swap", async function () {
    const { adapter } = await loadFixture(fixture);
    await adapter.setPool(key(ethers.ZeroAddress, B, ethers.ZeroAddress, 100, 1));
    await expect(adapter.swap(ethers.ZeroAddress, B, 1n, 0n, A, "0x")).to.be.revertedWithCustomError(adapter, "InvalidRoute");
    await expect(adapter.swap(B, ethers.ZeroAddress, 1n, 0n, A, "0x")).to.be.revertedWithCustomError(adapter, "InvalidRoute");
  });
});
