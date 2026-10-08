"use client";

import { useEffect, useState } from "react";
import { zeroAddress, type Hex } from "viem";
import { useAccount, usePublicClient, useReadContracts } from "wagmi";
import { arenaAbi, buyBurnAbi } from "@/generated/abis";
import { openRound } from "@/lib/arena";
import { useDeployment } from "@/lib/deployment";

/**
 * Chain time in seconds, ticking every second: the device clock corrected by the latest block's timestamp.
 * 0 until the page has mounted, so the server render and the first browser render agree.
 */
export function useNow() {
  const { chainId } = useDeployment();
  const client = usePublicClient({ chainId });
  const [offset, setOffset] = useState(0);
  const [now, setNow] = useState(0);
  useEffect(() => {
    if (!client) return;
    let stop = false;
    const sync = async () => {
      try {
        const b = await client.getBlock({ blockTag: "latest" });
        const o = Number(b.timestamp) - Date.now() / 1000;
        // Ignore small drift (blocks lag the clock by a second or two); correct a wrong device clock or a local chain.
        if (!stop) setOffset(Math.abs(o) > 20 ? Math.round(o) : 0);
      } catch {}
    };
    sync();
    const id = setInterval(sync, 30_000);
    return () => {
      stop = true;
      clearInterval(id);
    };
  }, [client]);
  useEffect(() => {
    const tick = () => setNow(Math.floor(Date.now() / 1000) + offset);
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [offset]);
  return now;
}

export type RoundInfo = { schemaId: bigint; feeBps: number; guardTicks: number; state: number; snapped: boolean; entries: number; revealed: number; pot: bigint; revealedPot: bigint };
export type EntryInfo = { stake: bigint; revealed: boolean; claimed: boolean; commitment: Hex; probs: bigint };

export function toRound(r: unknown): RoundInfo | undefined {
  const x = r as readonly [bigint, number, number, number, boolean, number, number, bigint, bigint] | undefined;
  if (!x) return undefined;
  return { schemaId: x[0], feeBps: Number(x[1]), guardTicks: Number(x[2]), state: Number(x[3]), snapped: x[4], entries: Number(x[5]), revealed: Number(x[6]), pot: x[7], revealedPot: x[8] };
}

/** The round taking commits now, its card, pot and limits, the wallet's entry and Arena balance. */
export function useOpenRound() {
  const { deployment: d, chainId } = useDeployment();
  const { address } = useAccount();
  const now = useNow();
  const n = openRound(now);
  const a = d?.arena;
  const { data, refetch } = useReadContracts({
    query: { enabled: Boolean(a) && now > 0, refetchInterval: 10_000 },
    contracts: a
      ? [
          { address: a, abi: arenaAbi, functionName: "schemaFor", args: [BigInt(n)], chainId },
          { address: a, abi: arenaAbi, functionName: "rounds", args: [BigInt(n)], chainId },
          { address: a, abi: arenaAbi, functionName: "minStake", chainId },
          { address: a, abi: arenaAbi, functionName: "maxStake", chainId },
          { address: a, abi: arenaAbi, functionName: "roundCap", chainId },
          { address: a, abi: arenaAbi, functionName: "feeBps", chainId },
          { address: a, abi: arenaAbi, functionName: "paused", chainId },
          { address: a, abi: arenaAbi, functionName: "entryOf", args: [BigInt(n), address ?? zeroAddress], chainId },
          { address: a, abi: arenaAbi, functionName: "balanceOf", args: [address ?? zeroAddress], chainId },
        ]
      : [],
  });
  const at = (i: number) => data?.[i]?.result;
  const round = toRound(at(1));
  const entry = at(7) as EntryInfo | undefined;
  return {
    n,
    now,
    ready: now > 0,
    schemaId: at(0) as bigint | undefined,
    round,
    minStake: at(2) as bigint | undefined,
    maxStake: at(3) as bigint | undefined,
    roundCap: at(4) as bigint | undefined,
    feeBps: at(5) as number | undefined,
    paused: at(6) as boolean | undefined,
    entry: entry && entry.stake > 0n ? entry : undefined,
    balance: at(8) as bigint | undefined,
    refetch,
  };
}

export type MyRound = EntryInfo & { n: number; round?: RoundInfo; received: bigint; fee: bigint };

/** The wallet's entries in the last `lookback` rounds (and the open one), with state and what a claim would pay. */
export function useMyRounds(current: number, lookback = 72) {
  const { deployment: d, chainId } = useDeployment();
  const { address } = useAccount();
  const a = d?.arena;
  const ns = Array.from({ length: lookback }, (_, i) => current - i).filter((x) => x > 0);
  const { data: entries, refetch } = useReadContracts({
    query: { enabled: Boolean(a && address), refetchInterval: 15_000 },
    contracts: a && address ? ns.map((n) => ({ address: a, abi: arenaAbi, functionName: "entryOf", args: [BigInt(n), address], chainId }) as const) : [],
  });
  const mine = ns.filter((_, i) => {
    const e = entries?.[i]?.result as EntryInfo | undefined;
    return e && e.stake > 0n;
  });
  const { data: details, refetch: refetch2 } = useReadContracts({
    query: { enabled: Boolean(a && address && mine.length), refetchInterval: 15_000 },
    contracts:
      a && address
        ? mine.flatMap((n) => [
            { address: a, abi: arenaAbi, functionName: "rounds", args: [BigInt(n)], chainId } as const,
            { address: a, abi: arenaAbi, functionName: "previewPayout", args: [BigInt(n), address], chainId } as const,
          ])
        : [],
  });
  const list: MyRound[] = mine.map((n, k) => {
    const e = entries![ns.indexOf(n)].result as EntryInfo;
    const pv = details?.[2 * k + 1]?.result as readonly [bigint, bigint] | undefined;
    return { ...e, n, round: toRound(details?.[2 * k]?.result), received: pv?.[0] ?? 0n, fee: pv?.[1] ?? 0n };
  });
  return {
    list,
    refetch: async () => {
      await refetch();
      await refetch2();
    },
  };
}

/** Arena and burn figures for the Burn and Safety pages. */
export function useArenaProtocol() {
  const { deployment: d, chainId } = useDeployment();
  const ADMIN = ("0x" + "00".repeat(32)) as Hex;
  const { data } = useReadContracts({
    allowFailure: true,
    query: { enabled: Boolean(d?.arena), refetchInterval: 30_000 },
    contracts: d?.arena
      ? [
          { address: d.buyBurn, abi: buyBurnAbi, functionName: "totalBurned", chainId },
          { address: d.buyBurn, abi: buyBurnAbi, functionName: "token", chainId },
          { address: d.buyBurn, abi: buyBurnAbi, functionName: "totalEthSpent", chainId },
          { address: d.buyBurn, abi: buyBurnAbi, functionName: "lastBurn", chainId },
          { address: d.arena, abi: arenaAbi, functionName: "feesAccrued", chainId },
          { address: d.arena, abi: arenaAbi, functionName: "feeBps", chainId },
          { address: d.arena, abi: arenaAbi, functionName: "hasRole", args: [ADMIN, d.timelock], chainId },
          { address: d.arena, abi: arenaAbi, functionName: "hasRole", args: [ADMIN, d.deployer], chainId },
          { address: d.arena, abi: arenaAbi, functionName: "feeSink", chainId },
          { address: d.arena, abi: arenaAbi, functionName: "paused", chainId },
          { address: d.buyBurn, abi: buyBurnAbi, functionName: "hasRole", args: [ADMIN, d.deployer], chainId },
          { address: d.arena, abi: arenaAbi, functionName: "guardTicks", chainId },
          { address: d.arena, abi: arenaAbi, functionName: "oracle", chainId },
          { address: d.arena, abi: arenaAbi, functionName: "totalBalances", chainId },
          { address: d.buyBurn, abi: buyBurnAbi, functionName: "hasRole", args: [ADMIN, d.timelock], chainId },
        ]
      : [],
  });
  const r = (i: number) => (data?.[i]?.status === "success" ? data[i].result : undefined);
  const token = r(1) as string | undefined;
  return {
    d,
    totalBurned: r(0) as bigint | undefined,
    token: token && token !== zeroAddress ? (token as `0x${string}`) : null,
    ethSpent: r(2) as bigint | undefined,
    lastBurn: r(3) as bigint | undefined,
    feesAccrued: r(4) as bigint | undefined,
    feeBps: r(5) as number | undefined,
    timelockIsAdmin: r(6) as boolean | undefined,
    deployerIsAdmin: r(7) as boolean | undefined,
    feeSink: r(8) as string | undefined,
    paused: r(9) as boolean | undefined,
    deployerBurnAdmin: r(10) as boolean | undefined,
    guardTicks: r(11) as number | undefined,
    oracle: r(12) as string | undefined,
    totalBalances: r(13) as bigint | undefined,
    timelockBurnAdmin: r(14) as boolean | undefined,
  };
}
