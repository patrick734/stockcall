const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { deployTimelock } = require("./fixtures");

const Kind = { Fount: 0n, Program: 1n };

describe("FountRegistry", function () {
  async function registryFixture() {
    const [, multisig, other, newOwner, fountA, fountB, fountC, program] = await ethers.getSigners();
    const { admin: owner } = await deployTimelock(multisig);
    const registry = await ethers.deployContract("FountRegistry", [owner.address, []]);
    return { registry, owner, other, newOwner, fountA, fountB, fountC, program };
  }

  function asPlain(e) {
    return { target: e.target, kind: e.kind, ticker: e.ticker, listed: e.listed };
  }

  it("starts empty with the given owner", async function () {
    const { registry, owner, fountA } = await loadFixture(registryFixture);
    expect(await registry.owner()).to.equal(owner.address);
    expect(await registry.entries()).to.deep.equal([]);
    expect(await registry.indexPlusOne(fountA)).to.equal(0n);
  });

  it("rejects a zero owner and an owner that is not a timelock", async function () {
    const { other } = await loadFixture(registryFixture);
    const F = await ethers.getContractFactory("FountRegistry");
    await expect(F.deploy(ethers.ZeroAddress, [])).to.be.revertedWithCustomError(F, "OwnableInvalidOwner");
    await expect(F.deploy(other.address, [])).to.be.revertedWithCustomError(F, "AdminNotTimelock");
  });

  it("lists the initial Founts in the constructor", async function () {
    const { owner, fountA, fountB } = await loadFixture(registryFixture);
    const registry = await ethers.deployContract("FountRegistry", [
      owner.address,
      [
        { target: fountA.address, kind: Kind.Fount, ticker: "AMD" },
        { target: fountB.address, kind: Kind.Fount, ticker: "TSLA" },
      ],
    ]);
    expect((await registry.entries()).map(asPlain)).to.deep.equal([
      { target: fountA.address, kind: Kind.Fount, ticker: "AMD", listed: true },
      { target: fountB.address, kind: Kind.Fount, ticker: "TSLA", listed: true },
    ]);
    const F = await ethers.getContractFactory("FountRegistry");
    await expect(
      F.deploy(owner.address, [{ target: ethers.ZeroAddress, kind: Kind.Fount, ticker: "X" }])
    ).to.be.revertedWithCustomError(F, "Unknown");
  });

  it("lists Founts and Programs in order", async function () {
    const { registry, owner, fountA, fountC, program } = await loadFixture(registryFixture);
    await expect(registry.connect(owner).list(fountA.address, Kind.Fount, "AMD"))
      .to.emit(registry, "Listed")
      .withArgs(fountA.address, Kind.Fount, "AMD");
    await registry.connect(owner).list(fountC.address, Kind.Fount, "NVDA");
    await registry.connect(owner).list(program.address, Kind.Program, "BASKET");

    const e = (await registry.entries()).map(asPlain);
    expect(e).to.deep.equal([
      { target: fountA.address, kind: Kind.Fount, ticker: "AMD", listed: true },
      { target: fountC.address, kind: Kind.Fount, ticker: "NVDA", listed: true },
      { target: program.address, kind: Kind.Program, ticker: "BASKET", listed: true },
    ]);
    expect(await registry.indexPlusOne(fountA)).to.equal(1n);
    expect(await registry.indexPlusOne(fountC)).to.equal(2n);
    expect(await registry.indexPlusOne(program)).to.equal(3n);
  });

  it("rejects listing the same target twice", async function () {
    const { registry, owner, fountA } = await loadFixture(registryFixture);
    await registry.connect(owner).list(fountA.address, Kind.Fount, "AMD");
    await expect(registry.connect(owner).list(fountA.address, Kind.Program, "OTHER")).to.be.revertedWithCustomError(
      registry,
      "AlreadyListed"
    );
  });

  it("delists by flag, keeping the entry and its index", async function () {
    const { registry, owner, fountA, fountB } = await loadFixture(registryFixture);
    await registry.connect(owner).list(fountA.address, Kind.Fount, "AMD");
    await registry.connect(owner).list(fountB.address, Kind.Fount, "TSLA");
    await expect(registry.connect(owner).delist(fountA.address)).to.emit(registry, "Delisted").withArgs(fountA.address);
    const e = (await registry.entries()).map(asPlain);
    expect(e[0]).to.deep.equal({ target: fountA.address, kind: Kind.Fount, ticker: "AMD", listed: false });
    expect(e[1].listed).to.equal(true);
    expect(await registry.indexPlusOne(fountA)).to.equal(1n);
    // a delisted target keeps its slot, so it cannot be listed again
    await expect(registry.connect(owner).list(fountA.address, Kind.Fount, "AMD")).to.be.revertedWithCustomError(
      registry,
      "AlreadyListed"
    );
  });

  it("rejects delisting an unknown target", async function () {
    const { registry, owner, fountA } = await loadFixture(registryFixture);
    await expect(registry.connect(owner).delist(fountA.address)).to.be.revertedWithCustomError(registry, "Unknown");
  });

  it("restricts list and delist to the owner", async function () {
    const { registry, owner, other, fountA } = await loadFixture(registryFixture);
    await expect(registry.connect(other).list(fountA.address, Kind.Fount, "AMD"))
      .to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount")
      .withArgs(other.address);
    await registry.connect(owner).list(fountA.address, Kind.Fount, "AMD");
    await expect(registry.connect(other).delist(fountA.address))
      .to.be.revertedWithCustomError(registry, "OwnableUnauthorizedAccount")
      .withArgs(other.address);
  });

  it("transfers ownership in two steps", async function () {
    const { registry, owner, other, newOwner, fountA } = await loadFixture(registryFixture);
    await registry.connect(owner).transferOwnership(newOwner.address);
    expect(await registry.pendingOwner()).to.equal(newOwner.address);
    await expect(registry.connect(other).acceptOwnership()).to.be.revertedWithCustomError(
      registry,
      "OwnableUnauthorizedAccount"
    );
    // still the old owner until accepted
    await registry.connect(owner).list(fountA.address, Kind.Fount, "AMD");
    await registry.connect(newOwner).acceptOwnership();
    expect(await registry.owner()).to.equal(newOwner.address);
    await expect(registry.connect(owner).delist(fountA.address)).to.be.revertedWithCustomError(
      registry,
      "OwnableUnauthorizedAccount"
    );
    await registry.connect(newOwner).delist(fountA.address);
  });
});
