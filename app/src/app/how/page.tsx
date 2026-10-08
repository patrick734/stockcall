import { catalog } from "@/generated/catalog";

export const metadata = { title: "How a round works · StockCall" };

const a = catalog.arena;

export default function How() {
  return (
    <div className="page prose">
      <div className="eyebrow">Rules</div>
      <h1>How a round works</h1>
      <p className="lead">
        One round every hour. You give probabilities, the chain reads what happened from Uniswap prices and checks them against Chainlink, and stakes move
        from the less calibrated to the better calibrated. Nobody runs the oracle and there is no house edge on losses.
      </p>

      <h2>Timing (round for the hour H to H+1)</h2>
      <ul>
        <li>
          <b>Commit</b> from H − 65 min to H − 5 min. You stake and send only a hash of your answers and a secret salt. Nobody, not even the keeper, can read
          them.
        </li>
        <li>
          <b>Reveal</b> from H − 5 min to H. Your answers are revealed: by the relay, which holds a sealed copy only the keeper can open, or by you on this
          site. <b>An entry not revealed by H loses its stake</b> to the burn. That rule makes revealing only the calls that look good always cost more than it
          gains.
        </li>
        <li>
          <b>Start price:</b> the 5-minute average from H − 5 min to H. <b>End price:</b> the 5-minute average over the hour&apos;s last 5 minutes.
        </li>
        <li>
          <b>Settle</b> once the hour ends. The keeper does it within minutes, anyone can, and your claim settles it first if needed. A price-checked round must
          settle within 30 minutes, or it is refunded.
        </li>
        <li>
          <b>Claim</b> any time after, into your Arena balance or straight to your wallet. There is no deadline.
        </li>
      </ul>

      <h2>The questions</h2>
      <p>
        <b>Weekdays</b> (Monday 02:00 to Friday 23:00 UTC):
      </p>
      <ul>
        {a.cards.weekday.questions.map((q) => (
          <li key={q.key}>{q.text}</li>
        ))}
      </ul>
      <p>
        <b>Weekends and nights outside the session:</b> ETH only, the deepest pool.
      </p>
      <ul>
        {a.cards.weekend.questions.map((q) => (
          <li key={q.key}>{q.text}</li>
        ))}
      </ul>

      <h2>The price check</h2>
      <p>
        For the stocks, the Arena compares the pool&apos;s start and end prices with Chainlink, read through the same hardened oracle the Founts use. If either
        is more than about {(a.guardTicks / 100).toFixed(0)}% apart, the round is void and every revealed entry is refunded in full, with no fee. Pushing a pool
        to win a round now gets you a refund, not a payout.
      </p>

      <h2>Soft answers near the line</h2>
      <p>
        Close calls are answered in shares: NVIDIA up 0.06% counts as 75% Yes, 25% No. To flip a clear answer, someone would have to hold the price a whole
        margin away for the full 5-minute window.
      </p>

      <h2>Scoring and payouts</h2>
      <p>Each question is scored with a proper scoring rule (Brier, or the ranked probability score for move-size buckets). Then:</p>
      <p className="formula">payout = stake × (1 + your score − the room&apos;s stake-weighted average score)</p>
      <ul>
        <li>Better than the room: you gain in proportion to your stake. Worse: you lose in proportion.</li>
        <li>If everyone answers the same, everyone gets their stake back. A lone entry is refunded exactly.</li>
        <li>Honesty pays: your expected payout is highest when you report what you really believe.</li>
        <li>Fee: {a.feeBps / 100}% of profit only, nothing on a loss. It buys $CALL and burns it.</li>
        <li>
          Limits: {a.minStake} to {a.maxStake} ETH per entry, {a.roundCap} ETH per round, one entry per wallet per round.
        </li>
      </ul>

      <h2>Your Arena balance</h2>
      <p>
        Deposit once and play many rounds. Entries draw from the balance first, and winnings and refunds land back in it. Withdraw any time: withdrawals,
        reveals, settling and claims can never be paused.
      </p>

      <h2>Risks</h2>
      <ul>
        <li>You can lose stake. A confident miss in a room of calibrated players can lose most of it.</li>
        <li>If your entry is not revealed in time (no relay copy, and you were away), you lose the whole stake.</li>
        <li>Small price pushes below the check, and ETH (no Chainlink feed here), are still possible. Small caps keep them unprofitable in most rounds.</li>
        <li>The contracts have not had an external audit. Stake only what you can afford to lose.</li>
        <li>Forecast rounds with stakes may not be allowed where you live. Check before playing. Nothing here is financial advice.</li>
      </ul>
    </div>
  );
}
