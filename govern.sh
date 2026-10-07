#!/usr/bin/env bash
# Timelock actions (read-only unless --schedule/--execute is given).
#   ./govern.sh status                         what is scheduled, ready or executed
#   ./govern.sh register-pool                  after $CALL graduates on Pons: start buy-and-burn
#   ./govern.sh register-pool --schedule       plain-wallet admin: schedule it now (signs with ADMIN_ACCOUNT)
#   ./govern.sh register-pool --execute        plain-wallet admin: execute it after 48 hours
set -euo pipefail
cd "$(dirname "$0")"
[[ -d contracts/node_modules ]] || (cd contracts && npm ci --no-audit --no-fund)
eval "$(node tools/env.js)"
CMD="${1:-status}"
MODE="${2:-}"
cd contracts
if [[ "$MODE" == "--schedule" || "$MODE" == "--execute" ]]; then
  [[ -n "${ADMIN_ACCOUNT:-}" ]] || { echo "STOPPED: set ADMIN_ACCOUNT in launch.env to the admin wallet's name (node tools/import-key.js <name>)" >&2; exit 1; }
  GOVERN_SEND="${MODE#--}" KEY_ENV=ADMIN_PRIVATE_KEY node ../tools/with-key.js "$ADMIN_ACCOUNT" -- node scripts/govern.js "$CMD"
else
  node scripts/govern.js "$CMD"
fi
