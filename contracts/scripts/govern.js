// Prepares timelock actions for the admin Safe. Read-only: it sends nothing and needs no key.
// Each action is two Safe Transaction Builder files in safe-txs/: "schedule" (submit now) and "execute"
// (submit once the 48h delay has passed). In Safe: Apps > Transaction Builder > drag the file in.
//
//   node scripts/govern.js set-token <address>   set $CALL in DrawdownRetire and BuyBurn (once), after the Pons launch
//   node scripts/govern.js register-pool         register the $CALL/ETH Pons pool, after $CALL graduates
//   node scripts/govern.js status                list scheduled timelock actions and whether they can execute
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const config = require("../config/robinhood.json");
const { plan } = require("./register-fount-pool");

const RPC = process.env.ROBINHOOD_RPC_URL || config.network.rpcUrl;
const OUT = path.join(__dirname, "..", "..", "safe-txs");
const DEPLOYMENT = path.join(__dirname, "..", "deployments", "robinhood.json");
const LOG_CHUNK = 400_000;

const TIMELOCK_ABI = [
  "function schedule(address target, uint256 value, bytes data, bytes32 predecessor, bytes32 salt, uint256 delay)",
  "function execute(address target, uint256 value, bytes payload, bytes32 predecessor, bytes32 salt)",
  "function scheduleBatch(address[] targets, uint256[] values, bytes[] payloads, bytes32 predecessor, bytes32 salt, uint256 delay)",
  "function executeBatch(address[] targets, uint256[] values, bytes[] payloads, bytes32 predecessor, bytes32 salt)",
  "function getMinDelay() view returns (uint256)",
  "function hashOperation(address target, uint256 value, bytes data, bytes32 predecessor, bytes32 salt) view returns (bytes32)",
  "function hashOperationBatch(address[] targets, uint256[] values, bytes[] payloads, bytes32 predecessor, bytes32 salt) view returns (bytes32)",
  "function isOperationPending(bytes32 id) view returns (bool)",
  "function isOperationReady(bytes32 id) view returns (bool)",
  "function isOperationDone(bytes32 id) view returns (bool)",
  "function getTimestamp(bytes32 id) view returns (uint256)",
  "event CallScheduled(bytes32 indexed id, uint256 indexed index, address target, uint256 value, bytes data, bytes32 predecessor, uint256 delay)",
];
const DRAWDOWN_ABI = [
  "function burnToken() view returns (address)",
  "function maxInputPerRun(address) view returns (uint256)",
  "function setBurnToken(address token)",
];
const BURN_ABI = ["function token() view returns (address)", "function setToken(address token)"];
const KNOWN = new ethers.Interface([
  "function setBurnToken(address token)",
  "function setToken(address token)",
  "function setGuard(uint16 ticks)",
  "function setLimits(uint96 minStake, uint96 maxStake, uint128 roundCap)",
  "function setFeeBps(uint16 bps)",
  "function setSchedule(uint64 weekday, uint64 weekend, uint256 hoursBitmap)",
  "function setPool((address,address,uint24,int24,address) key)",
  "function setHookAllowed(address hook, bool allowed)",
  "function setFeed(address token, address aggregator, uint32 maxAge, uint256 minAnswer, uint256 maxAnswer)",
  "function setBreaker(uint16 maxJumpBps, uint32 jumpCooldown)",
  "function setHeldValueCap(uint256 cap)",
  "function setProtocolShareBps(uint16 bps)",
  "function setInputLimit(address token, uint256 maxPerRun)",
  "function setMinInterval(uint32 interval)",
  "function unpause()",
  "function resume()",
  "function grantRole(bytes32 role, address account)",
  "function revokeRole(bytes32 role, address account)",
  "function transferOwnership(address newOwner)",
  "function proposeDestination(address next)",
  "function executeDestination()",
]);

function load() {
  if (!fs.existsSync(DEPLOYMENT)) throw new Error("No contracts/deployments/robinhood.json. Deploy first with ./launch.sh.");
  const d = JSON.parse(fs.readFileSync(DEPLOYMENT, "utf8"));
  const provider = new ethers.JsonRpcProvider(RPC);
  return { d, provider, timelock: new ethers.Contract(d.timelock, TIMELOCK_ABI, provider) };
}

