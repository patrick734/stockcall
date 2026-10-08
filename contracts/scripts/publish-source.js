// Publishes the source code of every StockCall contract on Robinhood Chain's Blockscout, so the explorer shows each
// contract under its StockCall name (StockCallArena, StockCallFount, ...) with readable code anyone can check.
// Sends no transactions and needs no key. Safe to run again: contracts already published are skipped.
//   npx hardhat run scripts/publish-source.js --network robinhood
// Uses Blockscout's own API (POST /api/v2/smart-contracts/<address>/verification/via/standard-input) with the exact
// compiler input Hardhat built the contracts from, so the explorer recompiles and matches the deployed bytecode.
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

const config = require("../config/robinhood.json");
const EXPLORER = (process.env.EXPLORER_URL || config.network.explorer).replace(/\/$/, "");

async function isPublished(address) {
  try {
    const res = await fetch(`${EXPLORER}/api/v2/smart-contracts/${address}`, { headers: { accept: "application/json" } });
    if (!res.ok) return false;
    const body = await res.json();
    return Boolean(body.is_verified || body.is_fully_verified || body.is_partially_verified);
  } catch {
    return false;
  }
}

async function publish(s) {
  const [file, name] = s.contract.split(":");
  const buildInfo = await hre.artifacts.getBuildInfo(s.contract);
  if (!buildInfo) throw new Error(`no build info for ${s.contract}: run npx hardhat compile`);
  const factory = await hre.ethers.getContractFactory(s.contract);
  const ctorArgs = factory.interface.encodeDeploy(s.args).slice(2);

  const form = new FormData();
  form.append("compiler_version", `v${buildInfo.solcLongVersion}`);
  form.append("license_type", "mit");
  form.append("contract_name", name);
  form.append("autodetect_constructor_args", "false");
  form.append("constructor_args", ctorArgs);
  form.append("files[0]", new Blob([JSON.stringify(buildInfo.input)], { type: "application/json" }), `${name}.json`);

  const res = await fetch(`${EXPLORER}/api/v2/smart-contracts/${s.address}/verification/via/standard-input`, {
    method: "POST",
    headers: { accept: "application/json" },
    body: form,
  });
  const text = await res.text();
  if (!res.ok) throw new Error(`explorer answered ${res.status}: ${text.replace(/\s+/g, " ").slice(0, 200)}`);
  void file;
}

async function main() {
  const fileName = process.env.DEPLOYMENT || path.join(__dirname, "..", "deployments", `${hre.network.name}.json`);
  const d = JSON.parse(fs.readFileSync(fileName, "utf8"));
  if (!Array.isArray(d.sources) || !d.sources.length) throw new Error(`${path.basename(fileName)} lists no contract sources. Was it written by this version of deploy.js?`);
  console.log(`Publishing source on ${EXPLORER}`);

  const queued = [];
  for (const s of d.sources) {
    const name = s.contract.split(":")[1];
    process.stdout.write(`  ${name.padEnd(22)} ${s.address} ... `);
    if (await isPublished(s.address)) {
      console.log("already published");
      continue;
    }
    try {
      await publish(s);
      console.log("sent");
      queued.push(s);
    } catch (e) {
      console.log(`FAILED: ${String(e.message || e).split("\n")[0]}`);
    }
  }

  // Blockscout verifies in the background; give it a moment, then report what is live.
  let missing = 0;
  if (queued.length) {
    console.log("\nWaiting for the explorer to finish verifying…");
    await new Promise((r) => setTimeout(r, 45_000));
  }
  for (const s of d.sources) if (!(await isPublished(s.address))) missing++;
  console.log(
    missing
      ? `\n${missing} of ${d.sources.length} not published yet. Run ./publish-source.sh again in a few minutes; if FAILED lines repeat, paste them.`
      : `\nAll ${d.sources.length} StockCall contracts are published: ${EXPLORER}/address/${d.arena}`
  );
  if (missing) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
