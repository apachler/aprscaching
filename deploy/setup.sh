#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
echo "=== aprscaching setup wizard ==="
read -rp "Your callsign (e.g. OE8APR): " CALL
read -rp "APRS-IS passcode: " PASS
read -rp "APRS-IS filter (e.g. r/47.07/15.42/300): " FILTER
read -rp "Public domain (blank = local/off-grid :80): " DOMAIN
SECRET="$(head -c 32 /dev/urandom | base64 | tr -d '/+=')"
OPSECRET="$(head -c 32 /dev/urandom | base64 | tr -d '/+=')"
SESSECRET="$(head -c 32 /dev/urandom | base64 | tr -d '/+=')"
cp -n .env.example .env
sed -i "s|^APRSIS_CALLSIGN=.*|APRSIS_CALLSIGN=${CALL}|"   .env
sed -i "s|^APRSIS_PASSCODE=.*|APRSIS_PASSCODE=${PASS}|"   .env
sed -i "s|^APRSIS_FILTER=.*|APRSIS_FILTER=${FILTER}|"     .env
# only fill secrets that are still empty — re-running setup must not rotate them (that signs users out)
sed -i "s|^INGEST_SECRET=$|INGEST_SECRET=${SECRET}|"          .env
sed -i "s|^OPERATOR_SECRET=$|OPERATOR_SECRET=${OPSECRET}|"    .env
sed -i "s|^SESSION_SECRET=$|SESSION_SECRET=${SESSECRET}|"     .env
sed -i "s|^DOMAIN=.*|DOMAIN=${DOMAIN:-:80}|"              .env
echo "Wrote .env."
echo "Validating APRS-IS reachability..."
( exec 3<>/dev/tcp/rotate.aprs2.net/14580 && echo "  APRS-IS reachable." && exec 3>&- ) || echo "  WARN: could not reach APRS-IS."
echo "Start:  docker compose up -d --build"
echo "Health: curl -fsS http://localhost:8080/health"
echo "Operator: OPERATOR_SECRET in .env drives tools/admin/verify-call.mjs — keep it off the ingest box."
