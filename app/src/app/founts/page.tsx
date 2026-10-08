import Link from "next/link";
import { Fragment } from "react";
import { FeeSplit } from "@/components/FeeSplit";
import { CallCA } from "@/components/CallCA";
import { HomeStats } from "@/components/HomeStats";
import { Ripple } from "@/components/Ripple";
import { FountBoard } from "@/components/FountBoard";
import { catalog } from "@/generated/catalog";
import { FountList } from "@/components/FountList";
import { MarketChip } from "@/components/MarketChip";

export const metadata = { title: "Founts · StockCall" };

const FLOW = [
  {
    k: "01 · Fill",
    title: "Deposit USDG",
    body: "You receive Fount shares for your slice of everything the Fount holds. New deposits sit idle until the next rebalance, then start earning.",
  },
  {
    k: "02 · Flow",
    title: "The Fount makes the market",
    body: "A keeper keeps a tight Uniswap v4 range around the Chainlink price of one stock token. Every trade through that range pays the Fount a fee.",
  },
  {
    k: "03 · Return",
    title: "Fees split 70 / 30",
    body: "70% compounds into the Fount, so each share grows. 30% buys $CALL and burns it. Both numbers are hard limits in the contract.",
  },
];

const GUARANTEES = [
  ["48-hour timelock", "Every admin change waits 48 hours in public. The contracts refuse to deploy with any other kind of admin."],
  ["Deployer holds nothing", "The wallet that deployed StockCall has no role, no ownership and nothing pending. Anyone can check with one script."],
  ["Circuit breaker", "A price that jumps too far between two Chainlink updates is ignored until it settles. It cannot be switched off."],
  ["Exit in kind, any time", "Taking your share as stock token plus USDG never needs a price, so it works when markets are closed or paused."],
];

export default function FountsPage() {
  return (
    <div className="page">
      <section className="hero">
        <Ripple />
        <div>
          <div className="eyebrow">Robinhood Chain · Uniswap v4 · Chainlink</div>
          <h1>
            Liquidity for tokenized stocks,
            <br />
            <span className="accent">with nobody holding the keys.</span>
          </h1>
          <p className="lead">
            Each Fount provides liquidity for one stock token and pays 70% of its trading fees back to depositors. The
            rules are fixed in code, and changing them takes a public 48-hour wait.
          </p>
          <div className="hero-cta">
            <a href="#all-founts" className="btn btn-primary">Browse Founts</a>
            <Link href="/safety" className="btn btn-ghost">Check the safety rails</Link>
          </div>
          <div className="hero-note">
            {catalog.launchFounts.length} Founts · ${catalog.heldValueCapUsdg.toLocaleString()} cap each · 70 / 30 split enforced in code
          </div>
          <CallCA />
        </div>
        <FountBoard />
      </section>

      <HomeStats />

      <section className="section" id="all-founts">
        <div className="section-head">
          <div>
            <h2>All Founts</h2>
            <p>
              One per tokenized stock, each with its own cap, range and risk limits. Deposits open while NYSE is open and Chainlink prices are fresh;
              withdrawals are open at any time.
            </p>
          </div>
          <MarketChip />
        </div>
        <FountList />
      </section>

      <section className="section">
        <div className="section-head">
          <div>
            <h2>How a Fount works</h2>
            <p>One Fount per stock, each its own contract with its own cap, so a problem in one never reaches another.</p>
          </div>
        </div>
        <div className="flow">
          {FLOW.map((s, i) => (
            <Fragment key={s.k}>
              {i > 0 && <div className="flow-arrow" aria-hidden>→</div>}
              <div className="card">
                <span className="flow-k">{s.k}</span>
                <h3>{s.title}</h3>
                <p>{s.body}</p>
              </div>
            </Fragment>
          ))}
        </div>
      </section>

      <section className="section">
        <FeeSplit />
      </section>

      <section className="section">
        <div className="section-head">
          <div>
            <h2>Built so it can&apos;t be rugged</h2>
            <p>These are enforced by the contracts themselves, not by promises.</p>
          </div>
          <Link href="/safety" className="btn btn-ghost">See them live</Link>
        </div>
        <div className="guarantees">
          {GUARANTEES.map(([title, body]) => (
            <div className="card" key={title}>
              <h3>{title}</h3>
              <p>{body}</p>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
