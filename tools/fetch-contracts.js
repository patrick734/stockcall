#!/usr/bin/env node
// Collects a project's contracts for review, read-only: finds every 0x address on a website (its HTML and the
// scripts it loads), keeps the ones that are contracts on Robinhood Chain, and saves each one's verified source
// (Sourcify), or its bytecode and a scan when it is not verified. Sends nothing and needs no key.
//   node tools/fetch-contracts.js https://example.app [more urls or 0x addresses...]
// Writes research/<name>/: README.txt (summary), <address>/ (sources, abi.json, scan.txt).
const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");
const { ROOT } = require("./lib");
const { ethers } = require("./lib").ethers();

const RPC = process.env.RPC || "https://rpc.mainnet.chain.robinhood.com";
const CHAIN = 4663;
const p = new ethers.JsonRpcProvider(RPC, CHAIN, { staticNetwork: true });
const IMPL = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const UA = { "user-agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 Chrome/126 Safari/537.36" };

async function get(url) {
  try {
    const r = await fetch(url, { headers: UA, redirect: "follow" });
    return r.ok ? await r.text() : "";
  } catch {
    return "";
  }
}

/** Every 0x address in a page and in the scripts, JSON and API responses it references (same site, up to 200
 *  files). Each file is also saved under site/ so the front end can be read. */
