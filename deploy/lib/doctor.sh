# doctor: a read-only health check of an installation, the same on every shape. Each check reports pass,
# warn or fail with a one-line fix and a docs link; --json prints them as one JSON document. It changes
# nothing: no setting, no file, no service.
#
# A shape module supplies its context in shape_doctor_context (the variables below) and may add its own
# checks in shape_doctor_extra. Sourced by deploy/aprscaching after common.sh, env.sh and config.sh.
# shellcheck shell=bash

DOC_ENV=""          # the .env the shape keeps its settings in (empty: none)
DOC_BASE=""         # the gateway as this host reaches it (http://127.0.0.1:8080), empty without a gateway
DOC_PUBLIC=""       # the public origin (APP_URL)
DOC_INGEST=""       # the ingest's /ingest URL as this host reaches it, empty without an ingest
DOC_DATA_DIR=""     # where the database lives, for the disk-space check
DOC_DB_FILE=""      # the SQLite file, for its size
DOC_BACKUP_DIR=""   # where backups land, for their age
DOC_BACKUP_GLOB="*" # the backup files in it
# More places backups land, each "DIR|GLOB …": a shape whose two backup tools write to different places lists
# them all, and the newest file across them counts.
DOC_BACKUP_PLACES=()
DOC_BACKUP_MISSING=fail # warn: a shape where no backup yet is a warning (Desktop: often a trial)
DOC_BACKUP_SETTINGS=0 # 1: the destination comes from BACKUP_DIR / OCI_BUCKET / BACKUP_BUCKET (deploy/backup.sh)
DOC_BACKUP_MAX_DAYS="${APRS_BACKUP_MAX_DAYS:-7}"
DOC_OPERATOR_SECRET="" # read from the shape's settings, or the environment; never printed
DOC_CURL_OPTS=()   # extra curl options for requests to DOC_BASE (Self-host pins its public name to this host)
DOC_HEALTH=""
DOC_ROWS=()

# Every warning and failure links its own entry on the troubleshooting page, which says what the check tests and
# links on to the page that explains the fix. The path is in the repository, readable in a checkout and on the
# docs site; tools/checks/docs.mjs fails when a check id has no entry there.
DOCS_URL="docs/run/troubleshooting.md"

# doc_see ID: the troubleshooting anchor of a check. A check named after a setting, a checklist item, a node or a
# peer shares one entry with its kind; every other id is its own entry (the heading's anchor drops the dots).
doc_see() {
  local a
  case "$1" in
    config.value.*) a=configvaluekey ;;
    setup.checklist | setup.update) a="${1//./}" ;;
    setup.*) a=setupitem ;;
    ingest.meshcom_fw.*) a=ingestmeshcom_fwcall ;;
    ingest.meshcom.*) a=ingestmeshcomcall ;;
    ingest.soundcard_audio.*) a=ingestsoundcard_audioport ;;
    ingest.soundcard_ptt.*) a=ingestsoundcard_pttport ;;
    ingest.soundcard_tx.*) a=ingestsoundcard_txport ;;
    federation.peer.*) a=federationpeerhost ;;
    identity.*) a=identityline ;;
    *) a="${1//./}" ;;
  esac
  printf '%s#%s' "$DOCS_URL" "$a"
}

# doc_add STATUS ID MESSAGE [FIX]: one result. MESSAGE and FIX never carry a secret value.
doc_add() {
  local see=""
  [ "$1" = pass ] || see="$(doc_see "$2")"
  DOC_ROWS+=("$1"$'\t'"$2"$'\t'"$3"$'\t'"${4:-}"$'\t'"$see")
}
pass() { doc_add pass "$@"; }
warnc() { doc_add warn "$@"; }
failc() { doc_add fail "$@"; }

# The value of KEY for this installation: its .env, else the environment.
doc_get() {
  local v=""
  [ -z "$DOC_ENV" ] || v="$(env_file_get "$DOC_ENV" "$1")"
  [ -n "$v" ] || v="${!1:-}"
  printf '%s' "$v"
}

doc_public() { case "$DOC_PUBLIC" in https://*) return 0 ;; *) return 1 ;; esac; }

# curl that sends a secret header without putting the secret on a command line (ps shows those).
curl_secret() { # curl_secret HEADER SECRET curl-args…
  local h="$1" s="$2"
  shift 2
  printf 'header = "%s: %s"\n' "$h" "$s" | gw_curl -K - "$@"
}

json_field() { # json_field JSON FIELD: a top-level string, number or boolean field, without jq
  printf '%s' "$1" | sed -n -E "s/.*\"$2\":[[:space:]]*(\"([^\"]*)\"|([-0-9.a-z]+)).*/\\2\\3/p" | head -n 1 || true
}

# curl to the gateway at DOC_BASE, with the shape's options.
gw_curl() { curl "${DOC_CURL_OPTS[@]+"${DOC_CURL_OPTS[@]}"}" "$@"; }

# The signed credential check of an enrolled box: the shape's own way to run apps/ingest/src/check.ts, else
# from this checkout with the settings loaded.
doc_signed_check() {
  if declare -F shape_doctor_signed_check >/dev/null; then
    shape_doctor_signed_check
  elif have node; then
    # shellcheck disable=SC1090 # the installation's own .env
    (set -a && . "$DOC_ENV" && set +a && cd "$DEPLOY_DIR/../apps/ingest" && node --import tsx src/check.ts) 2>/dev/null
  else
    echo "0 Node.js is needed here to check a signed credential"
  fi
}

tcp_open() { timeout 3 bash -c "exec 3<>/dev/tcp/$1/$2" 2>/dev/null; }

# apps/ingest/src/check.ts with ARGS, where the ingest runs: the shape's own way (inside its container), else
# from this checkout with the settings loaded. Prints nothing when neither is possible.
doc_ingest_node() {
  if declare -F shape_doctor_ingest_node >/dev/null; then
    shape_doctor_ingest_node "$@"
  elif have node && [ -n "$DOC_ENV" ]; then
    # shellcheck disable=SC1090 # the installation's own .env
    (set -a && . "$DOC_ENV" && set +a && cd "$DEPLOY_DIR/../apps/ingest" && node --import tsx src/check.ts "$@") 2>/dev/null
  fi
}

# ---- config -------------------------------------------------------------------------------------------------
doc_config() {
  local key v msg unknown=() bad=0 mode
  [ -n "$DOC_ENV" ] || return 0
  if [ ! -f "$DOC_ENV" ]; then
    failc config.file "$DOC_ENV is missing" "run deploy/aprscaching init $SHAPE"
    return 0
  fi
  mode="$(file_mode "$DOC_ENV")"
  if [ "${mode: -2}" = 00 ]; then
    pass config.permissions "$DOC_ENV is readable by its owner only"
  else
    failc config.permissions "$DOC_ENV is readable by others (mode $mode); it holds secrets" "chmod 600 $DOC_ENV"
  fi
  while IFS= read -r key; do
    cfg_known "$key" || { unknown+=("$key"); continue; }
    v="$(env_file_get "$DOC_ENV" "$key")"
    if ! msg="$(cfg_check "$key" "$v")"; then
      failc "config.value.$key" "$msg" "correct it in $DOC_ENV"
      bad=1
    fi
  done < <(env_file_keys "$DOC_ENV" | sort -u)
  [ "$bad" = 1 ] || pass config.values "every setting has a value of its type"
  if [ "${#unknown[@]}" -gt 0 ]; then
    warnc config.unknown "not settings (a typo?): ${unknown[*]}" "check the names in docs/reference/configuration.md"
  fi
  doc_config_secrets
  doc_config_required
}

doc_config_secrets() {
  local s v weak=()
  for s in INGEST_SECRET OPERATOR_SECRET SESSION_SECRET FED_SUBMIT_SECRET FED_RELAY_SECRET FED_CORROBORATION_SECRET; do
    v="$(env_file_get "$DOC_ENV" "$s")"
    [ -n "$v" ] || continue
    case "$v" in change-me | changeme | secret | example | xxx* | "<"*) weak+=("$s") ;; esac
    [ "${#v}" -ge 16 ] || weak+=("$s")
  done
  if [ "${#weak[@]}" -gt 0 ]; then
    failc config.secrets "weak or example secrets: ${weak[*]}" "deploy/aprscaching rotate-secret <name>"
  else
    pass config.secrets "no secret is empty-but-required, weak or an example value"
  fi
  if [ -n "$DOC_INGEST$DOC_BASE" ] && [ -z "$(env_file_get "$DOC_ENV" INGEST_SECRET)" ] &&
    [ -z "$(env_file_get "$DOC_ENV" BOX_KEY)" ] && [ "$SHAPE" != desktop ]; then
    failc config.ingest_secret "INGEST_SECRET is empty: the gateway refuses to start and the ingest cannot post" \
      "deploy/aprscaching init $SHAPE (it generates one)"
  fi
}

