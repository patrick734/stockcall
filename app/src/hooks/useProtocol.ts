"use client";

import { useQuery } from "@tanstack/react-query";
import { erc20Abi, parseAbiItem, zeroAddress, type Address } from "viem";
import { usePublicClient, useReadContracts } from "wagmi";
import { drawdownRetireAbi, fountOracleAbi, fountPositionV4Abi } from "@/generated/abis";
import { useDeployment } from "@/lib/deployment";
import { CALL_CA } from "@/lib/links";

/// $CALL's address: the deployment file's, else the one DrawdownRetire holds (the timelock sets it once), else the
/// launched token's published CA while that timelock action is still waiting. `pending` is true only when none is known.
export function useCallToken(): { token: Address | undefined; pending: boolean } {
  const { deployment, chainId } = useDeployment();
  const fixed = deployment?.burnToken ?? undefined;
  const { data } = useReadContracts({
    allowFailure: true,
    query: { enabled: Boolean(deployment && !fixed), refetchInterval: 20_000 },
    contracts: [{ address: deployment?.drawdownRetire, abi: drawdownRetireAbi, chainId, functionName: "burnToken" }],
  });
  const onChain = data?.[0]?.status === "success" ? (data[0].result as Address) : undefined;
  const token = fixed ?? (onChain && onChain !== zeroAddress ? onChain : CALL_CA || undefined);
  return { token, pending: !token };
}

/// Protocol fees not yet spent on $CALL: USDG and Equity Tokens sitting in the FeeRouter and in DrawdownRetire,
/// valued at the oracle price. One multicall.
export function useBurnQueue() {
  const { deployment, chainId } = useDeployment();
  const founts = deployment ? Object.values(deployment.founts) : [];
  const holders = deployment ? [deployment.feeRouter, deployment.drawdownRetire] : [];
  const tokens: Address[] = deployment ? [deployment.usdg, ...founts.map((w) => w.equityToken)] : [];
  const balances = useReadContracts({
    allowFailure: true,
    query: { enabled: Boolean(deployment) },
    contracts: holders.flatMap((h) => tokens.map((t) => ({ address: t, abi: erc20Abi, chainId, functionName: "balanceOf", args: [h] }) as const)),
  });
  const perToken = tokens.map((_, i) =>
    holders.reduce<bigint>((sum, _h, j) => {
      const r = balances.data?.[j * tokens.length + i];
      return sum + (r?.status === "success" ? (r.result as bigint) : 0n);
    }, 0n)
  );
  const valued = useReadContracts({
    allowFailure: true,
    query: { enabled: Boolean(deployment && balances.data) },
    contracts: tokens.slice(1).map((t, i) => ({ address: deployment?.oracle, abi: fountOracleAbi, chainId, functionName: "usdgValue", args: [t, perToken[i + 1]] }) as const),
  });
  if (!balances.data) return { usdg: undefined as bigint | undefined, loading: true };
  // Equity valuations revert while prices are stale; count those tokens as unpriced rather than zero.
  const equityValue = (valued.data ?? []).reduce<bigint>((s, r) => s + (r.status === "success" ? (r.result as bigint) : 0n), 0n);
  return { usdg: perToken[0] + equityValue, loading: false };
}

/// The Fount's live Uniswap v4 range: tick bounds and the pool's current tick. Undefined on local mock positions,
/// which have no pool.
export function usePositionRange(position: Address | undefined) {
  const { chainId } = useDeployment();
  const p = { address: position, abi: fountPositionV4Abi, chainId } as const;
  const { data } = useReadContracts({
    allowFailure: true,
    query: { enabled: Boolean(position) },
    contracts: [
      { ...p, functionName: "tickLower" },
      { ...p, functionName: "tickUpper" },
      { ...p, functionName: "slot0" },
      { ...p, functionName: "liquidity" },
    ],
  });
  const ok = data?.every((r) => r.status === "success");
  if (!ok) return undefined;
  const slot = data![2].result as readonly [bigint, number];
  return { lower: data![0].result as number, upper: data![1].result as number, tick: slot[1], liquidity: data![3].result as bigint };
}

const rebalanced = parseAbiItem("event Rebalanced(int24 tickLower, int24 tickUpper, uint128 liquidity)");
// The public RPC answers log queries up to 500k blocks (~14 hours at 0.1 s blocks).
const LOOKBACK = 450_000n;

/// Timestamp of the Fount's most recent rebalance within the RPC's log window, or null if older than that.
export function useLastRebalance(fount: Address | undefined) {
  const { chainId } = useDeployment();
  const client = usePublicClient({ chainId });
  return useQuery({
    queryKey: ["lastRebalance", chainId, fount],
    enabled: Boolean(client && fount),
    refetchInterval: 120_000,
    queryFn: async (): Promise<number | null> => {
      const head = await client!.getBlockNumber();
      const logs = await client!.getLogs({ address: fount, event: rebalanced, fromBlock: head > LOOKBACK ? head - LOOKBACK : 0n, toBlock: head });
      const last = logs.at(-1);
      if (!last?.blockNumber) return null;
      const block = await client!.getBlock({ blockNumber: last.blockNumber });
      return Number(block.timestamp);
    },
  });
}

/// Uniswap tick → price of token1 in token0, adjusted for decimals.
export function tickToPrice(tick: number, decimals0: number, decimals1: number) {
  return 1.0001 ** tick * 10 ** (decimals0 - decimals1);
}
