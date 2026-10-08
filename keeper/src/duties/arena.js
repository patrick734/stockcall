// Arena duties, in the order a round needs them:
//   reveal    during the 5-minute reveal window: opens sealed reveals from the inbox and reveals them (anyone may)
//   snapshot  during the same window: reads Chainlink for the round if no reveal did yet (anyone may)
//   settle    right after the hour: settles ended rounds, within the guard window (anyone may)
//   flush     sends accrued fees and forfeits to BuyBurn (anyone may)
//   buy-burn  buys $CALL with BuyBurn's ETH in the Pons pool and burns it (keeper only, capped, rate-limited)
const { ethers } = require("ethers");
const abis = require("../abis");
const { exec, reason, blockTime } = require("../chain");
const { logger } = require("../log");
const { open } = require("../sealed");
const { sealedFor } = require("../inbox");
const { revealRound, endedRounds, GUARD_WINDOW, P, burnAmount, minOut } = require("../arenaPlan");

const BATCH = 20;

function arena(ctx) {
  return new ethers.Contract(ctx.dep.arena, abis.Arena, ctx.runner);
}

/** Round fields by index: a Result's "entries" would collide with its own entries() method. */
async function roundOf(a, n) {
  const r = await a.rounds(n);
  return { schemaId: r[0], state: Number(r[3]), snapped: r[4], entries: Number(r[5]), revealed: Number(r[6]), pot: r[7] };
}

async function runReveals(ctx) {
  const log = logger("reveal", "Arena");
  if (!ctx.cfg.arena.reveal.enabled || !ctx.dep.arena) return;
  const now = Number(await blockTime(ctx.provider));
  const n = revealRound(now);
  if (n === null) return log.debug("no reveal window open");
  const a = arena(ctx);
  const round = await roundOf(a, n);
  if (round.entries === 0) return log.info("reveal window open, no entries", { round: n });
  if (round.revealed === round.entries) return log.info("every entry already revealed", { round: n });

  let sealed;
  try {
    sealed = await sealedFor(n);
  } catch (e) {
    return log.error("could not read the reveal inbox", { round: n, reason: e.message });
  }
  if (sealed === null) return log.info("relay off (no REVEAL_INBOX_URL): players reveal on the site", { round: n });
  if (!ctx.env.privateKey) return log.warn("sealed reveals need KEEPER_PRIVATE_KEY to open; skipping", { round: n, sealed: sealed.length });

  const calls = [];
  const seen = new Set();
  let bad = 0;
  for (const s of sealed) {
    let r;
    try {
      r = open(ctx.env.privateKey, s);
    } catch {
      bad++;
      continue;
    }
    if (r.n !== n || seen.has(r.player)) continue;
    seen.add(r.player);
    const e = await a.entryOf(n, r.player);
    if (e.stake === 0n || e.revealed) continue;
    if ((await a.commitmentFor(n, r.player, r.probs, r.salt)) !== e.commitment) {
      bad++;
      continue;
    }
    calls.push({ player: r.player, data: a.interface.encodeFunctionData("reveal", [n, r.player, r.probs, r.salt]) });
  }
  if (bad) log.warn("ignored sealed reveals that did not open or match a commitment", { round: n, count: bad });
  if (!calls.length) return log.info("nothing new to reveal", { round: n, sealed: sealed.length });
  log.info("revealing", { round: n, entries: calls.length, of: round.entries });
  for (let i = 0; i < calls.length; i += BATCH) {
    const chunk = calls.slice(i, i + BATCH);
    const r = await exec(ctx, log, a, "multicall", [chunk.map((c) => c.data)], `reveal ${chunk.length}`);
    if (r.ok) continue;
    // One bad entry fails the whole batch: reveal the rest one by one.
    for (const c of chunk) await exec(ctx, log, a, "multicall", [[c.data]], `reveal ${c.player}`);
  }
}