doc_config_required() {
  local k missing=()
  [ -n "$DOC_BASE" ] && doc_public || return 0
  while IFS= read -r k; do
    case "$k" in
      SESSION_SECRET) continue ;; # the servers generate it
      INGEST_SECRET) continue ;;  # checked above
    esac
    # a site setting may be set in Instance admin instead; the gateway's checklist reports it (setup.OPERATOR)
    cfg_site "$k" && continue
    [ -n "$(doc_get "$k")" ] || missing+=("$k")
  done < <(cfg_keys_for "$SHAPE" 1)
  if [ "${#missing[@]}" -gt 0 ]; then
    warnc config.public "a public instance should set: ${missing[*]}" "set them in $DOC_ENV"
  else
    pass config.public "everything a public instance needs is set"
  fi
}

# ---- mail ---------------------------------------------------------------------------------------------------
# Which transport carries the gateway's mail, by its rule: SMTP when SMTP_HOST is set, else Resend when
# EMAIL_API_KEY is set, else none. An SMTP server must answer on its port from here; a test mail is
# tools/admin/mail-test.mjs.
doc_mail() {
  local from host port secure
  [ -n "$DOC_ENV" ] && [ -f "$DOC_ENV" ] || return 0
  [ "$SHAPE" != ingest-box ] || return 0 # an ingest box sends no mail
  from="$(doc_get EMAIL_FROM)"
  host="$(doc_get SMTP_HOST)"
  if [ -z "$host" ] && [ -z "$(doc_get EMAIL_API_KEY)" ]; then
    pass mail.transport "no mail transport: sign-in is by passkey or one-time link (Setup checklist: Email delivery)"
    return 0
  fi
  if [ -z "$from" ]; then
    warnc mail.transport "$([ -n "$host" ] && echo SMTP_HOST || echo EMAIL_API_KEY) is set but EMAIL_FROM is not, so no mail is sent" \
      "set EMAIL_FROM in $DOC_ENV"
    return 0
  fi
  if [ -z "$host" ]; then
    pass mail.transport "mail from $from goes out over the Resend API (api.resend.com)"
    return 0
  fi
  port="$(doc_get SMTP_PORT)"
  port="${port:-587}"
  secure="$(doc_get SMTP_SECURE)"
  [ -n "$secure" ] || { [ "$port" = 465 ] && secure=tls || secure=starttls; }
  pass mail.transport "mail from $from goes out over SMTP $host:$port ($secure)"
  if tcp_open "$host" "$port"; then
    pass mail.smtp "$host:$port answers; send a test with tools/admin/mail-test.mjs <address>"
  else
    warnc mail.smtp "$host:$port does not answer from this host" \
      "check SMTP_HOST and SMTP_PORT, and that the host may connect out on that port"
  fi
}

# ---- gateway ------------------------------------------------------------------------------------------------
doc_gateway() {
  local db schema commit newest head
  [ -n "$DOC_BASE" ] || return 0
  if ! DOC_HEALTH="$(gw_curl -sS --max-time 8 "$DOC_BASE/health" 2>/dev/null)" || [ -z "$DOC_HEALTH" ]; then
    failc gateway.reachable "the gateway does not answer at $DOC_BASE/health" "deploy/aprscaching status; check its logs"
    DOC_HEALTH=""
    return 0
  fi
  db="$(json_field "$DOC_HEALTH" db)"
  if [ -z "$db" ]; then
    failc gateway.reachable "$DOC_BASE/health answers, but not as the gateway (a proxy serving the web app instead?)" \
      "check the reverse proxy's routes: /health, /api/*, /ingest and /.well-known/* go to the gateway"
    DOC_HEALTH=""
    return 0
  fi
  pass gateway.reachable "the gateway answers at $DOC_BASE"
  if [ "$db" = up ]; then pass gateway.database "the database answers"; else
    failc gateway.database "the database does not answer" "check the data directory and the gateway's logs"
  fi
  schema="$(json_field "$DOC_HEALTH" schema)"
  newest="$(cd "$DEPLOY_DIR/../db/migrations" 2>/dev/null && find . -maxdepth 1 -name '*.sql' | sed 's|^\./||' | sort | tail -n 1 || true)"
  if [ -z "$schema" ] || [ "$schema" = null ]; then
    warnc gateway.migrations "the gateway reports no schema (its database did not answer)" "check the data directory and the gateway's logs"
  elif [ -z "$newest" ] || [ "$schema" = "$newest" ]; then
    pass gateway.migrations "migrations are current ($schema)"
  elif [[ "$schema" < "$newest" ]]; then
    if [ "$SHAPE" = selfhost ]; then
      # the image carries the migrations it applies, so the new ones need an image built from this checkout
      warnc gateway.migrations "the database is at $schema; this checkout has $newest" "rebuild in deploy/: docker compose up -d --build"
    else
      warnc gateway.migrations "the database is at $schema; this checkout has $newest" "restart the gateway: it applies them when it starts"
    fi
  else
    warnc gateway.migrations "the database ($schema) is newer than this checkout ($newest)" "update this checkout"
  fi
  commit="$(json_field "$DOC_HEALTH" commit)"
  head="$(git -C "$DEPLOY_DIR/.." rev-parse HEAD 2>/dev/null || true)"
  if [ -n "$commit" ] && [ -n "$head" ] && [ "$commit" != null ] && [ "$commit" != "$head" ] && [ "$SHAPE" != ingest-box ]; then
    warnc gateway.version "the gateway runs ${commit:0:12}; this checkout is ${head:0:12}" "deploy/aprscaching update, or restart it"
  fi
}

# The gateway's own Setup checklist, read with the operator secret; relayed item by item.
doc_setup_checklist() {
  local body status key level detail
  [ -n "$DOC_BASE" ] && [ -n "$DOC_HEALTH" ] || return 0
  DOC_OPERATOR_SECRET="$(doc_get OPERATOR_SECRET)"
  if [ -z "$DOC_OPERATOR_SECRET" ]; then
    warnc setup.checklist "no OPERATOR_SECRET here, so the gateway's Setup checklist is not read" \
      "run doctor with OPERATOR_SECRET in the environment, or open Instance admin -> Setup"
    return 0
  fi
  body="$(curl_secret x-operator-secret "$DOC_OPERATOR_SECRET" -sS --max-time 10 "$DOC_BASE/api/admin/setup" 2>/dev/null || true)"
  case "$body" in *'"items"'*) ;; *)
    warnc setup.checklist "the gateway did not return its Setup checklist" "check OPERATOR_SECRET matches the gateway's"
    return 0
    ;;
  esac
  # one item per line: key, level, status, detail
  while IFS=$'\t' read -r key level status detail; do
    [ -n "$key" ] || continue
    case "$status" in
      ok) pass "setup.$key" "$detail" ;;
      warn) warnc "setup.$key" "$detail" "Instance admin -> Setup" ;;
      *) if [ "$level" = blocking ]; then failc "setup.$key" "$detail" "Instance admin -> Setup"; else
        warnc "setup.$key" "$detail" "Instance admin -> Setup"
      fi ;;
    esac
  done < <(doc_setup_items "$body")
  doc_setup_update "$body"
}

