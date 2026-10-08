"use client";

import { useState } from "react";
import { formatEther, type Hex } from "viem";
import { useAccount, useSignMessage } from "wagmi";
import { arenaAbi } from "@/generated/abis";
import { useMyRounds, useOpenRound, type MyRound } from "@/hooks/useArena";
import { GUARD_WINDOW, hourLabel, timing } from "@/lib/arena";
import { useDeployment } from "@/lib/deployment";
import { sendToRelay } from "@/lib/relay";
import { loadReveal, saveReveal } from "@/lib/reveals";
import { TxStatus, useTx } from "./Tx";

const fmt = (wei: bigint) => Number(formatEther(wei)).toLocaleString(undefined, { maximumFractionDigits: 6 });
const hhmm = (t: number) => new Date(t * 1000).toISOString().slice(11, 16);

type Row = MyRound & { status: string; tone: "" | "good" | "bad"; canReveal: boolean; canRelay: boolean; canSettle: boolean; claimable: boolean };

export function MyRounds() {
  const { deployment, chainId } = useDeployment();
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const r = useOpenRound();
  const { list, refetch } = useMyRounds(r.n);
  const tx = useTx();
  const [, bump] = useState(0);
  if (!isConnected || !deployment?.arena || !address || !r.ready) return null;
  const arena = deployment.arena;

  const rows: Row[] = list.map((e) => {
    const t = timing(e.n);
    const local = loadReveal(chainId, arena, e.n, address);
    const state = e.round?.state ?? 0;
    const beforeLock = r.now < t.locks;
    const inWindow = r.now >= t.locks && r.now < t.start;
    const ended = r.now >= t.end;
    let status = "";
    let tone: Row["tone"] = "";
    if (e.claimed) status = "Claimed";
    else if (!e.revealed && r.now >= t.start) (status = "Not revealed in time: stake forfeited"), (tone = "bad");
    else if (state === 2) status = "Void: full refund";
    else if (state === 1) status = "Settled";
    else if (ended) status = r.now > t.end + GUARD_WINDOW ? "Ended: settle (late rounds are refunded)" : "Ended: ready to settle";
    else if (e.revealed) status = "Revealed, in play";
    else if (inWindow) status = local ? "Reveal now" : "Waiting for the relay to reveal";
    else if (beforeLock) status = `Hidden · reveals ${hhmm(t.locks)}–${hhmm(t.start)} UTC${local?.relayed ? " · auto-reveal on" : ""}`;
    return {
      ...e,
      status,
      tone,
      canReveal: Boolean(inWindow && !e.revealed && local),
      canRelay: Boolean(r.now < t.start && !e.revealed && local && !local.relayed && deployment.keeperRevealKey),
      canSettle: ended && state === 0 && e.revealed,
      claimable: ended && e.revealed && !e.claimed,
    };
  });
  const toClaim = rows.filter((x) => x.claimable).map((x) => BigInt(x.n));
  const owed = rows.filter((x) => x.claimable && (x.round?.state ?? 0) !== 0).reduce((a, x) => a + x.received, 0n);
  const missing = rows.some((x) => !x.revealed && r.now < timing(x.n).start && !loadReveal(chainId, arena, x.n, address));

  async function claim(toWallet: boolean) {
    const ok = await tx.run(toWallet ? "Claim and withdraw" : "Claim to balance", async () =>
      tx.writeContractAsync({ address: arena, abi: arenaAbi, chainId, functionName: "claim", args: [toClaim, toWallet], gas: 3_000_000n })
    );
    if (ok) refetch();
  }

  async function reveal(x: Row) {
    const local = loadReveal(chainId, arena, x.n, address!)!;
    const ok = await tx.run("Reveal", async () =>
      tx.writeContractAsync({ address: arena, abi: arenaAbi, chainId, functionName: "reveal", args: [BigInt(x.n), address!, BigInt(local.probs), local.salt] })
    );
    if (ok) refetch();
  }

  async function settle(x: Row) {
    const ok = await tx.run("Settle", async () =>
      tx.writeContractAsync({ address: arena, abi: arenaAbi, chainId, functionName: "settle", args: [BigInt(x.n)], gas: 3_000_000n })
    );
    if (ok) refetch();
  }

  async function relay(x: Row) {
    const local = loadReveal(chainId, arena, x.n, address!)!;
    try {
      tx.note("Sign once (free) to turn on auto-reveal…");
      await sendToRelay({ keeperRevealKey: deployment!.keeperRevealKey as Hex, n: x.n, player: address!, probs: BigInt(local.probs), salt: local.salt, sign: (message) => signMessageAsync({ message }) });
      saveReveal(chainId, arena, x.n, address!, { ...local, relayed: true });
      tx.note("Auto-reveal is on for this round.");
      bump((v) => v + 1);
    } catch (e) {
      tx.note(undefined, `Could not turn on auto-reveal: ${(e as Error).message}`);
    }
  }

  return (
    <section className="card mine">
      <div className="mine-head">
        <h2>Your rounds</h2>
        <div className="mine-actions">
          <button className="btn btn-primary" disabled={!toClaim.length || tx.busy} onClick={() => claim(false)}>
            {toClaim.length ? `Claim ${toClaim.length} round${toClaim.length > 1 ? "s" : ""}${owed ? ` · ${fmt(owed)} ETH` : ""}` : "Nothing to claim"}
          </button>
          {toClaim.length > 0 && (
            <button className="btn" disabled={tx.busy} onClick={() => claim(true)}>
              Claim and withdraw
            </button>
          )}
        </div>
      </div>
      <TxStatus message={tx.busy ? undefined : tx.message} error={tx.error} />
      {missing && (
        <p className="tx-status error">
          This browser has no reveal for one of your hidden entries (entered on another device or browser?). Reveal it from the browser you entered with, or rely
          on auto-reveal if you turned it on there.
        </p>
      )}
      {!rows.length ? (
        <p className="muted">No entries in the last three days.</p>
      ) : (
        <table className="rounds-table">
          <thead>
            <tr>
              <th>Round</th>
              <th>Hour</th>
              <th>Stake</th>
              <th>Result</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((x) => {
              const done = (x.round?.state ?? 0) !== 0;
              const diff = done && x.revealed && !x.claimed ? x.received - x.stake : null;
              return (
                <tr key={x.n}>
                  <td className="num">{x.n.toLocaleString()}</td>
                  <td>{hourLabel(x.n)}</td>
                  <td className="num">{fmt(x.stake)}</td>
                  <td className={`num ${diff === null ? "" : diff >= 0n ? "good" : "bad"}`}>
                    {diff === null ? "—" : `${diff >= 0n ? "+" : "−"}${fmt(diff >= 0n ? diff : -diff)}`}
                  </td>
                  <td className={x.tone}>
                    {x.status}
                    {x.canReveal && (
                      <button className="btn btn-sm btn-primary row-btn" disabled={tx.busy} onClick={() => reveal(x)}>
                        Reveal
                      </button>
                    )}
                    {x.canRelay && (
                      <button className="btn btn-sm row-btn" disabled={tx.busy} onClick={() => relay(x)}>
                        Turn on auto-reveal
                      </button>
                    )}
                    {x.canSettle && (
                      <button className="btn btn-sm row-btn" disabled={tx.busy} onClick={() => settle(x)}>
                        Settle
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </section>
  );
}
