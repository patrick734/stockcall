const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture, time } = require("@nomicfoundation/hardhat-network-helpers");
const {
  P, W, ETH, ASSET, GUARD, WEEKDAY, pack, q, NOUL, baseFixture, openWeekdayRound, setMoves, commitEntry, revealAll, play,
  endRound, valueAtTick,
} = require("./arena-fixtures");

// The worked example: NVDA +6 ticks, GOOGL +12, ETH -16 over the hour, three entries.
const EXAMPLE_MOVES = { NVDA: 1800, GOOGL: 3600, ETH: -4800 };
const A = pack([6000, 4000, 3500, 4000, 2500, 2000, 4500, 2500, 1000]);
const B = pack([9500, 500, 7000, 1500, 1500, 500, 500, 1000, 8000]);
const C = pack([5000, 5000, 3334, 3333, 3333, 2500, 2500, 2500, 2500]);
const FLAT = pack([5000, 5000, 3334, 3333, 3333, 2500, 2500, 2500, 2500]);
const PAY = { alice: 11047862289682540n, bob: 18591714761904761n, carol: 5290008686507936n };
const FEES = 70414261904761n;

const unpack = (v, k) => Array.from({ length: k }, (_, j) => Number((v >> BigInt(16 * j)) & 0xffffn));
const SALT = ethers.zeroPadValue("0x01", 32);

