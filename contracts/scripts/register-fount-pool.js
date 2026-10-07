// Registers the $CALL / ETH Pons pool on the swap adapter once $CALL has graduated on Pons, which is what
// lets DrawdownRetire buy and burn $CALL. Checks the pool is live first. Read-only; sends nothing.
// Before the timelock owns the adapter it prints one direct transaction for the deployer; after, the
// admin multisig's schedule/execute pair. Usage: node scripts/register-fount-pool.js [deployments/robinhood.json]
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");
const config = require("../config/robinhood.json");

const RPC = process.env.ROBINHOOD_RPC_URL || config.network.rpcUrl;
const POOLS_SLOT = 6n;
const ADAPTER_ABI = [
  "function setPool((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key)",
  "function poolFor(address a, address b) view returns ((address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks) key, bool exists)",
  "function hookAllowed(address) view returns (bool)",
  "function owner() view returns (address)",
];
const TIMELOCK_ABI = [
  "function scheduleBatch(address[] targets, uint256[] values, bytes[] payloads, bytes32 predecessor, bytes32 salt, uint256 delay)",
  "function executeBatch(address[] targets, uint256[] values, bytes[] payloads, bytes32 predecessor, bytes32 salt)",
  "function getMinDelay() view returns (uint256)",
];

/// Inspects the pool and adapter for deployment `d` and builds the registration transaction(s).
/// Returns { status, ... } where status is one of: not-initialized, no-liquidity, hook-not-allowed, registered,
/// direct (deployer still owns the adapter) or timelock.
async function plan(provider, d) {
  const adapter = new ethers.Contract(d.swapAdapter, ADAPTER_ABI, provider);
  const pm = new ethers.Contract(config.uniswap.poolManager, ["function extsload(bytes32) view returns (bytes32)"], provider);
  const key = { currency0: ethers.ZeroAddress, currency1: d.burnToken, fee: config.pons.poolFee, tickSpacing: config.pons.poolTickSpacing, hooks: config.pons.hook };
  const id = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["address", "address", "uint24", "int24", "address"], [key.currency0, key.currency1, key.fee, key.tickSpacing, key.hooks]));
  const slot = ethers.keccak256(ethers.concat([id, ethers.toBeHex(POOLS_SLOT, 32)]));
  const sqrtP = BigInt(await pm.extsload(slot)) & ((1n << 160n) - 1n);
  const liquidity = BigInt(await pm.extsload(ethers.toBeHex(BigInt(slot) + 3n, 32))) & ((1n << 128n) - 1n);
  const raw = Number(sqrtP) / 2 ** 96;
  const base = { id, key, fountPerEth: raw * raw, liquidity };
  if (sqrtP === 0n) return { status: "not-initialized", ...base };
  if (liquidity === 0n) return { status: "no-liquidity", ...base };
  if (!(await adapter.hookAllowed(config.pons.hook))) return { status: "hook-not-allowed", ...base };
  const [, exists] = await adapter.poolFor(ethers.ZeroAddress, d.burnToken);
  if (exists) return { status: "registered", ...base };

  const setPool = adapter.interface.encodeFunctionData("setPool", [key]);
  const owner = await adapter.owner();
  if (owner.toLowerCase() !== d.timelock.toLowerCase()) {
    return { status: "direct", owner, tx: { to: d.swapAdapter, value: "0", data: setPool }, ...base };
  }
  const timelock = new ethers.Contract(d.timelock, TIMELOCK_ABI, provider);
  const delay = await timelock.getMinDelay();
  const targets = [d.swapAdapter], values = [0n], payloads = [setPool], predecessor = ethers.ZeroHash, salt = ethers.id("stockfount-register-fount-pool");
  const tl = new ethers.Interface(TIMELOCK_ABI);
  return {
    status: "timelock",
    delay,
    schedule: { to: d.timelock, value: "0", data: tl.encodeFunctionData("scheduleBatch", [targets, values, payloads, predecessor, salt, delay]) },
    execute: { to: d.timelock, value: "0", data: tl.encodeFunctionData("executeBatch", [targets, values, payloads, predecessor, salt]) },
    ...base,
  };
}

async function main() {
  const file = path.resolve(process.argv[2] || path.join(__dirname, "..", "deployments", "robinhood.json"));
  if (!fs.existsSync(file)) throw new Error(`No deployment file at ${file}. Deploy first.`);
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  const provider = new ethers.JsonRpcProvider(RPC, config.network.chainId, { staticNetwork: true });
  const p = await plan(provider, d);
  console.log(`$CALL ${d.burnToken}\nPons pool ${p.id}`);
  switch (p.status) {
    case "not-initialized":
      throw new Error("The $CALL / ETH Pons pool is not initialized yet: $CALL has not graduated. Run this again after graduation.");
    case "no-liquidity":
      throw new Error("The Pons pool exists but has no liquidity yet. Run this again once graduation finishes.");
    case "hook-not-allowed":
      throw new Error(`The adapter does not allow the Pons hook ${config.pons.hook}; allow it first (deploy.js does this on live deploys).`);
  }
  console.log(`  live: ${p.fountPerEth.toFixed(0)} FOUNT per ETH, liquidity ${p.liquidity}`);
  if (p.status === "registered") return console.log("Already registered on the adapter. Nothing to do.");
  if (p.status === "direct") {
    console.log(`\nThe adapter is still owned by ${p.owner} (handoff not executed yet). Send this from that wallet:`);
    return console.log(JSON.stringify(p.tx, null, 2));
  }
  console.log("\nStep 1, schedule (admin multisig, now). In Safe: New transaction > Transaction Builder > custom data:");
  console.log(JSON.stringify(p.schedule, null, 2));
  console.log(`\nStep 2, execute (admin multisig, after ${Number(p.delay) / 3600}h):`);
  console.log(JSON.stringify(p.execute, null, 2));
}

module.exports = { plan };

if (require.main === module) {
  main().catch((e) => {
    console.error(e.shortMessage || e.message);
    process.exit(1);
  });
}
