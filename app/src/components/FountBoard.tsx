"use client";

import Link from "next/link";
import type { Address } from "viem";
import { useBlockNumber } from "wagmi";
import { catalog } from "@/generated/catalog";
import { useFountStats, useYieldRate } from "@/hooks/useFount";
import { useDeployment } from "@/lib/deployment";
import { fmtUsdg } from "@/lib/format";
import { Pill } from "./ui";

type Ticker = keyof typeof catalog.equityTokens;

/// The home page's live board: one row per Fount with Held Value against its cap, trailing yield and status.
export function FountBoard() {
  const { deployment, chainId } = useDeployment();
  const { data: block } = useBlockNumber({ chainId, query: { enabled: Boolean(deployment), refetchInterval: 15_000 } });
  const rows = deployment
    ? Object.entries(deployment.founts).map(([t, w]) => ({ ticker: t, name: w.name, fount: w.fount as Address | undefined }))
    : catalog.launchFounts.map((t) => ({ ticker: t, name: catalog.equityTokens[t as Ticker].name, fount: undefined }));

  return (
    <div className="board">
      <div className="board-head">
        <span>{deployment ? "Live Founts" : "Launch Founts"}</span>
        <span className="num">{block ? `block ${block.toLocaleString()}` : deployment ? "…" : "not live yet"}</span>
      </div>
      {rows.map((r) => (
        <BoardRow key={r.ticker} {...r} />
      ))}
    </div>
  );
}

function BoardRow({ ticker, name, fount }: { ticker: string; name: string; fount?: Address }) {
  const s = useFountStats(fount);
  const y = useYieldRate(fount, s.heldValue, s.equityToken, s.oracle);
  const fill = s.heldValue !== undefined && s.cap ? Number((s.heldValue * 10_000n) / s.cap) / 100 : 0;
  const status = !fount ? (
    <Pill tone="muted">Launching</Pill>
  ) : s.paused ? (
    <Pill tone="warn">Paused</Pill>
  ) : s.priceFresh === false ? (
    <Pill tone="warn">Closed</Pill>
  ) : (
    <Pill tone="ok">Open</Pill>
  );

  return (
    <Link href={`/founts/${ticker}`} className="board-row">
      <div>
        <div className="t">{ticker}</div>
        <div className="n">{name}</div>
      </div>
      <div>
        <div className="label">Held value</div>
        <div className="v">{fount ? fmtUsdg(s.heldValue, 0) : "—"}</div>
        {fount && (
          <div className="capbar" title={`${fill.toFixed(1)}% of cap`}>
            <div style={{ width: `${Math.min(fill, 100)}%` }} />
          </div>
        )}
      </div>
      <div className="hide-m">
        <div className="label">Yield rate</div>
        <div className="v">{y.data != null ? `${(y.data * 100).toFixed(1)}%` : "—"}</div>
      </div>
      <div className="hide-m">{status}</div>
      <span className="btn btn-primary btn-sm">{fount ? "Sink" : "View"}</span>
    </Link>
  );
}