describe("Arena", function () {
  async function exampleRound() {
    const ctx = await baseFixture();
    const n = await openWeekdayRound(ctx.arena);
    await setMoves(ctx, n, EXAMPLE_MOVES);
    const entries = await play(ctx.arena, n, 1, [
      [ctx.alice, A, ETH("0.01")],
      [ctx.bob, B, ETH("0.02")],
      [ctx.carol, C, ETH("0.005")],
    ]);
    return { ...ctx, n, entries };
  }

  async function committedRound() {
    const ctx = await baseFixture();
    const n = await openWeekdayRound(ctx.arena);
    await setMoves(ctx, n, EXAMPLE_MOVES);
    const a = await commitEntry(ctx.arena, ctx.alice, n, 1, A, ETH("0.01"));
    const b = await commitEntry(ctx.arena, ctx.bob, n, 1, B, ETH("0.02"));
    const c = await commitEntry(ctx.arena, ctx.carol, n, 1, C, ETH("0.005"));
    return { ...ctx, n, a, b, c };
  }

  /** ETH the contract owes: balances, fees, and every unclaimed revealed payout. */
  async function owed(arena, n, players) {
    let sum = (await arena.totalBalances()) + (await arena.feesAccrued());
    for (const p of players) {
      const [received, fee] = await arena.previewPayout(n, p);
      sum += received + fee;
    }
    return sum;
  }

  describe("the worked example, to the wei", function () {
    it("settles to the documented soft answers", async function () {
      const { arena, n } = await loadFixture(exampleRound);
      await endRound(n);
      await arena.settle(n);
      const [up, lead, sev] = await arena.answerOf(n);
      expect(unpack(up, 2)).to.deep.equal([7500, 2500]);
      expect(unpack(lead, 3)).to.deep.equal([4117, 5883, 0]);
      expect(unpack(sev, 3)).to.deep.equal([0, 10000, 10000]); // cumulative: Minor 100%
    });

    it("pays every wallet exactly what the documented math says, to balance or wallet", async function () {
      const { arena, n, alice, bob, carol } = await loadFixture(exampleRound);
      await endRound(n);
      await arena.settle(n);
      expect(await arena.previewPayout(n, alice)).to.deep.equal([PAY.alice, 55150646825396n]);
      expect(await arena.previewPayout(n, bob)).to.deep.equal([PAY.bob, 0n]);
      expect(await arena.previewPayout(n, carol)).to.deep.equal([PAY.carol, 15263615079365n]);

      await expect(arena.connect(alice).claim([n], true)).to.changeEtherBalance(alice, PAY.alice);
      await arena.connect(bob).claim([n], false);
      expect(await arena.balanceOf(bob)).to.equal(PAY.bob);
      await expect(arena.connect(bob).withdraw(PAY.bob)).to.changeEtherBalance(bob, PAY.bob);
      await expect(arena.connect(carol).claim([n], true)).to.changeEtherBalance(carol, PAY.carol);
      expect(await arena.feesAccrued()).to.equal(FEES);
      expect(await ethers.provider.getBalance(arena)).to.equal(FEES + 2n); // 2 wei of rounding dust stays
    });

    it("sends the fees only to the burn contract", async function () {
      const { arena, n, alice, carol, burn, dave } = await loadFixture(exampleRound);
      await endRound(n);
      await arena.connect(alice).claim([n], false);
      await arena.connect(carol).claim([n], false);
      const fees = await arena.feesAccrued();
      await expect(arena.connect(dave).flushFees()).to.changeEtherBalances([arena, burn], [-fees, fees]);
      expect(await arena.feesAccrued()).to.equal(0n);
    });
  });

  describe("hidden entries", function () {
    it("stores only a hash until the reveal, and checks it", async function () {
      const { arena, n, a, alice, bob } = await loadFixture(committedRound);
      const e = await arena.entryOf(n, alice);
      expect(e.probs).to.equal(0n);
      expect(e.revealed).to.equal(false);
      expect(e.commitment).to.equal(await arena.commitmentFor(n, alice.address, A, a.salt));
      await time.increaseTo(n * P - W);
      await expect(arena.reveal(n, alice.address, B, a.salt)).to.be.revertedWithCustomError(arena, "BadReveal");
      await expect(arena.reveal(n, alice.address, A, SALT)).to.be.revertedWithCustomError(arena, "BadReveal");
      await expect(arena.reveal(n, bob.address, A, a.salt)).to.be.revertedWithCustomError(arena, "BadReveal");
      await expect(arena.connect(bob).reveal(n, alice.address, A, a.salt)).to.emit(arena, "Revealed").withArgs(n, alice.address, A);
      await expect(arena.reveal(n, alice.address, A, a.salt)).to.be.revertedWithCustomError(arena, "AlreadyRevealed");
    });

    it("reveals only between the lock and the start of the hour", async function () {
      const { arena, n, a, b, alice, bob } = await loadFixture(committedRound);
      await expect(arena.reveal(n, alice.address, A, a.salt)).to.be.revertedWithCustomError(arena, "NotRevealWindow");
      await time.increaseTo(n * P - W);
      await arena.reveal(n, alice.address, A, a.salt);
      await time.increaseTo(n * P);
      await expect(arena.reveal(n, bob.address, B, b.salt)).to.be.revertedWithCustomError(arena, "NotRevealWindow");
    });

    it("forfeits an unrevealed stake to the burn and leaves the others' payouts untouched", async function () {
      const ctx = await loadFixture(committedRound);
      const { arena, n, a, b, c, dave, alice, bob, carol, burn } = ctx;
      // Dave commits but never reveals; his stake must not change anyone else's result.
      await commitEntry(arena, dave, n, 1, B, ETH("0.05"));
      await revealAll(arena, [a, b, c]);
      await endRound(n);
      await arena.settle(n);
      expect((await arena.previewPayout(n, alice))[0]).to.equal(PAY.alice);
      expect((await arena.previewPayout(n, bob))[0]).to.equal(PAY.bob);
      expect((await arena.previewPayout(n, carol))[0]).to.equal(PAY.carol);
      expect(await arena.feesAccrued()).to.equal(ETH("0.05"));
      await expect(arena.connect(dave).claim([n], true)).to.be.revertedWithCustomError(arena, "NothingToClaim");
      await expect(arena.flushFees()).to.changeEtherBalance(burn, ETH("0.05"));
      expect(await owed(arena, n, [alice, bob, carol])).to.be.lte(await ethers.provider.getBalance(arena));
    });

    it("rejects bad probabilities at the reveal, which forfeits the stake", async function () {
      const { arena, alice } = await loadFixture(baseFixture);
      const n = await openWeekdayRound(arena);
      const bad = pack([5000, 4999, 3334, 3333, 3333, 2500, 2500, 2500, 2500]);
      const e = await commitEntry(arena, alice, n, 1, bad, ETH("0.001"));
      await time.increaseTo(n * P - W);
      await expect(arena.reveal(n, alice.address, bad, e.salt)).to.be.revertedWithCustomError(arena, "BadProbabilities");
      await endRound(n);
      await arena.settle(n);
      expect(await arena.feesAccrued()).to.equal(ETH("0.001"));
      expect((await arena.rounds(n)).state).to.equal(2n); // void: nobody revealed
    });

    it("rejects stray bits and wrong sums for every malformed forecast", async function () {
      const { arena } = await loadFixture(baseFixture);
      const signers = await ethers.getSigners();
      const n = await openWeekdayRound(arena);
      const bads = [
        pack([10000, 0, 3334, 3333, 3333, 2500, 2500, 2500, 2501]),
        FLAT | (1n << 160n),
        pack([20000, 0, 3334, 3333, 3333, 2500, 2500, 2500, 2500]),
      ];
      const entries = [];
      for (let i = 0; i < bads.length; i++) entries.push(await commitEntry(arena, signers[8 + i], n, 1, bads[i], ETH("0.001")));
      await time.increaseTo(n * P - W);
      for (const e of entries) {
        await expect(arena.reveal(n, e.signer.address, e.probs, e.salt)).to.be.revertedWithCustomError(arena, "BadProbabilities");
      }
    });
  });

  describe("play balance", function () {
    it("deposits, commits from the balance, tops up with ETH sent, and withdraws", async function () {
      const { arena, alice } = await loadFixture(baseFixture);
      await arena.connect(alice).deposit({ value: ETH("0.05") });
      expect(await arena.balanceOf(alice)).to.equal(ETH("0.05"));
      const n = await openWeekdayRound(arena);
      await commitEntry(arena, alice, n, 1, FLAT, ETH("0.03"), { fromBalance: true });
      expect(await arena.balanceOf(alice)).to.equal(ETH("0.02"));
      expect(await arena.totalBalances()).to.equal(ETH("0.02"));
      await expect(arena.connect(alice).withdraw(ETH("0.03"))).to.be.revertedWithCustomError(arena, "InsufficientBalance");
      await expect(arena.connect(alice).withdraw(ETH("0.02"))).to.changeEtherBalance(alice, ETH("0.02"));
      expect(await arena.totalBalances()).to.equal(0n);
    });

    it("refuses a commit the balance cannot cover", async function () {
      const { arena, alice } = await loadFixture(baseFixture);
      const n = await openWeekdayRound(arena);
      const c = await arena.commitmentFor(n, alice.address, FLAT, SALT);
      await expect(arena.connect(alice).commit(n, 1, ETH("0.01"), c, { value: ETH("0.005") })).to.be.revertedWithCustomError(arena, "InsufficientBalance");
      await expect(arena.connect(alice).commit(n, 1, ETH("0.01"), ethers.ZeroHash, { value: ETH("0.01") })).to.be.revertedWithCustomError(arena, "NoCommitment");
    });

    it("rolls winnings into the next round in one transaction with multicall", async function () {
      const ctx = await loadFixture(exampleRound);
      const { arena, alice, n } = ctx;
      const m = n + 3;
      await time.increaseTo(m * P - W - P + 5);
      const c = await arena.commitmentFor(m, alice.address, A, SALT);
      const calls = [
        arena.interface.encodeFunctionData("claim", [[n], false]),
        arena.interface.encodeFunctionData("commit", [m, 1, ETH("0.01"), c]),
      ];
      await expect(arena.connect(alice).multicall(calls)).to.emit(arena, "Committed");
      expect(await arena.balanceOf(alice)).to.equal(PAY.alice - ETH("0.01"));
    });

    it("never lets multicall reuse ETH sent with it", async function () {
      const { arena, alice } = await loadFixture(baseFixture);
      const calls = [arena.interface.encodeFunctionData("deposit"), arena.interface.encodeFunctionData("deposit")];
      await expect(arena.connect(alice).multicall(calls, { value: ETH(1) })).to.be.reverted; // multicall is not payable
    });

    it("pauses deposits and commits only; withdrawals, reveals, settling and claims keep working", async function () {
      const ctx = await loadFixture(committedRound);
      const { arena, guardian, admin, alice, n, a, b, c } = ctx;
      await arena.connect(ctx.bob).deposit({ value: ETH("0.01") });
      await arena.connect(guardian).pause();
      await expect(arena.connect(alice).deposit({ value: 1 })).to.be.revertedWithCustomError(arena, "EnforcedPause");
      await expect(arena.connect(alice).commit(n + 1, 1, ETH("0.001"), SALT, { value: ETH("0.001") })).to.be.revertedWithCustomError(arena, "EnforcedPause");
      await arena.connect(ctx.bob).withdraw(ETH("0.01"));
      await revealAll(arena, [a, b, c]);
      await endRound(n);
      await arena.connect(alice).claim([n], true);
      await expect(arena.connect(guardian).unpause()).to.be.revertedWithCustomError(arena, "AccessControlUnauthorizedAccount");
      await arena.connect(admin).unpause();
    });
  });

  describe("price guard", function () {
    const BASE = { NVDA: -230000, GOOGL: -229000, ETH: 0 }; // realistic ticks for a $100-ish stock in USDG

    async function guardedRound() {
      const ctx = await baseFixture();
      const n = await openWeekdayRound(ctx.arena);
      await setMoves(ctx, n, EXAMPLE_MOVES, BASE);
      for (const sym of ["NVDA", "GOOGL"]) await ctx.oracle.setPrice(ctx.pools[sym].asset, ETH(1), valueAtTick(BASE[sym]));
      const entries = await play(ctx.arena, n, 1, [
        [ctx.alice, A, ETH("0.01")],
        [ctx.bob, B, ETH("0.02")],
        [ctx.carol, C, ETH("0.005")],
      ]);
      return { ...ctx, n, entries };
    }

    const closeAt = async (ctx, sym, t) => ctx.oracle.setPrice(ctx.pools[sym].asset, ETH(1), valueAtTick(t));

    it("reads the oracle as a tick and snapshots it during the start window", async function () {
      const { arena, n } = await loadFixture(guardedRound);
      const [priced, tick] = await arena.oracleTick(ASSET.NVDA);
      expect(priced).to.equal(true);
      expect(Number(tick)).to.be.closeTo(BASE.NVDA, 1);
      expect((await arena.snapOf(n, ASSET.NVDA)).priced).to.equal(true);
      expect((await arena.snapOf(n, ASSET.ETH)).priced).to.equal(false); // ETH has no feed: guard off
      expect((await arena.rounds(n)).snapped).to.equal(true);
    });

    it("settles normally when the pools agree with Chainlink, with the same payouts", async function () {
      const ctx = await loadFixture(guardedRound);
      await closeAt(ctx, "NVDA", BASE.NVDA + 6);
      await closeAt(ctx, "GOOGL", BASE.GOOGL + 12);
      await endRound(ctx.n);
      await expect(ctx.arena.settle(ctx.n)).to.emit(ctx.arena, "Settled").withArgs(ctx.n, (x) => true, false, 0);
      expect((await ctx.arena.previewPayout(ctx.n, ctx.alice))[0]).to.equal(PAY.alice);
    });

    it("voids and refunds when a pool's end price strays from Chainlink", async function () {
      const ctx = await loadFixture(guardedRound);
      await closeAt(ctx, "NVDA", BASE.NVDA + 6 + 301); // the pool was pushed 301 ticks (about 3%) at the close
      await endRound(ctx.n);
      await expect(ctx.arena.settle(ctx.n)).to.emit(ctx.arena, "Settled").withArgs(ctx.n, (x) => true, true, 4);
      await expect(ctx.arena.connect(ctx.alice).claim([ctx.n], true)).to.changeEtherBalance(ctx.alice, ETH("0.01"));
      expect(await ctx.arena.feesAccrued()).to.equal(0n);
    });

    it("voids when the start window was pushed away from the snapshot", async function () {
      const ctx = await baseFixture();
      const n = await openWeekdayRound(ctx.arena);
      // The pool sat 400 ticks above Chainlink through the start window.
      await setMoves(ctx, n, EXAMPLE_MOVES, { ...BASE, NVDA: BASE.NVDA + 400 });
      await closeAt(ctx, "NVDA", BASE.NVDA);
      await closeAt(ctx, "GOOGL", BASE.GOOGL);
      await play(ctx.arena, n, 1, [[ctx.alice, A, ETH("0.01")], [ctx.bob, B, ETH("0.02")]]);
      await closeAt(ctx, "NVDA", BASE.NVDA + 406);
      await closeAt(ctx, "GOOGL", BASE.GOOGL + 12);
      await endRound(n);
      await expect(ctx.arena.settle(n)).to.emit(ctx.arena, "Settled").withArgs(n, (x) => true, true, 3);
    });

    it("voids a guarded round settled more than 30 minutes late", async function () {
      const ctx = await loadFixture(guardedRound);
      await endRound(ctx.n, 1801);
      await expect(ctx.arena.settle(ctx.n)).to.emit(ctx.arena, "Settled").withArgs(ctx.n, (x) => true, true, 5);
    });

    it("settles late normally when the guard was never live for the round", async function () {
      const { arena, n } = await loadFixture(exampleRound); // the oracle prices nothing
      await endRound(n, 1801);
      await expect(arena.settle(n)).to.emit(arena, "Settled").withArgs(n, (x) => true, false, 0);
    });

    it("plays on without the guard when the oracle is down or the feed is stale", async function () {
      const ctx = await loadFixture(guardedRound);
      await ctx.oracle.setReverts(true);
      expect((await ctx.arena.oracleTick(ASSET.NVDA))[0]).to.equal(false);
      await endRound(ctx.n);
      await expect(ctx.arena.settle(ctx.n)).to.emit(ctx.arena, "Settled").withArgs(ctx.n, (x) => true, false, 0);
    });

    it("voids when a required feed is unpriced", async function () {
      const ctx = await loadFixture(baseFixture);
      const { arena, admin, pools, oracle, alice } = ctx;
      // A second id for NVDA's pool, guard required, on its own card.
      await arena.connect(admin).setAsset(9, pools.NVDA, GUARD.REQUIRED);
      await arena.connect(admin).setSchema(7, [q(NOUL, 2, [9], [0], 12)]);
      await arena.connect(admin).setSchedule(7, 7, 0);
      const n = await openWeekdayRound(arena);
      await setMoves(ctx, n, { NVDA: 1800 });
      await play(arena, n, 7, [[alice, pack([5000, 5000]), ETH("0.001")]]);
      await oracle.setFresh(pools.NVDA.asset, false);
      await endRound(n);
      await expect(arena.settle(n)).to.emit(arena, "Settled").withArgs(n, (x) => true, true, 3);
    });

    it("keeps each round's guard, bounded, never off", async function () {
      const { arena, admin, alice } = await loadFixture(baseFixture);
      await expect(arena.connect(admin).setGuard(49)).to.be.revertedWithCustomError(arena, "InvalidConfig");
      await expect(arena.connect(admin).setGuard(2001)).to.be.revertedWithCustomError(arena, "InvalidConfig");
      await expect(arena.connect(alice).setGuard(500)).to.be.revertedWithCustomError(arena, "AccessControlUnauthorizedAccount");
      const n = await openWeekdayRound(arena);
      await commitEntry(arena, alice, n, 1, FLAT, ETH("0.001"));
      await arena.connect(admin).setGuard(1000);
      expect((await arena.rounds(n)).guardTicks).to.equal(300n);
      expect(await arena.guardTicks()).to.equal(1000n);
    });
  });

  describe("timing and cards", function () {
    it("takes commits only from open until five minutes before the hour", async function () {
      const { arena, alice } = await loadFixture(baseFixture);
      const n = await openWeekdayRound(arena);
      const [opens, locks, start, end] = await arena.timing(n);
      expect([opens, locks, start, end]).to.deep.equal([BigInt(n * P - W - P), BigInt(n * P - W), BigInt(n * P), BigInt(n * P + P)]);
      await expect(commitEntry(arena, alice, n + 1, 1, FLAT, ETH("0.001"))).to.be.revertedWithCustomError(arena, "RoundNotOpen");
      await time.increaseTo(n * P - W);
      await expect(commitEntry(arena, alice, n, 1, FLAT, ETH("0.001"))).to.be.revertedWithCustomError(arena, "RoundNotOpen");
      expect(await arena["openRound()"]()).to.equal(BigInt(n + 1));
    });

    it("asks stock questions on weekdays and ETH only on weekends", async function () {
      const { arena, alice } = await loadFixture(baseFixture);
      const wd = await openWeekdayRound(arena);
      expect(await arena.schemaFor(wd)).to.equal(1n);
      const WE = pack([5000, 5000, 2500, 2500, 2500, 2500]);
      await expect(commitEntry(arena, alice, wd, 2, WE, ETH("0.001"))).to.be.revertedWithCustomError(arena, "WrongSchema").withArgs(1);
      const we = await openWeekdayRound(arena, true);
      expect(await arena.schemaFor(we)).to.equal(2n);
      await commitEntry(arena, alice, we, 2, WE, ETH("0.001"));
    });

    it("keeps a round's card once it has a commit, even if the schedule changes", async function () {
      const { arena, admin, alice, bob } = await loadFixture(baseFixture);
      const n = await openWeekdayRound(arena);
      await commitEntry(arena, alice, n, 1, FLAT, ETH("0.001"));
      await arena.connect(admin).setSchedule(1, 2, 0); // every hour is now a weekend hour
      expect(await arena.schemaFor(n)).to.equal(1n);
      await commitEntry(arena, bob, n, 1, FLAT, ETH("0.001"));
      expect(await arena.schemaFor(n + 1)).to.equal(2n);
    });
  });

  describe("commits", function () {
    it("enforces the stake limits, the round cap and one entry per wallet", async function () {
      const { arena, alice, bob } = await loadFixture(baseFixture);
      const n = await openWeekdayRound(arena);
      await expect(commitEntry(arena, alice, n, 1, FLAT, ETH("0.0004"))).to.be.revertedWithCustomError(arena, "BadStake");
      await expect(commitEntry(arena, alice, n, 1, FLAT, ETH("0.11"))).to.be.revertedWithCustomError(arena, "BadStake");
      await commitEntry(arena, alice, n, 1, FLAT, ETH("0.1"));
      await expect(commitEntry(arena, alice, n, 1, FLAT, ETH("0.1"))).to.be.revertedWithCustomError(arena, "AlreadyEntered");
      const signers = await ethers.getSigners();
      for (const s of signers.slice(8, 17)) await commitEntry(arena, s, n, 1, FLAT, ETH("0.1"));
      await expect(commitEntry(arena, bob, n, 1, FLAT, ETH("0.0005"))).to.be.revertedWithCustomError(arena, "RoundFull");
    });

    it("refuses a card whose pools keep too few observations", async function () {
      const { arena, pools, alice } = await loadFixture(baseFixture);
      expect(await arena.MIN_OBSERVATIONS()).to.equal(6300n);
      await pools.GOOGL.setCardinality(6299);
      const n = await openWeekdayRound(arena);
      await expect(commitEntry(arena, alice, n, 1, FLAT, ETH("0.001"))).to.be.revertedWithCustomError(arena, "PoolTooShallow").withArgs(pools.GOOGL.target);
    });
  });

  describe("settlement and claims", function () {
    it("cannot settle before the hour ends; a claim settles first and works only once", async function () {
      const { arena, alice, n } = await loadFixture(exampleRound);
      await time.increaseTo(n * P + P - 10);
      await expect(arena.settle(n)).to.be.revertedWithCustomError(arena, "NotEnded");
      await endRound(n);
      await arena.connect(alice).claim([n], false); // settles on the way
      await expect(arena.settle(n)).to.be.revertedWithCustomError(arena, "AlreadySettled");
      await expect(arena.connect(alice).claim([n], false)).to.be.revertedWithCustomError(arena, "NothingToClaim");
    });

    it("refunds a lone entry exactly, and identical entries exactly", async function () {
      const ctx = await loadFixture(baseFixture);
      const { arena, alice, bob, carol } = ctx;
      const n = await openWeekdayRound(arena);
      await setMoves(ctx, n, EXAMPLE_MOVES);
      await play(arena, n, 1, [[alice, A, ETH("0.03")]]);
      const m = n + 3; // rounds next to each other share a price window
      await time.increaseTo(m * P - W - P + 5);
      await setMoves(ctx, m, { NVDA: -3000, GOOGL: 600, ETH: 9000 });
      await play(arena, m, 1, [[bob, B, ETH("0.02")], [carol, B, ETH("0.05")]]);
      await endRound(m);
      await expect(arena.connect(alice).claim([n], true)).to.changeEtherBalance(alice, ETH("0.03"));
      await expect(arena.connect(bob).claim([m], true)).to.changeEtherBalance(bob, ETH("0.02"));
      await expect(arena.connect(carol).claim([m], true)).to.changeEtherBalance(carol, ETH("0.05"));
    });

    it("voids the round and refunds in full when a pool can no longer be read", async function () {
      const { arena, pools, alice, bob, n } = await loadFixture(exampleRound);
      await endRound(n);
      await pools.ETH.setFailObserve(true);
      await expect(arena.settle(n)).to.emit(arena, "Settled").withArgs(n, (x) => true, true, 2);
      await expect(arena.connect(alice).claim([n], true)).to.changeEtherBalance(alice, ETH("0.01"));
      await expect(arena.connect(bob).claim([n], true)).to.changeEtherBalance(bob, ETH("0.02"));
      expect(await arena.feesAccrued()).to.equal(0n);
    });

    it("refuses to settle with too little gas instead of voiding", async function () {
      const { arena, n } = await loadFixture(exampleRound);
      await endRound(n);
      await expect(arena.settle(n, { gasLimit: 250_000 })).to.be.reverted;
      expect((await arena.rounds(n)).state).to.equal(0n);
      await arena.settle(n);
    });

    it("reads a pool whose asset is token1 with the sign flipped", async function () {
      const ctx = await loadFixture(baseFixture);
      const { arena, admin, usdg, factory, alice } = ctx;
      let token;
      do token = await ethers.deployContract("MockERC20", ["F", "F", 18]);
      while (BigInt(token.target) < BigInt(usdg.target));
      const pool = await ethers.deployContract("MockOraclePool", [token, usdg, 500]);
      expect(await pool.token0()).to.equal(usdg.target);
      await factory.register(pool, token, usdg, 500);
      await arena.connect(admin).setAsset(9, pool, GUARD.OFF);
      const asset = await arena.assets(9);
      expect(asset.flip).to.equal(true);
      expect(asset.token).to.equal(token.target);
      await arena.connect(admin).setSchema(7, [q(NOUL, 2, [9], [0], 12)]);
      await arena.connect(admin).setSchedule(7, 7, 0);

      const n = await openWeekdayRound(arena);
      await pool.setTickAt(n * P - 2 * W, 0);
      await pool.setTickAt(n * P + P - W, -6); // the asset rises 6 ticks, so the pool's tick falls 6
      await play(arena, n, 7, [[alice, pack([5000, 5000]), ETH("0.001")]]);
      await endRound(n);
      await arena.settle(n);
      const [up] = await arena.answerOf(n);
      expect(unpack(up, 2)).to.deep.equal([7500, 2500]);
    });

    it("claims several rounds at once", async function () {
      const ctx = await loadFixture(exampleRound);
      const { arena, alice, n } = ctx;
      const m = n + 3;
      await time.increaseTo(m * P - W - P + 5);
      await setMoves(ctx, m, { NVDA: 600, GOOGL: 0, ETH: 0 });
      await play(arena, m, 1, [[alice, A, ETH("0.002")]]);
      await endRound(m);
      await expect(arena.connect(alice).claim([n, m], true)).to.changeEtherBalance(alice, PAY.alice + ETH("0.002"));
    });

    it("voids a round nobody revealed, forfeiting every stake", async function () {
      const { arena, n } = await loadFixture(committedRound);
      await endRound(n);
      await expect(arena.settle(n)).to.emit(arena, "Settled").withArgs(n, [], true, 1);
      expect(await arena.feesAccrued()).to.equal(ETH("0.035"));
    });
  });

  describe("governance", function () {
    it("gives the deployer no role, the timelock admin and the guardian pause only", async function () {
      const { arena, deployer, timelock, guardian } = await loadFixture(baseFixture);
      expect(await arena.hasRole(await arena.DEFAULT_ADMIN_ROLE(), timelock.target)).to.equal(true);
      expect(await arena.hasRole(await arena.DEFAULT_ADMIN_ROLE(), deployer.address)).to.equal(false);
      expect(await arena.hasRole(await arena.GUARDIAN_ROLE(), deployer.address)).to.equal(false);
      expect(await arena.hasRole(await arena.GUARDIAN_ROLE(), guardian.address)).to.equal(true);
      for (const call of [
        () => arena.setLimits(1, 2, 3),
        () => arena.setFeeBps(100),
        () => arena.setSchedule(1, 2, 0),
        () => arena.setGuard(300),
        () => arena.unpause(),
        () => arena.pause(),
      ]) {
        await expect(call()).to.be.revertedWithCustomError(arena, "AccessControlUnauthorizedAccount");
      }
    });

    it("has no way for anyone to move a player's ETH", async function () {
      const { arena } = await loadFixture(baseFixture);
      const fns = arena.interface.fragments.filter((f) => f.type === "function").map((f) => f.name);
      for (const name of ["sweep", "rescue", "transfer", "emergencyWithdraw", "setFeeSink"]) expect(fns).to.not.include(name);
    });

    it("never changes a defined card or asset", async function () {
      const { arena, admin, pools } = await loadFixture(baseFixture);
      await expect(arena.connect(admin).setSchema(1, WEEKDAY)).to.be.revertedWithCustomError(arena, "InvalidSchema");
      await expect(arena.connect(admin).setAsset(ASSET.ETH, pools.NVDA, GUARD.OFF)).to.be.revertedWithCustomError(arena, "InvalidAsset");
      await expect(arena.connect(admin).setAsset(9, pools.NVDA, 3)).to.be.revertedWithCustomError(arena, "InvalidAsset");
      await arena.connect(admin).setSchema(3, [q(NOUL, 2, [ASSET.GOOGL], [5], 8)]);
      expect((await arena.schema(3)).length).to.equal(1);
    });

    it("only registers USDG pools the factory vouches for", async function () {
      const { arena, admin, usdg, factory } = await loadFixture(baseFixture);
      const t = await ethers.deployContract("MockERC20", ["X", "X", 18]);
      const rogue = await ethers.deployContract("MockOraclePool", [t, usdg, 500]);
      await expect(arena.connect(admin).setAsset(9, rogue, GUARD.OFF)).to.be.revertedWithCustomError(arena, "InvalidAsset");
      const other = await ethers.deployContract("MockERC20", ["Y", "Y", 18]);
      const noUsdg = await ethers.deployContract("MockOraclePool", [t, other, 500]);
      await factory.register(noUsdg, t, other, 500);
      await expect(arena.connect(admin).setAsset(9, noUsdg, GUARD.OFF)).to.be.revertedWithCustomError(arena, "InvalidAsset");
      await factory.register(rogue, t, usdg, 500);
      await arena.connect(admin).setAsset(9, rogue, GUARD.OFF);
    });

    it("delays a fee change 24h, caps it at 10%, and keeps each round's fee", async function () {
      const { arena, admin, alice } = await loadFixture(baseFixture);
      await expect(arena.connect(admin).setFeeBps(1001)).to.be.revertedWithCustomError(arena, "InvalidConfig");
      await arena.connect(admin).setFeeBps(1000);
      expect(await arena.feeBps()).to.equal(500n);
      const n = await openWeekdayRound(arena);
      await commitEntry(arena, alice, n, 1, FLAT, ETH("0.001"));
      await time.increase(24 * 3600);
      expect(await arena.feeBps()).to.equal(1000n);
      expect((await arena.rounds(n)).feeBps).to.equal(500n);
    });

    it("rejects a non-timelock admin, a deployer guardian and a missing oracle", async function () {
      const ctx = await loadFixture(baseFixture);
      const { deployArena } = require("./arena-fixtures");
      const F = await ethers.getContractFactory("Arena");
      await expect(deployArena({ ...ctx, timelock: { target: ctx.multisig.address } })).to.be.revertedWithCustomError(F, "AdminNotTimelock");
      await expect(deployArena({ ...ctx, guardian: ctx.deployer })).to.be.revertedWithCustomError(F, "InvalidConfig");
      await expect(deployArena({ ...ctx, oracle: { target: ethers.ZeroAddress } })).to.be.revertedWithCustomError(F, "InvalidConfig");
      await expect(deployArena(ctx, { guardTicks: 10 })).to.be.revertedWithCustomError(F, "InvalidConfig");
    });
  });
});

