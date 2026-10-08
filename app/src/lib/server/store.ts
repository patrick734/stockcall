import "server-only";

// The reveal inbox: Upstash Redis over its REST API (Vercel's Upstash integration sets these variables). Without them
// a per-process memory store is used in development only; production refuses to run without Redis, because the
// keeper reads the inbox from another machine.

type Cmd = (string | number)[];

const url = () => process.env.UPSTASH_REDIS_REST_URL || process.env.KV_REST_API_URL;
const token = () => process.env.UPSTASH_REDIS_REST_TOKEN || process.env.KV_REST_API_TOKEN;

export class ConfigError extends Error {}

async function redis<T>(command: Cmd): Promise<T> {
  const res = await fetch(url()!, {
    method: "POST",
    headers: { Authorization: `Bearer ${token()}`, "Content-Type": "application/json" },
    body: JSON.stringify(command.map(String)),
    cache: "no-store",
  });
  const body = (await res.json()) as { result?: T; error?: string };
  if (!res.ok || body.error) throw new Error(`store: ${body.error || res.status}`);
  return body.result as T;
}

const g = globalThis as { __callInbox?: Map<string, Map<string, string>> };
const mem = (g.__callInbox ??= new Map());

function backend() {
  if (url() && token()) return "redis" as const;
  if (process.env.NODE_ENV === "production" && process.env.ALLOW_MEMORY_INBOX !== "1") {
    throw new ConfigError("the reveal inbox needs Redis (UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN)");
  }
  return "memory" as const;
}

export const inbox = {
  /** Stores one sealed reveal per player per round (the player's latest replaces it). */
  async put(key: string, field: string, value: string, ttlSeconds: number): Promise<number> {
    if (backend() === "redis") {
      await redis(["HSET", key, field, value]);
      await redis(["EXPIRE", key, ttlSeconds]);
      return redis<number>(["HLEN", key]);
    }
    const h = mem.get(key) ?? new Map<string, string>();
    h.set(field, value);
    mem.set(key, h);
    return h.size;
  },
  async count(key: string): Promise<number> {
    if (backend() === "redis") return redis<number>(["HLEN", key]);
    return mem.get(key)?.size ?? 0;
  },
  async has(key: string, field: string): Promise<boolean> {
    if (backend() === "redis") return (await redis<number>(["HEXISTS", key, field])) === 1;
    return mem.get(key)?.has(field) ?? false;
  },
  async values(key: string): Promise<string[]> {
    if (backend() === "redis") return redis<string[]>(["HVALS", key]);
    return [...(mem.get(key)?.values() ?? [])];
  },
};