# The instance settings changed in Instance admin (stored in the database), read with the operator secret, so a
# value that applies without being in the env file is visible here. A stored value the environment overrides is
# named too: it applies again once the environment stops setting the key.
doc_site_settings() {
  local body line
  [ -n "$DOC_BASE" ] && [ -n "$DOC_HEALTH" ] && [ -n "$DOC_OPERATOR_SECRET" ] || return 0
  body="$(curl_secret x-operator-secret "$DOC_OPERATOR_SECRET" -sS --max-time 10 "$DOC_BASE/api/admin/settings" 2>/dev/null || true)"
  case "$body" in *'"settings"'*) ;; *)
    warnc site.settings "the gateway did not return its instance settings" "check OPERATOR_SECRET matches the gateway's"
    return 0
    ;;
  esac
  line="$(doc_site_fields "$body")"
  if [ -n "$line" ]; then
    pass site.settings "changed in Instance admin -> Instance settings: $line"
  else
    pass site.settings "no instance setting is changed in Instance admin; the environment and the defaults apply"
  fi
}

# The changed settings as one line: KEY=value (values cut at 40 characters), then the stored values the
# environment overrides.
doc_site_fields() {
  if have node; then
    B="$1" node -e '
      const s = JSON.parse(process.env.B).settings;
      const cut = (v) => (v.length > 40 ? `${v.slice(0, 39)}…` : v);
      const site = s.filter((x) => x.source === "site").map((x) => `${x.key}=${cut(x.value)}`);
      const over = s.filter((x) => x.source === "env" && x.stored).map((x) => x.key);
      const out = [site.join(", "), over.length ? `overridden by the environment: ${over.join(", ")}` : ""];
      console.log(out.filter(Boolean).join("; ").replace(/[\t\n]/g, " "));
    ' 2>/dev/null
  elif have python3; then
    B="$1" python3 -c '
import json, os
s = json.loads(os.environ["B"])["settings"]
cut = lambda v: v if len(v) <= 40 else v[:39] + "…"
site = ["%s=%s" % (x["key"], cut(x["value"])) for x in s if x["source"] == "site"]
over = [x["key"] for x in s if x["source"] == "env" and x.get("stored")]
out = [", ".join(site), ("overridden by the environment: " + ", ".join(over)) if over else ""]
print(" ".join("; ".join(o for o in out if o).split()))
' 2>/dev/null
  fi
}

# A newer release, as the gateway's daily update check found it: a warning, never a failure, so update's
# before/after comparison never rolls back over it; it clears once the gateway runs the new release.
doc_setup_update() {
  local current latest url
  IFS=$'\t' read -r current latest url < <(doc_update_fields "$1") || true
  [ -n "$latest" ] || return 0
  if [ "$current" = available ]; then
    if [ "$SHAPE" = desktop ]; then
      warnc setup.update "APRScaching $latest is available: $url" "download it from the release page and replace the app's binary"
    else
      warnc setup.update "APRScaching $latest is available: $url" "read its release notes, then run deploy/aprscaching update"
    fi
  else
    pass setup.update "the gateway runs the newest release ($latest)"
  fi
}

# The checklist's update fields as one tab-separated line: "available" or "current", the newest release and its
# page. Nothing when the check is off or has not answered yet.
doc_update_fields() {
  if have node; then
    B="$1" node -e '
      const u = JSON.parse(process.env.B).update;
      if (u && u.latest) console.log([u.available ? "available" : "current", u.latest, u.url ?? ""].join("\t"));
    ' 2>/dev/null
  elif have python3; then
    B="$1" python3 -c '
import json, os
u = json.loads(os.environ["B"]).get("update")
if u and u.get("latest"):
    print("\t".join(["available" if u.get("available") else "current", u["latest"], u.get("url") or ""]))
' 2>/dev/null
  fi
}

# The checklist's items as tab-separated lines (key, level, status, detail), parsed with node or python3.
doc_setup_items() {
  if have node; then
    B="$1" node -e '
      const j = JSON.parse(process.env.B);
      for (const i of j.items) console.log([i.key, i.level, i.status, `${i.label}: ${i.detail}`.replace(/[\t\n]/g, " ")].join("\t"));
    ' 2>/dev/null
  elif have python3; then
    B="$1" python3 -c '
import json, os
j = json.loads(os.environ["B"])
for i in j["items"]:
    print("\t".join([i["key"], i["level"], i["status"], " ".join(("%s: %s" % (i["label"], i["detail"])).split())]))
' 2>/dev/null
  else
    echo $'checklist\trecommended\twarn\tneither node nor python3 is installed here to read the Setup checklist; open Instance admin -> Setup'
  fi
}

# ---- ingest -------------------------------------------------------------------------------------------------
doc_ingest() {
  local secret code url body cred="INGEST_SECRET"
  [ -n "$DOC_INGEST" ] || return 0
  [ -z "$(doc_get BOX_KEY)" ] || cred="enrolled key ($(doc_get BOX_ID))"
  secret="$(doc_get INGEST_SECRET)"
  url="${DOC_INGEST%/}/check"
  if [ -n "$(doc_get BOX_KEY)" ]; then
    # an enrolled box signs; ask it to check the way it sends (apps/ingest/src/check.ts)
    body="$(doc_signed_check || true)"
    code="${body%% *}"
    body="${body#* }"
  else
    body="$(curl_secret x-ingest-secret "$secret" -s -w '\n%{http_code}' --max-time 8 "$url" 2>/dev/null || true)"
    code="${body##*$'\n'}"
    body="${body%$'\n'*}"
  fi
  # a 200 counts only with the gateway's answer: a proxy serving the web app answers 200 too
  [ "$code" != 200 ] || [ "$(json_field "$body" ok)" = true ] || code=proxy
  case "$code" in
    200) pass ingest.credentials "the gateway accepts this box's ${cred}" ;;
    proxy) failc ingest.credentials "$url answers, but not as the gateway" "check the reverse proxy's route for /ingest/*" ;;
    401)
      if [ -n "$(doc_get BOX_KEY)" ]; then
        failc ingest.credentials "the gateway refuses this box's key (revoked, or enrolled elsewhere)" \
          "enroll again with a new code: deploy/aprscaching init ingest-box"
      else
        failc ingest.credentials "the gateway refuses this box's INGEST_SECRET" "copy the gateway's INGEST_SECRET to $DOC_ENV"
      fi
      ;;
    404) warnc ingest.credentials "the gateway at $url is too old to check credentials" "update the gateway" ;;
    *) failc ingest.credentials "the gateway does not answer at $url" "check INGEST_URL and the network" ;;
  esac
  doc_ingest_url_http "$DOC_INGEST"
  doc_transports
}

# doc_ingest_url_http URL: plain http to a gateway beyond this box's loopback and LAN sends the ingest secret, and
# the gateway's answers, where a reader on the path sees them.
doc_ingest_url_http() {
  local url="$1" host
  case "$url" in http://*) ;; *) return 0 ;; esac
  host="${url#http://}"
  host="${host%%/*}"
  host="${host%:*}"
  host="${host#[}"
  host="${host%]}"
  case "$host" in
    localhost | 127.* | ::1 | 10.* | 192.168.* | 169.254.* | *.local | *.lan | *.home.arpa) return 0 ;;
    172.1[6-9].* | 172.2[0-9].* | 172.3[01].*) return 0 ;;
    *.*) ;;
    *) return 0 ;; # a bare name, such as the Docker service `gateway`
  esac
  warnc ingest.url_http "INGEST_URL is plain http to $host: the ingest secret and the gateway's answers cross the path readable" \
    "use an https INGEST_URL for a gateway beyond this box's LAN"
}

