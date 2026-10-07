// Checks a StockCall deployment on-chain. Read-only, needs no key, and anyone can run it:
//   npx hardhat run scripts/verify.js --network robinhood        (reads deployments/robinhood.json)
//   DEPLOYMENT=deployments/fork.json npx hardhat run scripts/verify.js
// Exits 1 if any check fails. deploy.js runs the same checks right after deploying.
const fs = require("fs");
const path = require("path");
const cards = require("../lib/cards");
const config = require("../config/robinhood.json");

const MIN_DELAY = 48n * 3600n;

/**
 * Role events for several contracts in one sweep. Free RPC plans cap eth_getLogs ranges (Alchemy free: 10
 * blocks), so: one request on the given RPC, then one on the public Robinhood RPC, then 10-block chunks.
 */
async function roleLogs(ethers, addresses, fromBlock) {
  const iface = new ethers.Interface([
    "event RoleGranted(bytes32 indexed role, address indexed account, address indexed sender)",
    "event RoleRevoked(bytes32 indexed role, address indexed account, address indexed sender)",
  ]);
  const topics = [[iface.getEvent("RoleGranted").topicHash, iface.getEvent("RoleRevoked").topicHash]];
  const toBlock = await ethers.provider.getBlockNumber();
  const filter = (from, to) => ({ address: addresses, topics, fromBlock: from, toBlock: to });
  const parse = (logs) => logs.map((l) => ({ address: l.address.toLowerCase(), ...iface.parseLog(l) }));
  try {
    return parse(await ethers.provider.getLogs(filter(fromBlock, toBlock)));
  } catch {}
  const config = require("../config/robinhood.json");
  if (config.network.chainId === Number((await ethers.provider.getNetwork()).chainId)) {
    const pub = new ethers.JsonRpcProvider(config.network.rpcUrl, config.network.chainId, { staticNetwork: true });
    for (let i = 0; i < 2; i++) {
      try {
        return parse(await pub.getLogs(filter(fromBlock, toBlock)));
      } catch {}
    }
  }
  const out = [];
  for (let from = fromBlock; from <= toBlock; from += 10) {
    const to = Math.min(from + 9, toBlock);
    for (let tries = 0; ; tries++) {
      try {
        out.push(...(await ethers.provider.getLogs(filter(from, to))));
        break;
      } catch (e) {
        if (tries >= 3) throw e;
        await new Promise((r) => setTimeout(r, 500 * (tries + 1)));
      }
    }
  }
  return parse(out);
}

