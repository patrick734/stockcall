#!/usr/bin/env node
// Buys influence.family creator keys (InfluenceKeys on Robinhood Chain) the moment they can be bought.
// Dry run by default: it prints what it would buy and simulates it. Add --live to send transactions.
//
//   node tools/influence-bot.js <wallet-name> --targets 0xabc...,@username [options]   buy these creators at launch
//   node tools/influence-bot.js <wallet-name> --new [options]                          snipe new creators as they appear
//   node tools/influence-bot.js <wallet-name> --watch @handle1,@handle2 [options]      buy these influencers the moment they are added
//   node tools/influence-bot.js --observe                                              log new members' fields (no wallet, no buys)
//
// How "live" works on this contract: buyKeys is blocked while the owner has it paused. There is no per-creator
// activation, so once it is unpaused anyone can buy any creator's first keys. The bot:
//   1. if keys are paused, signs every buy in advance and checks paused() every --poll-ms; the instant it reads
//      false it broadcasts them all at once;
//   2. with --new, watches the site's new-member feed (and, with --follow-first, on-chain first buys by creators
//      of their own keys) and buys creators whose supply is still 0.
//
// Limits the contract enforces: for 5 minutes after a creator's first buy one wallet may hold at most 10 keys of
// them (LAUNCH_CAP). msg.value is the most you pay; the contract refunds the rest, so --max-eth is a hard cap per
// creator and a buy that would cost more simply reverts (you lose only gas).
//
// Options:
//   --live                 send transactions (otherwise dry run)
//   --targets a,b,@user    creator wallets or site usernames
//   --new                  watch for new creators (new members, trending and new-keys lists); live it needs --require
//   --require RULE         --new buys only members matching every rule: field=value, field>N, field, !field
//                          (for example --require genesisRank or --require registered=false); see --observe
//   --any                  --new buys every new member (no --require)
//   (default)              first buyer only: a creator is bought only while nobody holds their keys, and the buy pays
//                          the exact price of the first keys, so if anyone else's buy lands first ours reverts
//                          (only gas is lost). On-chain first buys are then never followed: someone else was first.
//   --copy 0x...           copy-trade a wallet: whenever it buys keys of a creator, buy --keys of the same creator
//                          right after (once per creator); when it sells a creator you hold, sell yours too
//   --copy-every           with --copy: copy every buy it makes, not only its first buy of each creator
//   --no-copy-sells        with --copy: keep your keys when the copied wallet sells
//   --allow-second         also buy creators someone already bought into (--max-supply, --first-buyer, --follow-first)
//   --max-supply N         --new: still buy when up to N keys are already out (default 0: only untouched creators)
//   --latency              how fast this machine reaches the site and the chain (compare VPS locations)
//   --observe              buys nothing, needs no wallet: logs every new or changed member with all their fields
//   --watch @a,@b          X handles of influencers not on the site yet: each profile is checked every --watch-ms and
//                          bought the moment it has a wallet, even if someone else bought first (--max-eth caps it)
//   --watch-file list.txt  the same, one handle per line
//   --watch-ms N           how often each watched profile is checked (default 1000)
//   --feed-ms N            --new: how often the site's member lists are read (default 1000)
//   --chain-ms N           --new: how often the chain is checked for first buys (default 150); these show up
//                          seconds before the site's lists do, so they are the earliest signal
//   --first-buyer 0x...    a wallet whose first buys mark the creators to buy (the wallet that seeds every
//                          dev-added profile): its first buys are followed instantly, without the profile lookup
//   --follow-first         with --new: also buy when a creator makes the first buy of their own keys on chain
//   --keys N               keys per creator, decimals allowed down to 0.01 (default 2; at most 10 in a creator's first 5 minutes)
//   --max-eth X            most to pay per creator, fees included (default 0.005)
//   --budget X             most to spend in total this run (default 0.1)
//   --min-points N         --new: skip members with fewer site points (default 0)
//   --min-followers N      --new: skip members with fewer followers (default 0)
//   --referrer 0x...       referrer bound on your first trade (a second wallet of yours earns 0.5% of your trades)
//   --poll-ms N            how often to check paused() (default 100)
//   --gas-limit N          gas limit for each buy (default: estimated, else 2000000)
// Environment: RPC (default the public Robinhood Chain RPC), RPC2 (a second RPC to broadcast to as well),
// KEYSTORE_PASSWORD (else asked for). For a local test: KEYS (contract address), CHAIN_ID.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { fail, unlock } = require("./lib");
const { ethers } = require("./lib").ethers();

const SITE = process.env.SITE || "https://influence.family";
const CHAIN = Number(process.env.CHAIN_ID || 4663);
const KEYS_FALLBACK = process.env.KEYS || "0x570db3863643ca0A8DBB72E510D5Ee3D44F8E24F";
const PAUSED_SLOT = 2; // Ownable _owner, Ownable2Step _pendingOwner, Pausable _paused
const UNIT = 100n;
const LAUNCH_CAP = 1000n;
const STATE_FILE = path.join(os.homedir(), ".stockcall", "influence-bot.json");

const ABI = [
  "function paused() view returns (bool)",
  "function keysSupply(address) view returns (uint256)",
  "function keysBalance(address,address) view returns (uint256)",
  "function getBuyCost(address creator, uint256 amount, address trader) view returns (uint256)",
  "function launchCapRemaining(address creator, address buyer) view returns (uint256)",
  "function INITIAL_PRICE() view returns (uint256)",
  "function protocolFeeBps() view returns (uint256)",
  "function creatorFeeBps() view returns (uint256)",
  "function referralFeeBps() view returns (uint256)",
  "function owner() view returns (address)",
  "function buyKeys(address creator, uint256 amount, address referrer) payable",
  "function sellKeys(address creator, uint256 amount, uint256 minProceeds)",
  "function getSellProceeds(address creator, uint256 amount, address trader) view returns (uint256)",
  "event Trade(address indexed trader, address indexed creator, bool isBuy, uint256 amount, uint256 ethAmount, uint256 protocolFee, uint256 creatorFee, uint256 referralFee, uint256 supply, uint256 nextPrice, uint256 holderBalance)",
  "event Unpaused(address account)",
  "error InsufficientPayment(uint256 required)",
  "error LaunchCap(uint256 maxUnits)",
  "error EnforcedPause()",
  "error ZeroAmount()",
];
const iface = new ethers.Interface(ABI);

