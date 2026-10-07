// Random rounds: the contract and lib/score.js must agree to the wei, and payouts never exceed the pot.
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { loadFixture } = require("@nomicfoundation/hardhat-network-helpers");
const { ETH, W, WEEKDAY, WEEKEND, baseFixture, openWeekdayRound, setMoves, play, endRound } = require("./arena-fixtures");
const score = require("../../lib/score");

let seed = 20261006;
const rand = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const randProbs = (k) => score.toBasisPoints(Array.from({ length: k }, () => rand() ** 2 + 0.001));

describe("Scoring parity with lib/score.js", function () {
  for (const [label, card, weekend, ids] of [
    ["weekday card", WEEKDAY, false, { NVDA: 2, GOOGL: 3, ETH: 1 }],
    ["weekend card", WEEKEND, true, { NVDA: 2, GOOGL: 3, ETH: 1 }],
  ]) {
    for (let trial = 0; trial < 6; trial++) {
      it(`${label}, random round ${trial + 1}`, async function () {
        const ctx = await loadFixture(baseFixture);
        const n = await openWeekdayRound(ctx.arena, weekend);
        const moves = {};
        for (const sym of ["NVDA", "GOOGL", "ETH"]) moves[sym] = Math.round((rand() - 0.5) * 120) * W;
        await setMoves(ctx, n, moves);
        const signers = (await ethers.getSigners()).slice(4, 4 + 3 + Math.floor(rand() * 8));
        const entries = [];
        for (const s of signers) {
          const probs = card.map((q) => randProbs(q.options));
          const stake = ETH((0.0005 + rand() * 0.0995).toFixed(6));
          entries.push({ signer: s, stake, probs });
        }
        await play(ctx.arena, n, weekend ? 2 : 1, entries.map((e) => [e.signer, score.pack(e.probs), e.stake]));
        await endRound(n);
        await ctx.arena.settle(n);

        const byId = Object.fromEntries(Object.entries(moves).map(([sym, d]) => [ids[sym], d]));
        const expected = score.payouts(card, entries, byId, 500n);
        let paid = 0n;
        for (let i = 0; i < entries.length; i++) {
          const [received, fee] = await ctx.arena.previewPayout(n, entries[i].signer);
          expect(received).to.equal(expected[i].received);
          expect(fee).to.equal(expected[i].fee);
          paid += received + fee;
        }
        const pot = entries.reduce((a, e) => a + e.stake, 0n);
        expect(paid <= pot).to.equal(true);
        expect(pot - paid <= BigInt(entries.length)).to.equal(true); // at most a wei of dust per entry
      });
    }
  }
});