async function crawl(start, notes, OUT) {
  const found = new Map();
  const base = new URL(start);
  const queue = [start];
  const seen = new Set();
  while (queue.length && seen.size < 200) {
    const url = queue.shift();
    if (seen.has(url)) continue;
    seen.add(url);
    const text = await get(url);
    if (!text) continue;
    try {
      const u = new URL(url);
      let rel = safe(decodeURIComponent(u.pathname) + (u.search ? "_" + u.search.slice(1) : ""));
      if (!rel || rel.endsWith("/")) rel += "index.html";
      const f = path.join(OUT, "site", rel);
      fs.mkdirSync(path.dirname(f), { recursive: true });
      fs.writeFileSync(f, text.length > 5e6 ? text.slice(0, 5e6) : text);
    } catch {}
    for (const m of text.matchAll(/0x[a-fA-F0-9]{40}(?![a-fA-F0-9])/g)) {
      const a = ethers.getAddress(m[0].toLowerCase());
      if (!found.has(a)) {
        const i = m.index;
        found.set(a, text.slice(Math.max(0, i - 80), i).replace(/\s+/g, " ").slice(-80));
      }
    }
    // Scripts, chunks, JSON and API paths: anything quoted that looks like one, plus Next.js/Vite chunk names.
    const refs = [];
    for (const m of text.matchAll(/["'`]((?:https?:\/\/[^"'`\s]+|\.{0,2}\/[^"'`\s<>]*|[A-Za-z0-9_\-./]+)\.(?:m?js|json)(?:\?[^"'`\s]*)?)["'`]/g)) refs.push(m[1]);
    for (const m of text.matchAll(/["'`](\/api\/[^"'`\s<>]*)["'`]/g)) refs.push(m[1]);
    for (const m of text.matchAll(/static\/chunks\/[A-Za-z0-9_\-./\[\]]+\.js/g)) refs.push("/_next/" + m[0]);
    for (const ref of refs) {
      try {
        const u = new URL(ref, url);
        if (u.host === base.host && !seen.has(u.href)) queue.push(u.href);
      } catch {}
    }
  }
  notes.push(`${start}: read ${seen.size} files, found ${found.size} addresses`);
  return found;
}

async function sourcify(address) {
  const v2 = await get(`https://sourcify.dev/server/v2/contract/${CHAIN}/${address}?fields=all`);
  if (v2) {
    try {
      const j = JSON.parse(v2);
      if (j.sources) return { match: j.match || j.runtimeMatch || "match", name: j.compilation?.name, sources: Object.fromEntries(Object.entries(j.sources).map(([k, v]) => [k, v.content])), abi: j.abi };
    } catch {}
  }
  const v1 = await get(`https://sourcify.dev/server/files/any/${CHAIN}/${address}`);
  if (v1) {
    try {
      const j = JSON.parse(v1);
      if (j.files) {
        const sources = {};
        let abi;
        for (const f of j.files) {
          if (f.name === "metadata.json") abi = JSON.parse(f.content).output?.abi;
          sources[f.path.split(`/${address}/`).pop() || f.name] = f.content;
        }
        return { match: j.status, sources, abi };
      }
    } catch {}
  }
  return null;
}

function safe(p) {
  return p.replace(/^\/+/, "").replace(/\.\.(\/|\\)/g, "").replace(/[^A-Za-z0-9._\/@-]/g, "_");
}

(async () => {
  const args = process.argv.slice(2);
  if (!args.length) {
    console.error("usage: node tools/fetch-contracts.js <website url | 0x address> [...]");
    process.exit(1);
  }
  const name = safe((args.find((a) => a.startsWith("http")) ? new URL(args.find((a) => a.startsWith("http"))).host : args[0]).replace(/^www\./, ""));
  const OUT = path.join(ROOT, "research", name);
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  const notes = [];
  const candidates = new Map();
  for (const a of args) {
    if (a.startsWith("http")) for (const [k, v] of await crawl(a, notes, OUT)) candidates.set(k, v);
    else candidates.set(ethers.getAddress(a), "given");
  }

  const summary = [];
  const queue = [...candidates.keys()];
  const done = new Set();
  while (queue.length) {
    const a = queue.shift();
    if (done.has(a)) continue;
    done.add(a);
    let code = "0x";
    try {
      code = await p.getCode(a);
    } catch (e) {
      summary.push(`${a}  RPC error: ${e.shortMessage || e.message}`);
      continue;
    }
    if (code === "0x") {
      summary.push(`${a}  not a contract (wallet or other chain)   context: ${candidates.get(a) || ""}`);
      continue;
    }
    process.stdout.write(`  ${a} `);
    const dir = path.join(OUT, a);
    fs.mkdirSync(dir, { recursive: true });
    const src = await sourcify(a);
    let line = `${a}  contract, ${(code.length - 2) / 2} bytes`;
    if (src) {
      for (const [file, content] of Object.entries(src.sources)) {
        const f = path.join(dir, "src", safe(file));
        fs.mkdirSync(path.dirname(f), { recursive: true });
        fs.writeFileSync(f, content);
      }
      if (src.abi) fs.writeFileSync(path.join(dir, "abi.json"), JSON.stringify(src.abi, null, 2));
      line += `, VERIFIED (${src.match})${src.name ? " as " + src.name : ""}, ${Object.keys(src.sources).length} files`;
    } else {
      fs.writeFileSync(path.join(dir, "bytecode.txt"), code);
      line += ", not verified on Sourcify (bytecode saved)";
    }
    try {
      const scan = execFileSync(process.execPath, [path.join(__dirname, "scan-wallet.js"), a], { env: { ...process.env, MAX_NONCE: "50" }, timeout: 300_000 }).toString();
      fs.writeFileSync(path.join(dir, "scan.txt"), scan);
    } catch (e) {
      fs.writeFileSync(path.join(dir, "scan.txt"), String(e.stdout || "") + String(e.message));
    }
    const impl = "0x" + (await p.getStorage(a, IMPL)).slice(26);
    if (BigInt(impl)) {
      const i = ethers.getAddress(impl);
      line += `, PROXY -> ${i}`;
      if (!done.has(i)) queue.push(i);
      candidates.set(i, `implementation of ${a}`);
    }
    line += `   context: ${candidates.get(a) || ""}`;
    summary.push(line);
    console.log("done");
  }

  fs.writeFileSync(path.join(OUT, "README.txt"), [`Collected ${new Date().toISOString()}`, ...notes, "", ...summary, ""].join("\n"));
  console.log(`\n${summary.join("\n")}\n\nSaved to ${path.relative(ROOT, OUT)}/`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
