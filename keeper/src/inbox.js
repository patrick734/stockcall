// Where sealed reveals wait until a round locks. The site stores them; the keeper reads them for one round:
//   REVEAL_INBOX_URL    GET <url>?round=<n> -> {"reveals": ["0x01...", ...]}  (REVEAL_INBOX_TOKEN as a Bearer token)
//   REVEAL_INBOX_FILE   local JSON file {"<round>": ["0x01...", ...]}         (tests and self-hosting)
// Neither set: the relay is off and players reveal from the site themselves.
const fs = require("fs");

async function sealedFor(n, env = process.env) {
  if (env.REVEAL_INBOX_FILE) {
    if (!fs.existsSync(env.REVEAL_INBOX_FILE)) return [];
    const all = JSON.parse(fs.readFileSync(env.REVEAL_INBOX_FILE, "utf8"));
    return Array.isArray(all[String(n)]) ? all[String(n)] : [];
  }
  if (env.REVEAL_INBOX_URL) {
    const url = new URL(env.REVEAL_INBOX_URL);
    url.searchParams.set("round", String(n));
    const headers = env.REVEAL_INBOX_TOKEN ? { authorization: `Bearer ${env.REVEAL_INBOX_TOKEN}` } : {};
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`reveal inbox answered ${res.status}`);
    const body = await res.json();
    return Array.isArray(body.reveals) ? body.reveals.filter((x) => typeof x === "string") : [];
  }
  return null;
}

module.exports = { sealedFor };
