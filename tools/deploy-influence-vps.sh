#!/usr/bin/env bash
# Puts the influence.family key bot on a VPS (Ubuntu/Debian, AWS included) as a service that starts on boot and
# restarts on failure.
#   tools/deploy-influence-vps.sh ubuntu@VPS_IP [wallet-name]
# For an AWS .pem key, load it first:  ssh-add ~/Downloads/your-key.pem
#
# Run it from your Mac in the repo folder. It copies the bot, your ENCRYPTED wallet file (the private key is never
# typed or sent in the clear), influencers.txt (only if the VPS has none yet) and asks for the wallet password once,
# which is stored on the VPS readable by your user only. Run it again to update the bot; the watchlist and options
# on the VPS are kept.
#
# The first install is a DRY RUN: it logs "would buy" and spends nothing. Go live once it has shown it gets there
# first, by adding --live to ~/influence-bot/bot.args on the VPS and running: sudo systemctl restart influence-bot
#
# On the VPS afterwards:
#   journalctl -u influence-bot -f                         live log
#   nano ~/influence-bot/influencers.txt                   add handles; picked up within 2 s, no restart
#   nano ~/influence-bot/bot.args                          change options, then: sudo systemctl restart influence-bot
#   sudo systemctl stop influence-bot                      stop it
set -euo pipefail

HOST="${1:-}"
WALLET="${2:-bot-wallet}"
if [ -z "$HOST" ]; then
  echo "usage: tools/deploy-influence-vps.sh ubuntu@VPS_IP [wallet-name]"
  exit 1
fi
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
KEYSTORE="$HOME/.stockcall/keystores/$WALLET.json"
if [ ! -f "$KEYSTORE" ]; then
  echo "No saved wallet \"$WALLET\". Run first: node tools/import-key.js $WALLET"
  exit 1
fi

echo "Checking $HOST"
REMOTE_USER="$(ssh "$HOST" whoami)"
REMOTE_HOME="$(ssh "$HOST" 'echo $HOME')"
if [ "$REMOTE_USER" != root ] && ! ssh "$HOST" 'sudo -n true' 2>/dev/null; then
  echo "$REMOTE_USER cannot use sudo without a password on the VPS. Log in as a user that can (ubuntu on AWS)."
  exit 1
fi
SUDO=""
[ "$REMOTE_USER" = root ] || SUDO="sudo"

echo "Copying the bot and the encrypted wallet"
ssh "$HOST" 'mkdir -p ~/influence-bot/tools ~/.stockcall/keystores && chmod 700 ~/.stockcall ~/.stockcall/keystores'
scp -q "$ROOT/tools/lib.js" "$ROOT/tools/influence-bot.js" "$ROOT/tools/import-key.js" "$HOST:influence-bot/tools/"
scp -q "$KEYSTORE" "$HOST:.stockcall/keystores/$WALLET.json"
ssh "$HOST" "chmod 600 ~/.stockcall/keystores/$WALLET.json"
if ! ssh "$HOST" 'test -f ~/influence-bot/influencers.txt'; then
  if [ -f "$ROOT/influencers.txt" ]; then
    scp -q "$ROOT/influencers.txt" "$HOST:influence-bot/influencers.txt"
  else
    ssh "$HOST" 'printf "# one @handle per line\n" > ~/influence-bot/influencers.txt'
  fi
fi
if ! ssh "$HOST" 'test -f ~/influence-bot/bot.args'; then
  ssh "$HOST" "printf '%s\n' '--watch-file $REMOTE_HOME/influence-bot/influencers.txt --watch-ms 300 --new --require points=0 --keys 2 --budget 0.02' > ~/influence-bot/bot.args"
fi

if ! ssh "$HOST" 'test -f ~/.stockcall/bot.env'; then
  read -r -s -p "Password of wallet \"$WALLET\" (stored on the VPS, your user only): " PW
  echo
  printf 'KEYSTORE_PASSWORD=%s\n' "$PW" | ssh "$HOST" 'umask 077; cat > ~/.stockcall/bot.env'
  unset PW
fi

echo "Installing Node.js and ethers on the VPS (first time takes a minute)"
ssh "$HOST" SUDO="$SUDO" bash -s <<'REMOTE'
set -e
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 18 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | ${SUDO:+$SUDO -E} bash - >/dev/null
  $SUDO apt-get install -y nodejs >/dev/null
fi
cd ~/influence-bot
[ -d node_modules/ethers ] || npm i --silent ethers@6 >/dev/null
REMOTE

echo "Checking the wallet password"
ssh "$HOST" "cd ~/influence-bot && set -a && . ~/.stockcall/bot.env && set +a && node -e '
const fs=require(\"fs\"),{ethers}=require(\"ethers\");
ethers.Wallet.fromEncryptedJson(fs.readFileSync(process.env.HOME+\"/.stockcall/keystores/$WALLET.json\",\"utf8\"),process.env.KEYSTORE_PASSWORD)
.then(w=>console.log(\"  wallet \"+w.address+\" unlocked\")).catch(()=>{console.log(\"  WRONG PASSWORD: delete ~/.stockcall/bot.env on the VPS and run this again\");process.exit(1)})'"

echo "Installing the service"
ssh "$HOST" SUDO="$SUDO" WALLET="$WALLET" RUSER="$REMOTE_USER" RHOME="$REMOTE_HOME" bash -s <<'REMOTE'
set -e
$SUDO tee /etc/systemd/system/influence-bot.service >/dev/null <<EOF
[Unit]
Description=influence.family key bot
After=network-online.target
Wants=network-online.target

[Service]
User=$RUSER
WorkingDirectory=$RHOME/influence-bot
EnvironmentFile=$RHOME/.stockcall/bot.env
ExecStart=/bin/sh -c 'exec /usr/bin/node tools/influence-bot.js $WALLET \$\$(cat $RHOME/influence-bot/bot.args)'
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
$SUDO systemctl daemon-reload
$SUDO systemctl enable influence-bot >/dev/null 2>&1
$SUDO systemctl restart influence-bot
REMOTE

echo
echo "Speed from the VPS:"
ssh "$HOST" 'cd ~/influence-bot && node tools/influence-bot.js --latency'
echo
sleep 8
echo "Bot log so far:"
ssh "$HOST" "$SUDO journalctl -u influence-bot -n 25 --no-pager -o cat"
echo
echo "Running. Live log:  ssh $HOST journalctl -u influence-bot -f"
echo "Options:  ~/influence-bot/bot.args on the VPS ($(ssh "$HOST" 'grep -q -- --live ~/influence-bot/bot.args && echo LIVE || echo dry run, add --live to buy'))"
