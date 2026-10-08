import { NextResponse } from "next/server";
import { createPublicClient, getAddress, http, isAddress, isHex, keccak256, verifyMessage, type Hex } from "viem";
import { arenaAbi } from "@/generated/abis";
import { deployments } from "@/generated/deployments";
import { openRound, timing } from "@/lib/arena";
import { localChain, robinhoodChain } from "@/lib/chains";
import { inboxMessage } from "@/lib/sealed";
import { ConfigError, inbox } from "@/lib/server/store";

// The sealed-reveal inbox the keeper reads during each reveal window (keeper/src/inbox.js).
//   POST {round, player, sealed, signature}  a player stores the sealed reveal of their own hidden entry
//   GET  ?round=n                             the keeper reads a round's sealed reveals (Bearer REVEAL_INBOX_TOKEN)
// Everything stored is ciphertext only the keeper can open. A slot is per player and round, and only that player
// can write it: they sign a message naming the round and the sealed blob, and must already have an entry on-chain.

export const dynamic = "force-dynamic";

const MAX_PER_ROUND = 5000;
const TTL = 2 * 24 * 3600;

const json = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { "Cache-Control": "no-store" } });
const fail = (error: string, status = 400) => json({ error }, status);

function chain() {
  const local = process.env.NEXT_PUBLIC_ENABLE_LOCAL === "1";
  const c = local ? localChain : robinhoodChain;
  const d = deployments[c.id];
  const rpc = local ? process.env.LOCAL_RPC_URL || c.rpcUrls.default.http[0] : process.env.ROBINHOOD_RPC_URL || c.rpcUrls.default.http[0];
  return { c, d, client: createPublicClient({ chain: c, transport: http(rpc) }) };
}

const keyFor = (chainId: number, arena: string, n: number) => `reveals:${chainId}:${arena.toLowerCase()}:${n}`;

async function handle<T>(fn: () => Promise<T>) {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ConfigError) return fail(`Server setup: ${e.message}`, 503);
    console.error(e);
    return fail("Something went wrong. Try again.", 500);
  }
}

export async function POST(req: Request) {
  return handle(async () => {
    const { c, d, client } = chain();
    if (!d?.arena) return fail("StockCall is not live on this network yet.", 404);
    const body = (await req.json().catch(() => null)) as { round?: unknown; player?: unknown; sealed?: unknown; signature?: unknown } | null;
    const n = Number(body?.round);
    const player = typeof body?.player === "string" && isAddress(body.player) ? getAddress(body.player) : null;
    const sealed = typeof body?.sealed === "string" && isHex(body.sealed) && body.sealed.startsWith("0x01") ? (body.sealed as Hex) : null;
    const signature = typeof body?.signature === "string" && isHex(body.signature) ? (body.signature as Hex) : null;
    if (!Number.isSafeInteger(n) || n <= 0 || !player || !sealed || !signature) return fail("Malformed request.");
    if (sealed.length > 2048) return fail("Sealed reveal too large.");

    const now = Number((await client.getBlock({ blockTag: "latest" })).timestamp); // chain time, not this server's clock
    if (n > openRound(now) || now >= timing(n).start) return fail("That round is not taking reveals any more.");

    const ok = await verifyMessage({ address: player, message: inboxMessage(n, keccak256(sealed)), signature }).catch(() => false);
    if (!ok) return fail("The signature does not match this wallet.", 401);

    const e = (await client.readContract({ address: d.arena, abi: arenaAbi, functionName: "entryOf", args: [BigInt(n), player] })) as { stake: bigint; revealed: boolean };
    if (e.stake === 0n) return fail("No entry for this wallet in that round yet. Try again once the entry is confirmed.", 409);
    if (e.revealed) return json({ ok: true, alreadyRevealed: true });

    const key = keyFor(c.id, d.arena, n);
    if (!(await inbox.has(key, player.toLowerCase())) && (await inbox.count(key)) >= MAX_PER_ROUND) return fail("The relay is full for this round. Reveal on the site.", 429);
    await inbox.put(key, player.toLowerCase(), sealed, TTL);
    return json({ ok: true });
  });
}

export async function GET(req: Request) {
  return handle(async () => {
    const want = process.env.REVEAL_INBOX_TOKEN;
    if (want && req.headers.get("authorization") !== `Bearer ${want}`) return fail("Unauthorized.", 401);
    const { c, d } = chain();
    if (!d?.arena) return json({ reveals: [] });
    const n = Number(new URL(req.url).searchParams.get("round"));
    if (!Number.isSafeInteger(n) || n <= 0) return fail("round is required.");
    return json({ reveals: await inbox.values(keyFor(c.id, d.arena, n)) });
  });
}
