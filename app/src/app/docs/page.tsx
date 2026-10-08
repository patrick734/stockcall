import type { ReactNode } from "react";

const TOC = [
  ["overview", "Overview"],
  ["founts", "Founts"],
  ["fees", "Fees, drawdown and retire"],
  ["oracle", "Prices and market hours"],
  ["governance", "Governance and safety"],
  ["glossary", "Glossary"],
] as const;

function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="doc-section">
      <h2>{title}</h2>
      {children}
    </section>
  );
}

export default function DocsPage() {
  return (
    <div className="page docs">
      <aside className="toc">
        {TOC.map(([id, label]) => (
          <a key={id} href={`#${id}`}>{label}</a>
        ))}
      </aside>
      <article>
        <h1>StockCall docs</h1>

        <Section id="overview" title="Overview">
          <p>
            StockCall runs managed liquidity for Equity Tokens on Robinhood Chain. Each <strong>Fount</strong> holds one
            Equity Token / USDG position on Uniswap v4. You sink USDG, the Fount earns swap fees from traders, and 70% of
            those fees compound back into the Fount. The other 30% is spent buying $CALL and burning it.
          </p>
          <p>
            Every contract is open source and verified. There are no off-chain valuations: Held Value, share prices and
            exit amounts are all computed on-chain from Chainlink prices.
          </p>
        </Section>

        <Section id="founts" title="Founts">
          <ul>
            <li><strong>Sinking into a Fount.</strong> Deposit USDG and receive Fount shares (ERC-4626). Your shares are your portion of the Fount&apos;s Held Value.</li>
            <li><strong>Ranges.</strong> A keeper places the Fount&apos;s balances in a concentrated range around the Chainlink price and re-ranges when price moves. Rebalances revert if the price is stale or the pool has drifted more than 2% from the oracle.</li>
            <li><strong>USDG exits.</strong> <code>withdraw</code>/<code>redeem</code> pull your slice of the range and sell Equity Token for USDG. The swap must clear within 1% of the oracle price, and you pay that cost, not the holders who stay.</li>
            <li><strong>In-kind exits.</strong> <code>redeemInKind</code> returns your share of Equity Token and USDG with no swap and no price check. It works while paused, over weekends, and during oracle outages.</li>
            <li><strong>Caps.</strong> Each Fount has a Held Value cap. Launch Founts open at $25,000 each and rise only through the timelock.</li>
          </ul>
        </Section>

        <Section id="fees" title="Fees, drawdown and retire">
          <p>
            Swap fees are collected on every sink, exit and rebalance, and whenever anyone calls <code>harvest</code>.
          </p>
          <ul>
            <li><strong>70%</strong> stays in the Fount and raises the value of every share.</li>
            <li><strong>30%</strong> goes to the <code>FeeRouter</code>, which forwards all of it to <code>DrawdownRetire</code>. That contract swaps the fees into $CALL through registered pools, subject to per-run limits and a minimum interval, then burns the $CALL in the same transaction. It has no withdrawal function.</li>
            <li>Pointing the FeeRouter anywhere else requires a public 48-hour delay.</li>
          </ul>
        </Section>

        <Section id="oracle" title="Prices and market hours">
          <p>
            Equity Token prices come from Chainlink feeds that follow US market hours: 24 hours a day, five days a week,
            with a 24-hour heartbeat. A price counts as fresh for up to 26 hours. StockCall also checks the USDG/USD feed
            and the Equity Token&apos;s corporate-action flag.
          </p>
          <p>
            When a price is not usable, deposits, USDG exits and rebalances pause automatically. In-kind exits stay open.
          </p>
          <p>A price is not usable when any of these hold:</p>
          <ul>
            <li><strong>Stale.</strong> The feed has not updated within its maximum age.</li>
            <li><strong>Out of bounds.</strong> The answer is outside the feed&apos;s sanity band, set at deployment to a tenth and ten times the launch price. USDG must stay between $0.95 and $1.05.</li>
            <li><strong>Circuit breaker.</strong> The answer moved more than 15% from the feed&apos;s previous round and is less than 30 minutes old. Once it has stood for 30 minutes it is used. The limits can be tuned through the timelock, within 1–50% and 5 minutes to 1 day, but the breaker can never be turned off.</li>
            <li><strong>Corporate action or sequencer outage.</strong> The Equity Token reports a split or dividend in progress, or the L2 sequencer is down.</li>
          </ul>
          <p>The <a href="/safety">Safety page</a> shows each Fount&apos;s price status live.</p>
        </Section>

        <Section id="governance" title="Governance and safety">
          <ul>
            <li><strong>Admin</strong> is a 48-hour OpenZeppelin timelock controlled by a multisig. Only the admin can unpause, raise caps, or change fees, risk limits, feeds and pools. Every contract checks at deployment that its admin is such a timelock and refuses to deploy otherwise.</li>
            <li><strong>Deployer</strong> holds nothing. It cannot propose, execute or cancel on the timelock, holds no role, and owns no contract. Every setting is passed in at construction, so there is never a moment where the deployer controls a contract. <code>scripts/verify.js</code> proves this on-chain for any deployment.</li>
            <li><strong>Guardian</strong> is a separate multisig. It can pause, lower caps and halt drawdowns. It cannot unpause, raise limits or move funds.</li>
            <li><strong>Keeper</strong> rebalances and runs drawdowns within on-chain limits.</li>
            <li>No contract has a function that lets any role take user funds. A malicious change would still need 48 hours in public, which is enough time to exit in kind.</li>
          </ul>
        </Section>

        <Section id="glossary" title="Glossary">
          <dl className="glossary">
            <dt>Fount</dt><dd>A managed Equity Token / USDG liquidity vault, for example the AMD Fount.</dd>
            <dt>Equity Token</dt><dd>A tokenized debt security on Robinhood Chain that tracks a stock or ETF.</dd>
            <dt>Sinking into a Fount</dt><dd>Depositing USDG into a Fount.</dd>
            <dt>Held Value</dt><dd>The total USDG value of a Fount&apos;s assets at the oracle price.</dd>
            <dt>Yield Rate</dt><dd>Recent fee income to Fount holders, annualized. Historical, not a forecast.</dd>
            <dt>Circuit breaker</dt><dd>The oracle rule that holds a price which jumped too far between two Chainlink rounds.</dd>
            <dt>Drawdown and retire</dt><dd>Spending the protocol fee share on $CALL and burning it.</dd>
            <dt>$CALL</dt><dd>StockCall&apos;s fixed-supply token, launched on the Pons launchpad. Its supply only falls.</dd>
          </dl>
        </Section>
      </article>
    </div>
  );
}
