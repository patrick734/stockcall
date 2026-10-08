// Writes the files for publishing StockCall's source by hand on the explorer website (its API sits behind a
// Cloudflare bot check that blocks scripts, but the website works in a normal browser).
//   npx hardhat run scripts/verify-files.js --network robinhood
// Output in ../verify-files/: one compiler-input JSON for every contract, and STEPS.txt with each contract's address,
// name and constructor arguments to paste.
const fs = require("fs");
const path = require("path");
const hre = require("hardhat");

async function main() {
  const file = process.env.DEPLOYMENT || path.join(__dirname, "..", "deployments", `${hre.network.name}.json`);
  const d = JSON.parse(fs.readFileSync(file, "utf8"));
  if (!Array.isArray(d.sources) || !d.sources.length) throw new Error(`${path.basename(file)} lists no contract sources.`);
  const explorer = require("../config/robinhood.json").network.explorer;
  const out = path.join(__dirname, "..", "..", "verify-files");
  fs.mkdirSync(out, { recursive: true });

  const buildInfo = await hre.artifacts.getBuildInfo(d.sources[0].contract);
  fs.writeFileSync(path.join(out, "StockCall-standard-input.json"), JSON.stringify(buildInfo.input));
  const compiler = `v${buildInfo.solcLongVersion}`;

  const lines = [
    "Publish StockCall's source on the explorer, one contract at a time, in a normal browser.",
    "",
    "For each contract below:",
    "  1. Open its link and go to the Contract tab > Verify & publish.",
    "  2. Verification method: Solidity (Standard JSON input).",
    `  3. Compiler: ${compiler}. License: MIT.`,
    "  4. Contract name: as listed. Upload StockCall-standard-input.json from this folder.",
    "  5. Constructor arguments: paste the hex below (if asked; turn auto-detect off).",
    "  6. Verify. If a contract already shows as verified (the explorer can match identical code), skip it.",
    "",
  ];
  for (const s of d.sources) {
    if ((await hre.artifacts.getBuildInfo(s.contract)).id !== buildInfo.id) throw new Error(`${s.contract} was built separately; recompile and run again.`);
    const name = s.contract.split(":")[1];
    const factory = await hre.ethers.getContractFactory(s.contract);
    const args = factory.interface.encodeDeploy(s.args).slice(2);
    lines.push(`${name}`, `  ${explorer}/address/${s.address}?tab=contract`, `  constructor arguments: ${args}`, "");
  }
  fs.writeFileSync(path.join(out, "STEPS.txt"), lines.join("\n"));
  console.log(`Wrote ${path.relative(process.cwd(), out)}/StockCall-standard-input.json and STEPS.txt (${d.sources.length} contracts).`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