// ---------------------------------------------------------------- options

/** Handles in a watch file: one per line (or comma separated), # starts a comment. */
function readHandles(file) {
  if (!fs.existsSync(file)) fail(`${file} not found. Create it with one @handle per line.`);
  return fs
    .readFileSync(file, "utf8")
    .split(/\r?\n/)
    .map((l) => l.replace(/#.*$/, ""))
    .join(",")
    .split(/[\s,]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function parseArgs(argv) {
  const o = { live: false, targets: [], watchNew: false, followFirst: false, keys: "2", maxEth: "0.005", budget: "0.1", minPoints: 0, minFollowers: 0, referrer: ethers.ZeroAddress, pollMs: 100, gasLimit: null, watch: [], watchMs: 1000, feedMs: 1000, chainMs: 150, firstBuyers: [], firstOnly: true, copy: [], copySells: true, copyEvery: false, observe: false, require: [], any: false, maxSupply: 0n };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const val = () => {
      if (i + 1 >= argv.length) fail(`${a} needs a value`);
      return argv[++i];
    };
    if (a === "--live") o.live = true;
    else if (a === "--new") o.watchNew = true;
    else if (a === "--observe") o.observe = true;
    else if (a === "--any") o.any = true;
    else if (a === "--allow-second") o.firstOnly = false;
    else if (a === "--copy") o.copy.push(...val().split(",").map((x) => ethers.getAddress(x.trim())));
    else if (a === "--no-copy-sells") o.copySells = false;
    else if (a === "--copy-every") o.copyEvery = true;
    else if (a === "--max-supply") o.maxSupply = BigInt(Math.round(Number(val()) * 100));
    else if (a === "--require") o.require.push(parseRule(val()));
    else if (a === "--watch") o.watch.push(...val().split(",").map((x) => x.trim()).filter(Boolean));
    else if (a === "--watch-file") {
      o.watchFile = val();
      o.watch.push(...readHandles(o.watchFile));
    } else if (a === "--latency") o.latency = true;
    else if (a === "--watch-ms") o.watchMs = Math.max(250, Number(val()));
    else if (a === "--feed-ms") o.feedMs = Math.max(300, Number(val()));
    else if (a === "--chain-ms") o.chainMs = Math.max(50, Number(val()));
    else if (a === "--first-buyer") o.firstBuyers.push(...val().split(",").map((x) => ethers.getAddress(x.trim())));
    else if (a === "--follow-first") o.followFirst = true;
    else if (a === "--targets") o.targets.push(...val().split(",").map((s) => s.trim()).filter(Boolean));
    else if (a === "--keys") o.keys = val();
    else if (a === "--max-eth") o.maxEth = val();
    else if (a === "--budget") o.budget = val();
    else if (a === "--min-points") o.minPoints = Number(val());
    else if (a === "--min-followers") o.minFollowers = Number(val());
    else if (a === "--referrer") o.referrer = ethers.getAddress(val());
    else if (a === "--poll-ms") o.pollMs = Math.max(20, Number(val()));
    else if (a === "--gas-limit") o.gasLimit = BigInt(val());
    else if (a.startsWith("--")) fail(`unknown option ${a}`);
    else rest.push(a);
  }
  o.wallet = rest[0];
  if (o.observe || o.latency) return o;
  if (!o.wallet) fail("usage: node tools/influence-bot.js <wallet-name> --targets 0x...,@user | --new [--live]  (see the top of this file)");
  if (!o.targets.length && !o.watchNew && !o.watch.length && !o.watchFile && !o.firstBuyers.length && !o.copy.length) fail("give --targets, --watch, --new and/or --first-buyer");
  if (o.firstOnly && (o.firstBuyers.length || o.followFirst || o.maxSupply > 0n))
    fail("--first-buyer, --follow-first and --max-supply buy after someone else; add --allow-second to use them");
  if (o.watchNew && o.live && !o.require.length && !o.any)
    fail("--new --live needs --require (which profiles to buy, for example the ones the dev added; find the field with --observe), or --any to buy every new member");
  o.units = BigInt(Math.round(Number(o.keys) * 100));
  if (o.units <= 0n) fail("--keys must be at least 0.01");
  o.maxWei = ethers.parseEther(o.maxEth);
  o.budgetWei = ethers.parseEther(o.budget);
  return o;
}

// ---------------------------------------------------------------- helpers

/** --require rules: "field=value" (true, false, null, numbers or text), "field" (set and not false/0), "!field" (unset). */
function parseRule(text) {
  let m = text.match(/^!([\w.]+)$/);
  if (m) return { text, field: m[1], test: (v) => v === undefined || v === null || v === false || v === 0 || v === "" };
  m = text.match(/^([\w.]+)(>=|<=|!=|=|>|<)(.*)$/);
  if (!m) {
    if (!/^[\w.]+$/.test(text)) fail(`bad --require "${text}"`);
    return { text, field: text, test: (v) => v !== undefined && v !== null && v !== false && v !== 0 && v !== "" };
  }
  const [, field, op, raw] = m;
  const want = raw === "true" ? true : raw === "false" ? false : raw === "null" ? null : raw !== "" && !isNaN(Number(raw)) ? Number(raw) : raw;
  const norm = (v) => (v === undefined ? null : typeof want === "number" && typeof v === "string" && !isNaN(Number(v)) ? Number(v) : v);
  const ops = { "=": (v) => norm(v) === want, "!=": (v) => norm(v) !== want, ">": (v) => norm(v) > want, "<": (v) => norm(v) < want, ">=": (v) => norm(v) >= want, "<=": (v) => norm(v) <= want };
  return { text, field, test: ops[op] };
}
const fieldOf = (u, path) => path.split(".").reduce((x, k) => (x == null ? undefined : x[k]), u);
const matches = (u, rules) => rules.every((r) => r.test(fieldOf(u, r.field)));

const eth = (w) => `${Number(ethers.formatEther(w)).toFixed(6)} ETH`;
const keysOf = (u) => (Number(u) / 100).toString();
const now = () => new Date().toISOString().slice(11, 23);
const log = (...a) => console.log(now(), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function loadState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { bought: {} };
  }
}
function saveState(s) {
  fs.mkdirSync(path.dirname(STATE_FILE), { recursive: true });
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2) + "\n");
}

