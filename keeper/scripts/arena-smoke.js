// End-to-end smoke test of the keeper's Arena duties against a local Hardhat node running the mock demo deploy:
// sealed reveals from an inbox file, the start-window snapshot, settling, flushing and the $CALL buy-and-burn.
//
//   cd contracts
//   npx hardhat node --port 8547                                  # terminal 1
//   npx hardhat run scripts/deploy.js --network keeper            # writes deployments/keeper.json
//   cd ../keeper && npm run arena-smoke                           # this script
//
// Refuses to run on anything but a Hardhat chain (31337): it moves time.
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { ethers } = require("ethers");

const RPC_URL = process.env.RPC_URL || "http://127.0.0.1:8547";
const NETWORK = process.env.KEEPER_NETWORK || "keeper";
// Hardhat's well-known dev account #3, which deploy.js makes the keeper on local chains. Not a secret.
const HARDHAT_KEEPER_KEY = "0x7c852118294e51e653712a81e05800f419141751be58f605c371e15141b007a6";
const P = 3600;
const W = 300;

process.env.KEEPER_NETWORK = NETWORK;
const { loadDeployment } = require("../src/config");
const abis = require("../src/abis");
const { seal, publicKeyOf } = require("../src/sealed");

let failures = 0;
function check(cond, msg) {
  console.log(`${cond ? "  PASS" : "  FAIL"} ${msg}`);
  if (!cond) failures++;
}

function runKeeper(label, env) {
  console.log(`\n===== keeper --once (${label}) =====`);
  const r = spawnSync(process.execPath, [path.join(__dirname, "..", "src", "index.js"), "--once"], {
    env: { ...process.env, RPC_URL, KEEPER_NETWORK: NETWORK, LOG_LEVEL: "info", ...env },
    encoding: "utf8",
  });
  const out = (r.stdout || "") + (r.stderr || "");
  console.log(out.split("\n").filter((l) => /\[(reveal|snapshot|settle|flush|buy-burn)\]/.test(l)).join("\n"));
  return out;
}

async function warpTo(provider, t) {
  await provider.send("evm_setNextBlockTimestamp", [t]);
  await provider.send("evm_mine", []);
}

/** Even probabilities for a card, nudged so two players differ. */
function probsFor(questions, tilt) {
  let packed = 0n;
  let bit = 0n;
  for (const q of questions) {
    const k = Number(q.options);
    const p = Array(k).fill(Math.floor(10_000 / k));
    p[0] += 10_000 - p.reduce((a, b) => a + b, 0);
    if (tilt) {
      p[0] += 1500;
      p[k - 1] -= 1500;
    }
    for (const x of p) {
      packed |= BigInt(x) << (16n * bit);
      bit++;
    }
  }
  return packed;
}

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL, undefined, { staticNetwork: true });
  if (Number((await provider.getNetwork()).chainId) !== 31337) throw new Error("arena smoke test only runs on a Hardhat node (chainId 31337)");
  const dep = loadDeployment(NETWORK);
  const accounts = await provider.send("eth_accounts", []);
  const arena = new ethers.Contract(dep.arena, abis.Arena, provider);
  const buyBurn = new ethers.Contract(dep.buyBurn, abis.BuyBurn, provider);
  const keeperPub = publicKeyOf(HARDHAT_KEEPER_KEY);

  // Into the commit window of the next round that opens.
  const now = (await provider.getBlock("latest")).timestamp;
  const n = Math.floor((now + W) / P) + 2;
  await warpTo(provider, n * P - W - P + 30);
  const schemaId = await arena.schemaFor(n);
  const questions = await arena.schema(schemaId);
  console.log(`Round ${n}, card ${schemaId} (${questions.length} questions)`);

  const inbox = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "stockcall-inbox-")), "inbox.json");
  const players = [accounts[5], accounts[6], accounts[7]];
  const sealedList = [];
  const stake = ethers.parseEther("0.01");
  for (const [i, who] of players.entries()) {
    const signer = await provider.getSigner(who);
    const probs = probsFor(questions, i === 1);
    const salt = ethers.hexlify(ethers.randomBytes(32));
    const c = await arena.commitmentFor(n, who, probs, salt);
    await (await arena.connect(signer).commit(n, schemaId, stake, c, { value: stake })).wait();
    // The third player never hands over a reveal: that stake is forfeited to the burn.
    if (i < 2) sealedList.push(seal(keeperPub, { n, player: who, probs, salt }));
  }
  sealedList.push("0x01deadbeef"); // junk in the inbox is ignored
  fs.writeFileSync(inbox, JSON.stringify({ [n]: sealedList }));
  const env = { KEEPER_PRIVATE_KEY: HARDHAT_KEEPER_KEY, REVEAL_INBOX_FILE: inbox };

  console.log("\nBefore the lock");
  let out = runKeeper("commit window, live", { ...env, DRY_RUN: "0" });
  check(!/revealing/.test(out), "nothing is revealed before the lock");

  await warpTo(provider, n * P - W + 20);
  console.log("\nReveal window");
  out = runKeeper("reveal window, dry run", { ...env, DRY_RUN: "1" });
  check(/reveal 2: DRY_RUN, would send/.test(out), "dry run would reveal both sealed entries in one batch");
  check(Number((await arena.rounds(n))[6]) === 0, "dry run revealed nothing");
  out = runKeeper("reveal window, live", { ...env, DRY_RUN: "0" });
  check(Number((await arena.rounds(n))[6]) === 2, "both sealed entries revealed");
  check((await arena.rounds(n))[4] === true, "Chainlink snapshot taken during the start window");
  check(/did not open or match/.test(out), "junk in the inbox reported, not sent");
  check(!out.includes(HARDHAT_KEEPER_KEY.slice(2)), "private key never printed");
  out = runKeeper("reveal window again", { ...env, DRY_RUN: "0" });
  check(/nothing new to reveal/.test(out), "a second pass reveals nothing twice");

  await warpTo(provider, n * P + P + 15);
  console.log("\nAfter the hour");
  const burnedBefore = await buyBurn.totalBurned();
  out = runKeeper("settle, flush, burn", { ...env, DRY_RUN: "0" });
  const r = await arena.rounds(n);
  check(Number(r[3]) === 1, "round settled (not void: the pools agree with Chainlink)");
  check((await arena.feesAccrued()) === 0n, "fees and the forfeited stake flushed to BuyBurn");
  check((await buyBurn.totalBurned()) > burnedBefore, `$CALL bought and burned (${ethers.formatEther((await buyBurn.totalBurned()) - burnedBefore)})`);
  const [received] = await arena.previewPayout(n, players[0]);
  check(received > 0n, "a revealed player has a payout to claim");

  out = runKeeper("next cycle", { ...env, DRY_RUN: "0" });
  check(/nothing to settle/.test(out), "nothing left to settle");
  check(!/\[(reveal|snapshot|settle|flush)\].*(WARN|ERROR)|(WARN|ERROR).*\[(reveal|snapshot|settle|flush)\]/.test(out), "routine re-run logs no Arena warnings");

  console.log(failures ? `\n${failures} check(s) FAILED` : "\nAll Arena smoke checks passed");
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