doc_transports() {
  local host port name
  host="$(doc_get APRSIS_HOST)"
  port="$(doc_get APRSIS_PORT)"
  host="${host:-rotate.aprs2.net}"
  port="${port:-14580}"
  if tcp_open "$host" "$port"; then pass ingest.aprsis "APRS-IS $host:$port is reachable"; else
    warnc ingest.aprsis "APRS-IS $host:$port is not reachable from here (fine off-grid)" "check the network or APRSIS_HOST"
  fi
  for name in KISS_TNC AGWPE HOSTMODE MESHTASTIC; do
    host="$(doc_get "${name}_HOST")"
    [ -n "$host" ] || continue
    port="$(doc_get "${name}_PORT")"
    port="${port:-$(cfg_default "${name}_PORT")}"
    if tcp_open "$host" "$port"; then pass "ingest.${name,,}" "$name $host:$port is reachable"; else
      failc "ingest.${name,,}" "$name $host:$port does not answer" "check the device and ${name}_HOST/${name}_PORT"
    fi
  done
  doc_meshcom
  doc_soundcard
  doc_fedlink_box
}

# The soundcard ports, checked by the ingest itself (check.ts --soundcard): the ALSA tools, the devices, the
# PTT driver, the watchdog and the station calls' verification. It never keys the radio.
doc_soundcard() {
  local out kind port st msg fix
  [ -n "$(doc_get SOUNDCARD_DEVICE)$(doc_get SOUNDCARD_PORTS)" ] || return 0
  out="$(doc_ingest_node --soundcard || true)"
  if [ -z "$out" ]; then
    warnc ingest.soundcard_alsa "the soundcard checks could not run here" "run doctor where the ingest runs, with Node.js"
    return 0
  fi
  while IFS=$'\t' read -r kind port st msg fix; do
    case "$kind:$st" in
      alsa:fail) failc ingest.soundcard_alsa "$msg" "$fix" ;;
      audio:fail) failc "ingest.soundcard_audio.$port" "$msg" "$fix" ;;
      ptt:fail) failc "ingest.soundcard_ptt.$port" "$msg" "$fix" ;;
      tx:fail) failc "ingest.soundcard_tx.$port" "$msg" "$fix" ;;
      tx:warn) warnc "ingest.soundcard_tx.$port" "$msg" "$fix" ;;
      alsa:pass) pass ingest.soundcard_alsa "$msg" ;;
      audio:pass | ptt:pass | tx:pass) pass "ingest.soundcard_$kind.$port" "$msg" ;;
    esac
  done <<<"$out"
}

# Federation over packet circuits on this box: what it serves and pulls, and whether the settings can work.
doc_fedlink_box() {
  local serve pull call link="" node="" every
  serve="$(doc_get FED_LINK_SERVE)"
  pull="$(doc_get FED_LINK_PULL)"
  call="$(doc_get FED_LINK_CALL)"
  [ -z "$(doc_get KISS_TNC_HOST)$(doc_get SOUNDCARD_DEVICE)$(doc_get SOUNDCARD_PORTS)$(doc_get AXUDP_PEERS)" ] || link=1
  [ -z "$(doc_get NETROM_CALL)" ] || [ -z "$(doc_get NETROM_ALIAS)" ] || node=1
  if [ "$serve" != 1 ] && [ "$pull" != 1 ]; then
    pass ingest.fedlink "federation over packet circuits is off"
    return 0
  fi
  if [ -z "$link" ]; then
    failc ingest.fedlink "federation over packet needs a frame link" "set KISS_TNC_HOST or SOUNDCARD_DEVICE, or AXUDP_PORT and AXUDP_PEERS"
    return 0
  fi
  if [ -z "$call" ] && { [ "$pull" = 1 ] || [ -z "$node" ]; }; then
    failc ingest.fedlink "federation over packet needs FED_LINK_CALL" "set FED_LINK_CALL to the call-SSID it answers and dials as"
    return 0
  fi
  every="$(doc_get FED_LINK_PULL_MS)"
  every="$(( ${every:-3600000} / 60000 ))"
  local where=""
  [ -z "$call" ] || where=" on $call"
  [ -z "$node" ] || where="$where, and as the node's FED command"
  [ "$serve" != 1 ] || pass ingest.fedlink "serving federation sync over packet$where"
  [ "$pull" != 1 ] || pass ingest.fedlink_pull "pulling from packet peers as $call, a session every $every min at most"
}

# MeshCom: when each configured node was last heard, and whether its firmware is new enough for ExtUDP.
doc_meshcom() {
  local nodes entry call body heard fw base
  nodes="$(doc_get MESHCOM_NODE)"
  [ -n "$nodes" ] || return 0
  if [ "$(doc_get MESHCOM_BIND)" = 0.0.0.0 ] && doc_public; then
    warnc ingest.meshcom_bind "MESHCOM_BIND=0.0.0.0 on a public host accepts datagrams from anywhere" \
      "bind the LAN address, or leave it blank"
  fi
  base="${DOC_BASE:-${DOC_INGEST%/ingest}}"
  for entry in ${nodes//,/ }; do
    call="${entry#*=}"
    [ "$call" != "$entry" ] || continue # a node without =CALL cannot be looked up
    body="$(gw_curl -sS --max-time 8 "$base/api/meshcom/nodes?call=$call" 2>/dev/null || true)"
    heard="$(json_field "$body" lastHeard)"
    fw="$(json_field "$body" firmware)"
    if [ -z "$heard" ]; then
      warnc "ingest.meshcom.$call" "MeshCom node $call has not been heard recently" "check the node's ExtUDP settings"
      continue
    fi
    pass "ingest.meshcom.$call" "MeshCom node $call last heard $(date -d "@$heard" '+%F %T' 2>/dev/null || echo "$heard")"
    if [ -n "$fw" ] && ! fw_at_least "$fw" 4 35 u; then
      warnc "ingest.meshcom_fw.$call" "MeshCom node $call runs firmware $fw; ExtUDP needs 4.35u or newer" \
        "update the node's firmware"
    fi
  done
}

# fw_at_least VERSION MAJOR MINOR LETTER: MeshCom versions look like 4.35t.
fw_at_least() {
  local v="${1#v}" maj min sub
  [[ "$v" =~ ^([0-9]+)\.([0-9]+)([a-z]?) ]] || return 0 # unknown format: do not warn
  maj="${BASH_REMATCH[1]}" min="$((10#${BASH_REMATCH[2]}))" sub="${BASH_REMATCH[3]}"
  [ "$maj" -ne "$2" ] && { [ "$maj" -gt "$2" ]; return; }
  [ "$min" -ne "$3" ] && { [ "$min" -gt "$3" ]; return; }
  [[ ! "$sub" < "$4" ]]
}

# ---- network ------------------------------------------------------------------------------------------------
doc_network() {
  local host ips end end_s now days health
  doc_public || return 0
  host="${DOC_PUBLIC#https://}"
  host="${host%%/*}"
  host="${host%%:*}"
  ips="$(getent hosts "$host" 2>/dev/null | awk '{print $1}' | sort -u | tr '\n' ' ' || true)"
  if [ -n "$ips" ]; then pass network.dns "$host resolves ($ips)"; else
    failc network.dns "$host does not resolve" "create its DNS record (or the tunnel's public hostname)"
    return 0
  fi
  end="$(echo | timeout 10 openssl s_client -connect "$host:443" -servername "$host" 2>/dev/null |
    openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2 || true)"
  if [ -z "$end" ]; then
    failc network.tls "no TLS certificate from $host:443" "check Caddy / the tunnel / your proxy"
  else
    end_s="$(date -d "$end" +%s 2>/dev/null || echo 0)"
    now="$(date +%s)"
    days=$(((end_s - now) / 86400))
    if [ "$end_s" -le "$now" ]; then failc network.tls "the certificate of $host expired on $end" "renew it"
    elif [ "$days" -lt 14 ]; then warnc network.tls "the certificate of $host expires in $days days" "check its automatic renewal"
    else pass network.tls "the certificate of $host is valid for $days more days"; fi
  fi
  # The public name reaches this gateway: the same instance answers there as here.
  if [ -n "$DOC_HEALTH" ] && health="$(curl -sS --max-time 10 "${DOC_PUBLIC%/}/health" 2>/dev/null)"; then
    if [ "$(json_field "$health" instance)" = "$(json_field "$DOC_HEALTH" instance)" ] &&
      [ "$(json_field "$health" commit)" = "$(json_field "$DOC_HEALTH" commit)" ]; then
      pass network.route "$DOC_PUBLIC reaches this gateway"
    else
      failc network.route "$DOC_PUBLIC answers, but not as this gateway" "point the DNS record or tunnel at this host"
    fi
  elif [ -n "$DOC_HEALTH" ]; then
    failc network.route "$DOC_PUBLIC/health does not answer from here" "check DNS, the proxy and the firewall"
  fi
}

