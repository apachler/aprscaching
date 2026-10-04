# Troubleshooting

This page is for the sysop whose instance misbehaves. It explains every check `deploy/aprscaching doctor`
runs: what it tests, what its message means, and how to fix it.

## Run the doctor first

Run it from the repository checkout on the machine that runs the instance:

```bash
deploy/aprscaching doctor
deploy/aprscaching --json doctor      # one JSON document: {shape, pass, warn, fail, checks: [{status, id, message, fix, docs}]}
```

- It checks the shape `init` recorded. Name another one with `--shape <shape>`.
- It changes nothing: no setting, no file, no service.
- It never prints a secret value. It reads `OPERATOR_SECRET` and `INGEST_SECRET` to ask the gateway, and
  sends them as headers, not on the command line.
- The exit status is `1` when any check failed, so a cron job or a monitor can run it.
- `deploy/aprscaching update` runs it after an update. A check that fails after the update but did not fail
  before rolls the update back ([Updates](day-to-day/updates.md)).

[The deploy/aprscaching command](day-to-day/helper-command.md) covers the command and its options.

## How to read a result

The report lists the checks by group, in the order of this page; each section below names its group in brackets. Each line starts with a status:

| Status | Meaning |
|---|---|
| `pass` | The check found what it expects. |
| `warn` | Something works less well than it should, or is unsafe. The instance still runs. |
| `fail` | Something is broken: members cannot sign in, packets do not arrive, or data is at risk. |

A `warn` or `fail` line adds up to two more lines:

- `fix:` the one action that usually clears it.
- `see:` this check's entry on this page, as a path in the repository
  (`docs/run/troubleshooting.md#gatewayreachable`). The entry links on to the page that explains the fix.

Each check has an id such as `gateway.reachable`; `--json` prints it in `id`. Below, every id has its own
section. Ids with a part in angle brackets, such as `config.value.<KEY>`, stand for one check per key, node or
peer. The doctor prints only the checks that apply to your shape and settings.

Fix the first `fail` in the list first. A later check often fails only because an earlier one did: no
gateway answer means no Setup checklist and no network route.

## Settings (`config`)

The settings file of the shape: Self-host `deploy/.env`, bare metal and Pocket their own `.env`, the
ingest box `deploy/.env`. Desktop keeps no `.env` the doctor reads.

### `config.file`

- **Tests:** the shape's `.env` exists.
- **Message:** `<path> is missing` (fail).
- **Fix:** `deploy/aprscaching init <shape>` writes it.
- **See:** [The deploy/aprscaching command](day-to-day/helper-command.md).

### `config.permissions`

- **Tests:** only the owner can read the `.env`.
- **Message:** `<path> is readable by others (mode <mode>); it holds secrets` (fail).
- **Fix:** `chmod 600 <path>`.
- **See:** [Secrets and credentials](../reference/secrets.md).

### `config.value.<KEY>`

- **Tests:** each known setting has a value of its type: a whole number, a number, one of a list, an
  absolute URL or JSON.
- **Message:** `<KEY>: expected a whole number` and similar (fail). The Node and Bun gateways refuse to start
  on such a value.
- **Fix:** correct the value in the `.env`, then restart.
- **See:** [Configuration](../reference/configuration.md), which lists each key's type.

### `config.values`

- **Tests:** every setting has a value of its type. It passes when no `config.value.<KEY>` failed.

### `config.unknown`

- **Tests:** every key in the `.env` is a known setting.
- **Message:** `not settings (a typo?): <keys>` (warn). The software ignores these keys.
- **Fix:** check the names against the reference and correct the spelling.
- **See:** [Configuration](../reference/configuration.md).

### `config.secrets`

- **Tests:** `INGEST_SECRET`, `OPERATOR_SECRET`, `SESSION_SECRET`, `FED_SUBMIT_SECRET`, `FED_RELAY_SECRET`
  and `FED_CORROBORATION_SECRET`, where set, are at least 16 characters long and not an example value such
  as `change-me`.
