#!/usr/bin/env bash
# Install and start Pocket inside the termux/termux-docker image, the way the phone does, from a checkout
# mounted at /src: install.sh (Termux packages, better-sqlite3 compiled with Termux's clang, the web
# build, the migrations), Direwolf's WebAssembly modem loading, start.sh, /health and the SPA, status.sh, tls.sh
# with https answering, stop.sh; and for the radio on the phone, the USB PTT helper's tests and a PulseAudio
# soundcard port with a termux-usb PTT as the ingest's checks see it.
# The weekly workflow .github/workflows/pocket-termux.yml runs it; on a PC with Docker:
#
#   docker run --rm -v "$PWD:/src:ro" termux/termux-docker:aarch64 bash /src/deploy/pocket/test/termux-ci.sh
#
# Rolldown, the web build's bundler, has native builds for Android on arm64 and 32-bit arm only, which is
# what phones run. On x86_64 the web app is built outside and handed in, the way install.sh's --web-dist
# takes a build copied from a PC: a mounted apps/web/dist as the second argument. (Arguments, not the
# environment: the image's entrypoint starts the command with a clean environment.)
#
#   termux-ci.sh [SRC] [WEB_DIST]
#
# The container has no Android: Termux:API, the wake lock, the phone's audio and the phone's networks are
# absent, so those lines of status.sh stay empty. It runs as Termux's unprivileged user, like the app.
set -euo pipefail

SRC="${1:-/src}"
WEB_DIST="${2:-}"
DIR="$HOME/aprscaching"
DATA="$HOME/.aprscaching"
PORT=8787
HTTPS_PORT=8443
fail() {
  printf 'FAIL  %s\n' "$*" >&2
  tail -n 40 "$DATA/logs/gateway.log" 2>/dev/null >&2 || true
  exit 1
}
ok() { printf 'ok    %s\n' "$*"; }

# The Termux app preloads termux-exec, which maps /bin/sh and /usr/bin/env in script shebangs (the pnpm
# bin shims, for one) to Termux's own; the image does not, so set it the way the app does.
if [ -z "${LD_PRELOAD:-}" ]; then
  for lib in libtermux-exec-ld-preload.so libtermux-exec.so; do
    if [ -f "$PREFIX/lib/$lib" ]; then
      export LD_PRELOAD="$PREFIX/lib/$lib"
      break
    fi
  done
fi

# The checkout as the phone has it: a git clone under Termux's home.
command -v git >/dev/null 2>&1 || { apt-get update -q && apt-get install -yq git; }
git config --global --add safe.directory "$SRC"
git config --global --add safe.directory "$SRC/.git"
rm -rf "$DIR"
git clone --quiet "$SRC" "$DIR"
ok "cloned $(git -C "$DIR" rev-parse --short HEAD)"

start=$(date +%s)
web=()
if [ -n "${WEB_DIST:-}" ]; then web=(--web-dist "$WEB_DIST"); fi
if ! bash "$DIR/deploy/pocket/install.sh" --call N0CALL --dir "$DIR" --data-dir "$DATA" --no-update --no-next-steps \
  "${web[@]}"; then
  for log in better-sqlite3-build web-build install-boot; do
    [ -f "$DATA/logs/$log.log" ] || continue
    printf -- '---- %s.log\n' "$log" >&2
    grep -v '^ *at ' "$DATA/logs/$log.log" | tail -n 40 >&2
  done
  fail "install.sh"
fi
ok "install.sh in $(($(date +%s) - start)) s on $(uname -m), node $(node --version)${WEB_DIST:+, web build from $WEB_DIST}"

# Direwolf's WebAssembly modem loads under Termux's Node: the ingest's own modem check (the one doctor runs) on a
# 9600-baud port, which only Direwolf serves. Termux has no ALSA, so the audio rows are not the point here.
modem="$(cd "$DIR/apps/ingest" && SOUNDCARD_DEVICE=plughw:0,0 SOUNDCARD_MODEM=9600 node --import tsx src/check.ts --soundcard 2>&1)" ||
  fail "check.ts --soundcard: $modem"
grep -q $'^modem\t1\tpass\t' <<<"$modem" || fail "the Direwolf modem does not load: $modem"
ok "$(grep $'^modem\t' <<<"$modem" | cut -f4)"

