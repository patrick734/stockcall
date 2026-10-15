#!/usr/bin/env bash
# Puts the influence.family key bot on a VPS (Ubuntu/Debian) as a service that starts on boot and restarts on failure.
#   tools/deploy-influence-vps.sh root@VPS_IP [wallet-name]
# Run it from your Mac in the repo folder. It copies the bot, your ENCRYPTED wallet file (the private key is never
# typed or sent in the clear), influencers.txt (only if the VPS has none yet) and asks for the wallet password once,
# which is stored on the VPS readable by root only. Run it again to update the bot; the watchlist on the VPS is kept.
#
# On the VPS afterwards:
#   journalctl -u influence-bot -f                         live log
#   nano ~/influence-bot/influencers.txt                   add handles; picked up within 2 s, no restart
#   nano ~/influence-bot/bot.args                          change options, then: systemctl restart influence-bot
#   systemctl stop influence-bot                           stop it
set -euo pipefail

HOST="${1:-}"
WALLET="${2:-bot-wallet}"
if [ -z "$HOST" ]; then
  echo "usage: tools/deploy-influence-vps.sh root@VPS_IP [wallet-name]"
  exit 1
fi
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
KEYSTORE="$HOME/.stockcall/keystores/$WALLET.json"
if [ ! -f "$KEYSTORE" ]; then
  echo "No saved wallet \"$WALLET\". Run first: node tools/import-key.js $WALLET"
  exit 1
fi

echo "Checking $HOST"
ssh "$HOST" 'test "$(id -u)" = 0' || { echo "Log in as root (root@VPS_IP): the service needs it."; exit 1; }

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
  ssh "$HOST" 'printf "%s\n" "--watch-file /root/influence-bot/influencers.txt --watch-ms 300 --new --require points=0 --keys 2 --budget 0.05 --live" > ~/influence-bot/bot.args'
fi

if ! ssh "$HOST" 'test -f ~/.stockcall/bot.env'; then
  read -r -s -p "Password of wallet \"$WALLET\" (stored on the VPS, root only): " PW
  echo
  printf 'KEYSTORE_PASSWORD=%s\n' "$PW" | ssh "$HOST" 'umask 077; cat > ~/.stockcall/bot.env'
  unset PW
fi

echo "Installing Node.js and ethers on the VPS (first time takes a minute)"
ssh "$HOST" bash -s <<'REMOTE'
set -e
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 18 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null
  apt-get install -y nodejs >/dev/null
fi
cd ~/influence-bot
[ -d node_modules/ethers ] || npm i --silent ethers@6 >/dev/null
REMOTE

echo "Installing the service"
ssh "$HOST" WALLET="$WALLET" bash -s <<'REMOTE'
set -e
cat > /etc/systemd/system/influence-bot.service <<EOF
[Unit]
Description=influence.family key bot
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=/root/influence-bot
EnvironmentFile=/root/.stockcall/bot.env
ExecStart=/bin/sh -c 'exec /usr/bin/node tools/influence-bot.js $WALLET \$\$(cat /root/influence-bot/bot.args)'
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable influence-bot >/dev/null 2>&1
systemctl restart influence-bot
REMOTE

echo
echo "Speed from the VPS:"
ssh "$HOST" 'cd ~/influence-bot && node tools/influence-bot.js --latency'
echo
sleep 6
echo "Bot log so far:"
ssh "$HOST" 'journalctl -u influence-bot -n 25 --no-pager -o cat'
echo
echo "Running. Live log:  ssh $HOST journalctl -u influence-bot -f"
