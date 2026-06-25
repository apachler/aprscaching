#!/usr/bin/env bash
# Assemble the multi-viewport UI tour frames into an ordered, captioned teaser video.
# Each frame is letterboxed onto a uniform 1920x1080 canvas, captioned with its journey label
# (from the per-viewport manifests), held ~2.4s, and faded into the next step.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="$HERE/tour"
TMP="$OUT/_seg"
FFMPEG="${FFMPEG:-$(for f in /opt/pw-browsers/ffmpeg-*/ffmpeg-linux; do [ -x "$f" ] && echo "$f" && break; done)}"
FONT="/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"
FONTB="/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf"
[ -x "$FFMPEG" ] || { echo "no ffmpeg"; exit 1; }
[ -f "$FONTB" ] || FONTB="$FONT"
HOLD="${HOLD:-2.4}"; FADE="${FADE:-0.35}"; W=1920; H=1080

mkdir -p "$TMP"; rm -f "$TMP"/*.mp4 "$TMP"/list.txt 2>/dev/null || true

# Merge the three per-viewport manifests into one label map (file -> "Label · Viewport").
node -e '
const fs=require("fs"),p="'"$OUT"'";
const m={};
for(const v of ["desktop","tablet","mobile"]){
  const f=p+"/manifest-"+v+".json"; if(!fs.existsSync(f))continue;
  for(const e of JSON.parse(fs.readFileSync(f,"utf8"))) m[e.file]=e.label+" · "+e.viewport;
}
fs.writeFileSync(p+"/_labels.json",JSON.stringify(m));
console.error("labels:",Object.keys(m).length);
'

esc() { printf '%s' "$1" | sed -e "s/\\\\/\\\\\\\\/g" -e "s/:/\\\\:/g" -e "s/'/\\\\\\\\'/g" -e "s/%/\\\\%/g"; }

i=0
for f in $(ls "$OUT"/[123]-*.png | sort); do
  base="$(basename "$f")"
  label="$(node -e 'const m=require("'"$OUT"'/_labels.json");process.stdout.write(m["'"$base"'"]||"")')"
  [ -z "$label" ] && label="$base"
  seg="$TMP/$(printf '%03d' "$i").mp4"
  cap="$(esc "$label")"
  # scale-to-fit within a margin, pad onto a dark canvas, caption bar bottom-left, fade in/out.
  "$FFMPEG" -y -loglevel error -loop 1 -t "$HOLD" -i "$f" -filter_complex \
    "[0:v]scale=${W}-120:${H}-200:force_original_aspect_ratio=decrease,\
pad=${W}:${H}:(ow-iw)/2:(oh-ih)/2:color=0x12161cff,\
drawtext=fontfile=${FONTB}:text='${cap}':fontcolor=white:fontsize=38:x=70:y=h-92:\
box=1:boxcolor=0x0b76b8cc:boxborderw=18,\
drawtext=fontfile=${FONT}:text='aprscaching':fontcolor=0x6fd0ef:fontsize=26:x=w-220:y=58,\
fade=t=in:st=0:d=${FADE},fade=t=out:st=$(echo "$HOLD-$FADE"|bc):d=${FADE},format=yuv420p,setsar=1[v]" \
    -map "[v]" -r 30 -c:v libx264 -pix_fmt yuv420p "$seg"
  echo "file '$seg'" >> "$TMP/list.txt"
  i=$((i+1))
done

echo "==> concatenating $i clips"
"$FFMPEG" -y -loglevel error -f concat -safe 0 -i "$TMP/list.txt" -c copy "$OUT/aprscaching-ui-teaser.mp4"
"$FFMPEG" -y -loglevel error -i "$OUT/aprscaching-ui-teaser.mp4" -vf "fps=12,scale=900:-1:flags=lanczos" "$OUT/aprscaching-ui-teaser.gif" 2>/dev/null || true
echo "==> done: $OUT/aprscaching-ui-teaser.mp4 ($i steps)"
ls -la "$OUT/aprscaching-ui-teaser.mp4"