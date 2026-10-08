// Pure Arena timing decisions, kept apart from chain calls so they can be unit tested.
// Round n is the hour [n * P, (n + 1) * P). Commits close at n * P - W; reveals run from then until n * P.
const P = 3600;
const W = 300;
const GUARD_WINDOW = 1800;

/** The round whose reveal window is open at `now`, or null. */
function revealRound(now) {
  const n = Math.floor(now / P) + 1;
  return now >= n * P - W && now < n * P ? n : null;
}

/** Rounds that have ended and may need settling, newest first. */
function endedRounds(now, lookback) {
  const lastEnded = Math.floor(now / P) - 1; // round n ends at (n + 1) * P
  return Array.from({ length: lookback }, (_, i) => lastEnded - i).filter((n) => n > 0);
}

/**
 * When an hour-mode run should next wake, in seconds from `now`: just after the next reveal window opens, then
 * just after the next round ends (to settle well inside the guard window). `margin` seconds past each moment.
 */
function nextWake(now, margin = 10) {
  const hour = Math.floor(now / P) * P;
  const next = hour + P;
  // A second look shortly after the hour retries a settle that ran before the chain's clock passed the end.
  const events = [hour + margin, hour + 3 * margin, next - W + margin, next + margin];
  return events.find((e) => e > now) - now;
}

/** How much ETH to burn this run, or 0. */
function burnAmount(balance, maxPerRun, minBurn) {
  const amount = balance < maxPerRun ? balance : maxPerRun;
  return amount >= minBurn ? amount : 0n;
}

function minOut(quoted, slippageBps) {
  return (quoted * BigInt(10_000 - slippageBps)) / 10_000n;
}

module.exports = { P, W, GUARD_WINDOW, revealRound, endedRounds, nextWake, burnAmount, minOut };
