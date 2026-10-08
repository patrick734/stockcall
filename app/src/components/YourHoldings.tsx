"use client";

import Link from "next/link";
import { useAccount, useReadContracts } from "wagmi";
import { fountAbi, burnTokenAbi } from "@/generated/abis";
import { useCallToken } from "@/hooks/useProtocol";
import { useDeployment } from "@/lib/deployment";
import { fmtAmount, fmtUsdg, CALL_SHARE_DECIMALS } from "@/lib/format";
import { ConnectButton } from "./ConnectButton";
import { Stat } from "./ui";

type Result = { status: string; result?: unknown };
const get = <T,>(src: readonly Result[] | undefined, i: number) =>
  src?.[i]?.status === "success" ? (src[i].result as T) : undefined;

export function YourHoldings() {
  const { deployment, chainId } = useDeployment();
  const { address } = useAccount();
  const founts = deployment ? Object.entries(deployment.founts) : [];
  const enabled = Boolean(deployment && address);
  const me = address!;

  const { token: fountAddress, pending: fountPending } = useCallToken();
  const t = { address: fountAddress, abi: burnTokenAbi, chainId } as const;
  const token = useReadContracts({
    allowFailure: true,
    query: { enabled: enabled && Boolean(fountAddress) },
    contracts: [
      { ...t, functionName: "balanceOf", args: [me] },
      { ...t, functionName: "totalSupply" },
      { ...t, functionName: "decimals" },
    ],
  });
  const fountBalance = get<bigint>(token.data, 0);
  const fountSupply = get<bigint>(token.data, 1);
  const fountDecimals = get<number>(token.data, 2) ?? 18;

  const shares = useReadContracts({
    allowFailure: true,
    query: { enabled },
    contracts: founts.map(([, w]) => ({ address: w.fount, abi: fountAbi, chainId, functionName: "balanceOf", args: [me] }) as const),
  });
  const fountShares = founts.map((_, i) => get<bigint>(shares.data, i));
  const fountValuesQ = useReadContracts({
    allowFailure: true,
    query: { enabled: enabled && Boolean(shares.data) },
    contracts: founts.map(([, w], i) => ({ address: w.fount, abi: fountAbi, chainId, functionName: "convertToAssets", args: [fountShares[i] ?? 0n] }) as const),
  });
  const fountValues = founts.map((_, i) => get<bigint>(fountValuesQ.data, i));

  const sum = (xs: (bigint | undefined)[]) => xs.reduce<bigint>((s, x) => s + (x ?? 0n), 0n);
  // Distinguish "you hold nothing" from "couldn't read the chain", so an unreachable RPC never shows as empty.
  const queries = [token, shares];
  const unreachable = queries.some((q) => q.isError || (q.data !== undefined && q.data.length > 0 && q.data.every((x) => x.status !== "success")));
  const loadingLists = !shares.data;
  const loaded = fountValuesQ.data;
  // Fount valuations revert while the oracle price is unpriced (market closed, circuit breaker); don't count those as zero.
  const failed = (q: readonly Result[] | undefined) => q?.some((x) => x.status !== "success") ?? false;
  const priced = !failed(fountValuesQ.data);
  const netValue = loaded && priced ? sum(fountValues) : undefined;
  const supplyPct =
    fountBalance !== undefined && fountSupply ? `${(Number((fountBalance * 1_000_000n) / fountSupply) / 10_000).toFixed(4)}% of supply` : undefined;

  if (!deployment) return null;
  if (!address) {
    return (
      <div className="card notice">
        <h3>Your holdings</h3>
        <p className="muted">Connect a wallet to see your $CALL balance and Fount shares.</p>
        <ConnectButton />
      </div>
    );
  }

  const heldFounts = founts.map(([ticker], i) => ({ ticker, shares: fountShares[i], value: fountValues[i] })).filter((w) => w.shares);

  return (
    <div className="stack">
      {unreachable && (
        <p className="tx-status error" style={{ margin: 0 }}>Couldn&apos;t read your positions from the network. Check your connection or RPC and try again.</p>
      )}
      <div className="strip three">
        <Stat label="Fount value" value={fmtUsdg(netValue)} hint={loaded && !priced ? "unavailable while a price is held" : "all your Fount shares"} />
        <Stat label="Founts held" value={loadingLists ? "…" : String(founts.filter((_, i) => fountShares[i]).length)} hint={`of ${founts.length}`} />
        <Stat label="$CALL balance" value={fountPending ? "—" : fmtAmount(fountBalance, fountDecimals, 2)} hint={fountPending ? "launching soon on Pons" : supplyPct} />
      </div>

      <div className="card">
        <h3>Founts</h3>
        {loadingLists || unreachable ? (
          <p className="small">{unreachable ? "Unavailable" : "Loading…"}</p>
        ) : heldFounts.length === 0 ? (
          <p className="small">No Fount shares yet. <Link href="/founts">Browse Founts</Link></p>
        ) : null}
        {heldFounts.map((w) => {
          // Shares start at 1 USDG each, so value per share above 1.00 is the Fount's growth since launch.
          const perShare = w.value !== undefined && w.shares ? Number((w.value * 10n ** 12n * 10_000n) / w.shares) / 10_000 / 1e6 : undefined;
          const growth = perShare !== undefined ? (perShare - 1) * 100 : undefined;
          return (
            <Link key={w.ticker} href={`/founts/${w.ticker}`} className="holding">
              <span className="holding-ic">{w.ticker}</span>
              <span>
                <b>{fmtAmount(w.shares, CALL_SHARE_DECIMALS, 2)} f{w.ticker}</b>
                <span className="small muted" style={{ display: "block" }}>{w.ticker} Fount</span>
              </span>
              <span className="holding-v">
                {fmtUsdg(w.value)}
                {growth !== undefined && (
                  <span className={growth >= 0 ? "holding-d good" : "holding-d danger"} style={{ display: "block" }}>
                    {growth >= 0 ? "+" : ""}{growth.toFixed(2)}% per share
                  </span>
                )}
              </span>
            </Link>
          );
        })}
      </div>
    </div>
  );
}
