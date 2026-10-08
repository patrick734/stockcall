#!/usr/bin/env bash
# Publishes StockCall's contract source on Robinhood Chain's explorer, so every contract shows its StockCall name.
# Run once after ./launch.sh. Sends nothing and needs no key; safe to run again.
set -euo pipefail
cd "$(dirname "$0")/contracts"
[[ -f deployments/robinhood.json ]] || { echo "STOPPED: no contracts/deployments/robinhood.json yet. Deploy first with ./launch.sh." >&2; exit 1; }
npx hardhat run scripts/publish-source.js --network robinhood
