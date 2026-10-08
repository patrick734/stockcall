import { encodeAbiParameters, keccak256, toHex, type Address, type Hex } from "viem";
import { catalog } from "@/generated/catalog";

// Round n is the hour [n * P, (n + 1) * P). Commits close at n * P - W (the lock); reveals run from then until n * P.
export const P = 3600;
export const W = 300;
export const GUARD_WINDOW = 1800;

export type CardQuestion = { key: string; kind: "noul" | "choice" | "score"; text: string; options: string[] };
export type Card = { id: number; name: "weekday" | "weekend"; questions: CardQuestion[] };

const NAMES: Record<string, string> = { ETH: "ETH", NVDA: "NVIDIA", GOOGL: "Alphabet" };

/** The cards from config, with display labels for every option. */
export const CARDS: Card[] = (Object.entries(catalog.arena.cards) as [Card["name"], (typeof catalog.arena.cards)["weekday"]][]).map(([name, c]) => ({
  id: c.id,
  name,
  questions: c.questions.map((q) => {
    const anyQ = q as unknown as { key: string; kind: CardQuestion["kind"]; text: string; assets?: string[]; buckets?: string[] };
    const options =
      anyQ.kind === "noul" ? ["Yes", "No"] : anyQ.kind === "choice" ? (anyQ.assets ?? []).map((a) => NAMES[a] ?? a) : (anyQ.buckets ?? []);
    return { key: anyQ.key, kind: anyQ.kind, text: anyQ.text, options };
  }),
}));

export const cardById = (id: number | bigint | undefined) => CARDS.find((c) => BigInt(c.id) === BigInt(id ?? -1));

export const openRound = (t: number) => Math.floor((t + W) / P) + 1;
export const timing = (n: number) => {
  const start = n * P;
  return { opens: start - W - P, locks: start - W, start, end: start + P };
};
/** The round whose reveal window is open at `t`, or null. */
export const revealRound = (t: number) => {
  const n = Math.floor(t / P) + 1;
  return t >= n * P - W && t < n * P ? n : null;
};

/** Whole basis points summing to exactly 10,000 (largest remainder, ties to the lower index). */
export function toBasisPoints(weights: number[]): number[] {
  const total = weights.reduce((a, b) => a + b, 0);
  const exact = weights.map((p) => (total === 0 ? 10000 / weights.length : (p / total) * 10000));
  const out = exact.map(Math.floor);
  let left = 10000 - out.reduce((a, b) => a + b, 0);
  const order = exact.map((x, i) => [x - Math.floor(x), i] as const).sort((a, b) => b[0] - a[0] || a[1] - b[1]);
  for (let i = 0; left > 0; i++, left--) out[order[i % order.length][1]] += 1;
  return out;
}

/** Packs per-question basis points into one uint256: option i of the card at bits 16i. */
export function pack(perQuestion: number[][]): bigint {
  return perQuestion.flat().reduce((acc, p, i) => acc | (BigInt(p) << BigInt(16 * i)), 0n);
}

export function unpack(probs: bigint, card: Card): number[][] {
  let i = 0;
  return card.questions.map((q) => q.options.map(() => Number((probs >> BigInt(16 * i++)) & 0xffffn)));
}

/** A fresh secret salt for a hidden entry. */
export function randomSalt(): Hex {
  return toHex(crypto.getRandomValues(new Uint8Array(32)));
}

/** Arena.commitmentFor, computed locally: keccak256(abi.encode(chainid, arena, n, player, probs, salt)). */
export function commitmentFor(chainId: number, arena: Address, n: number, player: Address, probs: bigint, salt: Hex): Hex {
  return keccak256(
    encodeAbiParameters(
      [{ type: "uint256" }, { type: "address" }, { type: "uint256" }, { type: "address" }, { type: "uint256" }, { type: "bytes32" }],
      [BigInt(chainId), arena, BigInt(n), player, probs, salt]
    )
  );
}

export function countdown(seconds: number) {
  if (seconds <= 0) return "0:00";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  return h ? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}` : `${m}:${String(s).padStart(2, "0")}`;
}

export const hourLabel = (n: number) => {
  const f = (x: Date) => x.toISOString().slice(11, 16);
  return `${f(new Date(n * P * 1000))}–${f(new Date((n + 1) * P * 1000))} UTC`;
};
