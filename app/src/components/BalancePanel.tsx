"use client";

import { useState } from "react";
import { formatEther, parseEther } from "viem";
import { useAccount } from "wagmi";
import { arenaAbi } from "@/generated/abis";
import { useOpenRound } from "@/hooks/useArena";
import { useDeployment } from "@/lib/deployment";
import { TxStatus, useTx } from "./Tx";

const eth = (wei?: bigint) => (wei === undefined ? "…" : Number(formatEther(wei)).toLocaleString(undefined, { maximumFractionDigits: 6 }));

/** The player's Arena balance: deposit once, play many rounds, withdraw any time (withdrawals are never paused). */
export function BalancePanel() {
  const { deployment, chainId } = useDeployment();
  const { isConnected } = useAccount();
  const r = useOpenRound();
  const [amount, setAmount] = useState("0.05");
  const tx = useTx();
  if (!isConnected || !deployment?.arena) return null;

  let wei: bigint | null = null;
  try {
    wei = amount ? parseEther(amount as `${number}`) : null;
  } catch {
    wei = null;
  }

  const call = (label: string, functionName: "deposit" | "withdraw", value?: bigint) =>
    tx.run(label, () =>
      functionName === "deposit"
        ? tx.writeContractAsync({ address: deployment.arena, abi: arenaAbi, chainId, functionName: "deposit", value })
        : tx.writeContractAsync({ address: deployment.arena, abi: arenaAbi, chainId, functionName: "withdraw", args: [value!] })
    );

  return (
    <section className="card balance">
      <div>
        <span className="round-tag">Arena balance</span>
        <div className="balance-figure num">{eth(r.balance)} ETH</div>
        <p className="fine">Entries draw from it first. Winnings and refunds land back in it. Withdraw any time, even while entries are paused.</p>
      </div>
      <div className="balance-actions">
        <label className="stake">
          <input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.trim().replace(",", "."))} aria-label="Amount in ETH" />
          <span>ETH</span>
        </label>
        <button className="btn btn-primary" disabled={!wei || tx.busy || r.paused} onClick={() => wei && call("Deposit", "deposit", wei)}>
          Deposit
        </button>
        <button className="btn" disabled={!wei || tx.busy || r.balance === undefined || wei > r.balance} onClick={() => wei && call("Withdraw", "withdraw", wei)}>
          Withdraw
        </button>
        <button className="btn btn-ghost" disabled={!r.balance || tx.busy} onClick={() => r.balance && call("Withdraw all", "withdraw", r.balance)}>
          Withdraw all
        </button>
      </div>
      <TxStatus message={tx.busy ? undefined : tx.message} error={tx.error} />
    </section>
  );
}
