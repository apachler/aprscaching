#!/usr/bin/env sh
# Gateway first (the ingest posts to it), then the ingest in the foreground.
set -eu
: "${PORT:=8787}"
: "${DB_PATH:=/data/acs.db}"
mkdir -p /data
DB_PATH="$DB_PATH" PORT="$PORT" pnpm --filter @aprscaching/node-gateway start &
i=0
# node is the one tool guaranteed in this image — slim ships neither wget nor curl
until node -e "fetch('http://127.0.0.1:$PORT/health').then((r)=>process.exit(r.ok?0:1),()=>process.exit(1))"; do
  i=$((i + 1))
  [ "$i" -gt 60 ] && echo "gateway did not start" && exit 1
  sleep 1
done
# The ingest runs the packet BBS and FBB forwarding, which take only a box enrolled with its own key that the
# sysop lets run the instance's services: enroll it first.
box="$(/enroll-bbs-box.sh "http://127.0.0.1:$PORT" acs-bbs)"
BOX_ID="$(printf '%s\n' "$box" | sed -n 's/^BOX_ID=//p')"
BOX_KEY="$(printf '%s\n' "$box" | sed -n 's/^BOX_KEY=//p')"
export BOX_ID BOX_KEY
INGEST_URL="http://127.0.0.1:$PORT/ingest" exec pnpm --filter @aprscaching/ingest start