function safeBatch(name, description, admin, txs) {
  return {
    version: "1.0",
    chainId: String(config.network.chainId),
    createdAt: Date.now(),
    meta: { name, description, txBuilderVersion: "1.17.1", createdFromSafeAddress: admin, createdFromOwnerAddress: "" },
    transactions: txs.map((t) => ({ to: t.to, value: "0", data: t.data, contractMethod: null, contractInputsValues: null })),
  };
}

function write(file, obj) {
  fs.mkdirSync(OUT, { recursive: true });
  const p = path.join(OUT, file);
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + "\n");
  return path.relative(path.join(__dirname, "..", ".."), p);
}

/** Writes schedule + execute files for one timelock call, or for several calls run together as one batch. */
async function prepare(ctx, slug, title, target, data, salt) {
  const { d, timelock } = ctx;
  const delay = await timelock.getMinDelay();
  const tl = new ethers.Interface(TIMELOCK_ABI);
  const batch = Array.isArray(target);
  const zeros = batch ? target.map(() => 0) : 0;
  const id = batch
    ? await timelock.hashOperationBatch(target, zeros, data, ethers.ZeroHash, salt)
    : await timelock.hashOperation(target, 0, data, ethers.ZeroHash, salt);
  if (await timelock.isOperationDone(id)) return console.log(`"${title}" was already executed. Nothing to do.`);
  const pending = await timelock.isOperationPending(id);
  const schedule = batch
    ? tl.encodeFunctionData("scheduleBatch", [target, zeros, data, ethers.ZeroHash, salt, delay])
    : tl.encodeFunctionData("schedule", [target, 0, data, ethers.ZeroHash, salt, delay]);
  const execute = batch
    ? tl.encodeFunctionData("executeBatch", [target, zeros, data, ethers.ZeroHash, salt])
    : tl.encodeFunctionData("execute", [target, 0, data, ethers.ZeroHash, salt]);
  const a = write(`${slug}-1-schedule.json`, safeBatch(`${title}: schedule`, `Schedules on the StockCall timelock (${Number(delay) / 3600}h delay)`, d.roles.admin, [{ to: d.timelock, data: schedule }]));
  const b = write(`${slug}-2-execute.json`, safeBatch(`${title}: execute`, "Executes the scheduled call once the delay has passed", d.roles.admin, [{ to: d.timelock, data: execute }]));
  console.log(`\nTimelock operation ${id}`);
  if (pending) {
    const ts = Number(await timelock.getTimestamp(id));
    const ready = await timelock.isOperationReady(id);
    console.log(ready ? "Already scheduled and READY: submit the execute file now." : `Already scheduled; executable after ${new Date(ts * 1000).toISOString()}.`);
  }
  const mode = process.env.GOVERN_SEND;
  if (mode) return send(ctx, mode, { schedule, execute, pending, id });
  const isWallet = (await ctx.provider.getCode(d.roles.admin)) === "0x";
  if (isWallet) {
    console.log(`\nThe admin ${d.roles.admin} is a plain wallet. Send it from there with:`);
    console.log(`  1. Now:            ${ctx.cmd} --schedule`);
    console.log(`  2. After ${Number(delay) / 3600} hours:  ${ctx.cmd} --execute   (check with: ./govern.sh status)`);
    return;
  }
  console.log(`\nIn the admin Safe ${d.roles.admin} on app.safe.global:`);
  console.log(`  1. Now:            Apps > Transaction Builder > drag in ${a} > Create batch > sign with the owners`);
  console.log(`  2. After ${Number(delay) / 3600} hours:  same with ${b}  (anyone can check with: ./govern.sh status)`);
}