# ---- further addresses (EXTRA_ORIGINS) ----------------------------------------------------------------------
# origin_scope ADDRESS: where an IPv4 address lies — 44net (44Net space, see ampr_scope: a HAMNET address or one
# the internet reaches, which the range cannot tell apart), private (a LAN, loopback or CGNAT range), or public.
origin_scope() {
  local a b
  IFS=. read -r a b _ _ <<<"$1"
  case "$a" in '' | *[!0-9]*) echo public; return 0 ;; esac
  if [ "$(ampr_scope "$1")" = 44net ]; then echo 44net
  elif [ "$a" = 10 ] || [ "$a" = 127 ] || { [ "$a" = 192 ] && [ "$b" = 168 ]; } ||
    { [ "$a" = 172 ] && [ "$b" -ge 16 ] && [ "$b" -le 31 ]; } || { [ "$a" = 169 ] && [ "$b" = 254 ]; } ||
    { [ "$a" = 100 ] && [ "$b" -ge 64 ] && [ "$b" -le 127 ]; }; then echo private
  else echo public; fi
}

# Each further address of the instance: listed once, resolves, answers from here as this gateway, a valid
# certificate on an https one, and no plain http on the internet.
doc_origins() {
  local list o seen="," host hostport port ip ips health end end_s now days scope
  list="$(doc_get EXTRA_ORIGINS)"
  [ -n "${list//[[:space:],]/}" ] || return 0
  for o in ${list//,/ }; do
    o="$(printf '%s' "${o%/}" | tr '[:upper:]' '[:lower:]')"
    case "$o" in https://* | http://*) ;; *) continue ;; esac # config.value.EXTRA_ORIGINS names a malformed one
    if [ "$o" = "$(printf '%s' "${DOC_PUBLIC%/}" | tr '[:upper:]' '[:lower:]')" ] || [[ "$seen" == *",$o,"* ]]; then
      warnc origins.duplicate "$o is listed twice (EXTRA_ORIGINS, or EXTRA_ORIGINS and APP_URL)" "list each address once"
      continue
    fi
    seen="$seen$o,"
    hostport="${o#*://}"
    host="${hostport%%:*}"
    if [[ "$host" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      ips="$host"
    else
      ips="$(getent hosts "$host" 2>/dev/null | awk '{print $1}' | grep -E '^[0-9.]+$' | sort -u | tr '\n' ' ' || true)"
      if [ -z "$ips" ]; then
        failc origins.dns "$host ($o) does not resolve from here" "create its DNS record (the 44Net Portal, or HAMNET's DNS)"
        continue
      fi
      pass origins.dns "$host resolves (${ips% })"
    fi
    if [ -n "$DOC_HEALTH" ] && health="$(curl -sS --max-time 10 "$o/health" 2>/dev/null)"; then
      if [ "$(json_field "$health" instance)" = "$(json_field "$DOC_HEALTH" instance)" ]; then
        pass origins.route "$o reaches this gateway"
      else
        failc origins.route "$o answers, but not as this gateway" "point its DNS record at this host, and restart Caddy after changing EXTRA_ORIGINS"
      fi
    elif [ -n "$DOC_HEALTH" ]; then
      failc origins.route "$o/health does not answer from here" "restart Caddy after changing EXTRA_ORIGINS (docker compose up -d), and check the firewall"
    fi
    case "$o" in
      https://*)
        port="${hostport#"$host"}"
        port="${port#:}"
        end="$(echo | timeout 10 openssl s_client -connect "$host:${port:-443}" -servername "$host" 2>/dev/null |
          openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2 || true)"
        if [ -z "$end" ]; then
          failc origins.tls "no TLS certificate from $o" "Caddy fetches one once the name resolves and ports 80 and 443 reach it"
        else
          end_s="$(date -d "$end" +%s 2>/dev/null || echo 0)"
          now="$(date +%s)"
          days=$(((end_s - now) / 86400))
          if [ "$end_s" -le "$now" ]; then failc origins.tls "the certificate of $o expired on $end" "check Caddy's renewal (docker compose logs caddy)"
          elif [ "$days" -lt 14 ]; then warnc origins.tls "the certificate of $o expires in $days days" "check Caddy's renewal (docker compose logs caddy)"
          else pass origins.tls "the certificate of $o is valid for $days more days"; fi
        fi
        ;;
      http://*)
        for ip in $ips; do
          scope="$(origin_scope "$ip")"
          if [ "$scope" = public ]; then
            warnc origins.http "$o is plain http on an internet address ($ip): sign-ins and sessions cross the internet unencrypted" \
              "list it as https://$hostport instead; plain http suits HAMNET and a LAN"
            break
          elif [ "$scope" = 44net ]; then
            pass origins.http "$o is plain http on a 44Net address ($ip): right for a HAMNET address; if its subnet is routed on the internet, list it as https instead"
            break
          fi
        done
        ;;
    esac
  done
}

# ---- federation ---------------------------------------------------------------------------------------------
# fed_fingerprint KEY: a federation key's fingerprint, as Instance admin shows it (federation.ts keyFingerprint):
# the first 64 bits of SHA-256 over the raw Ed25519 key (base64url), in four groups of four hex digits. Two sysops
# read theirs to each other out of band to check the key each one pinned. Prints nothing for a malformed key.
fed_fingerprint() {
  local k="$1" raw
  [[ "$k" =~ ^[A-Za-z0-9_-]{43}$ ]] || return 0
  raw="$(printf '%s=' "$k" | tr '_-' '/+')"
  if command -v sha256sum >/dev/null 2>&1; then
    printf '%s' "$raw" | base64 -d 2>/dev/null | sha256sum
  else
    printf '%s' "$raw" | base64 -d 2>/dev/null | shasum -a 256
  fi | cut -c1-16 | sed 's/..../& /g; s/ $//'
}

# desc_key JSON: the current signing key a federation descriptor (/.well-known/aprscaching) publishes.
desc_key() { printf '%s' "$1" | sed -n 's/.*"publicKey":"\([A-Za-z0-9_-]*\)".*/\1/p'; }

doc_federation() {
  local peers p host scope unsafe=()
  [ -n "$DOC_BASE" ] || return 0
  # federation over FBB is experimental and off by default; reported either way, never a warning
  case "$(doc_get FED_BBS)" in
    1 | true | yes) pass federation.fbb "federation over FBB is on (experimental): only partners marked for it carry it" ;;
    *) pass federation.fbb "federation over FBB is off" ;;
  esac
  peers="$(doc_get FED_PEERS)"
  if ! doc_public; then
    if [ -z "$peers$(doc_get FED_HUB_URL)" ]; then pass federation.off "federation is off on this LAN instance"; else
      warnc federation.lan "a LAN instance has federation peers configured" "fine on HAMNET; otherwise remove FED_PEERS"
    fi
    return 0
  fi
  [ -n "$DOC_ENV" ] || return 0 # no settings file to read here; Setup reports them
  if [ -n "$(doc_get FED_PRIVATE_KEY)" ]; then pass federation.key "the federation signing key is set"; else
    warnc federation.key "no FED_PRIVATE_KEY: feeds go out unsigned and peers cannot verify them" \
      "node tools/fedkey/genkey.mjs --raw, into FED_PRIVATE_KEY"
  fi
  case "$(doc_get FED_AUTO_PROMOTE)" in 0 | "") ;; *) unsafe+=("FED_AUTO_PROMOTE is not 0") ;; esac
  case "$(doc_get FED_CORROBORATION_QUORUM)" in 0 | 1) unsafe+=("FED_CORROBORATION_QUORUM is below 2") ;; esac
  for p in ${peers//,/ }; do
    host="${p#*://}"
    host="${host%%[/:#]*}"
    case "$p" in
      https://*)
        # a 44Net peer is admitted by callsign from Instance admin, where DNS attests its name
        case "$host" in *.ampr.org | ampr.org) scope=44net ;; *) scope="$(ampr_scope "$host")" ;; esac
        [ "$scope" != 44net ] || unsafe+=("peer ${p%%#*} is on 44Net: admit it from Instance admin")
        ;;
      http://*)
        if printf '%s' "${p%%#*}" | grep -Eq '^http://[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?(:[0-9]{1,5})?/?$'; then
          pass "federation.hamnet.$host" "peer ${p%%#*} is a HAMNET or LAN peer over plain http"
        else
          unsafe+=("peer ${p%%#*} is plain http with a path: a HAMNET or LAN peer is http://<name or address>[:port]")
        fi
        ;;
      *) unsafe+=("peer $p is neither https nor a plain-http HAMNET peer") ;;
    esac
  done
  if [ -n "$(doc_get FED_SUBMIT_SECRET)" ] && [ -z "$(doc_get FED_SUBMIT_INSTANCES)" ]; then
    unsafe+=("a hub without FED_SUBMIT_INSTANCES")
  fi
  if [ -n "$(doc_get FED_REGISTRY)$(doc_get FED_REGISTRY_DNS)" ] && [ -z "$(doc_get FED_REGISTRY_KEY)" ]; then
    unsafe+=("a registry without FED_REGISTRY_KEY")
  fi
  if [ "${#unsafe[@]}" -gt 0 ]; then
    local u
    for u in "${unsafe[@]}"; do
      warnc federation.posture "$u" "see Running federation safely"
    done
  else
    pass federation.posture "the federation settings are the safe ones"
  fi
  local desc fp
  desc="$(gw_curl -fsS --max-time 8 "$DOC_BASE/.well-known/aprscaching" 2>/dev/null || true)"
  fp="$(fed_fingerprint "$(desc_key "$desc")")"
  [ -z "$fp" ] || pass federation.fingerprint "this instance's key fingerprint is $fp; read it to each peer's sysop"
  local pin
  for p in ${peers//,/ }; do
    # a FED_PEERS entry may pin the peer's key fingerprint after #
    pin=""
    case "$p" in *"#"*) pin="$(printf '%s' "${p#*#}" | tr -d ' :' | tr 'A-F' 'a-f')" ;; esac
    p="${p%%#*}"
    if desc="$(curl -fsS --max-time 8 "${p%/}/.well-known/aprscaching" 2>/dev/null)"; then
      fp="$(fed_fingerprint "$(desc_key "$desc")")"
      if [ -n "$pin" ] && [ "$pin" != "$(printf '%s' "$fp" | tr -d ' ')" ]; then
        warnc "federation.peer.${p#*://}" "peer $p signs with key ${fp:-none}, not the fingerprint FED_PEERS pins" \
          "compare fingerprints with its sysop again, then correct FED_PEERS"
      else
        pass "federation.peer.${p#*://}" "peer $p answers; its key fingerprint is ${fp:-missing (it signs nothing)}"
      fi
    else
      case "$p" in
        http://*) warnc "federation.peer.${p#*://}" "peer $p does not answer from here" \
          "a HAMNET peer answers only where this host has a route to HAMNET; otherwise check the URL, or ask its operator" ;;
        *) warnc "federation.peer.${p#*://}" "peer $p does not answer" "check the URL, or ask its operator" ;;
      esac
    fi
  done
}