async function runSnapshot(ctx) {
  const log = logger("snapshot", "Arena");
  if (!ctx.dep.arena) return;
  const n = revealRound(Number(await blockTime(ctx.provider)));
  if (n === null) return;
  const a = arena(ctx);
  const round = await roundOf(a, n);
  if (round.entries === 0 || round.snapped) return;
  log.info("reading Chainlink for the start window", { round: n });
  await exec(ctx, log, a, "snapshot", [n], "snapshot");
}

async function runSettle(ctx) {
  const log = logger("settle", "Arena");
  if (!ctx.dep.arena) return;
  const now = Number(await blockTime(ctx.provider));
  const a = arena(ctx);
  let done = 0;
  for (const n of endedRounds(now, ctx.cfg.arena.settleLookbackRounds)) {
    const round = await roundOf(a, n);
    if (round.state !== 0 || round.entries === 0) continue;
    const late = now > (n + 1) * P + GUARD_WINDOW;
    const fields = { round: n, entries: round.entries, revealed: round.revealed, pot: ethers.formatEther(round.pot) };
    if (late && round.snapped) log.warn("settling late: a guarded round past its 30-minute window is refunded", fields);
    else log.info("settling", fields);
    const r = await exec(ctx, log, a, "settle", [n], `settle ${n}`);
    if (r.ok) done++;
  }
  if (!done) log.info("nothing to settle");
}

async function runFlush(ctx) {
  const log = logger("flush", "Arena");
  if (!ctx.dep.arena) return;
  const a = arena(ctx);
  const fees = await a.feesAccrued();
  if (fees < ethers.parseEther(ctx.cfg.arena.minFlushEth)) return log.info("fees below threshold", { eth: ethers.formatEther(fees) });
  log.info("sending fees and forfeits to BuyBurn", { eth: ethers.formatEther(fees) });
  await exec(ctx, log, a, "flushFees", [], "flushFees");
}

async function runBuyBurn(ctx) {
  const log = logger("buy-burn", "BuyBurn");
  const cfg = ctx.cfg.arena.burn;
  if (!cfg.enabled || !ctx.dep.buyBurn) return;
  const b = new ethers.Contract(ctx.dep.buyBurn, abis.BuyBurn, ctx.runner);
  if ((await b.token()) === ethers.ZeroAddress) return log.info("$CALL not set yet (./set-token.sh): fees wait in BuyBurn");
  if (await b.halted()) return log.warn("halted by the guardian");
  if (!(await b.hasRole(await b.KEEPER_ROLE(), ctx.keeper))) return log.warn("keeper address lacks KEEPER_ROLE on BuyBurn; skipping", { keeper: ctx.keeper });
  const [last, interval, now, cap, balance] = await Promise.all([b.lastBurn(), b.minInterval(), blockTime(ctx.provider), b.maxEthPerRun(), ctx.provider.getBalance(ctx.dep.buyBurn)]);
  const wait = Number(last) + Number(interval) - Number(now);
  if (wait > 0) return log.info(`next burn allowed in ${Math.ceil(wait / 60)} min`);
  const amount = burnAmount(balance, cap, ethers.parseEther(cfg.minBurnEth));
  if (!amount) return log.info("not enough ETH to burn yet", { eth: ethers.formatEther(balance) });
  let quoted;
  try {
    quoted = await b.burn.staticCall(amount, 0, { from: ctx.keeper });
  } catch (e) {
    return log.warn("cannot buy $CALL yet (has its Pons pool graduated?)", { reason: reason(e) });
  }
  const floor = minOut(quoted, cfg.slippageBps);
  log.info("buying and burning $CALL", { eth: ethers.formatEther(amount), quoted: ethers.formatEther(quoted), minOut: ethers.formatEther(floor) });
  await exec(ctx, log, b, "burn", [amount, floor], "burn");
}

module.exports = { runReveals, runSnapshot, runSettle, runFlush, runBuyBurn };