/** Sends the schedule or execute call from the admin wallet (ADMIN_PRIVATE_KEY, set by tools/with-key.js). */
async function send(ctx, mode, { schedule, execute, pending, id }) {
  const { d, provider, timelock } = ctx;
  if (!process.env.ADMIN_PRIVATE_KEY) throw new Error("no admin key: run this through ./set-token.sh or ./govern.sh with --schedule or --execute");
  const wallet = new ethers.Wallet(process.env.ADMIN_PRIVATE_KEY, provider);
  if (wallet.address.toLowerCase() !== d.roles.admin.toLowerCase()) {
    throw new Error(`ADMIN_ACCOUNT is ${wallet.address}, but the timelock's admin is ${d.roles.admin}.`);
  }
  if (mode === "schedule" && pending) return console.log("\nAlready scheduled. Run the same command with --execute once it is ready.");
  if (mode === "execute") {
    if (!pending) throw new Error("not scheduled yet. Run the same command with --schedule first.");
    if (!(await timelock.isOperationReady(id))) {
      const ts = Number(await timelock.getTimestamp(id));
      throw new Error(`not ready yet: executable after ${new Date(ts * 1000).toISOString()}.`);
    }
  }
  if (mode !== "schedule" && mode !== "execute") throw new Error(`unknown mode ${mode}`);
  const tx = await wallet.sendTransaction({ to: d.timelock, data: mode === "schedule" ? schedule : execute });
  console.log(`\n${mode} sent: ${config.network.explorer}/tx/${tx.hash}`);
  const r = await tx.wait();
  if (r.status !== 1) throw new Error("the transaction reverted");
  console.log(mode === "schedule" ? "Scheduled. Run the same command with --execute after the delay." : "Executed.");
}

async function setToken(ctx, address) {
  if (!address || !ethers.isAddress(address)) throw new Error("usage: ./set-token.sh <$CALL token address>");
  const { d, provider } = ctx;
  const token = ethers.getAddress(address);
  if ((await provider.getCode(token)) === "0x") throw new Error(`No contract at ${token} on Robinhood Chain.`);
  const t = new ethers.Contract(token, ["function symbol() view returns (string)", "function decimals() view returns (uint8)", "function totalSupply() view returns (uint256)", "function burn(uint256)"], provider);
  const [symbol, decimals, supply] = await Promise.all([t.symbol(), t.decimals(), t.totalSupply()]);
  if (decimals !== 18n) throw new Error(`${symbol} has ${decimals} decimals; DrawdownRetire expects 18.`);
  const from = "0x000000000000000000000000000000000000dEaD";
  const over = await provider.call({ from, to: token, data: t.interface.encodeFunctionData("burn", [10n ** 40n]) }).then(() => true, () => false);
  const zero = await provider.call({ from, to: token, data: t.interface.encodeFunctionData("burn", [0n]) }).then(() => true, () => false);
  if (!zero || over) throw new Error(`${symbol} has no working burn(uint256); DrawdownRetire could not retire it.`);
  console.log(`$CALL candidate: ${symbol} at ${token}, supply ${ethers.formatEther(supply)}, burnable`);

  const dd = new ethers.Contract(d.drawdownRetire, DRAWDOWN_ABI, provider);
  const bb = new ethers.Contract(d.buyBurn, BURN_ABI, provider);
  // Both burners must end on the same token. Each can be set only once, so set whichever is still unset.
  const targets = [];
  const calls = [];
  for (const [name, current, target, data] of [
    ["DrawdownRetire", await dd.burnToken(), d.drawdownRetire, dd.interface.encodeFunctionData("setBurnToken", [token])],
    ["BuyBurn", await bb.token(), d.buyBurn, bb.interface.encodeFunctionData("setToken", [token])],
  ]) {
    if (current === ethers.ZeroAddress) {
      targets.push(target);
      calls.push(data);
    } else if (current.toLowerCase() !== token.toLowerCase()) {
      throw new Error(`${name} is already set to ${current}; it can only be set once.`);
    }
  }
  if (!targets.length) return console.log("DrawdownRetire and BuyBurn already burn this token. Nothing to do.");
  if ((await dd.maxInputPerRun(token)) !== 0n) throw new Error("This token is configured as a fee input; that must be cleared first.");
  ctx.cmd = `./set-token.sh ${token}`;
  await prepare(ctx, "set-token", `Set $CALL to ${symbol}`, targets, calls, ethers.id(`stockcall:set-token:${token.toLowerCase()}`));
  console.log("\nAfter it executes, buy-and-burn still waits for $CALL to graduate on Pons: then run ./govern.sh register-pool");
}

