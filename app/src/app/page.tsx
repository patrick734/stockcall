import Link from "next/link";
import { BalancePanel } from "@/components/BalancePanel";
import { CallCA } from "@/components/CallCA";
import { MyRounds } from "@/components/MyRounds";
import { RoundCard } from "@/components/RoundCard";

export default function Play() {
  return (
    <div className="page">
      <section className="hero">
        <div>
          <div className="eyebrow">Hourly rounds · Robinhood Chain</div>
          <h1>
            Call the hour.
            <br />
            <span className="accent">Get paid for being right.</span>
          </h1>
          <p className="lead">
            Every hour, StockCall asks a few questions about NVIDIA, Alphabet and ETH. You answer with probabilities and stake ETH. Your answers stay hidden
            until entries close. After the hour, the contract reads what happened from Uniswap prices, checks them against Chainlink, and pays the better
            calibrated from the worse.
          </p>
          <ul className="checks">
            <li>Hidden entries: nobody can see or copy your call before the round locks</li>
            <li>Price-checked: a pool pushed away from Chainlink voids the round and refunds everyone</li>
            <li>No admin keys: every change waits 48 hours in a public timelock</li>
          </ul>
          <div className="hero-cta">
            <Link href="/how" className="btn btn-ghost">How a round works</Link>
            <Link href="/founts" className="btn btn-ghost">Or earn fees in a Fount</Link>
          </div>
          <CallCA />
        </div>
        <RoundCard />
      </section>
      <BalancePanel />
      <MyRounds />
      <section className="how-steps">
        <div>
          <span className="step">1</span>
          <h3>Call it</h3>
          <p>Drag each option to how likely you think it is. Each question always adds up to 100%.</p>
        </div>
        <div>
          <span className="step">2</span>
          <h3>Lock it</h3>
          <p>Stake before entries close, five minutes before the hour. Only a hash of your answers goes on-chain.</p>
        </div>
        <div>
          <span className="step">3</span>
          <h3>Reveal</h3>
          <p>In the five minutes before the hour, your answers are revealed: by the relay automatically, or by you here.</p>
        </div>
        <div>
          <span className="step">4</span>
          <h3>Claim</h3>
          <p>After the hour, score above the room and you win from the others. Winnings land in your Arena balance.</p>
        </div>
      </section>
    </div>
  );
}