- **Message:** `weak or example secrets: <names>` (fail).
- **Fix:** `deploy/aprscaching rotate-secret <name>` for each one, then restart.
- **See:** [Rotating a secret](../reference/secrets.md#rotating-a-secret).

### `config.ingest_secret`

- **Tests:** `INGEST_SECRET` is set, or an enrolled box key (`BOX_KEY`). Desktop generates its own and is
  not checked.
- **Message:** `INGEST_SECRET is empty: the gateway refuses to start and the ingest cannot post` (fail).
- **Fix:** `deploy/aprscaching init <shape>` generates one.
- **See:** [Secrets and credentials](../reference/secrets.md).

### `config.public`

- **Tests:** a public instance (an `https://` `APP_URL`) sets every key the configuration reference marks
  as required for a public instance of its shape. `SESSION_SECRET` does not count: the gateway generates
  it.
- **Message:** `a public instance should set: <keys>` (warn).
- **Fix:** set them in the `.env` and restart.
- **See:** [Your first hour](first-hour.md#the-checklist) and [A public instance's duties](compliance/index.md).

### `config.ingest_url`

- **Tests:** on an ingest box, `INGEST_URL` is set.
- **Message:** `INGEST_URL is not set` (fail).
- **Fix:** set it to your gateway's `/ingest` URL in `deploy/.env`.
- **See:** [Set up an ingest box](radios/ingest-box.md).

## Mail (`mail`)

How the gateway sends mail, read from the `.env`. The ingest box sends none and skips this group.

### `mail.transport`

- **Tests:** which transport carries the mail: SMTP when `SMTP_HOST` is set, else the Resend API when
  `EMAIL_API_KEY` is set, else none. No transport passes; the Setup checklist's `EMAIL` item says whether
  members still have a way to sign in.
- **Message:** `SMTP_HOST is set but EMAIL_FROM is not, so no mail is sent` (warn), or the same for
  `EMAIL_API_KEY`.
- **Fix:** set `EMAIL_FROM` in the `.env` and restart.
- **See:** [Send mail](day-to-day/mail.md).

### `mail.smtp`

- **Tests:** the SMTP server answers on `SMTP_HOST`:`SMTP_PORT` from this host. It does not log in or send.
- **Message:** `<host>:<port> does not answer from this host` (warn).
- **Fix:** check the host name and port, and that the host may connect out on that port: some providers
  block 25 and 587 until asked. Then send a test mail ([Send mail](day-to-day/mail.md#send-a-test-mail)).
- **See:** [Send mail](day-to-day/mail.md).

## The gateway (`gateway`)

Every shape with a gateway: all but the ingest box. Self-host asks through this host's Caddy, with the
public name pinned to this host. A DNS problem then shows under [the public address](#the-public-address-network), not here.

### `gateway.reachable`

- **Tests:** `GET /health` answers, and answers as the gateway: the reply reports the database.
- **Message:** `the gateway does not answer at <base>/health` (fail). Nothing listens, or it crashed.
- **Message:** `<base>/health answers, but not as the gateway (a proxy serving the web app instead?)` (fail).
  A reverse proxy sends `/health` to the web app.
- **Fix:** `deploy/aprscaching status`, then read the gateway's logs. For the second message, route
  `/health`, `/api/*`, `/ingest` and `/.well-known/*` to the gateway.
- **See:** the install page of your shape, such as [Self-host with Docker](install/self-host-docker.md);
  for a proxy in front, [Cloudflare Tunnel and CDN](networks/cloudflare.md).

### `gateway.database`

- **Tests:** `/health` reports the database as up.
- **Message:** `the database does not answer` (fail).
- **Fix:** check that the data directory exists, has free space and belongs to the gateway's user; read the
  gateway's logs.
- **See:** the install page of your shape.

### `gateway.migrations`

- **Tests:** the database schema `/health` reports is the newest file in `db/migrations/` of this checkout.
- **Message:** `the database is at <file>; this checkout has <file>` (warn). The gateway applies migrations
  when it starts, and has not started on this checkout's code.
- **Message:** `the database (<file>) is newer than this checkout (<file>)` (warn). The checkout is older
  than the running gateway.
- **Message:** `the gateway does not report its schema (an older release)` (warn).
- **Fix:** bring the gateway onto this checkout: `deploy/aprscaching update`. On Self-host the image carries the
  migrations, so rebuild it in `deploy/` with `docker compose up -d --build`; on the other shapes a restart applies
  them.
  Self-host, in `deploy/`: `SOURCE_COMMIT=$(git rev-parse HEAD) docker compose up -d --build`. For the
  second message, update the checkout.
- **See:** [Updates](day-to-day/updates.md).

### `gateway.version`

- **Tests:** the commit the gateway runs is this checkout's `HEAD`.
- **Message:** `the gateway runs <commit>; this checkout is <commit>` (warn).
- **Fix:** `deploy/aprscaching update`, or restart the gateway on this checkout.
- **See:** [Updates](day-to-day/updates.md).

## The setup checklist (`setup`)

The gateway's own checklist, the one under **Instance admin → Setup**. The doctor reads it with
`OPERATOR_SECRET` and reports each item as a check.

### `setup.checklist`

- **Message:** `no OPERATOR_SECRET here, so the gateway's Setup checklist is not read` (warn).
- **Message:** `the gateway did not return its Setup checklist` (warn). The secret does not match the
  gateway's.
- **Message:** `neither node nor python3 is installed here to read the Setup checklist` (warn).
- **Fix:** run the doctor with `OPERATOR_SECRET` in the environment, or check that it matches the gateway's.
  Or open **Instance admin → Setup** in the app.
- **See:** [Your first hour](first-hour.md#the-checklist).

### `setup.<item>`

One check per checklist item. An item that is met passes. An item that is not met warns, and fails when it
is **blocking** and missing. The fix is always on **Instance admin → Setup**; the table says what to change.

| Item | Level | When it is not met | Fix |
|---|---|---|---|
| `config` | blocking | a setting has a value of the wrong type | correct it ([`config.value.<KEY>`](#configvaluekey)) |
| `INGEST_SECRET` | blocking | unset or `change-me`: the ingest box cannot post | set it, or `rotate-secret INGEST_SECRET` |
| `SESSION_SECRET` | blocking | unset, weak, or the same as a machine secret: nobody can sign in | set a dedicated secret ([Secrets](../reference/secrets.md)) |
| `OPERATOR_SECRET` | recommended | unset: operator scripts are closed; the web surface still works | set it |
| `ADMIN_CALLSIGNS` | blocking | always met when the checklist answers | — |
| `SERVICE_CALL` | recommended | `APRSCG` (no `ADMIN_CALLSIGNS`), or not a call of an `ADMIN_CALLSIGNS` base call | name an operator in `ADMIN_CALLSIGNS`, or set `SERVICE_CALL` to one of your calls with a free SSID |
| `APP_URL` | recommended | unset: passkeys are closed; links fall back to the request host | set the public `https://` origin |
| `INSTANCE` | recommended | unset: federation records need a domain | set `APP_URL`; `INSTANCE` follows its host |
| `RP_ID` | optional | unset: the passkey domain is missing | set `APP_URL`; `RP_ID` follows its host |
| `FIRST_PARTY_SITES` | optional | no trusted receiving station: no find reaches Tier A | trust your receiver's call under **Instance admin → Trusted receiving stations**, or list it here ([RF ingest](radios/rf-ingest.md#receiving-site-and-tier-a)) |
| `FED_PRIVATE_KEY` | recommended | unset: feeds go out unsigned | see [`federation.key`](#federationkey) |
| `44net` | optional | the 44net endpoint is not a name under `<call>.ampr.org` | [44Net name and identity](networks/44net-identity.md#3-name-and-identity) |
| `FED_REGISTRY_KEY` | blocking | a registry is configured without its authority key | [Hubs, relays and the registry](federation/hubs-and-relays.md) |
| `OPERATOR` | recommended | `OPERATOR_NAME`, `OPERATOR_ADDRESS` or `OPERATOR_EMAIL` missing: `/imprint` and `/privacy` warn | set all three ([duties](compliance/index.md)) |
| `SOURCE_REPO` | optional | unset: the source link names the upstream repository | set your fork if you changed the code ([`source.fork`](#sourcefork)) |
| `EMAIL` | blocking, recommended or optional | no mail delivery; blocking when nobody has a way to sign in | set `EMAIL_FROM` and an SMTP server or a Resend key ([Send mail](day-to-day/mail.md)), or use [sign-in links](day-to-day/sign-in-links.md) |
| `VAPID` | optional | no web push; notifications go by email digest | set `VAPID_PUBLIC` and `VAPID_PRIVATE` |
| `db:ingest` | blocking | no packet in the last hour (a warning, never a failure) | see [`ingest.credentials`](#ingestcredentials), or connect a radio ([quick starts](radios/quick-starts.md)) |
| `db:peers` | optional | no enabled federation peer | [Join the network](federation/index.md#joining-the-network) |
| `db:partners` | optional | always met: a count of forwarding partners | — |
| `db:caches` | optional | no active cache yet | hide the first cache |
| `db:verify` | recommended | your callsign is not control-verified | **You → Verify callsign** ([Callsign verification](day-to-day/callsign-verification.md)) |

## Ingest and radios (`ingest`)

Every shape with an ingest.

### `ingest.credentials`

- **Tests:** `GET /ingest/check` accepts this box's `INGEST_SECRET`, or the signed request of an enrolled
  box key.
- **Message:** `the gateway accepts this box's <credential>` (pass).
- **Message:** `<url> answers, but not as the gateway` (fail). A proxy serves the web app on `/ingest`.
  Route `/ingest/*` to the gateway.
- **Message:** `the gateway refuses this box's INGEST_SECRET` (fail). Copy the gateway's `INGEST_SECRET` to
  the box's `.env`.
- **Message:** `the gateway refuses this box's key (revoked, or enrolled elsewhere)` (fail). Enroll again
  with a new code: `deploy/aprscaching init ingest-box`.
- **Message:** `the gateway at <url> is too old to check credentials` (warn). Update the gateway.
- **Message:** `the gateway does not answer at <url>` (fail). Check `INGEST_URL` and the network.
- **See:** [Enrolling the box](radios/ingest-box.md#enrolling-the-box) and
  [Secrets and credentials](../reference/secrets.md).

### `ingest.aprsis`

- **Tests:** a TCP connection to `APRSIS_HOST:APRSIS_PORT` (default `rotate.aprs2.net:14580`).
- **Message:** `APRS-IS <host>:<port> is not reachable from here (fine off-grid)` (warn).
- **Fix:** check the internet connection, or `APRSIS_HOST`. On a HAMNET-only network, point `APRSIS_HOST` at
  a server inside it.
- **See:** [APRS-IS quick start](radios/quick-starts.md#aprs-is-internet-feed) and
  [HAMNET only](networks/hamnet.md).

### `ingest.kiss_tnc`

- **Tests:** a TCP connection to `KISS_TNC_HOST:KISS_TNC_PORT`, when `KISS_TNC_HOST` is set.
- **Message:** `KISS_TNC <host>:<port> does not answer` (fail).
- **Fix:** start the TNC or Direwolf, and check the host and port. In a container, `localhost` is the
  container, not your machine.
- **See:** [KISS TNC quick start](radios/quick-starts.md#kiss-tnc-with-direwolf-soundcard-or-hardware-tnc) and
  [From a container](radios/rf-ingest.md#from-a-container).

### `ingest.agwpe`

- **Tests:** a TCP connection to `AGWPE_HOST:AGWPE_PORT`, when `AGWPE_HOST` is set.
- **Message:** `AGWPE <host>:<port> does not answer` (fail).
- **Fix:** start the AGWPE server (Direwolf, SoundModem, UZ7HO) and check the host and port.
- **See:** [AGWPE quick start](radios/quick-starts.md#agwpe-direwolf-soundmodem-uz7ho).

### `ingest.hostmode`

- **Tests:** a TCP connection to `HOSTMODE_HOST:HOSTMODE_PORT`, when `HOSTMODE_HOST` is set.
- **Message:** `HOSTMODE <host>:<port> does not answer` (fail).
- **Fix:** check the serial-to-TCP bridge of the WA8DED TNC, and the host and port.
- **See:** [WA8DED hostmode quick start](radios/quick-starts.md#wa8ded-hostmode-thefirmware-tncs-tfpcx).

### `ingest.meshtastic`

- **Tests:** a TCP connection to `MESHTASTIC_HOST:MESHTASTIC_PORT`, when `MESHTASTIC_HOST` is set.
- **Message:** `MESHTASTIC <host>:<port> does not answer` (fail).
- **Fix:** check that the node's network API is on, and the host and port.
- **See:** [Meshtastic quick start](radios/quick-starts.md#meshtastic).

### `ingest.meshcom_bind`

- **Tests:** a public instance does not set `MESHCOM_BIND=0.0.0.0`.
- **Message:** `MESHCOM_BIND=0.0.0.0 on a public host accepts datagrams from anywhere` (warn).
- **Fix:** bind the LAN address, or leave `MESHCOM_BIND` blank.
- **See:** [MeshCom optional settings](radios/meshcom.md#optional-settings) and
  [MeshCom firewall](radios/meshcom.md#3-firewall).

### `ingest.meshcom.<CALL>`

- **Tests:** each node in `MESHCOM_NODE` written with `=CALL` was heard recently.
- **Message:** `MeshCom node <CALL> has not been heard recently` (warn).
- **Fix:** check the node's ExtUDP settings: it sends to this box on port 1799.
- **See:** [Point the node at the box](radios/meshcom.md#1-point-the-node-at-the-box) and
  [MeshCom troubleshooting](radios/meshcom.md#troubleshooting).

### `ingest.meshcom_fw.<CALL>`

- **Tests:** the node runs MeshCom firmware 4.35u or newer, which ExtUDP needs.
- **Message:** `MeshCom node <CALL> runs firmware <version>; ExtUDP needs 4.35u or newer`
  (warn).
- **Fix:** update the node's firmware.
- **See:** [MeshCom: before you start](radios/meshcom.md#before-you-start).

### `ingest.url`

- **Tests:** on bare metal, `INGEST_URL` does not name the Docker service `gateway`.
- **Message:** `INGEST_URL names the Docker service 'gateway', which bare metal has not` (fail).
- **Fix:** set `INGEST_URL=http://127.0.0.1:<port>/ingest` in the `.env`; the doctor prints the value.
- **See:** [Self-host without Docker](install/self-host-bare-metal.md).

## The public address (`network`)

A public instance only: one whose `APP_URL` starts with `https://`.

### `network.dns`

- **Tests:** the public name resolves.
- **Message:** `<host> does not resolve` (fail). The doctor skips the other network checks.
- **Fix:** create the DNS record, or the tunnel's public hostname.
- **See:** [Self-host with Docker](install/self-host-docker.md) and
  [Cloudflare Tunnel and CDN](networks/cloudflare.md).

### `network.tls`

- **Tests:** port 443 of the public name serves a certificate that is valid for more than 14 days.
- **Message:** `no TLS certificate from <host>:443` (fail). Caddy, the tunnel or your proxy serves none.
- **Message:** `the certificate of <host> expired on <date>` (fail). Renew it.
- **Message:** `the certificate of <host> expires in <n> days` (warn). Automatic renewal has not run.
- **Fix:** read Caddy's logs (`docker compose logs caddy` in `deploy/`), or check the tunnel or your proxy.
  Caddy needs ports 80 and 443 open to get and renew a certificate.
- **See:** [Self-host with Docker](install/self-host-docker.md) and
  [Cloudflare Tunnel and CDN](networks/cloudflare.md).

### `network.route`

- **Tests:** the public URL's `/health` answers with the same instance and commit as this host's gateway.
- **Message:** `<APP_URL> answers, but not as this gateway` (fail). DNS or the tunnel points at another
  machine, or at an older copy.
- **Message:** `<APP_URL>/health does not answer from here` (fail).
- **Fix:** point the DNS record or the tunnel at this host; check the proxy and the firewall.
- **See:** [Cloudflare Tunnel and CDN](networks/cloudflare.md) and
  [Self-host with Docker](install/self-host-docker.md).

## Federation (`federation`)

Every shape with a gateway. A LAN instance gets one check, `federation.off` or `federation.lan`.

### `federation.off`

- **Tests:** a LAN instance has no `FED_PEERS` and no `FED_HUB_URL`. It passes.

### `federation.lan`

- **Message:** `a LAN instance has federation peers configured` (warn).
- **Fix:** on HAMNET this is fine. Otherwise remove `FED_PEERS`: peers cannot reach a LAN-only instance.
- **See:** [HAMNET only](networks/hamnet.md) and [Join the network](federation/index.md).

### `federation.key`

- **Tests:** `FED_PRIVATE_KEY` is set.
- **Message:** `no FED_PRIVATE_KEY: feeds go out unsigned and peers cannot verify them` (warn).
- **Fix:** in the repository root, run `node tools/fedkey/genkey.mjs --raw`, put the value into
  `FED_PRIVATE_KEY`, and restart.
- **See:** [Join the network](federation/index.md).

### `federation.posture`

- **Tests:** the federation settings are the safe ones. Each unsafe setting is its own warning:

| Message | What to change |
|---|---|
| `FED_DISCOVER is on` | set it to `0`, or accept that learned peers arrive disabled until you enable them |
| `FED_AUTO_PROMOTE is not 0` | set it to `0`, so only you promote a peer to `trusted` |
| `FED_CORROBORATION_QUORUM is below 2` | set it to `2` or more, so no single peer lifts a find to Tier A |
| `peer <url> is not https` | use the peer's `https://` address |
| `peer <url> is on 44Net: admit it from Instance admin` | remove it from `FED_PEERS`: a 44Net peer is admitted `unvetted`, and you promote it yourself |
| `a hub without FED_SUBMIT_INSTANCES` | list the spokes that may push to this hub |
| `a registry without FED_REGISTRY_KEY` | pin the registry's authority key |

- **See:** [Running federation safely](federation/index.md#running-federation-safely).

### `federation.peer.<host>`

- **Tests:** each peer in `FED_PEERS` answers at `/.well-known/aprscaching`, and signs with the key whose
  fingerprint the entry pins after `#`, if it pins one.
- **Message:** `peer <url> does not answer` (warn), or `peer <url> signs with key <fingerprint>, not the
  fingerprint FED_PEERS pins` (warn).
- **Fix:** check the URL, or ask the peer's operator. For a key that does not match, compare fingerprints
  with its sysop again and correct `FED_PEERS`.
- **See:** [Join the network](federation/index.md#joining-the-network).

## The 44Net tunnel and name (`net44`)

An instance with a `44net` endpoint in `FED_ENDPOINTS`, or a host with the `wg44` tunnel up. Self-host and
bare metal check the tunnel on the host. On Pocket the WireGuard app carries the tunnel, so the doctor checks
the DNS records only.

### `net44.tunnel`

- **Tests:** `wg44` is up and its last handshake is at most 180 seconds old.
- **Message:** `wg44 is up, but has had no handshake` (fail). Check the endpoint and the keys.
- **Message:** `wg44's last handshake was <n> s ago` (warn). A peer handshakes every 2 minutes while traffic
  flows, and keepalive 25 keeps the tunnel open.
- **Message:** `FED_ENDPOINTS names <name>, but wg44 is not up on this host` (fail).
- **Fix:** `deploy/aprscaching net44 status`; to bring it up, `deploy/aprscaching net44 setup <connect.conf>`.
- **See:** [Bring the tunnel up](networks/44net.md#2-bring-the-tunnel-up).

### `net44.mtu`

- **Tests:** the MTU of `wg44` is at most 1420.
- **Message:** `wg44's MTU is <n>, above 1420: large replies can stall` (warn).
- **Fix:** `deploy/aprscaching net44 setup` sets it from the path MTU.
- **See:** [Bring the tunnel up](networks/44net.md#2-bring-the-tunnel-up).

### `net44.firewall`

- **Tests:** the firewall `net44 setup` installs on `wg44` is in place: only TCP 80 and 443 and replies.
- **Message:** `no firewall from net44 on wg44: ARDC filters nothing` (warn).
- **Fix:** `deploy/aprscaching net44 setup` applies it, or filter `wg44` yourself.
- **See:** [Who can reach you](networks/44net.md#who-can-reach-you).

### `net44.dns`

- **Tests:** the 44Net name has an A record, and it matches the tunnel's address.
- **Message:** `<name> has no A record` (fail).
- **Message:** `<name> points at <address>, but the tunnel is <address>` (fail).
- **Fix:** add or correct the A record in the 44Net Portal. Changes publish within about an hour.
- **See:** [Name and identity](networks/44net-identity.md#3-name-and-identity).

### `net44.txt`

- **Tests:** the `_aprscaching` TXT record is published for the name or its parent.
- **Message:** `no _aprscaching TXT record for <name>` (fail).
- **Fix:** publish the value **Instance admin → Setup → 44Net** shows.
- **See:** [Name and identity](networks/44net-identity.md#3-name-and-identity).

### `net44.cert`

- **Tests:** when `DOMAIN` lists the 44Net name, its certificate is valid for more than 14 days.
- **Message:** `no certificate answered for <name>` (warn). Caddy fetches one once the name resolves and is
  reachable.
- **Message:** `the certificate for <name> expires in <n> days` (warn).
- **Fix:** read Caddy's logs: `docker compose logs caddy` in `deploy/`.
- **See:** [TLS on the 44Net name](networks/44net-identity.md#tls-on-the-44net-name).

## Services (`service`)

The processes of the shape. Self-host checks its containers, bare metal its systemd units, the ingest box its
container.

### `service.docker`

- **Tests:** Self-host: Docker is installed.
- **Message:** `docker is not installed here` (fail).
- **Fix:** install Docker, or name the right shape with `--shape <shape>`.
- **See:** [Self-host with Docker](install/self-host-docker.md#before-you-start).

### `service.gateway`

- **Tests:** Self-host: the `gateway` container runs.
- **Message:** `gateway is not running` (fail).
- **Fix:** `deploy/aprscaching status`; then `docker compose logs gateway` in `deploy/`. The gateway refuses
  to start without `INGEST_SECRET` or with a malformed setting.
- **See:** [Self-host with Docker](install/self-host-docker.md).

### `service.ingest`

- **Tests:** Self-host or ingest box: the `ingest` container runs.
- **Message:** `ingest is not running` (Self-host) or `the ingest is not running` (ingest box) (fail).
- **Fix:** Self-host: `docker compose logs ingest` in `deploy/`. Ingest box: in `deploy/`, run
  `docker compose -f compose.ingest-only.yml up -d`.
- **See:** [Self-host with Docker](install/self-host-docker.md) and
  [Set up an ingest box](radios/ingest-box.md).

### `service.caddy`

- **Tests:** Self-host: the `caddy` container runs.
- **Message:** `caddy is not running` (fail).
- **Fix:** `docker compose logs caddy` in `deploy/`. Another program on port 80 or 443 stops it.
- **See:** [Self-host with Docker](install/self-host-docker.md).

### `service.cloudflared`

- **Tests:** Self-host with `TUNNEL_TOKEN` set: the `cloudflared` container runs.
- **Message:** `cloudflared is not running` (fail).
- **Fix:** `docker compose logs cloudflared` in `deploy/`; check the tunnel token.
- **See:** [Cloudflare Tunnel and CDN](networks/cloudflare.md).

### `service.compose`

- **Tests:** Self-host: Docker Compose is 2.24 or newer, which the stack's compose files need (`!reset` in
  `compose.home.yml`, optional `env_file` entries).
- **Message:** `Docker Compose <version> is older than 2.24, which the stack's compose files need` (fail).
- **Fix:** update the Docker Compose plugin; `docker compose version` shows the one installed.
- **See:** [Self-host with Docker](install/self-host-docker.md#before-you-start).

### `service.tunnel_ports`

- **Tests:** Self-host with `TUNNEL_TOKEN` set: the merged compose configuration (`docker compose config`)
  publishes no port for Caddy, so the tunnel is the only way in.
- **Message:** `TUNNEL_TOKEN is set, but Caddy still publishes ports on the host` (fail).
- **Fix:** remove the `caddy` service's `ports:` from any other compose file; `compose.home.yml` resets them.
  Update Docker Compose when it is older than 2.24.
- **See:** [Cloudflare Tunnel and CDN](networks/cloudflare.md#set-up-the-tunnel).

### `service.gateway_port`

- **Tests:** Self-host: the gateway's port 8080 is not published on the host.
- **Message:** `the gateway's port 8080 is published on the host, bypassing Caddy` (warn).
- **Fix:** remove the `ports:` entry of the `gateway` service.
- **See:** [Self-host with Docker](install/self-host-docker.md#before-you-start).

### `service.data_owner`

- **Tests:** Self-host: the gateway's user (UID 10001) can write the data directory, `/data/media`, the database
  files and the generated secrets in the `data` volume.
- **Message:** `the gateway (UID 10001) cannot write <file> in the data volume` (fail).
- **Fix:** `deploy/aprscaching update` hands the volume to UID 10001; by hand, in `deploy/`:
  `docker compose run --rm --no-deps --user 0 gateway chown -R 10001:10001 /data`. A host directory bound to
  `/data` takes `sudo chown -R 10001:10001 <dir>`.
- **See:** [The services run as an unprivileged user](install/self-host-docker.md#the-services-run-as-an-unprivileged-user).

### `service.meshcom_port`

- **Tests:** a public Self-host instance does not publish MeshCom's 1799/udp on every address.
- **Message:** `MeshCom's 1799/udp is published on every address of a public host` (warn).
- **Fix:** publish the port on the LAN address only.
- **See:** [MeshCom firewall](radios/meshcom.md#3-firewall) and
  [From a container](radios/rf-ingest.md#from-a-container).

### `service.aprscaching-gateway`

- **Tests:** bare metal: the `aprscaching-gateway` unit is active.
- **Message:** `aprscaching-gateway is <state>` or `is not installed` (fail).
- **Fix:** `sudo systemctl enable --now aprscaching-gateway`; read `journalctl -u aprscaching-gateway -n 50`.
- **See:** [Self-host without Docker](install/self-host-bare-metal.md).

### `service.aprscaching-ingest`

- **Tests:** bare metal: the `aprscaching-ingest` unit is active.
- **Message:** `aprscaching-ingest is <state>` or `is not installed` (fail).
- **Fix:** `sudo systemctl enable --now aprscaching-ingest`; read `journalctl -u aprscaching-ingest -n 50`.
- **See:** [Self-host without Docker](install/self-host-bare-metal.md).

## Disk, database and backups (`resources`)

Disk, database and backups. The ingest box has none of these checks; Desktop has no backup check.

### `resources.disk`

- **Tests:** the disk that holds the data. Self-host measures Docker's data directory.
- **Message:** `the data disk is <n>% full` (fail at 98 %).
- **Message:** `the data disk is <n>% full (<n> MiB free)` (warn at 90 %, or under 1 GiB free).
- **Fix:** free space, or move the data to a larger disk.
- **See:** [Backups and moving](day-to-day/backups.md).

### `resources.database`

- **Tests:** reports the database's size. It always passes.

### `resources.backup`

A backup destination is set and its newest backup is at most 7 days old. Set `APRS_BACKUP_MAX_DAYS` in the
doctor's environment for another limit. The doctor looks wherever either backup tool writes, and the newest file
across those places counts:

| Shape | Where the doctor looks |
|---|---|
| Self-host, bare metal | `BACKUP_DIR`: the `<time>.db.gz` snapshots of `deploy/backup.sh` and the `aprscaching-*.tar.gz` archives of `deploy/aprscaching backup`. Else `OCI_BUCKET`, read with the `oci` CLI, under `archives/` and `db/`. Else `BACKUP_BUCKET` with `R2_ENDPOINT`, read with the `aws` CLI, under `db/`. Else `deploy/backups/`, also when a bucket is set but its CLI is missing, since nothing then uploads |
| Pocket | the phone's scheduled backup in `APRSCACHING_BACKUP_DIR` (default `~/storage/shared/aprscaching-backups`), and the archives of `deploy/aprscaching backup` (`BACKUP_DIR`, else `deploy/backups/`) |
| Desktop | the archives of `deploy/aprscaching backup` (`deploy/backups/`); without one it warns rather than fails |

- **Message:** `no backup destination is set` (fail).
- **Message:** `no backup in <dir> …` (fail; warn on Desktop).
- **Message:** `no backup archive in the bucket <bucket>, or the bucket is unreachable`, or `no snapshot in the
  bucket <bucket>, or the bucket is unreachable` (fail).
- **Message:** `the newest backup is <n> days old`, `the newest backup in the bucket <bucket> is <n> days old`, or
  `the newest snapshot in the bucket <bucket> is <n> days old` (warn past the limit).
- **Fix:** run `deploy/aprscaching backup`, then schedule it. On the Oracle Cloud stack, check the timer:
  `systemctl status aprscaching-backup.timer`.
- **See:** [What to back up](day-to-day/backups.md#what-to-back-up).

### `resources.backup_place`

- **Tests:** backups leave this host's disk: `BACKUP_DIR` is set, or a bucket with the CLI that uploads to it.
- **Message:** `backups stay on this host (<dir>)` (warn), led by the reason when a bucket is set but nothing
  uploads to it: the `oci` or `aws` CLI is missing, or `BACKUP_BUCKET` has no `R2_ENDPOINT`. A failed disk takes
  the instance and its backups. `deploy/aprscaching backup` uploads its archives to `OCI_BUCKET` only;
  `BACKUP_BUCKET` takes the snapshots of `deploy/backup.sh`.
- **Fix:** set `BACKUP_DIR` to another disk or mount, install and configure the bucket's CLI, or copy the
  archives off this host.
- **See:** [What to back up](day-to-day/backups.md#what-to-back-up).

## The source link (`source`)

Every shape with a gateway. AGPL §13 requires a public instance to offer its source.

### `source.link`

- **Tests:** `/.well-known/source` answers and names the repository and commit.
- **Message:** `<url>/.well-known/source does not answer` (fail).
- **Message:** `the source link names no commit` (warn).
- **Fix:** make the route public. For a missing commit on Self-host, rebuild in `deploy/`:
  `SOURCE_COMMIT=$(git rev-parse HEAD) docker compose up -d --build`. On another shape, set `SOURCE_COMMIT`
  or deploy from a git checkout.
- **See:** [A public instance's duties](compliance/index.md).

### `source.fork`

- **Tests:** when this checkout has local changes to tracked files, the instance's source link does not name
  the upstream repository (`SOURCE_REPO` unset, or set to it).
- **Message:** `this checkout has local changes but SOURCE_REPO is the upstream` (warn).
- **Fix:** publish your changes and set `SOURCE_REPO` to your fork.
- **See:** [A public instance's duties](compliance/index.md).

## Not from doctor

The doctor checks the instance, not the radio in your hand. These pages cover the rest:

- **A radio in the browser** (Web Serial, Bluetooth): [Your radio in the browser](../shack/my-radio.md#troubleshooting).
- **MeshCom log messages**: [MeshCom troubleshooting](radios/meshcom.md#troubleshooting).
- **Pocket on the phone**: [Run Pocket in the field](pocket/field-station.md#troubleshooting).
- **Ingest box log lines**, such as `[forward] gateway unreachable` or `[axip] disabled`:
  [Set up an ingest box](radios/ingest-box.md) and [Quick starts](radios/quick-starts.md).

## Next

- [Backups and moving](day-to-day/backups.md): the check most instances fail first.
- [The deploy/aprscaching command](day-to-day/helper-command.md): the other commands, such as `status` and
  `rotate-secret`.