# Federation over packet circuits, the gateway's view: the peers the ingest box pulls over packet and how their last
# sessions went (GET /federation/packet/peers, read with the operator secret).
doc_fedlink_gateway() {
  local body total failing never
  [ -n "$DOC_BASE" ] && [ -n "$DOC_HEALTH" ] && [ -n "$DOC_OPERATOR_SECRET" ] || return 0
  body="$(curl_secret x-operator-secret "$DOC_OPERATOR_SECRET" -sS --max-time 10 \
    "$DOC_BASE/federation/packet/peers" 2>/dev/null || true)"
  total="$(json_field "$body" total)"
  [ -n "$total" ] || return 0
  failing="$(json_field "$body" failing)"
  never="$(json_field "$body" never)"
  if [ "$total" = 0 ]; then
    pass federation.packet "no peer publishes a packet endpoint"
  elif [ "${failing:-0}" != 0 ]; then
    warnc federation.packet "$failing of $total packet peer(s) failed their last session" \
      "read the ingest box's [fedlink] log lines; check the radio path and FED_LINK_NODE"
  elif [ "${never:-0}" != 0 ]; then
    pass federation.packet "$total packet peer(s); $never not pulled yet"
  else
    pass federation.packet "$total packet peer(s); every last session completed"
  fi
}

# Records of other instances that no neighbour delivered within a week, given up so sync moves on (fedgaps.ts),
# until the sysop marks them seen in Instance admin (GET /federation/peers, read with the operator secret).
doc_fedgaps() {
  local body n
  [ -n "$DOC_BASE" ] && [ -n "$DOC_HEALTH" ] && [ -n "$DOC_OPERATOR_SECRET" ] || return 0
  body="$(curl_secret x-operator-secret "$DOC_OPERATOR_SECRET" -sS --max-time 10 \
    "$DOC_BASE/federation/peers" 2>/dev/null || true)"
  n="$(printf '%s' "$body" | sed -n -E 's/.*"givenUp":\{"count":([0-9]+).*/\1/p' | head -n 1)"
  [ -n "$n" ] || return 0
  if [ "$n" = 0 ]; then
    pass federation.gaps "no records of other instances given up"
  else
    warnc federation.gaps "$n record(s) of other instances given up: no neighbour delivered them within a week" \
      "read them under Instance admin -> Federation -> Records given up, then mark them seen"
  fi
}

# ---- callsign identity -------------------------------------------------------------------------------------------
# The gateway's own self-check of the records that let peers add this instance by callsign (44Net, https or both),
# read with the operator secret and relayed line by line, each fix carrying the exact value to publish.
DOC_IDENTITY=0
doc_identity() {
  local body id status msg fix
  [ -n "$DOC_BASE" ] && [ -n "$DOC_HEALTH" ] && [ -n "$DOC_OPERATOR_SECRET" ] || return 0
  body="$(curl_secret x-operator-secret "$DOC_OPERATOR_SECRET" -sS --max-time 30 \
    "$DOC_BASE/api/admin/federation/identity?check=1" 2>/dev/null || true)"
  case "$body" in *'"lines"'*) ;; *) return 0 ;; esac
  DOC_IDENTITY=1
  while IFS=$'\t' read -r id status msg fix; do
    [ -n "$id" ] || continue
    case "$status" in
      fail) failc "identity.$id" "$msg" "$fix" ;;
      warn) warnc "identity.$id" "$msg" "$fix" ;;
      *) pass "identity.$id" "$msg" ;;
    esac
  done < <(doc_identity_lines "$body")
}

# The identity check's lines as tab-separated lines (id, status, "label: detail", fix), parsed with node or python3.
doc_identity_lines() {
  if have node; then
    B="$1" node -e '
      const flat = (s) => String(s ?? "").replace(/[\t\n]/g, " ");
      for (const l of JSON.parse(process.env.B).lines ?? [])
        console.log([l.id, l.status, flat(`${l.label}: ${l.detail}`), flat(l.fix)].join("\t"));
    ' 2>/dev/null
  elif have python3; then
    B="$1" python3 -c '
import json, os
for l in json.loads(os.environ["B"]).get("lines") or []:
    flat = lambda s: " ".join(str(s or "").split())
    print("\t".join([l["id"], l["status"], flat("%s: %s" % (l["label"], l["detail"])), flat(l.get("fix"))]))
' 2>/dev/null
  fi
}

