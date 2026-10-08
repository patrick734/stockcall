#!/usr/bin/env bash
# Publishing StockCall's source on the explorer, so every contract shows its StockCall name.
# The explorer's API sits behind a Cloudflare bot check that blocks scripts, so this tries the API once and, if it
# is blocked, writes the files for publishing by hand on the explorer website (verify-files/STEPS.txt).
set -euo pipefail
cd "$(dirname "$0")/contracts"
[[ -f deployments/robinhood.json ]] || { echo "STOPPED: no contracts/deployments/robinhood.json yet. Deploy first with ./launch.sh." >&2; exit 1; }
if npx hardhat run scripts/publish-source.js --network robinhood; then exit 0; fi
echo
echo "The explorer blocked the script. Preparing the files to publish by hand in your browser:"
npx hardhat run scripts/verify-files.js --network robinhood
echo "Open verify-files/STEPS.txt and follow it."
[[ "$(uname)" == "Darwin" ]] && open ../verify-files/STEPS.txt || true
