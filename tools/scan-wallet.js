#!/usr/bin/env node
// Read-only look at every contract a wallet deployed: nonce scan for CREATE deployments, proxy slots, common
// views (owner, name, taxes...), explorer source status and function selectors. Sends nothing, needs no key.
//   node tools/scan-wallet.js <wallet> [extra contract addresses...]
const { ethers } = require("./lib").ethers();
const RPC = process.env.RPC || "https://rpc.mainnet.chain.robinhood.com";
const EXP = "https://robinhoodchain.blockscout.com";
const wallet = ethers.getAddress(process.argv[2]);
const p = new ethers.JsonRpcProvider(RPC);
const IMPL = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const ADMIN = "0xb53127684a568b3173ae13b9f8a6016e243e63b6e8ee1178d6a717850b5d6103";
const VIEWS = ["owner()(address)", "admin()(address)", "name()(string)", "symbol()(string)", "decimals()(uint8)", "totalSupply()(uint256)", "paused()(bool)", "pendingOwner()(address)", "getMinDelay()(uint256)", "token()(address)", "treasury()(address)", "feeRecipient()(address)", "devWallet()(address)", "maxWallet()(uint256)", "maxTx()(uint256)", "buyTax()(uint256)", "sellTax()(uint256)", "tradingEnabled()(bool)"];
async function view(addr, sig) {
  const [fn, out] = sig.split(")(");
  const iface = new ethers.Interface([`function ${fn}) view returns (${out}`]);
  const f = iface.fragments[0];
  try {
    const r = await p.call({ to: addr, data: iface.encodeFunctionData(f) });
    if (r === "0x") return undefined;
    const v = iface.decodeFunctionResult(f, r)[0];
    return typeof v === "bigint" ? v.toString() : v;
  } catch { return undefined; }
}
function selectors(code) {
  const s = new Set();
  const b = code.slice(2);
  for (let i = 0; i + 10 <= b.length; i += 2) {
    const op = parseInt(b.slice(i, i + 2), 16);
    if (op === 0x63) s.add("0x" + b.slice(i + 2, i + 10));
    if (op >= 0x60 && op <= 0x7f) i += (op - 0x5f) * 2;
  }
  return [...s];
}
async function source(addr) {
  try {
    const r = await fetch(`${EXP}/api/v2/smart-contracts/${addr}`, { headers: { accept: "application/json" } });
    if (!r.ok) return `source: explorer ${r.status}`;
    const j = await r.json();
    return j.name ? `source: verified as ${j.name} (${j.compiler_version})` : "source: NOT verified";
  } catch (e) { return `source: ${e.message}`; }
}
async function report(addr, how) {
  const code = await p.getCode(addr);
  if (code === "0x") return;
  console.log(`\n=== ${addr}  (${how})  ${(code.length - 2) / 2} bytes`);
  const impl = "0x" + (await p.getStorage(addr, IMPL)).slice(26);
  const adm = "0x" + (await p.getStorage(addr, ADMIN)).slice(26);
  if (BigInt(impl)) console.log(`PROXY -> implementation ${ethers.getAddress(impl)}`);
  if (BigInt(adm)) console.log(`proxy admin ${ethers.getAddress(adm)}`);
  if (code.length < 200) console.log(`code ${code}`);
  for (const v of VIEWS) {
    const r = await view(addr, v);
    if (r !== undefined) console.log(`${v.split("(")[0]} = ${r}`);
  }
  console.log(await source(addr));
  console.log(`selectors ${selectors(code).join(" ")}`);
  if (BigInt(impl)) await report(ethers.getAddress(impl), `implementation of ${addr}`);
}
(async () => {
  const nonce = await p.getTransactionCount(wallet);
  const bal = await p.getBalance(wallet);
  console.log(`wallet ${wallet} nonce ${nonce} balance ${ethers.formatEther(bal)} ETH`);
  for (let n = 0; n < nonce; n++) {
    const a = ethers.getCreateAddress({ from: wallet, nonce: n });
    await report(a, `deployed by wallet, nonce ${n}`);
  }
  for (const extra of process.argv.slice(3)) await report(ethers.getAddress(extra), "extra");
  console.log("\ndone");
})().catch((e) => { console.error(e); process.exit(1); });
