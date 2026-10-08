// Publishes the source code of every StockCall contract on Robinhood Chain's Blockscout, so the explorer shows each
// contract under its StockCall name (StockCallArena, StockCallFount, ...) with readable code anyone can check.
// Read-only for the chain: it sends no transactions and needs no key.
//   npx hardhat run scripts/publish-source.js --network robinhood
// Safe to run again: contracts already published are skipped.
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

async function main() {
  const file = process.env.DEPLOYMENT || path.join(__dirname, "..", "deployments", `${hre.network.name}.json`);
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(d.sources) || !d.sources.length) throw new Error(`${path.basename(file)} lists no contract sources. Was it written by this version of deploy.js?`);
  let failed = 0;
  for (const s of d.sources) {
    const name = s.contract.split(":")[1];
    process.stdout.write(`  ${name.padEnd(22)} ${s.address} ... `);
    try {
      await hre.run("verify:verify", { address: s.address, constructorArguments: s.args, contract: s.contract });
      console.log("published");
    } catch (e) {
      const msg = String(e.message || e);
      if (/already verified|already been verified/i.test(msg)) console.log("already published");
      else {
        failed++;
        console.log(`FAILED: ${msg.split("\n")[0].slice(0, 200)}`);
      }
    }
  }
  console.log(failed ? `\n${failed} contract(s) not published. Run this again in a minute (the explorer may still be indexing).` : "\nEvery StockCall contract is published on the explorer.");
  if (failed) process.exitCode = 1;
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