# ---- 44Net ---------------------------------------------------------------------------------------------------
# When the instance publishes a 44net endpoint or this host has wg44: the tunnel, its MTU and firewall, the DNS
# records under the 44Net name, and the certificate when Caddy serves that name with TLS.
doc_net44() {
  local name="" on_host=0 age mtu v4 a txt end days domain
  declare -F n44_up >/dev/null || return 0
  [ -z "$DOC_ENV" ] || name="$(SHAPE_ENV="$DOC_ENV" n44_name_from_env)"
  n44_up && on_host=1
  [ -n "$name" ] || [ "$on_host" = 1 ] || return 0
  case "$(n44_shape_mode)" in docker | host) ;; *) on_host=0 ;; esac
  if [ "$on_host" = 1 ]; then
    age="$(n44_handshake_age)"
    if [ -z "$age" ]; then
      failc net44.tunnel "$N44_IF is up, but has had no handshake" "check the endpoint and the keys: deploy/aprscaching net44 status"
    elif [ "$age" -gt 180 ]; then
      warnc net44.tunnel "$N44_IF's last handshake was $age s ago" "a peer handshakes every 2 minutes while traffic flows; keepalive 25 keeps it open"
    else
      pass net44.tunnel "$N44_IF is up; handshake $age s ago"
    fi
    mtu="$(ip -o link show dev "$N44_IF" 2>/dev/null | sed -nE 's/.* mtu ([0-9]+).*/\1/p')"
    if [ -n "$mtu" ] && [ "$mtu" -le "$N44_MTU_CAP" ]; then pass net44.mtu "$N44_IF's MTU is $mtu"; else
      warnc net44.mtu "$N44_IF's MTU is ${mtu:-unknown}, above $N44_MTU_CAP: large replies can stall" "deploy/aprscaching net44 setup sets it from the path MTU"
    fi
    if have nft && nft list table inet "$N44_NFT" >/dev/null 2>&1; then pass net44.firewall "$N44_IF is filtered: only TCP 80/443 and replies"; else
      warnc net44.firewall "no firewall from net44 on $N44_IF: ARDC filters nothing" "deploy/aprscaching net44 setup applies it, or filter $N44_IF yourself"
    fi
  elif [ -n "$name" ] && [ "$(n44_shape_mode)" != guide ]; then
    failc net44.tunnel "FED_ENDPOINTS names $name, but $N44_IF is not up on this host" "deploy/aprscaching net44 setup <connect.conf>"
  fi
  [ -n "$name" ] || return 0
  a="$(SHAPE_ENV="$DOC_ENV" n44_doh "$name" A | grep -E '^[0-9.]+$' | head -n 1)"
  v4="$( [ -f "$(n44_conf)" ] && n44_v4 "$(n44_conf)" || true)"
  if [ -z "$a" ]; then
    failc net44.dns "$name has no A record" "add it in the 44Net Portal${v4:+, pointing at $v4}"
  elif [ -n "$v4" ] && [ "$a" != "$v4" ]; then
    failc net44.dns "$name points at $a, but the tunnel is $v4" "correct the A record in the 44Net Portal"
  elif [ "$(ampr_scope "$a")" = sold ]; then
    warnc net44.dns "$name points at $a, in 44.192.0.0/10, which ARDC sold in 2019 and is not 44Net" \
      "point it at your 44Net address in the 44Net Portal"
  elif [ "$(ampr_scope "$a")" != 44net ]; then
    warnc net44.dns "$name points at $a, outside 44Net (44.0.0.0/9 and 44.128.0.0/10)" "point it at your 44Net address in the 44Net Portal"
  else
    pass net44.dns "$name points at $a, a 44Net address; reachability from the internet depends on how the subnet is routed (BGP, Connect, IPIP)"
  fi
  # the gateway's own check (doc_identity) compares the record with this instance's id and key; without it, the
  # record's presence is what this host can see
  if [ "$DOC_IDENTITY" != 1 ]; then
    txt="$(SHAPE_ENV="$DOC_ENV" n44_identity_txt "$name")"
    if [ -n "$txt" ]; then pass net44.txt "the _aprscaching record is published"; else
      failc net44.txt "no _aprscaching TXT record for $name" \
        "add it in the 44Net Portal: Instance admin -> Federation -> Publish your callsign identity shows the values"
    fi
  fi
  # Caddy serves the name with TLS when DOMAIN or EXTRA_ORIGINS (as https://<name>) lists it
  domain=" $(doc_get DOMAIN | tr ',' ' ') $(doc_get EXTRA_ORIGINS | tr ',' ' ') "
  case "$domain" in
    *" $name "* | *" https://$name "* | *" https://$name/ "*)
      end="$(echo | timeout 10 openssl s_client -connect "${a:-$name}:443" -servername "$name" 2>/dev/null |
        openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2 || true)"
      if [ -z "$end" ]; then
        warnc net44.cert "no certificate answered for $name" "Caddy fetches one once the name resolves and is reachable"
      else
        days=$((($(date -d "$end" +%s) - $(date +%s)) / 86400))
        if [ "$days" -gt 14 ]; then pass net44.cert "the certificate for $name is valid for $days more days"; else
          warnc net44.cert "the certificate for $name expires in $days days" "check Caddy's renewal (docker compose logs caddy)"
        fi
      fi
      ;;
  esac
}

# ---- resources ----------------------------------------------------------------------------------------------
doc_resources() {
  local avail pct size newest age
  [ "$DOC_BACKUP_SETTINGS" = 0 ] || doc_backup_destination
  if [ -n "$DOC_DATA_DIR" ] && [ -d "$DOC_DATA_DIR" ]; then
    read -r avail pct < <(df -Pk "$DOC_DATA_DIR" | awk 'NR==2 {print $4, $5}')
    pct="${pct%\%}"
    if [ "$pct" -ge 98 ]; then failc resources.disk "the data disk is ${pct}% full" "free space, or move the data"
    elif [ "$pct" -ge 90 ] || [ "$avail" -lt 1048576 ]; then warnc resources.disk "the data disk is ${pct}% full ($((avail / 1024)) MiB free)" "free space soon"
    else pass resources.disk "the data disk has $((avail / 1024)) MiB free (${pct}% used)"; fi
  fi
  if [ -n "$DOC_DB_FILE" ] && [ -f "$DOC_DB_FILE" ]; then
    size="$(du -k "$DOC_DB_FILE" | cut -f1 || true)"
    pass resources.database "the database is $((size / 1024)) MiB"
  fi
  [ -z "$DOC_BACKUP_DIR" ] || DOC_BACKUP_PLACES+=("$DOC_BACKUP_DIR|$DOC_BACKUP_GLOB")
  [ "${#DOC_BACKUP_PLACES[@]}" -gt 0 ] || return 0
  local place dir glob f t best=0 where=() missing
  for place in "${DOC_BACKUP_PLACES[@]}"; do
    dir="${place%%|*}" glob="${place#*|}"
    [[ " ${where[*]} " == *" $dir "* ]] || where+=("$dir")
    # shellcheck disable=SC2086 # the glob is the point
    f="$(cd "$dir" 2>/dev/null && ls -t $glob 2>/dev/null | head -n 1 || true)"
    [ -n "$f" ] || continue
    t="$(stat -c %Y "$dir/$f" 2>/dev/null || stat -f %m "$dir/$f")"
    [ "$t" -le "$best" ] || { best="$t" newest="$f"; }
  done
  if [ "$best" = 0 ]; then
    missing="${DOC_BACKUP_MISSING}c"
    [ "$missing" = warnc ] || missing=failc
    "$missing" resources.backup "no backup in ${where[*]}" "deploy/aprscaching backup, and schedule it"
  else
    age=$((($(date +%s) - best) / 86400))
    if [ "$age" -gt "$DOC_BACKUP_MAX_DAYS" ]; then
      warnc resources.backup "the newest backup is $age days old" "check the scheduled backup"
    else
      pass resources.backup "the newest backup is $age days old ($newest)"
    fi
  fi
}

