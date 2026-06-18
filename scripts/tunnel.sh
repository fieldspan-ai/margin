#!/usr/bin/env bash
# Expose the local Margin server on a public https URL so you can review from
# your phone. Uses cloudflared if present, otherwise ngrok.
#
#   npm run tunnel
#
# Then copy the printed https URL into .env as PUBLIC_BASE_URL=<url> and restart
# the server (npm start) so the reviewer links it hands out are reachable.
set -euo pipefail
PORT="${PORT:-8787}"

echo "Opening a public tunnel to http://localhost:${PORT} ..."
echo "→ Copy the https URL below into .env as PUBLIC_BASE_URL=<url>, then restart: npm start"
echo

if command -v cloudflared >/dev/null 2>&1; then
  exec cloudflared tunnel --url "http://localhost:${PORT}"
elif command -v ngrok >/dev/null 2>&1; then
  exec ngrok http "${PORT}"
else
  echo "No tunnel tool found. Install one of:" >&2
  echo "  brew install cloudflared      # https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/" >&2
  echo "  brew install ngrok            # https://ngrok.com/download" >&2
  exit 1
fi