async function getJson(url) {
  const r = await fetch(url, { headers: { accept: "application/json", "user-agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(8000) });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}

/** The address a member's keys trade under: the profile endpoint's keysAddress (the lists hide wallets), else
 *  their linked or in-app wallet. */
const creatorAddress = (u, keysAddress) => {
  const a = keysAddress || u?.keysAddress || u?.wallet || u?.appWallet;
  return a && ethers.isAddress(a) ? ethers.getAddress(a) : null;
};

/** A member's full profile and key address from /api/users/<name>; null when there is no such member yet. */
async function profile(name) {
  const r = await fetch(`${SITE}/api/users/${encodeURIComponent(name)}`, { headers: { accept: "application/json", "user-agent": "Mozilla/5.0" }, signal: AbortSignal.timeout(5000) });
  if (r.status === 404) return null;
  if (!r.ok) {
    const e = new Error(`profile @${name}: HTTP ${r.status}`);
    e.status = r.status;
    throw e;
  }
  const j = await r.json();
  const u = j.user || j;
  if (!u || !u.username) return null;
  return { user: u, address: creatorAddress(u, j.keysAddress), stats: j.stats || null };
}

async function resolveTarget(t) {
  if (ethers.isAddress(t)) return { address: ethers.getAddress(t), label: t };
  const name = t.replace(/^@/, "");
  const p = await profile(name);
  if (!p) fail(`@${name} is not on influence.family yet. Use --watch @${name} to buy the moment they are added.`);
  if (!p.address) fail(`@${name} has no key address yet. Use --watch @${name} to buy the moment they get one.`);
  return { address: p.address, label: `@${p.user.username}` };
}

function decodeError(e) {
  const data = e?.data || e?.info?.error?.data || e?.error?.data;
  if (typeof data === "string" && data.length >= 10) {
    try {
      const p = iface.parseError(data);
      if (p) return `${p.name}(${p.args.map(String).join(", ")})`;
    } catch {}
  }
  return e?.shortMessage || e?.info?.error?.message || e?.message || String(e);
}

// ---------------------------------------------------------------- bot

/** --observe: buys nothing and needs no wallet. Watches for the profiles the dev adds and logs what marks them:
 *  - member numbers skipped by the new-members list (dev-added profiles seem to be left out of it),
 *  - members appearing in the trending, new-keys and new-members lists, with their key address,
 *  - first buys of any creator on chain (supply 0 -> above 0): who bought, how much, and the creator's profile.
 *  Everything is appended to ~/.stockcall/influence-members.jsonl. */
async function observe(o) {
  const file = path.join(os.homedir(), ".stockcall", "influence-members.jsonl");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const record = (kind, data) => fs.appendFileSync(file, JSON.stringify({ seenAt: new Date().toISOString(), kind, ...data }) + "\n");
  const STABLE = ["memberNo", "registered", "genesisRank", "walletVerified", "tier"];
  const known = new Map();
  const numbers = new Set();
  let topNo = 0;
  let first = true;
  const p = new ethers.JsonRpcProvider(process.env.RPC || "https://rpc.mainnet.chain.robinhood.com", CHAIN, { staticNetwork: true });
  let fromBlock = null;
  const show = (u, a, stats) =>
    `#${u.memberNo} points=${u.points} earned=${u.earnedPoints} score=${u.score} registered=${u.registered} genesisRank=${u.genesisRank} tier=${u.tier} keys=${keysOf(BigInt(u.keySupply || 0))}${stats ? ` holders=${stats.holders}` : ""} keysAddress=${a || "?"}`;
  log(`observing ${SITE} every ${o.feedMs} ms and on-chain first buys; everything is saved to ${file}. Ctrl-C to stop.`);
  for (;;) {
    const lists = await Promise.allSettled([getJson(`${SITE}/api/feed?tab=newusers`), getJson(`${SITE}/api/trending?limit=50`), getJson(`${SITE}/api/market/explore?tab=new&limit=50`)]);
    if (!lists.some((l) => l.status === "fulfilled")) log(`site: ${lists[0].reason?.message}`);
    const members = [];
    for (const l of lists) {
      if (l.status !== "fulfilled") continue;
      const j = l.value;
      for (const [src, arr] of [["newusers", j.users], ["members", j.members], ["newKeys", j.newKeys], ["keys", j.keys], ["exploreNew", j.creators]]) for (const x of arr || []) members.push([src, x.user || x]);
    }
    // member numbers the new-members list skips
    const listed = members.filter(([src]) => src === "newusers").map(([, u]) => Number(u.memberNo)).filter(Boolean);
    if (listed.length) {
      const lo = Math.min(...listed);
      const hi = Math.max(...listed);
      listed.forEach((n) => numbers.add(n));
      for (let n = Math.max(lo, topNo ? topNo - 50 : lo); n <= hi; n++) {
        if (numbers.has(n)) continue;
        numbers.add(n);
        log(`HIDDEN member #${n}: skipped by the new-members list (likely added by the dev)`);
        record("hidden", { memberNo: n });
      }
      topNo = Math.max(topNo, hi);
    }
    for (const [src, u] of members) {
      const id = u.id || u.username;
      const key = JSON.stringify(STABLE.map((k) => u[k]));
      const before = known.get(id);
      if (before && before.key === key) continue;
      known.set(id, { key, u });
      if (!before) {
        const pr = first ? null : await profile(u.username).catch(() => null);
        record("member", { list: src, initial: first, profile: u, keysAddress: pr?.address || null });
        if (!first) log(`NEW in ${src}: @${u.username} (${u.displayName}) ${show(u, pr?.address, pr?.stats)}`);
      } else {
        const diff = STABLE.filter((k) => JSON.stringify(before.u[k]) !== JSON.stringify(u[k]));
        record("changed", { list: src, profile: u });
        log(`CHANGED @${u.username}: ${diff.map((k) => `${k} ${JSON.stringify(before.u[k])} -> ${JSON.stringify(u[k])}`).join(", ")}`);
      }
    }
    // first buys on chain
    try {
      const head = await p.getBlockNumber();
      if (fromBlock === null) fromBlock = head + 1;
      if (head >= fromBlock) {
        const logs = await p.getLogs({ address: KEYS_FALLBACK, topics: [iface.getEvent("Trade").topicHash], fromBlock, toBlock: head });
        fromBlock = head + 1;
        for (const l of logs) {
          const { trader, creator, isBuy, amount, supply } = iface.parseLog(l).args;
          if (!isBuy || supply !== amount) continue;
          const pr = await profile(creator).catch(() => null);
          log(`FIRST BUY of ${creator} by ${trader === creator ? "the creator themself" : trader}: ${keysOf(amount)} keys, block ${l.blockNumber}${pr ? `  = @${pr.user.username} ${show(pr.user, pr.address, pr.stats)}` : "  (no profile found by address)"}`);
          record("firstBuy", { creator, trader, amount: amount.toString(), block: l.blockNumber, tx: l.transactionHash, username: pr?.user.username || null, profile: pr?.user || null });
        }
      }
    } catch (e) {
      log(`chain: ${decodeError(e)}`);
    }
    if (first) log(`${known.size} members listed now (saved); printing hidden numbers, new members and first buys from here`);
    first = false;
    await sleep(o.feedMs);
  }
}

/** --latency: how fast this machine reaches the site and the chain (no wallet needed). Run it on each VPS you
 *  consider: the one with the lowest numbers sees new profiles first and lands its buy first. */
async function latency() {
  const rpc = process.env.RPC || "https://rpc.mainnet.chain.robinhood.com";
  const time = async (fn) => {
    const t = performance.now();
    await fn();
    return performance.now() - t;
  };
  const probes = {
    "site profile lookup": () => fetch(`${SITE}/api/users/elonmusk`, { headers: { accept: "application/json" } }).then((r) => r.text()),
    "chain RPC": () => fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}' }).then((r) => r.text()),
  };
  for (const [name, fn] of Object.entries(probes)) {
    const ms = [];
    for (let i = 0; i < 12; i++) ms.push(await time(fn).catch(() => NaN));
    const ok = ms.slice(2).filter(Number.isFinite).sort((a, b) => a - b); // first two warm the connection
    if (!ok.length) console.log(`${name.padEnd(20)} unreachable`);
    else console.log(`${name.padEnd(20)} fastest ${ok[0].toFixed(0)} ms   typical ${ok[Math.floor(ok.length / 2)].toFixed(0)} ms`);
  }
  console.log("Lower is better. A buy needs one site lookup and one RPC send after the profile appears.");
}

async function main() {
  const o = parseArgs(process.argv.slice(2));
  if (o.latency) return latency();
  if (o.observe) return observe(o);
  const rpc = process.env.RPC || "https://rpc.mainnet.chain.robinhood.com";
  const p = new ethers.JsonRpcProvider(rpc, CHAIN, { staticNetwork: true });
  const p2 = process.env.RPC2 ? new ethers.JsonRpcProvider(process.env.RPC2, CHAIN, { staticNetwork: true }) : null;

  let keysAddr = KEYS_FALLBACK;
  let opensAt = null;
  if (!process.env.KEYS) try {
    const cfg = await getJson(`${SITE}/api/market/config`);
    if (cfg.chainId !== CHAIN) fail(`site config says chain ${cfg.chainId}, expected ${CHAIN}`);
    if (cfg.contracts?.keys) keysAddr = ethers.getAddress(cfg.contracts.keys);
    opensAt = cfg.tradesOpenAt || null;
  } catch (e) {
    log(`site config unreachable (${e.message}); using ${KEYS_FALLBACK}`);
  }
  if (keysAddr !== KEYS_FALLBACK) log(`NOTE: the site now points at a different keys contract ${keysAddr} (was ${KEYS_FALLBACK})`);
  const keys = new ethers.Contract(keysAddr, ABI, p);

  const wallet = (await unlock(o.wallet)).connect(p);
  const me = wallet.address;
  const [paused, initial, pf, cf, rf, owner, bal, slot] = await Promise.all([
    keys.paused(),
    keys.INITIAL_PRICE(),
    keys.protocolFeeBps(),
    keys.creatorFeeBps(),
    keys.referralFeeBps(),
    keys.owner(),
    p.getBalance(me),
    p.getStorage(keysAddr, PAUSED_SLOT),
  ]);
  const slotKnown = BigInt(slot) === (paused ? 1n : 0n);

  console.log(`\ninfluence.family key bot  ${o.live ? "LIVE: transactions will be sent" : "DRY RUN: nothing is sent (add --live)"}`);
  console.log(`  keys contract  ${keysAddr}   owner ${owner}`);
  console.log(`  buy state      ${paused ? "PAUSED (waiting for the owner to unpause)" : "OPEN"}${opensAt ? `   site opens trading ${new Date(opensAt * 1000).toUTCString()}` : ""}`);
  console.log(`  fees           protocol ${Number(pf) / 100}% + creator ${Number(cf) / 100}% + referral ${Number(rf) / 100}% on every buy and every sell`);
  console.log(`  first key      ${eth((initial * 16n) / 10n)} before fees; 10 keys from 0 ${eth((initial * 202n * (10000n + pf + cf + rf)) / 10000n)}`);
  console.log(`  wallet         ${me}   balance ${eth(bal)}`);
  console.log(`  per creator    ${keysOf(o.units)} keys, at most ${eth(o.maxWei)}   budget ${eth(o.budgetWei)}\n`);
  if (o.units > LAUNCH_CAP) log(`NOTE: in a creator's first 5 minutes one wallet may hold at most 10 keys; above that a buy reverts.`);

  const fee = await p.getFeeData();
  const base = fee.gasPrice ?? 10_000_000n;
  const gas = { maxFeePerGas: base * 3n, maxPriorityFeePerGas: 0n }; // FCFS sequencer: a tip does not buy order
  setInterval(async () => {
    try {
      const f = await p.getFeeData();
      if (f.gasPrice) gas.maxFeePerGas = f.gasPrice * 3n;
    } catch {}
  }, 30_000).unref();
  const state = loadState();
  let spent = BigInt(state.spent || "0"); // kept across restarts, so --budget is a lifetime cap
  if (spent) log(`already spent ${eth(spent)} on earlier runs (delete ${STATE_FILE} to reset)`);
  let nonce = await p.getTransactionCount(me, "pending");
  const busy = new Set();

  /** State override that reads the contract as unpaused, for simulating while it is still paused. */
  const unpausedOverride = () => (slotKnown ? { [keysAddr]: { stateDiff: { [ethers.toBeHex(PAUSED_SLOT, 32)]: ethers.ZeroHash } } } : null);

  async function simulate(tx, unpause) {
    const params = [{ from: me, to: tx.to, data: tx.data, value: ethers.toQuantity(tx.value) }, "latest"];
    if (unpause && unpausedOverride()) params.push(unpausedOverride());
    try {
      await p.send("eth_call", params);
      let g = null;
      try {
        g = BigInt(await p.send("eth_estimateGas", params));
      } catch {}
      return { ok: true, gas: g };
    } catch (e) {
      return { ok: false, why: decodeError(e) };
    }
  }

  /** The units to buy of `creator` now: the request, less the launch cap and what is held, cut to fit --max-eth. */
  async function plan(creator) {
    const [held, capLeft, supply] = await Promise.all([keys.keysBalance(creator, me), keys.launchCapRemaining(creator, me), keys.keysSupply(creator)]);
    let units = o.units > held ? o.units - held : 0n;
    if (units > capLeft) units = capLeft;
    if (units === 0n) return { units: 0n, supply, why: held > 0n ? `already hold ${keysOf(held)} keys` : "launch cap reached" };
    let cost = await keys.getBuyCost(creator, units, me);
    while (cost > o.maxWei && units > 1n) {
      units = (units * 9n) / 10n || 1n;
      cost = await keys.getBuyCost(creator, units, me);
    }
    if (cost > o.maxWei) return { units: 0n, supply, why: `even 0.01 key costs ${eth(cost)}, above --max-eth` };
    return { units, cost, supply };
  }

  function buyTx(creator, units, value) {
    return { to: keysAddr, data: iface.encodeFunctionData("buyKeys", [creator, units, o.referrer]), value };
  }

  /** Signs and sends one transaction at a time, so nonces reach the node in order. */
  let sendChain = Promise.resolve();
  function sendInOrder(sign) {
    const run = sendChain.then(async () => broadcast(await sign()));
    sendChain = run.catch(() => {});
    return run;
  }

  async function broadcast(raw) {
    const sends = [p.send("eth_sendRawTransaction", [raw])];
    if (p2) sends.push(p2.send("eth_sendRawTransaction", [raw]));
    const r = await Promise.allSettled(sends);
    const ok = r.find((x) => x.status === "fulfilled");
    if (ok) return ok.value;
    throw r[0].reason;
  }

  async function report(hash, label, creator) {
    try {
      const rc = await p.waitForTransaction(hash, 1, 120_000);
      if (!rc) return log(`${label}: ${hash} not mined after 2 minutes`);
      if (rc.status !== 1) {
        let why = "reverted";
        try {
          const t = await p.getTransaction(hash);
          await p.call({ from: t.from, to: t.to, data: t.data, value: t.value, blockTag: rc.blockNumber });
        } catch (e) {
          why = decodeError(e);
        }
        return log(`${label}: FAILED ${why}  ${hash}`);
      }
      for (const l of rc.logs) {
        if (l.address.toLowerCase() !== keysAddr.toLowerCase()) continue;
        const ev = iface.parseLog(l);
        if (ev?.name === "Trade" && ev.args.trader === me) {
          const paid = ev.args.ethAmount + ev.args.protocolFee + ev.args.creatorFee + (ev.args.ethAmount * rf) / 10000n; // unpaid referral halves go to the protocol
          log(`${label}: BOUGHT ${keysOf(ev.args.amount)} keys for ~${eth(paid)}; supply now ${keysOf(ev.args.supply)}, you hold ${keysOf(ev.args.holderBalance)}  block ${rc.blockNumber}  ${hash}`);
          state.spent = (BigInt(state.spent || "0") + paid).toString();
          state.bought[creator] = { label, keys: keysOf(ev.args.holderBalance), tx: hash, at: new Date().toISOString() };
          saveState(state);
        }
      }
    } catch (e) {
      log(`${label}: could not read the receipt (${e.message}) ${hash}`);
    }
  }

  /** Buys one creator now. Used once keys are open. */
  async function buyNow(creator, label) {
    if (busy.has(creator)) return;
    busy.add(creator);
    try {
      const pl = await plan(creator);
      if (!pl.units) return log(`${label}: skip, ${pl.why}`);
      if (spent + o.maxWei > o.budgetWei) return log(`${label}: skip, budget used up (${eth(spent)} committed)`);
      const tx = buyTx(creator, pl.units, o.maxWei);
      const sim = await simulate(tx, false);
      if (!sim.ok) return log(`${label}: skip, simulation fails: ${sim.why}`);
      log(`${label}: ${o.live ? "buying" : "would buy"} ${keysOf(pl.units)} keys at supply ${keysOf(pl.supply)}, quote ${eth(pl.cost)} (sending up to ${eth(o.maxWei)}, rest refunded)`);
      if (!o.live) return;
      spent += o.maxWei;
      const signed = await wallet.signTransaction({ ...tx, ...gas, chainId: CHAIN, type: 2, nonce: nonce++, gasLimit: o.gasLimit ?? ((sim.gas ?? 1_000_000n) * 3n) / 2n });
      const hash = await broadcast(signed);
      log(`${label}: sent ${hash}`);
      await report(hash, label, creator);
    } catch (e) {
      log(`${label}: error ${decodeError(e)}`);
      nonce = await p.getTransactionCount(me, "pending");
    } finally {
      busy.delete(creator);
    }
  }

  /** Gas limit for buys sent without a simulation: measured once on a fresh creator, with headroom. */
  let fastLimit = o.gasLimit ?? 1_500_000n;
  if (!paused && !o.gasLimit) {
    try {
      const probe = buyTx(ethers.Wallet.createRandom().address, LAUNCH_CAP, o.maxWei);
      fastLimit = (BigInt(await p.send("eth_estimateGas", [{ from: me, to: probe.to, data: probe.data, value: ethers.toQuantity(probe.value) }, "latest"])) * 3n) / 2n;
    } catch {}
  }

  /** Price with fees of `units` at `supply`, computed locally from the curve (same math as the contract). */
  const G = (a) => 2n * a * a * a + 10_000n * a - 300n * a * a;
  const feeBps = pf + cf + rf;
  function localCost(supply, units) {
    const a = supply + 200n;
    const num = initial * (G(a + units) - G(a));
    const price = num === 0n ? 0n : (num - 1n) / 15_000_000n + 1n;
    return price + (price * feeBps) / 10_000n + 3n;
  }
  /** The most units (up to the request) whose cost at `supply` fits --max-eth; 0 if not even 0.01 key fits. */
  function fitUnits(supply) {
    let units = o.units > LAUNCH_CAP ? LAUNCH_CAP : o.units;
    while (units > 0n && localCost(supply, units) > o.maxWei) units -= units > 20n ? units / 10n : 1n;
    return units;
  }

  /** Buys one creator right away, nothing checked first: used for on-chain first buys, where every millisecond
   *  counts. The contract enforces the limits: msg.value (--max-eth) is the most paid, the rest is refunded, and a
   *  buy over the launch cap or over --max-eth reverts. */
  async function buyFast(creator, label, t0, supply = 0n, after = false) {
    if (busy.has(creator)) return;
    busy.add(creator);
    try {
      if (spent + o.maxWei > o.budgetWei) return log(`${label}: skip, budget used up (${eth(spent)} committed)`);
      if (o.firstOnly && !after && supply > 0n) return log(`${label}: skip, ${keysOf(supply)} keys already out: not first`);
      // copy-trading buys exactly --keys or nothing; the other modes shrink the amount to fit --max-eth
      const exact = o.copy.length && after;
      const want = o.units > LAUNCH_CAP ? LAUNCH_CAP : o.units;
      const units = exact ? (localCost(supply, want) <= o.maxWei ? want : 0n) : fitUnits(supply);
      if (!units)
        return log(
          exact
            ? `${label}: skip, ${keysOf(want)} keys at supply ${keysOf(supply)} cost ~${eth(localCost(supply, want))}, over --max-eth ${eth(o.maxWei)}`
            : `${label}: skip, ${keysOf(supply)} keys already out and even 0.01 key costs more than --max-eth`,
        );
      const quote = localCost(supply, units);
      // pay the quote plus room for a few buys landing first (the rest is refunded), never more than --max-eth
      // first-only: the exact first-keys price, so any buy landing before ours makes it revert
      const value = o.firstOnly && !after ? quote : quote * 2n < o.maxWei ? quote * 2n : o.maxWei;
      const tx = buyTx(creator, units, value);
      if (!o.live) return log(`${label}: would buy ${keysOf(units)} keys at supply ${keysOf(supply)}, ~${eth(quote)} (${Date.now() - t0} ms after spotting it)`);
      spent += value;
      const hash = await sendInOrder(() => wallet.signTransaction({ ...tx, ...gas, chainId: CHAIN, type: 2, nonce: nonce++, gasLimit: fastLimit }));
      log(`${label}: sent ${hash}: ${keysOf(units)} keys at supply ${keysOf(supply)}, ~${eth(quote)} (${Date.now() - t0} ms after spotting it)`);
      await report(hash, label, creator);
    } catch (e) {
      log(`${label}: error ${decodeError(e)}`);
      nonce = await p.getTransactionCount(me, "pending");
    } finally {
      busy.delete(creator);
    }
  }

  /** Sells every key this wallet holds of `creator` (copy-trading: the copied wallet sold). Accepts up to 5% less
   *  than the quote, in case other sells land first. */
  async function sellAll(creator, label, t0) {
    try {
      const held = await keys.keysBalance(creator, me);
      if (held === 0n) return;
      const proceeds = await keys.getSellProceeds(creator, held, me);
      if (!o.live) return log(`${label}: would sell your ${keysOf(held)} keys for ~${eth(proceeds)}`);
      const data = iface.encodeFunctionData("sellKeys", [creator, held, (proceeds * 95n) / 100n]);
      const hash = await sendInOrder(() => wallet.signTransaction({ to: keysAddr, data, value: 0n, ...gas, chainId: CHAIN, type: 2, nonce: nonce++, gasLimit: fastLimit }));
      log(`${label}: selling your ${keysOf(held)} keys for ~${eth(proceeds)}: ${hash} (${Date.now() - t0} ms after the copied sell)`);
      const rc = await p.waitForTransaction(hash, 1, 120_000);
      log(`${label}: sell ${rc && rc.status === 1 ? "done" : "FAILED"} ${hash}`);
      if (rc && rc.status === 1 && state.bought[creator]) {
        state.bought[creator].sold = new Date().toISOString();
        saveState(state);
      }
    } catch (e) {
      log(`${label}: sell error ${decodeError(e)}`);
      nonce = await p.getTransactionCount(me, "pending");
    }
  }

  // ---------------------------------------------------------------- launch: pre-signed, fired on unpause
  const targets = [];
  for (const t of o.targets) {
    const r = await resolveTarget(t);
    targets.push(r);
    log(`target ${r.label} -> ${r.address}`);
  }

  if (paused && targets.length) {
    const ready = [];
    for (const t of targets) {
      const pl = await plan(t.address);
      if (!pl.units) {
        log(`${t.label}: skip, ${pl.why}`);
        continue;
      }
      if (spent + o.maxWei > o.budgetWei) {
        log(`${t.label}: skip, over --budget`);
        continue;
      }
      spent += o.maxWei;
      const tx = buyTx(t.address, pl.units, o.maxWei);
      const sim = await simulate(tx, true);
      if (slotKnown && !/EnforcedPause/.test(sim.why || "")) log(`${t.label}: ${keysOf(pl.units)} keys, quote now ${eth(pl.cost)}; simulated as if unpaused: ${sim.ok ? "OK" : "FAILS " + sim.why}`);
      else log(`${t.label}: ${keysOf(pl.units)} keys, quote now ${eth(pl.cost)} (cannot simulate while paused)`);
      const gasLimit = o.gasLimit ?? (sim.gas ? (sim.gas * 3n) / 2n : 2_000_000n);
      const raw = o.live ? await wallet.signTransaction({ ...tx, ...gas, chainId: CHAIN, type: 2, nonce: nonce++, gasLimit }) : null;
      ready.push({ ...t, raw });
    }
    const need = spent + gas.maxFeePerGas * 2_000_000n * BigInt(ready.length);
    if (o.live && bal < need) fail(`wallet holds ${eth(bal)}; the signed buys can need up to ${eth(need)}. Lower --max-eth or fund the wallet.`);
    if (!ready.length) log("nothing to fire at launch");
    else {
      log(`${ready.length} buy(s) ${o.live ? "signed" : "planned"}. Watching paused() every ${o.pollMs} ms. Ctrl-C to stop.`);
      let polls = 0;
      for (;;) {
        let isPaused = true;
        try {
          isPaused = await keys.paused();
        } catch {}
        if (!isPaused) break;
        if (++polls % Math.round(60_000 / o.pollMs) === 0) log(`still paused${opensAt ? `; site time ${new Date(opensAt * 1000).toISOString().slice(11, 19)} UTC` : ""}`);
        await sleep(o.pollMs);
      }
      log("UNPAUSED");
      if (o.live) {
        const hashes = await Promise.all(ready.map((r) => broadcast(r.raw).catch((e) => (log(`${r.label}: broadcast failed ${decodeError(e)}`), null))));
        hashes.forEach((h, i) => h && log(`${ready[i].label}: sent ${h}`));
        await Promise.all(hashes.map((h, i) => h && report(h, ready[i].label, ready[i].address)));
      } else ready.forEach((r) => log(`${r.label}: would broadcast now`));
    }
  } else if (targets.length) {
    log("keys are open: buying targets now");
    await Promise.all(targets.map((t) => buyNow(t.address, t.label)));
  }

  if (!o.watchNew && !o.watch.length && !o.watchFile && !o.firstBuyers.length && !o.followFirst && !o.copy.length) return;

  // ---------------------------------------------------------------- new creators and the watchlist
  while (await keys.paused().catch(() => true)) await sleep(1000);
  const seen = new Set(Object.keys(state.bought));
  const handled = new Set(); // watchlist handles already bought or skipped
  const sources = [(o.watch.length || o.watchFile) && `${o.watch.length} watched profile(s) every ${o.watchMs} ms${o.watchFile ? ` (add more to ${o.watchFile} any time)` : ""}`, o.watchNew && `new members and new keys every ${o.feedMs} ms`, (o.copy.length || (!o.firstOnly && (o.watchNew || o.followFirst))) && `the chain every ${o.chainMs} ms`].filter(Boolean);
  if (sources.length) log(`watching: ${sources.join(", ")}`);

  /** A member seen on the site: buy if they have a wallet, pass the filters and (unless watched) have no keys out. */
  const looked = new Set(); // list members whose profile was already fetched
  async function consider(u, watched, keysAddress) {
    const label = `@${u.username}`;
    if (!watched && ((u.points ?? 0) < o.minPoints || (u.followersCount ?? 0) < o.minFollowers || !matches(u, o.require))) return false;
    let a = creatorAddress(u, keysAddress);
    if (!keysAddress && !u.keysAddress) {
      // the member lists hide key addresses: read the profile once per member
      if (looked.has(u.username)) return false;
      looked.add(u.username);
      const p = await profile(u.username).catch(() => null);
      a = p?.address || null;
    }
    if (!a) return false;
    if (seen.has(a)) {
      if (watched && state.bought[a]) log(`${label}: already bought on an earlier run (${state.bought[a].tx})`);
      return true;
    }
    seen.add(a);
    const supply = await keys.keysSupply(a);
    if (o.firstOnly) {
      if (supply > 0n) {
        log(`${label}: ${keysOf(supply)} keys already out: not first, skip`);
        return true;
      }
      log(`${label}: key address ${a}, nobody has bought yet`);
      buyFast(a, label, Date.now(), 0n);
      return true;
    }
    if (supply > o.maxSupply && !watched) {
      log(`${label}: ${keysOf(supply)} keys already out (over --max-supply ${keysOf(o.maxSupply)}); skip`);
      return true;
    }
    if (supply > 0n) log(`${label}: ${keysOf(supply)} keys already out, buying anyway (--max-eth still caps the price)`);
    else log(`${label}: wallet ${a} just appeared with no keys out`);
    buyNow(a, label);
    return true;
  }

  // Each watched profile is checked on its own timer, spread over --watch-ms, so a new one is seen within that time.
  const watching = new Set();
  function startWatch(h, delay) {
    const name = h.replace(/^@/, "");
    if (watching.has(name.toLowerCase())) return;
    watching.add(name.toLowerCase());
    let backoff = 0;
    const tick = async () => {
      if (handled.has(name)) return;
      try {
        const p = await profile(name);
        backoff = 0;
        if (p && p.address) {
          handled.add(name);
          const t0 = Date.now();
          if (seen.has(p.address)) {
            if (state.bought[p.address]) log(`@${p.user.username}: already bought on an earlier run (${state.bought[p.address].tx})`);
          } else {
            seen.add(p.address);
            log(`@${p.user.username}: profile is live, key address ${p.address}, ${keysOf(BigInt(p.user.keySupply || 0))} keys out`);
            if (o.firstOnly && BigInt(p.user.keySupply || 0) > 0n) {
              log(`@${p.user.username}: someone already bought: not first, skip`);
              return;
            }
            buyFast(p.address, `@${p.user.username}`, t0, BigInt(p.user.keySupply || 0));
          }
        }
      } catch (e) {
        if (e.status === 429) backoff = Math.min(30_000, (backoff || 1000) * 2);
        if (!tick.warned) log(`@${name}: profile check failed (${decodeError(e)}); retrying`);
        tick.warned = true;
      }
      if (!handled.has(name)) setTimeout(tick, o.watchMs + backoff);
    };
    setTimeout(tick, delay);
  }
  o.watch.forEach((h, i) => startWatch(h, Math.floor((o.watchMs * i) / o.watch.length)));
  // The watch file is read again every 2 s: add a handle to it while the bot runs and it is watched at once.
  if (o.watchFile) {
    setInterval(() => {
      try {
        for (const h of readHandles(o.watchFile)) {
          if (watching.has(h.replace(/^@/, "").toLowerCase())) continue;
          log(`now watching ${h} (added to ${o.watchFile})`);
          startWatch(h, 0);
        }
      } catch {}
    }, 2000);
  }

  // On-chain first buys are the earliest public sign of a new creator: the site's lists show them seconds later.
  // Each one is looked up on the site by address and bought if the profile passes --require (with --new), or if
  // the creator bought their own first key (--follow-first alone).
  const copied = new Set(Object.keys(state.bought));
  if (o.copy.length || (!o.firstOnly && (o.watchNew || o.followFirst || o.firstBuyers.length))) {
    if (o.copy.length) log(`copy-trading ${o.copy.join(", ")}: ${keysOf(o.units)} keys ${o.copyEvery ? "on every buy it makes" : "of each creator it buys"}${o.copySells ? ", sell when it sells" : ""}`);
    if (o.firstBuyers.length) log(`following first buys by ${o.firstBuyers.join(", ")} instantly`);
    let fromBlock = (await p.getBlockNumber()) + 1;
    (async () => {
      for (;;) {
        try {
          // one HTTP request: ethers batches calls made together
          const [head, logs] = await Promise.all([p.getBlockNumber(), p.getLogs({ address: keysAddr, topics: [iface.getEvent("Trade").topicHash], fromBlock, toBlock: "latest" })]);
          fromBlock = Math.max(head, ...logs.map((l) => l.blockNumber)) + 1;
          for (const l of logs) {
            const { trader, creator, isBuy, amount, supply } = iface.parseLog(l).args;
            if (o.copy.includes(trader)) {
              const t0 = Date.now();
              const label = `copy ${creator.slice(0, 10)}`;
              if (isBuy && (o.copyEvery || !copied.has(creator))) {
                copied.add(creator);
                log(`${label}: copied wallet ${trader.slice(0, 8)} bought ${keysOf(amount)} keys (supply now ${keysOf(supply)}), block ${l.blockNumber}`);
                buyFast(creator, label, t0, supply, true);
                profile(creator)
                  .then((pr) => pr && log(`${label} is @${pr.user.username} (points=${pr.user.points})`))
                  .catch(() => {});
              } else if (!isBuy && o.copySells) {
                log(`${label}: copied wallet ${trader.slice(0, 8)} sold ${keysOf(amount)} keys (supply now ${keysOf(supply)}), block ${l.blockNumber}`);
                sellAll(creator, label, t0);
              }
              continue;
            }
            if (o.firstOnly) continue;
            if (!isBuy || supply !== amount || trader === me || seen.has(creator)) continue;
            const t0 = Date.now();
            seen.add(creator);
            if (o.firstBuyers.includes(trader)) {
              buyFast(creator, `creator ${creator.slice(0, 10)}`, t0, supply);
              profile(creator)
                .then((pr) => pr && log(`creator ${creator.slice(0, 10)} is @${pr.user.username} (points=${pr.user.points}, member #${pr.user.memberNo})`))
                .catch(() => {});
              continue;
            }
            if (o.watchNew) {
              const pr = await profile(creator).catch(() => null);
              if (!pr) {
                log(`first buy of ${creator} by ${trader}: no profile on the site; skip`);
                continue;
              }
              const u = pr.user;
              const watched = o.watch.some((h) => h.replace(/^@/, "").toLowerCase() === u.username.toLowerCase());
              const passes = watched || ((u.points ?? 0) >= o.minPoints && (u.followersCount ?? 0) >= o.minFollowers && matches(u, o.require) && supply <= o.maxSupply);
              log(`first buy of @${u.username} (${keysOf(amount)} keys by ${trader === creator ? "the creator" : trader}), block ${l.blockNumber}: ${passes ? "matches" : "does not match, skip"}`);
              if (passes) buyFast(creator, `@${u.username}`, t0, supply);
            } else if (o.followFirst && trader === creator) {
              buyFast(creator, `creator ${creator.slice(0, 10)}`, t0, supply);
            }
          }
        } catch (e) {
          log(`chain: ${decodeError(e)}`);
        }
        await sleep(o.chainMs);
      }
    })();
  }

  let lastFeed = 0;
  for (;;) {
    if (spent >= o.budgetWei) {
      log(`budget used (${eth(spent)}); stopping`);
      process.exit(0);
    }
    if (o.watchNew && Date.now() - lastFeed >= o.feedMs) {
      lastFeed = Date.now();
      // the Explore page's "new" list first: it carries each creator's key address and supply
      const lists = await Promise.allSettled([getJson(`${SITE}/api/market/explore?tab=new&limit=50`), getJson(`${SITE}/api/feed?tab=newusers`), getJson(`${SITE}/api/trending?limit=50`)]);
      const members = [];
      for (const l of lists) {
        if (l.status !== "fulfilled") continue;
        const j = l.value;
        members.push(...(j.creators || []).filter((c) => c.user).map((c) => [c.user, c.address]));
        members.push(...[...(j.users || []), ...(j.members || []), ...(j.newKeys || []).map((k) => k.user || k), ...(j.keys || []).map((k) => k.user || k)].map((u) => [u, undefined]));
      }
      if (!lists.some((l) => l.status === "fulfilled")) log(`site feed: ${lists[0].reason?.message}`);
      for (const [u, address] of members) {
        try {
          await consider(u, o.watch.some((h) => h.replace(/^@/, "").toLowerCase() === String(u.username).toLowerCase()), address);
        } catch (e) {
          log(`@${u.username}: ${decodeError(e)}`);
        }
      }
    }
    await sleep(o.watchNew ? Math.min(o.feedMs, 1000) : 60_000);
  }
}

main().catch((e) => fail(decodeError(e)));
