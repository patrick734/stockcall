"use client";

import { formatEther, formatUnits } from "viem";
import { useReadContracts } from "wagmi";
import { CallCA } from "@/components/CallCA";
import { drawdownRetireAbi } from "@/generated/abis";
import { useArenaProtocol } from "@/hooks/useArena";
import { useDeployment } from "@/lib/deployment";

const n = (v: bigint | undefined, d = 4, dec = 18) => (v === undefined ? "…" : Number(dec === 18 ? formatEther(v) : formatUnits(v, dec)).toLocaleString(undefined, { maximumFractionDigits: d }));

export default function Burn() {
  const p = useArenaProtocol();
  const { deployment: d, chainId } = useDeployment();
  const { data } = useReadContracts({
    allowFailure: true,
    query: { enabled: Boolean(d) },
    contracts: d ? [{ address: d.drawdownRetire, abi: drawdownRetireAbi, functionName: "totalRetired", chainId }] : [],
  });
  const retired = data?.[0]?.status === "success" ? (data[0].result as bigint) : undefined;
  return (
    <div className="page">
      <div className="eyebrow">$CALL</div>
      <h1>Every fee burns $CALL</h1>
      <p className="lead">
        Two contracts with no withdraw function buy $CALL on its Pons pool and burn every token they buy. <b>BuyBurn</b> takes the Arena&apos;s{" "}
        {p.feeBps !== undefined ? p.feeBps / 100 : 5}% fee on winners&apos; profit and every forfeited stake. <b>DrawdownRetire</b> takes 30% of the Founts&apos;
        trading fees. Runs are capped and rate-limited.
      </p>
      <CallCA />
      <div className="stats">
        <div className="card bstat">
          <span>$CALL burned by the Arena</span>
          <b className="num">{n(p.totalBurned, 0)}</b>
        </div>
        <div className="card bstat">
          <span>$CALL burned by the Founts</span>
          <b className="num">{n(retired, 0)}</b>
        </div>
        <div className="card bstat">
          <span>ETH spent on Arena burns</span>
          <b className="num">{n(p.ethSpent)}</b>
        </div>
        <div className="card bstat">
          <span>Fees waiting in the Arena</span>
          <b className="num">{n(p.feesAccrued)}</b>
        </div>
      </div>
      {d && !p.token && (
        <div className="card notice">
          <h3>Burns start once the timelock connects $CALL</h3>
          <p>Connecting $CALL to both burners goes through the 48-hour public timelock, once and permanently. Until then, fees wait in the contracts.</p>
        </div>
      )}
      {!d && <div className="card notice"><p>StockCall is not live on this network yet.</p></div>}
    </div>
  );
}
