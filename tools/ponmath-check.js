#!/usr/bin/env node
// Read-only check of who controls Ponmath (ponmath.academy) right now: guardian, DAO settings, timelock roles,
// minters and what the prize vaults hold. Sends nothing and needs no key.
//   node tools/ponmath-check.js
const { ethers } = require("./lib").ethers();

const RPC = process.env.RPC || "https://rpc.mainnet.chain.robinhood.com";
const p = new ethers.JsonRpcProvider(RPC, 4663, { staticNetwork: true });
const A = {
  points: "0x3Ab20e537DAEd4BCd31Aec42B24F77820025aA46",
  hunt: "0xEef72a0966379a0d14565dC67e136190991D0577",
  vaults: "0x3413F11959E6B916907D95aABBe4597c31e37611",
  governor: "0xBacEA72242bE632f687932717f660b5b49E48a60",
  timelock: "0x7528129bB104226B18f1c83A0F2f166b76f3969a",
  token: "0x498a30269f4b5527a661D7E3694536673F49Ad55",
  deployer: "0xeA56142F08e2C03362a5E9Ca75a4fA63DAa94776",
};
const c = (addr, abi) => new ethers.Contract(addr, abi, p);
const read = async (f, ...a) => {
  try {
    const v = await f(...a);
    return typeof v === "bigint" ? v.toString() : v;
  } catch (e) {
    return `(reverted: ${e.shortMessage || e.message})`.slice(0, 80);
  }
};
const fmtTime = (s) => (Number(s) >= 86400 ? `${Number(s) / 3600} h` : `${s} s (${(Number(s) / 3600).toFixed(2)} h)`);

