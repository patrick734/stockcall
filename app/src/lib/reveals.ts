import type { Address, Hex } from "viem";

// Each hidden entry's reveal (probabilities and salt) is kept in this browser until the round is revealed, so the
// player can reveal it here even without the keeper relay. Losing it before the reveal window means the stake is
// forfeited, which is why the relay copy exists too.

export type Stored = { probs: string; salt: Hex; relayed?: boolean };

const key = (chainId: number, arena: Address, n: number, player: Address) => `stockcall:reveal:${chainId}:${arena.toLowerCase()}:${n}:${player.toLowerCase()}`;

export function saveReveal(chainId: number, arena: Address, n: number, player: Address, value: Stored) {
  try {
    localStorage.setItem(key(chainId, arena, n, player), JSON.stringify(value));
  } catch {}
}

export function loadReveal(chainId: number, arena: Address, n: number, player: Address): Stored | null {
  try {
    const raw = localStorage.getItem(key(chainId, arena, n, player));
    return raw ? (JSON.parse(raw) as Stored) : null;
  } catch {
    return null;
  }
}
