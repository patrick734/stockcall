// Reference implementation of the StockCall round math in BigInt, bit for bit with Arena.sol.
// Used by the parity tests, the keeper and the app.
const W = 300n;
const NOUL = 0;
const CHOICE = 1;
const SCORE = 2;

const fdiv = (a, b) => {
  const q = a / b;
  return a % b !== 0n && (a < 0n) !== (b < 0n) ? q - 1n : q;
};
const clamp = (x) => (x < 0n ? 0n : x > 10000n ? 10000n : x);
const big = (x) => BigInt(x);

/** The chain's answer vector v for one question (cumulative for SCORE, K - 1 entries). moves: id -> tick-seconds. */
function answerFor(q, moves) {
  const mw = big(q.margin) * W;
  if (q.kind === NOUL) {
    const x = big(moves[q.assets[0]]) - big(q.lines[0]) * W;
    const yes = clamp(5000n + fdiv(5000n * x, mw));
    return [yes, 10000n - yes];
  }
  if (q.kind === CHOICE) {
    const d = q.assets.slice(0, q.options).map((a) => big(moves[a]));
    let best = d[0];
    let leader = 0;
    d.forEach((x, i) => {
      if (x > best) [best, leader] = [x, i];
    });
    const g = d.map((x) => {
      const v = mw - (best - x);
      return v > 0n ? v : 0n;
    });
    const sum = g.reduce((a, b) => a + b, 0n);
    const v = g.map((x) => (10000n * x) / sum);
    v[leader] += 10000n - v.reduce((a, b) => a + b, 0n);
    return v;
  }
  const raw = big(moves[q.assets[0]]);
  const x = q.absMove && raw < 0n ? -raw : raw;
  return Array.from({ length: q.options - 1 }, (_, m) => clamp(5000n + fdiv(5000n * (big(q.lines[m]) * W - x), mw)));
}

/** u for one question: probabilities, or cumulative probabilities (first K - 1) for SCORE. */
function forecast(q, p) {
  if (q.kind !== SCORE) return p.map(big);
  let s = 0n;
  return p.slice(0, -1).map((x) => (s += big(x)));
}

const normaliser = (q) => (q.kind === SCORE ? big(q.options - 1) * 100000000n : 200000000n);
const gcd = (a, b) => (b === 0n ? a : gcd(b, a % b));

/**
 * Payouts for a settled round. entries: [{ stake: bigint, probs: number[][] (per question) }].
 * Returns [{ payout, fee, received }] in the same order.
 */
function payouts(card, entries, moves, feeBps = 500n) {
  const v = card.map((q) => answerFor(q, moves));
  const pot = entries.reduce((a, e) => a + e.stake, 0n);
  const T = card.map((q, qi) => {
    let q2 = 0n;
    const q1 = [0n, 0n, 0n, 0n];
    for (const e of entries) {
      const u = forecast(q, e.probs[qi]);
      q2 += e.stake * u.reduce((a, x) => a + x * x, 0n);
      u.forEach((x, j) => (q1[j] += e.stake * x));
    }
    return q2 - 2n * v[qi].reduce((a, x, j) => a + x * q1[j], 0n) + pot * v[qi].reduce((a, x) => a + x * x, 0n);
  });
  const lambda = card.reduce((l, q) => (l / gcd(l, normaliser(q))) * normaliser(q), 1n);
  return entries.map((e) => {
    let num = 0n;
    card.forEach((q, qi) => {
      const u = forecast(q, e.probs[qi]);
      const loss = u.reduce((a, x, j) => a + (x - v[qi][j]) ** 2n, 0n);
      num += (T[qi] - pot * loss) * (lambda / normaliser(q));
    });
    let payout = e.stake + fdiv(e.stake * num, big(card.length) * pot * lambda);
    if (payout < 0n) payout = 0n;
    const fee = payout > e.stake ? ((payout - e.stake) * big(feeBps)) / 10000n : 0n;
    return { payout, fee, received: payout - fee };
  });
}

/** Packs per-question basis points into the uint256 that enter() takes. */
function pack(perQuestion) {
  return perQuestion.flat().reduce((acc, p, i) => acc | (big(p) << big(16 * i)), 0n);
}

/** Whole basis points summing to exactly 10,000 (largest remainder, ties to the lower index). */
function toBasisPoints(probs) {
  const total = probs.reduce((a, b) => a + b, 0);
  const exact = probs.map((p) => (p / total) * 10000);
  const out = exact.map(Math.floor);
  let left = 10000 - out.reduce((a, b) => a + b, 0);
  const order = exact.map((x, i) => [x - Math.floor(x), i]).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let i = 0; left > 0; i++, left--) out[order[i % order.length][1]] += 1;
  return out;
}

module.exports = { NOUL, CHOICE, SCORE, answerFor, forecast, payouts, pack, toBasisPoints };