# The radio on the phone: the USB PTT helper's tests under Termux's Python (the usbfs structures at the phone's
# word size), and a PulseAudio soundcard port with a termux-usb PTT as the ingest's checks see it. Termux's
# pulseaudio package must bring parec and pacat; a null source and sink stand in for Android's OpenSL ES ones,
# which the container lacks.
(cd "$DIR/deploy/pocket/extras" && python3 -m unittest discover -s test -q) >/dev/null 2>&1 ||
  fail "the USB PTT helper's tests under Termux's Python: $(cd "$DIR/deploy/pocket/extras" && python3 -m unittest discover -s test 2>&1 | tail -n 20)"
ok "the USB PTT helper's tests pass under Termux's Python"
command -v pulseaudio >/dev/null 2>&1 || apt-get install -yq pulseaudio >/dev/null || fail "pkg install pulseaudio"
pulse_up=0
if pulseaudio -n --daemonize=yes --exit-idle-time=-1 --load=module-native-protocol-unix \
  --load=module-null-sink --load=module-null-source 2>/dev/null; then
  pulse_up=1
fi
pulse="$(cd "$DIR/apps/ingest" && SOUNDCARD_DEVICE=default SOUNDCARD_AUDIO=pulse SOUNDCARD_TX=1 \
  SOUNDCARD_PTT=termux-usb BOX_CALL=N0CALL-10 node --import tsx src/check.ts --soundcard 2>&1)" || true
grep -q $'^pulse\t-\tpass\t' <<<"$pulse" || fail "parec and pacat from Termux's pulseaudio package: $pulse"
ok "$(grep $'^pulse\t' <<<"$pulse" | cut -f4)"
grep -q $'^ptt\t1\tfail\t.*termux-usb' <<<"$pulse" || fail "the termux-usb PTT check: $pulse"
ok "the termux-usb PTT check names what the container lacks: $(grep $'^ptt\t' <<<"$pulse" | cut -f4)"
if [ "$pulse_up" -eq 1 ]; then
  grep -q $'^audio\t1\tpass\t' <<<"$pulse" || fail "parec and pacat on a running PulseAudio: $pulse"
  ok "$(grep $'^audio\t' <<<"$pulse" | cut -f4)"
  pulseaudio --kill 2>/dev/null || true
else
  printf 'note  PulseAudio did not start in the container; the capture and playback check was skipped\n'
fi

bash "$DIR/deploy/pocket/start.sh" --no-attach --gateway-only --dir "$DIR" --data-dir "$DATA"
curl -fsS --max-time 5 "http://127.0.0.1:$PORT/health" >/dev/null || fail "/health"
ok "the gateway answers /health"
# Read the page whole before matching: grep -q stops at the first match, and curl then fails its write.
page="$(curl -fsS --max-time 5 "http://127.0.0.1:$PORT/")" || fail "the web app at /"
grep -qi "<html" <<<"$page" || fail "the web app at / is not the web app"
ok "the gateway serves the web app"
out="$(bash "$DIR/deploy/pocket/status.sh" --data-dir "$DATA" 2>&1)" || true
grep -q "gateway  running" <<<"$out" || fail "status.sh: $out"
ok "status.sh shows the gateway running"

bash "$DIR/deploy/pocket/tls.sh" --port "$HTTPS_PORT" --dir "$DIR" --data-dir "$DATA"
for _ in $(seq 1 60); do
  curl -fsS -o /dev/null --max-time 2 --cacert "$DATA/tls/ca.crt" "https://127.0.0.1:$HTTPS_PORT/health" 2>/dev/null && break
  sleep 1
done
curl -fsS -o /dev/null --max-time 5 --cacert "$DATA/tls/ca.crt" "https://127.0.0.1:$HTTPS_PORT/health" ||
  fail "https with the station CA"
ok "tls.sh: https answers with the station CA"

bash "$DIR/deploy/pocket/stop.sh" --dir "$DIR" --data-dir "$DATA"
if curl -fsS -o /dev/null --max-time 2 "http://127.0.0.1:$PORT/health" 2>/dev/null; then fail "stop.sh left the gateway"; fi
ok "stop.sh stopped the station"
echo "all Termux checks passed"
