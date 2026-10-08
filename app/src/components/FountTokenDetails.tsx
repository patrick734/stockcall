"use client";

import { useState } from "react";
import { useAccount, useReadContracts, useWatchAsset } from "wagmi";
import { drawdownRetireAbi, burnTokenAbi } from "@/generated/abis";
import { explorerAddress } from "@/lib/chains";
import { useDeployment } from "@/lib/deployment";
import { useBurnQueue, useCallToken } from "@/hooks/useProtocol";
import { fmtAmount, fmtUsdg, shortAddress } from "@/lib/format";
import { tradeUrl } from "@/lib/links";
import { Pill } from "./ui";

export function FountTokenDetails() {
  const { deployment, chainId } = useDeployment();
  const { isConnected } = useAccount();
  const { watchAsset, isPending } = useWatchAsset();
  const [copied, setCopied] = useState(false);
  const queue = useBurnQueue();
  const { token, pending } = useCallToken();
  const t = { address: token, abi: burnTokenAbi, chainId } as const;
  const { data, isError } = useReadContracts({
    allowFailure: true,
    query: { enabled: Boolean(deployment && token) },
    contracts: [
      { ...t, functionName: "name" },
      { ...t, functionName: "symbol" },
      { ...t, functionName: "decimals" },
      { ...t, functionName: "totalSupply" },
      { address: deployment?.drawdownRetire, abi: drawdownRetireAbi, chainId, functionName: "totalRetired" },
    ],
  });
  const unreachable = isError || (data !== undefined && data.every((x) => x.status !== "success"));
  const r = <T,>(i: number) => (data?.[i]?.status === "success" ? (data[i].result as T) : undefined);
  const name = r<string>(0);
  const symbol = r<string>(1);
  const decimals = r<number>(2);
  const supply = r<bigint>(3);
  const retired = r<bigint>(4);
  const d = decimals ?? 18;
  const original = supply !== undefined && retired !== undefined ? supply + retired : undefined;
  const retiredPct = original && retired !== undefined ? (Number((retired * 1_000_000n) / original) / 10_000).toFixed(2) : undefined;

  async function copy() {
    if (!token) return;
    await navigator.clipboard.writeText(token);
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  }

  return (
    <div className="card card-ember">
      <div className="fount-card-head">
        <div>
          <h2>{symbol ? `$${symbol}` : "$CALL"}</h2>
          <p className="small" style={{ margin: "0.3rem 0 0" }}>
            Fixed supply, minted once. Protocol fees buy it back and burn it, so supply only goes down.
          </p>
        </div>
        {!deployment ? <Pill tone="muted">Not deployed</Pill> : pending ? <Pill tone="ember">Launching soon</Pill> : <Pill tone="ember">Fixed supply</Pill>}
      </div>
      {deployment && pending && (
        <>
          <p className="small" style={{ marginTop: "0.9rem" }}>
            $CALL launches on Pons shortly. Protocol fees earned before then wait in the burn contract, which has no
            withdrawal function, and are spent on $CALL once it is live.
          </p>
          <div className="kv"><span>Waiting to be spent</span><span>{fmtUsdg(queue.usdg)}</span></div>
        </>
      )}
      {deployment && token && (
        <>
          {unreachable && <p className="tx-status error">Couldn&apos;t read the token from the network.</p>}
          <div className="kv" style={{ marginTop: "0.9rem" }}><span>Total supply</span><span>{fmtAmount(supply, d, 0)}</span></div>
          <div className="kv">
            <span>Retired so far</span>
            <span style={{ color: "var(--burn)" }}>{fmtAmount(retired, d, 0)}{retiredPct ? ` (${retiredPct}%)` : ""}</span>
          </div>
          <div className="kv"><span>Waiting to be spent</span><span>{fmtUsdg(queue.usdg)}</span></div>
          <div className="kv"><span>Name</span><span>{name ?? "…"}</span></div>
          <div className="kv">
            <span>Contract</span>
            <span>
              <a href={explorerAddress(token)} target="_blank" rel="noreferrer">
                {shortAddress(token)} ↗
              </a>
            </span>
          </div>
          <div className="hero-cta">
            <a className="btn btn-ember" href={tradeUrl(token)} target="_blank" rel="noreferrer">Trade on Pons ↗</a>
            <button className="btn" onClick={copy}>{copied ? "Copied" : "Copy address"}</button>
            {isConnected && (
              <button
                className="btn"
                disabled={!symbol || isPending}
                onClick={() => watchAsset({ type: "ERC20", options: { address: token, symbol: symbol!, decimals: d } })}
              >
                Add $CALL to wallet
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
}
