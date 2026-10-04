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
    setup.checklist) a="${1//./}" ;;
    setup.*) a=setupitem ;;
    ingest.meshcom_fw.*) a=ingestmeshcom_fwcall ;;
    ingest.meshcom.*) a=ingestmeshcomcall ;;
    federation.peer.*) a=federationpeerhost ;;
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
    warnc gateway.migrations "the gateway does not report its schema (an older release)" "update it"
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
  doc_transports
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

# ---- federation ---------------------------------------------------------------------------------------------
doc_federation() {
  local peers p unsafe=()
  [ -n "$DOC_BASE" ] || return 0
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
  case "$(doc_get FED_DISCOVER)" in 1 | true | yes) unsafe+=("FED_DISCOVER is on") ;; esac
  case "$(doc_get FED_AUTO_PROMOTE)" in 0 | "") ;; *) unsafe+=("FED_AUTO_PROMOTE is not 0") ;; esac
  case "$(doc_get FED_CORROBORATION_QUORUM)" in 0 | 1) unsafe+=("FED_CORROBORATION_QUORUM is below 2") ;; esac
  for p in ${peers//,/ }; do
    case "$p" in
      https://*) ;;
      *) unsafe+=("peer $p is not https") ;;
    esac
    case "${p#*://}" in *.ampr.org* | 44.*) unsafe+=("peer $p is on 44Net and starts trusted") ;; esac
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
  for p in ${peers//,/ }; do
    if curl -fsS -o /dev/null --max-time 8 "${p%/}/.well-known/aprscaching" 2>/dev/null; then
      pass "federation.peer.${p#*://}" "peer $p answers"
    else
      warnc "federation.peer.${p#*://}" "peer $p does not answer" "check the URL, or ask its operator"
    fi
  done
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
  else
    pass net44.dns "$name points at $a"
  fi
  txt="$(SHAPE_ENV="$DOC_ENV" n44_doh "_aprscaching.$name" TXT | grep 'v=acs1' | head -n 1)"
  [ -n "$txt" ] || txt="$(SHAPE_ENV="$DOC_ENV" n44_doh "_aprscaching.${name#*.}" TXT | grep 'v=acs1' | head -n 1)"
  if [ -n "$txt" ]; then pass net44.txt "the _aprscaching record is published"; else
    failc net44.txt "no _aprscaching TXT record for $name" "publish the value Instance admin -> Setup -> 44Net shows"
  fi
  domain="$(doc_get DOMAIN)"
  case ", $domain," in
    *", $name,"* | *" $name,"*)
      end="$(echo | openssl s_client -connect "${a:-$name}:443" -servername "$name" 2>/dev/null | openssl x509 -noout -enddate 2>/dev/null | cut -d= -f2)"
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
  doc_ingest
  doc_network
  doc_federation
  doc_net44
  if declare -F shape_doctor_extra >/dev/null; then shape_doctor_extra; fi
  doc_resources
  doc_source
  doc_report
}