(async () => {
  const roles = ["function guardian() view returns (address)", "function dao() view returns (address)"];
  const hunt = c(A.hunt, [...roles, "function season() view returns (uint32)", "function paused() view returns (bool)", "function targetKs() view returns (uint16[])", "function solvedCount() view returns (uint32)", "function totalShares() view returns (uint64)"]);
  const vaults = c(A.vaults, [...roles, "function hunt() view returns (address)", "function pointsPerUsd() view returns (uint256)", "function minAttestations() view returns (uint256)", "function vaultCount() view returns (uint256)", "function vaultAssets(uint256) view returns (address[] tokens, uint256[] amounts)", "function huntVaultOf(uint16) view returns (uint256)", "function attestors() view returns (address[] list, bool[] active)", "function yieldVaults() view returns (address[] list, bool[] allowed)", "function patronCount() view returns (uint256)"]);
  const points = c(A.points, [...roles, "function totalSupply() view returns (uint256)", "function mintersSealed() view returns (bool)", "function isMinter(address) view returns (bool)", "function holderCount() view returns (uint256)", "function getVotes(address) view returns (uint256)"]);
  const gov = c(A.governor, ["function votingDelay() view returns (uint256)", "function votingPeriod() view returns (uint256)", "function proposalThreshold() view returns (uint256)", "function quorumNumerator() view returns (uint256)", "function timelock() view returns (address)", "function token() view returns (address)", "function proposalCount() view returns (uint256)"]);
  const tl = c(A.timelock, ["function getMinDelay() view returns (uint256)", "function hasRole(bytes32,address) view returns (bool)", "function PROPOSER_ROLE() view returns (bytes32)", "function EXECUTOR_ROLE() view returns (bytes32)", "function CANCELLER_ROLE() view returns (bytes32)", "function DEFAULT_ADMIN_ROLE() view returns (bytes32)"]);

  console.log("== Guardian (the single wallet with setup powers)");
  const guardians = {};
  for (const [n, x] of [["Hunt", hunt], ["Vaults", vaults], ["Points", points]]) {
    guardians[n] = await read(x.guardian);
    console.log(`  ${n.padEnd(7)} guardian = ${guardians[n]}   dao = ${await read(x.dao)}`);
  }
  const g = Object.values(guardians).find((v) => ethers.isAddress(v) && v !== ethers.ZeroAddress);
  if (g) {
    console.log(`  guardian is ${g.toLowerCase() === A.deployer.toLowerCase() ? "the token deployer" : "NOT the token deployer"}; ` +
      `${(await p.getCode(g)) === "0x" ? "a plain wallet (one key)" : "a contract (maybe a multisig)"}; nonce ${await p.getTransactionCount(g)}, ${ethers.formatEther(await p.getBalance(g))} ETH`);
    console.log(`  guardian votes = ${await read(points.getVotes, g)} PTS`);
  } else console.log("  guardian renounced on every contract");

  console.log("\n== DAO");
  for (const k of ["votingDelay", "votingPeriod", "proposalThreshold", "quorumNumerator", "proposalCount", "timelock", "token"]) {
    const v = await read(gov[k]);
    console.log(`  ${k.padEnd(18)} ${["votingDelay", "votingPeriod"].includes(k) && /^\d+$/.test(v) ? fmtTime(v) : v}`);
  }
  const supply = await read(points.totalSupply);
  console.log(`  points supply      ${supply} PTS, holders ${await read(points.holderCount)}, minters sealed ${await read(points.mintersSealed)}`);
  for (const [n, x] of [["Hunt", A.hunt], ["Vaults", A.vaults], ["guardian", g], ["deployer", A.deployer]]) {
    if (x) console.log(`  isMinter(${n}) = ${await read(points.isMinter, x)}`);
  }

  console.log("\n== Timelock");
  console.log(`  min delay ${fmtTime(await read(tl.getMinDelay))}`);
  const R = {};
  for (const k of ["PROPOSER_ROLE", "EXECUTOR_ROLE", "CANCELLER_ROLE", "DEFAULT_ADMIN_ROLE"]) R[k] = await read(tl[k]);
  const who = { governor: A.governor, guardian: g, deployer: A.deployer, "anyone (0x0)": ethers.ZeroAddress, "timelock itself": A.timelock };
  for (const [rn, role] of Object.entries(R)) {
    const holders = [];
    for (const [wn, wa] of Object.entries(who)) if (wa && (await read(tl.hasRole, role, wa)) === true) holders.push(wn);
    console.log(`  ${rn.padEnd(18)} ${holders.join(", ") || "none of: governor, guardian, deployer, anyone"}`);
  }

  console.log("\n== Vaults");
  console.log(`  hunt = ${await read(vaults.hunt)}  pointsPerUsd = ${await read(vaults.pointsPerUsd)}  minAttestations = ${await read(vaults.minAttestations)}  patrons = ${await read(vaults.patronCount)}`);
  const att = await read(vaults.attestors);
  console.log(`  attestors: ${Array.isArray(att) ? att[0].map((a, i) => `${a}${att[1][i] ? "" : " (off)"}`).join(", ") || "none" : att}`);
  const yv = await read(vaults.yieldVaults);
  console.log(`  yield vaults: ${Array.isArray(yv) ? yv[0].map((a, i) => `${a}${yv[1][i] ? "" : " (off)"}`).join(", ") || "none" : yv}`);
  console.log(`  contract balance: ${ethers.formatEther(await p.getBalance(A.vaults))} ETH`);
  const n = Number(await read(vaults.vaultCount)) || 0;
  for (let id = 1; id <= n; id++) {
    const r = await read(vaults.vaultAssets, id);
    if (!Array.isArray(r)) continue;
    const parts = [];
    for (let i = 0; i < r[0].length; i++) {
      if (r[1][i] === 0n) continue;
      let sym = "ETH";
      let dec = 18;
      if (r[0][i] !== ethers.ZeroAddress) {
        const t = c(r[0][i], ["function symbol() view returns (string)", "function decimals() view returns (uint8)"]);
        sym = await read(t.symbol);
        dec = Number(await read(t.decimals)) || 18;
      }
      parts.push(`${ethers.formatUnits(r[1][i], dec)} ${sym}`);
    }
    console.log(`  vault ${id}: ${parts.join(" + ") || "empty"}`);
  }

  console.log("\n== Hunt");
  const ks = await read(hunt.targetKs);
  console.log(`  season ${await read(hunt.season)}, paused ${await read(hunt.paused)}, shares ${await read(hunt.totalShares)}, solved ${await read(hunt.solvedCount)}`);
  if (Array.isArray(ks)) for (const k of ks) console.log(`  k = ${k}: prize vault ${await read(vaults.huntVaultOf, k)}`);
  console.log("\ndone");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