async function verifyDeployment(ethers, d, { requireMultisigs = false } = {}) {
  let failures = 0;
  const check = (ok, msg) => {
    console.log(`  ${ok ? "ok  " : "FAIL"}  ${msg}`);
    if (!ok) failures++;
  };
  const same = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();
  const fromBlock = d.startBlock ?? 0;

  console.log("Timelock");
  const tl = await ethers.getContractAt("TimelockController", d.timelock);
  const artifact = await require("hardhat").artifacts.readArtifact("TimelockController");
  const code = await ethers.provider.getCode(d.timelock);
  check(ethers.keccak256(code) === ethers.keccak256(artifact.deployedBytecode), "bytecode is the unmodified OpenZeppelin TimelockController");
  const delay = await tl.getMinDelay();
  check(delay >= MIN_DELAY, `minimum delay ${delay / 3600n}h (at least 48h)`);
  const R = { admin: await tl.DEFAULT_ADMIN_ROLE(), proposer: await tl.PROPOSER_ROLE(), executor: await tl.EXECUTOR_ROLE(), canceller: await tl.CANCELLER_ROLE() };
  for (const [name, role] of Object.entries(R)) {
    check(!(await tl.hasRole(role, d.deployer)), `deployer is not a timelock ${name}`);
  }
  check(await tl.hasRole(R.proposer, d.roles.admin), "admin multisig can propose");
  check(!(await tl.hasRole(R.admin, d.roles.admin)), "admin multisig cannot bypass the timelock's own role management");
  const ALL = ["admin", "guardian", "keeper"];
  const accessControlled = [
    ["DrawdownRetire", d.drawdownRetire, ALL],
    ...Object.entries(d.founts).map(([t, f]) => [`Fount ${t}`, f.fount, ALL]),
    ["Arena", d.arena, ["admin", "guardian"]],
    ["BuyBurn", d.buyBurn, ALL],
  ];
  const logs = await roleLogs(ethers, [d.timelock, ...accessControlled.map(([, a]) => a)], fromBlock);
  const tlGrants = logs.filter((l) => l.address === d.timelock.toLowerCase() && l.name === "RoleGranted" && l.args.role === R.admin);
  check(tlGrants.every((e) => same(e.args.account, d.timelock)), "only the timelock administers itself");

  if (requireMultisigs) {
    console.log("Multisigs");
    for (const name of ["admin", "guardian"]) {
      check((await ethers.provider.getCode(d.roles[name])) !== "0x", `${name} ${d.roles[name]} is a contract`);
    }
  }

  console.log("Role holders");
  for (const [label, address, names] of accessControlled) {
    const c = await ethers.getContractAt("Fount", address); // same AccessControl ABI
    const roleIds = {
      admin: [await c.DEFAULT_ADMIN_ROLE(), d.timelock],
      guardian: [ethers.id("GUARDIAN_ROLE"), d.roles.guardian],
      keeper: [ethers.id("KEEPER_ROLE"), d.roles.keeper],
    };
    const expected = Object.fromEntries(names.map((n) => roleIds[n]));
    const holders = new Map();
    for (const e of logs.filter((l) => l.address === address.toLowerCase())) {
      const k = `${e.args.role}:${e.args.account.toLowerCase()}`;
      if (e.name === "RoleGranted") holders.set(k, [e.args.role, e.args.account]);
      else holders.delete(k);
    }
    const unexpected = [...holders.values()].filter(([role, account]) => !same(expected[role], account));
    check(unexpected.length === 0 && holders.size === names.length, `${label}: exactly ${names.map((n) => (n === "admin" ? "timelock admin" : n)).join(", ")}`);
    check(!(await c.hasRole(await c.DEFAULT_ADMIN_ROLE(), d.deployer)), `${label}: deployer has no admin role`);
  }

  console.log("Owners");
  for (const [label, name, address] of [
    ["FountOracle", "FountOracle", d.oracle],
    ["FeeRouter", "FeeRouter", d.feeRouter],
    ["FountRegistry", "FountRegistry", d.registry],
    ...(d.swapAdapterIsMock ? [] : [["V4SwapAdapter", "V4SwapAdapter", d.swapAdapter]]),
  ]) {
    const c = await ethers.getContractAt(name, address);
    if (!c.interface.getFunction("owner", [])) continue;
    try {
      check(same(await c.owner(), d.timelock) && same(await c.pendingOwner(), ethers.ZeroAddress), `${label}: owned by the timelock, nothing pending`);
    } catch {
      check(false, `${label}: has no owner() (mock?)`);
    }
  }

  console.log("Wiring");
  const drawdown = await ethers.getContractAt("DrawdownRetire", d.drawdownRetire);
  const onChainToken = await drawdown.burnToken();
  if (d.burnToken) check(same(onChainToken, d.burnToken), `DrawdownRetire burns $CALL ${d.burnToken}`);
  else if (same(onChainToken, ethers.ZeroAddress)) console.log("  info  $CALL not set yet: fees wait in DrawdownRetire until the timelock sets it (set-token.sh)");
  else console.log(`  info  $CALL set on-chain to ${onChainToken} (deployment file not updated yet)`);
  const router = await ethers.getContractAt("FeeRouter", d.feeRouter);
  check(same(await router.drawdownRetire(), d.drawdownRetire) && same(await router.pendingDrawdownRetire(), ethers.ZeroAddress), "FeeRouter sends to DrawdownRetire, no change pending");
  const oracle = await ethers.getContractAt("FountOracle", d.oracle);
  check((await oracle.maxJumpBps()) > 0n && (await oracle.jumpCooldown()) > 0n, `circuit breaker ${await oracle.maxJumpBps()} bps / ${await oracle.jumpCooldown()}s`);
  const registry = await ethers.getContractAt("FountRegistry", d.registry);
  const listed = (await registry.entries()).map((e) => e.target.toLowerCase());
  for (const [ticker, f] of Object.entries(d.founts)) {
    const fount = await ethers.getContractAt("Fount", f.fount);
    const position = await ethers.getContractAt("FountPositionV4", f.position);
    const wired =
      same(await fount.position(), f.position) &&
      same(await position.fount(), f.fount) &&
      same(await fount.oracle(), d.oracle) &&
      same(await fount.feeRouter(), d.feeRouter) &&
      same(await fount.swapAdapter(), d.swapAdapter);
    check(wired, `Fount ${ticker}: position bound both ways, shared oracle, router and adapter`);
    check((await oracle.feeds(f.equityToken)).aggregator !== ethers.ZeroAddress, `Fount ${ticker}: oracle feed set`);
    check(listed.includes(f.fount.toLowerCase()), `Fount ${ticker}: listed in the registry`);
  }

  console.log("Arena");
  const arena = await ethers.getContractAt("Arena", d.arena);
  check(same(await arena.feeSink(), d.buyBurn), "fees and forfeits can only go to BuyBurn");
  check(same(await arena.oracle(), d.oracle), "price guard reads the shared FountOracle");
  check(same(await arena.usdg(), d.usdg) && same(await arena.v3Factory(), d.v3Factory), "prices from Uniswap v3 pools quoted in USDG");
  const fee = await arena.feeBps();
  check(fee <= 1000n, `fee ${Number(fee) / 100}% of profit, none on a loss (code cap 10%)`);
  const guard = await arena.guardTicks();
  check(guard >= 50n && guard <= 2000n, `price guard ${guard} ticks (about ${(Number(guard) / 100).toFixed(1)}%)`);
  const [minS, maxS, cap] = await Promise.all([arena.minStake(), arena.maxStake(), arena.roundCap()]);
  check(maxS <= ethers.parseEther("10") && cap <= ethers.parseEther("100"), `stakes ${ethers.formatEther(minS)} to ${ethers.formatEther(maxS)} ETH, ${ethers.formatEther(cap)} ETH a round`);
  for (const [sym, a] of Object.entries(d.assets)) {
    const onChain = await arena.assets(config.arena.assets[sym].id);
    check(same(onChain.pool, a.pool) && Number(onChain.guard) === cards.GUARD[config.arena.assets[sym].guard], `${sym}: TWAP pool ${a.pool}, guard ${config.arena.assets[sym].guard}`);
    if (config.arena.assets[sym].guard !== "off") check((await oracle.feeds(a.token)).aggregator !== ethers.ZeroAddress, `${sym}: oracle feed set for the guard`);
  }
  for (const card of cards.schemas()) {
    const got = await arena.schema(card.id);
    const match = got.length === card.questions.length && card.questions.every((q, i) => Number(got[i].kind) === q.kind && Number(got[i].options) === q.options && Number(got[i].margin) === q.margin);
    check(match, `card ${card.id}: ${card.questions.length} questions as configured`);
  }
  check((await arena.weekdayHours()) === cards.weekdayBitmap(), "weekday card Monday 02:00 to Friday 23:00 UTC, ETH-only card otherwise");
  check(!(await arena.paused()), "not paused");

  console.log("Buy-and-burn");
  const burn = await ethers.getContractAt("BuyBurn", d.buyBurn);
  check(same(await burn.poolManager(), d.poolManager) && same(await burn.ponsHook(), d.ponsHook), `buys through the Uniswap v4 PoolManager and the Pons hook ${d.ponsHook}`);
  const burnToken = await burn.token();
  if (d.burnToken) check(same(burnToken, d.burnToken) && same(onChainToken, d.burnToken), `BuyBurn and DrawdownRetire both burn $CALL ${d.burnToken}`);
  else if (same(burnToken, ethers.ZeroAddress)) console.log("  info  $CALL not set yet in BuyBurn: fees wait there until the timelock sets it (set-token.sh)");
  else console.log(`  info  $CALL set on-chain to ${burnToken}`);
  const fns = burn.interface.fragments.filter((f) => f.type === "function").map((f) => f.name);
  check(!fns.some((n) => /withdraw|sweep|rescue/i.test(n)), "BuyBurn has no withdraw function: ETH leaves only as $CALL bought and burned");

  console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed: the deployer holds no power over StockCall.");
  return failures;
}

async function main() {
  const hre = require("hardhat");
  const file = process.env.DEPLOYMENT || path.join(__dirname, "..", "deployments", `${hre.network.name}.json`);
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  console.log(`Verifying ${path.relative(process.cwd(), file)} on ${hre.network.name}\n`);
  const failures = await verifyDeployment(hre.ethers, d, { requireMultisigs: hre.network.name === "robinhood" && process.env.ALLOW_PLAIN_WALLETS !== "1" });
  if (failures) process.exitCode = 1;
}

if (require.main === module) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}

module.exports = { verifyDeployment };
