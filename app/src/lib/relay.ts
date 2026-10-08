"use client";

import { keccak256, type Address, type Hex } from "viem";
import { inboxMessage, seal } from "./sealed";

/**
 * Hands the keeper a sealed copy of a hidden entry's reveal, so it can reveal while the player is away.
 * The player signs one message (free, no transaction) proving the inbox slot is theirs.
 */
export async function sendToRelay(opts: {
  keeperRevealKey: Hex;
  n: number;
  player: Address;
  probs: bigint;
  salt: Hex;
  sign: (message: string) => Promise<Hex>;
}): Promise<void> {
  const sealed = await seal(opts.keeperRevealKey, { n: opts.n, player: opts.player, probs: opts.probs, salt: opts.salt });
  const signature = await opts.sign(inboxMessage(opts.n, keccak256(sealed)));
  const res = await fetch("/api/reveals", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ round: opts.n, player: opts.player, sealed, signature }),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new Error(body.error || `The relay answered ${res.status}`);
  }
}