# Self-host and bare metal: where deploy/backup.sh writes, from the settings.
doc_backup_destination() {
  local dir why=""
  dir="$(doc_get BACKUP_DIR)"
  if [ -n "$dir" ]; then
    # deploy/backup.sh's snapshots (<time>.db.gz) and deploy/aprscaching backup's archives, side by side
    DOC_BACKUP_DIR="$dir"
    DOC_BACKUP_GLOB="*.db.gz aprscaching-*.tar.gz"
    return 0
  fi
  # A bucket counts only when its CLI is here to upload to it; otherwise the backups stay on this host.
  if [ -n "$(doc_get OCI_BUCKET)" ]; then
    if have oci; then
      doc_bucket_backup_age "$(doc_get OCI_BUCKET)"
      return 0
    fi
    why="OCI_BUCKET is set, but the oci CLI that uploads to it is not installed"
  elif [ -n "$(doc_get BACKUP_BUCKET)" ] && [ -n "$(doc_get R2_ENDPOINT)" ]; then
    if have aws; then
      doc_s3_backup_age "$(doc_get BACKUP_BUCKET)" "$(doc_get R2_ENDPOINT)"
      return 0
    fi
    why="BACKUP_BUCKET is set, but the aws CLI that uploads to it is not installed"
  elif [ -n "$(doc_get BACKUP_BUCKET)" ]; then
    why="BACKUP_BUCKET is set without R2_ENDPOINT, so nothing is uploaded"
  fi
  if [ -n "$why" ] || compgen -G "$DEPLOY_DIR/backups/aprscaching-*.tar.gz" >/dev/null; then
    DOC_BACKUP_DIR="$DEPLOY_DIR/backups"
    DOC_BACKUP_GLOB="aprscaching-*.tar.gz"
    warnc resources.backup_place "${why:+$why: }backups stay on this host ($DOC_BACKUP_DIR)" \
      "set BACKUP_DIR to another disk or mount, set up the bucket's CLI, or copy the archives off this host"
  else
    failc resources.backup "no backup destination is set" "set BACKUP_DIR, OCI_BUCKET or BACKUP_BUCKET, then schedule deploy/aprscaching backup"
  fi
}

# The newest backup in the OCI bucket, by its upload time: deploy/aprscaching backup's archives (archives/) or
# deploy/backup.sh's snapshots (db/), whichever is newer.
doc_bucket_backup_age() {
  local when snap age
  when="$(bk_bucket_newest_time "$1")"
  snap="$(bk_bucket_newest_time "$1" db/)"
  if [ -n "$snap" ] && [ "$snap" -gt "${when:-0}" ]; then when="$snap"; fi
  if [ -z "$when" ]; then
    failc resources.backup "no backup archive in the bucket $1, or the bucket is unreachable" \
      "deploy/aprscaching backup; on the OCI stack, systemctl status aprscaching-backup.timer"
    return 0
  fi
  age=$((($(date +%s) - when) / 86400))
  if [ "$age" -gt "$DOC_BACKUP_MAX_DAYS" ]; then
    warnc resources.backup "the newest backup in the bucket $1 is $age days old" "check the scheduled backup"
  else
    pass resources.backup "the newest backup in the bucket $1 is $age days old"
  fi
}

# The newest snapshot deploy/backup.sh uploaded to an S3-compatible bucket (db/), by its listed time.
doc_s3_backup_age() {
  local line when age
  line="$(aws s3 ls "s3://$1/db/" --endpoint-url "$2" 2>/dev/null | sort | tail -n 1 || true)"
  when="$(date -d "$(awk '{print $1" "$2}' <<<"$line")" +%s 2>/dev/null || true)"
  if [ -z "$line" ] || [ -z "$when" ]; then
    failc resources.backup "no snapshot in the bucket $1, or the bucket is unreachable" "run deploy/backup.sh, and schedule it"
    return 0
  fi
  age=$((($(date +%s) - when) / 86400))
  if [ "$age" -gt "$DOC_BACKUP_MAX_DAYS" ]; then
    warnc resources.backup "the newest snapshot in the bucket $1 is $age days old" "check the scheduled backup"
  else
    pass resources.backup "the newest snapshot in the bucket $1 is $age days old"
  fi
}

# ---- AGPL §13 -----------------------------------------------------------------------------------------------
doc_source() {
  local base body repo commit
  base="${DOC_PUBLIC:-$DOC_BASE}"
  [ -n "$base" ] && [ "$SHAPE" != ingest-box ] || return 0
  body="$(curl -sS --max-time 8 "${base%/}/.well-known/source" 2>/dev/null || true)"
  repo="$(json_field "$body" repo)"
  commit="$(json_field "$body" commit)"
  if [ -z "$repo" ]; then
    failc source.link "${base%/}/.well-known/source does not answer" "the AGPL §13 source link must be public"
  elif [ -z "$commit" ] || [ "$commit" = null ]; then
    if [ "$SHAPE" = selfhost ]; then
      warnc source.link "the source link names no commit" "rebuild in deploy/: SOURCE_COMMIT=\$(git rev-parse HEAD) docker compose up -d --build"
    else
      warnc source.link "the source link names no commit" "set SOURCE_COMMIT, or deploy from a git checkout"
    fi
  else
    pass source.link "the source link names $repo at ${commit:0:12}"
  fi
  # the link names the upstream (SOURCE_REPO unset, or set to it) while this checkout runs changed code
  if [ "${repo%/}" = "https://github.com/apachler/aprscaching" ] &&
    [ -n "$(git -C "$DEPLOY_DIR/.." status --porcelain --untracked-files=no 2>/dev/null)" ]; then
    warnc source.fork "this checkout has local changes but SOURCE_REPO is the upstream" "publish your changes and set SOURCE_REPO to your fork"
  fi
}

# ---- the report ---------------------------------------------------------------------------------------------
doc_report() {
  local row st id msg fix docs fails=0 warns=0 passes=0 first=1 section=""
  for row in "${DOC_ROWS[@]}"; do
    case "${row%%$'\t'*}" in fail) fails=$((fails + 1)) ;; warn) warns=$((warns + 1)) ;; *) passes=$((passes + 1)) ;; esac
  done
  if [ "$APRS_JSON" = 1 ]; then
    printf '{"shape":%s,"pass":%d,"warn":%d,"fail":%d,"checks":[' "$(json_str "$SHAPE")" "$passes" "$warns" "$fails"
    for row in "${DOC_ROWS[@]}"; do
      IFS=$'\t' read -r st id msg fix docs <<<"$row"
      [ "$first" = 1 ] || printf ','
      first=0
      printf '{"status":%s,"id":%s,"message":%s,"fix":%s,"docs":%s}' "$(json_str "$st")" "$(json_str "$id")" \
        "$(json_str "$msg")" "$(json_str "$fix")" "$(json_str "$docs")"
    done
    printf ']}\n'
  else
    step "doctor: $SHAPE"
    for row in "${DOC_ROWS[@]}"; do
      IFS=$'\t' read -r st id msg fix docs <<<"$row"
      if [ "${id%%.*}" != "$section" ]; then
        section="${id%%.*}"
        printf '\n  %s\n' "$section"
      fi
      printf '    %-4s  %s\n' "$st" "$msg"
      if [ "$st" != pass ] && [ -n "$fix" ]; then printf '          fix: %s\n' "$fix"; fi
      if [ "$st" != pass ] && [ -n "$docs" ]; then printf '          see: %s\n' "$docs"; fi
    done
    printf '\n  %d passed, %d warnings, %d failed\n' "$passes" "$warns" "$fails"
  fi
  [ "$fails" = 0 ]
}

# doctor for the loaded shape: its context, the shared checks, its own, then the report. Exit status 1
# when any check failed.
run_doctor() {
  declare -F shape_doctor_context >/dev/null || die "'doctor' is not available for the $SHAPE shape."
  shape_doctor_context
  doc_config
  doc_mail
  doc_gateway
  doc_setup_checklist
  doc_site_settings
  doc_ingest
  doc_network
  doc_origins
  doc_federation
  doc_fedlink_gateway
  doc_fedgaps
  doc_identity
  doc_net44
  if declare -F shape_doctor_extra >/dev/null; then shape_doctor_extra; fi
  doc_resources
  doc_source
  doc_report
}
