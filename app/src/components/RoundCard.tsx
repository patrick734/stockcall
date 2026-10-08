"use client";

import { useEffect, useMemo, useState } from "react";
import { formatEther, parseEther, type Hex } from "viem";
import { useAccount, useBalance, useSignMessage } from "wagmi";
import { arenaAbi } from "@/generated/abis";
import { useOpenRound } from "@/hooks/useArena";
import { cardById, commitmentFor, countdown, hourLabel, pack, randomSalt, timing, toBasisPoints } from "@/lib/arena";
import { useDeployment } from "@/lib/deployment";
import { sendToRelay } from "@/lib/relay";
import { saveReveal } from "@/lib/reveals";
import { TxStatus, useTx } from "./Tx";

/** Flat weights: every option starts equal. Players drag, and each question is normalised to 100%. */
const flat = (k: number) => Array.from({ length: k }, () => 50);
const eth = (wei?: bigint) => (wei === undefined ? "…" : Number(formatEther(wei)).toLocaleString(undefined, { maximumFractionDigits: 6 }));

export function RoundCard() {
  const { deployment, chainId } = useDeployment();
  const { address, isConnected } = useAccount();
  const r = useOpenRound();
  const card = cardById(r.schemaId);
  const t = timing(r.n);
  const [weights, setWeights] = useState<number[][]>([]);
  const [stake, setStake] = useState("0.01");
  const tx = useTx();
  const { signMessageAsync } = useSignMessage();
  const { data: wallet } = useBalance({ address, chainId });

  // New round or new card: start from flat weights.
  useEffect(() => {
    if (card) setWeights(card.questions.map((q) => flat(q.options.length)));
  }, [card?.id, r.n]); // eslint-disable-line react-hooks/exhaustive-deps

  const bp = useMemo(() => weights.map((w) => toBasisPoints(w)), [weights]);

  let stakeWei: bigint | null = null;
  try {
    stakeWei = stake ? parseEther(stake as `${number}`) : null;
  } catch {
    stakeWei = null;
  }
  const fromBalance = stakeWei !== null && r.balance !== undefined ? (r.balance < stakeWei ? r.balance : stakeWei) : 0n;
  const fromWallet = stakeWei !== null ? stakeWei - fromBalance : 0n;

  async function enter() {
    if (!deployment || !card || stakeWei === null || !address) return;
    const n = r.n;
    const probs = pack(bp);
    const salt = randomSalt();
    const commitment = commitmentFor(chainId, deployment.arena, n, address, probs, salt);
    // Keep the reveal before sending: without it the stake cannot be revealed and is forfeited.
    saveReveal(chainId, deployment.arena, n, address, { probs: probs.toString(), salt });
    const ok = await tx.run("Enter round", async () =>
      tx.writeContractAsync({
        address: deployment.arena,
        abi: arenaAbi,
        chainId,
        functionName: "commit",
        args: [BigInt(n), BigInt(card.id), stakeWei!, commitment],
        value: fromWallet,
      })
    );
    if (!ok) return;
    r.refetch();
    if (!deployment.keeperRevealKey) return tx.note("Entered. Come back between :55 and :00 to reveal it here.");
    try {
      tx.note("Entered. Sign once (free) so the relay can reveal it if you are away…");
      await sendToRelay({
        keeperRevealKey: deployment.keeperRevealKey as Hex,
        n,
        player: address,
        probs,
        salt,
        sign: (message) => signMessageAsync({ message }),
      });
      saveReveal(chainId, deployment.arena, n, address, { probs: probs.toString(), salt, relayed: true });
      tx.note("Entered. Auto-reveal is on: the relay reveals it at the lock, or reveal it yourself here.");
    } catch (e) {
      tx.note(undefined, `Entered, but auto-reveal is off (${(e as Error).message}). Turn it on under Your rounds, or reveal here between :55 and :00.`);
    }
  }

  const left = r.round && r.roundCap !== undefined ? r.roundCap - r.round.pot : undefined;
  let action = { label: "Enter round", disabled: false };
  if (!deployment?.arena) action = { label: "Not live on this network yet", disabled: true };
  else if (r.paused) action = { label: "Entries are paused", disabled: true };
  else if (!isConnected) action = { label: "Connect a wallet to play", disabled: true };
  else if (r.entry) action = { label: "You're in this round (hidden)", disabled: true };
  else if (stakeWei === null || (r.minStake !== undefined && stakeWei < r.minStake) || (r.maxStake !== undefined && stakeWei > r.maxStake))
    action = { label: `Stake ${r.minStake ? formatEther(r.minStake) : "…"} to ${r.maxStake ? formatEther(r.maxStake) : "…"} ETH`, disabled: true };
  else if (left !== undefined && stakeWei > left) action = { label: "This round is full", disabled: true };
  else if (wallet && fromWallet > wallet.value) action = { label: "Not enough ETH", disabled: true };
  else if (tx.busy) action = { label: tx.message ?? "Working…", disabled: true };

  return (
    <div className="card round" aria-label="This hour's round">
      <div className="round-head">
        <div>
          <span className="round-tag">
            {r.ready ? `Round ${r.n.toLocaleString()} · ${card?.name === "weekend" ? "ETH weekend card" : "Weekday card"}` : "This hour's round"}
          </span>
          <h2>{r.ready ? hourLabel(r.n) : "…"}</h2>
        </div>
        <div className="timer" title="Entries close five minutes before the hour, when reveals and the start price window begin.">
          <span>entries close in</span>
          <b className="num">{r.ready ? countdown(t.locks - r.now) : "…"}</b>
        </div>
      </div>

      {!card && <p className="muted">Loading this hour&apos;s card…</p>}
      {card &&
        card.questions.map((q, qi) => (
          <fieldset key={q.key} className="question" disabled={Boolean(r.entry)}>
            <legend>{q.text}</legend>
            {q.options.map((opt, j) => {
              const pct = (bp[qi]?.[j] ?? 0) / 100;
              return (
                <label key={opt} className="opt">
                  <span className="opt-name">{opt}</span>
                  <input
                    type="range"
                    min={0}
                    max={100}
                    value={weights[qi]?.[j] ?? 50}
                    onChange={(e) => setWeights((w) => w.map((row, a) => (a === qi ? row.map((v, b) => (b === j ? Number(e.target.value) : v)) : row)))}
                    aria-label={`${q.text} ${opt}`}
                  />
                  <span className="opt-bar" aria-hidden>
                    <span style={{ width: `${pct}%` }} />
                  </span>
                  <b className="num">{pct.toFixed(pct % 1 ? 1 : 0)}%</b>
                </label>
              );
            })}
          </fieldset>
        ))}
      {r.entry && <p className="hidden-note">🔒 Your answers are hidden on-chain until the lock. Nobody can see or copy them.</p>}

      <div className="stake">
        <label>
          <span>Stake</span>
          <input inputMode="decimal" value={stake} onChange={(e) => setStake(e.target.value.trim().replace(",", "."))} disabled={Boolean(r.entry)} aria-label="Stake in ETH" />
          <span>ETH</span>
        </label>
        <span className="muted">
          Pot {eth(r.round?.pot)} ETH · {r.round?.entries ?? "…"} {r.round?.entries === 1 ? "entry" : "entries"}
        </span>
      </div>
      {isConnected && !r.entry && stakeWei !== null && stakeWei > 0n && (
        <p className="fine">
          {fromBalance > 0n ? `${eth(fromBalance)} ETH from your Arena balance` : ""}
          {fromBalance > 0n && fromWallet > 0n ? " + " : ""}
          {fromWallet > 0n ? `${eth(fromWallet)} ETH from your wallet` : ""}
        </p>
      )}
      <button className="btn btn-primary wide big" disabled={action.disabled} onClick={enter}>
        {action.label}
      </button>
      <TxStatus message={tx.busy ? undefined : tx.message} error={tx.error} />
      <p className="fine">
        Better calibrated than the room? You win from the less calibrated. Fee: {r.feeBps !== undefined ? r.feeBps / 100 : 5}% of profit only, nothing on a loss;
        it buys and burns $CALL. An entry that is not revealed before the hour starts loses its stake. You can lose stake.
      </p>
    </div>
  );
}
