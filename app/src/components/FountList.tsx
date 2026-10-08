"use client";

import { catalog } from "@/generated/catalog";
import { useDeployment } from "@/lib/deployment";
import { FountCard } from "./FountCard";

type Ticker = keyof typeof catalog.equityTokens;

export function FountList() {
  const { deployment } = useDeployment();
  const live = deployment ? Object.keys(deployment.founts) : [];
  const launch = catalog.launchFounts.filter((t) => !live.includes(t));
  const upcoming = (Object.keys(catalog.equityTokens) as Ticker[]).filter((t) => !live.includes(t) && !launch.includes(t as never));

  return (
    <>
      {live.length > 0 && (
        <div className="fount-grid">
          {live.map((t) => (
            <FountCard key={t} ticker={t} name={deployment!.founts[t].name} fount={deployment!.founts[t].fount} />
          ))}
        </div>
      )}
      {launch.length > 0 && (
        <div className="fount-grid">
          {launch.map((t) => (
            <FountCard key={t} ticker={t} name={catalog.equityTokens[t as Ticker].name} />
          ))}
        </div>
      )}
      <section className="section">
        <div className="section-head">
          <div>
            <h3 className="muted">Coming next</h3>
            <p>Opened once the stock&apos;s pool has enough depth and tracks its Chainlink feed.</p>
          </div>
        </div>
        <div className="fount-grid">
          {upcoming.map((t) => (
            <FountCard key={t} ticker={t} name={catalog.equityTokens[t].name} soon />
          ))}
        </div>
      </section>
    </>
  );
}
