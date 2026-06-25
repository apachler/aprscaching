#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
echo "=== aprscaching setup wizard ==="
read -rp "Your callsign (e.g. OE8APR): " CALL
read -rp "APRS-IS passcode: " PASS
read -rp "APRS-IS filter (e.g. r/47.07/15.42/300): " FILTER
read -rp "Public domain (blank = local/off-grid :80): " DOMAIN
SECRET="$(head -c 32 /dev/urandom | base64 | tr -d '/+=')"
cp -n .env.example .env
sed -i "s|^APRSIS_CALLSIGN=.*|APRSIS_CALLSIGN=${CALL}|"   .env
sed -i "s|^APRSIS_PASSCODE=.*|APRSIS_PASSCODE=${PASS}|"   .env
sed -i "s|^APRSIS_FILTER=.*|APRSIS_FILTER=${FILTER}|"     .env
sed -i "s|^INGEST_SECRET=.*|INGEST_SECRET=${SECRET}|"     .env
sed -i "s|^DOMAIN=.*|DOMAIN=${DOMAIN:-:80}|"              .env
echo "Wrote .env."
echo "Validating APRS-IS reachability..."
( exec 3<>/dev/tcp/rotate.aprs2.net/14580 && echo "  APRS-IS reachable." && exec 3>&- ) || echo "  WARN: could not reach APRS-IS."
echo "Start:  docker compose up -d --build"
echo "Health: curl -fsS http://localhost:8080/health"