async function registerPool(ctx) {
  const { d, provider } = ctx;
  const dd = new ethers.Contract(d.drawdownRetire, DRAWDOWN_ABI, provider);
  const token = d.burnToken || (await dd.burnToken());
  if (!token || token === ethers.ZeroAddress) throw new Error("$CALL is not set in DrawdownRetire yet. Run ./set-token.sh first and wait for it to execute.");
  let p;
  try {
    p = await plan(provider, { ...d, burnToken: token });
  } catch (e) {
    throw new Error(`could not read the Uniswap v4 PoolManager at ${config.uniswap.poolManager} (${e.shortMessage || e.message}). Is ROBINHOOD_RPC_URL a Robinhood Chain mainnet RPC?`);
  }
  switch (p.status) {
    case "not-initialized":
      throw new Error("The $CALL / ETH Pons pool does not exist yet: $CALL has not graduated. Run this again after graduation.");
    case "no-liquidity":
      throw new Error("The Pons pool exists but has no liquidity yet. Run this again once graduation finishes.");
    case "hook-not-allowed":
      throw new Error(`The swap adapter does not allow the Pons hook ${config.pons.hook}.`);
    case "registered":
      return console.log("The $CALL / ETH pool is already registered. Buy-and-burn is live.");
  }
  console.log(`Pons pool live: ${p.fountPerEth.toFixed(0)} CALL per ETH, liquidity ${p.liquidity}`);
  const adapter = new ethers.Interface(["function setPool((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key)"]);
  ctx.cmd = "./govern.sh register-pool";
  await prepare(ctx, "register-pool", "Register the $CALL/ETH pool", d.swapAdapter, adapter.encodeFunctionData("setPool", [p.key]), ethers.id(`stockcall:register-pool:${token.toLowerCase()}`));
}

async function status({ d, provider, timelock }) {
  const head = await provider.getBlockNumber();
  const events = [];
  // Free RPC plans cap eth_getLogs ranges; fall back to the public Robinhood RPC for this read.
  const scan = async (tl) => {
    const out = [];
    for (let from = d.startBlock ?? 0; from <= head; from += LOG_CHUNK) {
      out.push(...(await tl.queryFilter(tl.filters.CallScheduled(), from, Math.min(from + LOG_CHUNK - 1, head))));
    }
    return out;
  };
  try {
    events.push(...(await scan(timelock)));
  } catch {
    const pub = new ethers.JsonRpcProvider(config.network.rpcUrl, config.network.chainId, { staticNetwork: true });
    events.push(...(await scan(new ethers.Contract(d.timelock, TIMELOCK_ABI, pub))));
  }
  if (!events.length) return console.log("No timelock actions have ever been scheduled.");
  const names = { [d.arena.toLowerCase()]: "Arena", [d.buyBurn.toLowerCase()]: "BuyBurn", [d.drawdownRetire.toLowerCase()]: "DrawdownRetire", [d.swapAdapter.toLowerCase()]: "V4SwapAdapter", [d.oracle.toLowerCase()]: "FountOracle", [d.feeRouter.toLowerCase()]: "FeeRouter", [d.registry.toLowerCase()]: "FountRegistry", [d.timelock.toLowerCase()]: "Timelock" };
  for (const [t, f] of Object.entries(d.founts)) names[f.fount.toLowerCase()] = `Fount ${t}`;
  for (const e of events) {
    const { id, target, data } = e.args;
    let call = data.slice(0, 10);
    try {
      const p = KNOWN.parseTransaction({ data });
      call = `${p.name}(${p.args.map(String).join(", ")})`;
    } catch {}
    const [done, ready, pending] = await Promise.all([timelock.isOperationDone(id), timelock.isOperationReady(id), timelock.isOperationPending(id)]);
    const ts = Number(await timelock.getTimestamp(id));
    const state = done ? "EXECUTED" : ready ? "READY to execute" : pending ? `waiting until ${new Date(ts * 1000).toISOString()}` : "cancelled";
    console.log(`${state.padEnd(36)} ${names[target.toLowerCase()] ?? target}.${call}`);
  }
}

async function main() {
  const [cmd, arg] = process.argv.slice(2);
  const ctx = load();
  const chainId = Number((await ctx.provider.getNetwork()).chainId);
  if (chainId !== config.network.chainId && process.env.STOCKCALL_LOCAL_TEST !== "1") {
    throw new Error(`the RPC is on chain ${chainId}, not Robinhood Chain (${config.network.chainId}). Check ROBINHOOD_RPC_URL in launch.env.`);
  }
  if (cmd === "set-token") return setToken(ctx, arg);
  if (cmd === "register-pool") return registerPool(ctx);
  if (cmd === "status") return status(ctx);
  throw new Error("usage: node scripts/govern.js set-token <address> | register-pool | status");
}

main().catch((e) => {
  console.error(`STOPPED: ${e.shortMessage || e.message}`);
  process.exit(1);
});
