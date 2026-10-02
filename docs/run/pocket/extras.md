# Pocket extras

This page shows the sysop the optional extras of a Pocket station: a status notification, home-screen
shortcuts, a battery saver, field alerts and a scheduled backup. Each one needs a Termux add-on; without it, the
station works as before.

## Before you start

Three optional add-ons give the extras, each from F-Droid or each from GitHub. **Install every Termux app from
the same source as Termux itself:** the apps share a signing key, and apps from different sources refuse to talk
to each other. Open each app once after installing it, and grant the permissions it asks for (notifications for
Termux:API).

| Add-on | Gives the station |
|---|---|
| **Termux:API** (the app and `pkg install termux-api`) | the status notification, the battery saver, field alerts, the battery and Wi-Fi lines in `status.sh`, the scheduled backup, the setup questions as dialogs, a USB TNC, the Wi-Fi check before a sync |
| **Termux:Widget** | home-screen shortcuts |
| **Termux:Boot** | start at boot ([Keep it running](field-station.md#keep-it-running)) |

Without an add-on, the scripts print one line saying what to install.

## Every extra at a glance

The extras `start.sh` starts run in their own tmux window. Every script is under `~/aprscaching/deploy/pocket/`.

| Extra | Script | Needs | Where |
|---|---|---|---|
| Setup questions | `wizard.sh` | Termux:API for dialogs, else the terminal | [Install](../install/pocket.md#install) |
| Status notification | `extras/notify.sh` (`start.sh` runs it) | Termux:API | [below](#status-notification) |
| Home-screen shortcuts | `extras/setup.sh --shortcuts` | Termux:Widget | [below](#home-screen-shortcuts) |
| Battery saver | `extras/battery.sh` (`start.sh` runs it) | Termux:API | [below](#battery-saver) |
| Field alerts | `extras/alerts.sh` (`POCKET_ALERTS=1`) | Termux:API | [below](#field-alerts) |
| Scheduled backup | `extras/setup.sh --scheduled-backup` | Termux:API | [below](#scheduled-backup) |
| A USB KISS TNC | `extras/usb-kiss.sh` (`start.sh` runs it) | Termux:API, `python`, `libusb`, a CDC-ACM TNC | [A USB TNC on the phone](field-station.md#a-usb-tnc-on-the-phone) |
| Sync before a trip | `extras/sync-now.sh` | Termux:API to tell Wi-Fi from mobile data | [Before a trip](trips.md) |
| Your home instance as the hub | `wizard.sh` | the home instance's submit secret | [Your home instance as the hub](trips.md#your-home-instance-as-the-hub) |
| https on the ampr.org name | `extras/ampr-cert.sh` | `lego`, 44Net | [Pocket on 44Net](44net.md#pocket-on-44net) |
| An RTL-SDR | — | not supported | [An RTL-SDR on the phone](../install/pocket.md#an-rtl-sdr-on-the-phone-not-supported) |

## Status notification

With Termux:API, `start.sh` keeps one ongoing notification current every minute. It shows whether the station
runs, the stations heard in the last hour, when the MeshCom node was last heard, whether APRS-IS delivers, and the
battery. Its buttons are **Stop**, **Restart** and **Open map**; tapping it opens the map. It reads the gateway's
`/api/admin/station-status` with the station's `OPERATOR_SECRET`. `stop.sh` removes it.

## Home-screen shortcuts

```bash
bash ~/aprscaching/deploy/pocket/extras/setup.sh --shortcuts
```

It puts **Status**, **Start**, **Stop**, **Open map**, **Backup** and **Sync before trip** into `~/.shortcuts/`.
Add the Termux:Widget widget to the home screen to tap them. **Status** opens a terminal with `status.sh`; the
others run in the background and report with a short toast.

## Battery saver

With Termux:API, `start.sh` also watches the battery. On battery below `POCKET_BATTERY_LOW` percent (default 20),
the station switches to a saver profile:

- APRS-IS narrows to your own call's packets. The connection stays up, and almost no data flows.
- The raw packet log keeps 2 hours instead of 6.
- MeshCom and every radio port stay on.

It switches back when the phone charges or the battery is 10 points above the threshold, and says so in a
notification each time. The profile is an overlay, `~/.aprscaching/battery-saver.env`, applied by restarting both
processes. `POCKET_BATTERY_LOW=0` turns the saver off.

## Field alerts

Field alerts are off by default. With `POCKET_ALERTS=1` in the `.env`, a new direct message to your call makes the
phone vibrate within 15 seconds. That is any SSID of a call in `ADMIN_CALLSIGNS`, from MeshCom or APRS.

- `POCKET_ALERTS_SPEAK=1` also says who it is from ("Message from O E 8 X Y Z").
- `POCKET_ALERTS_SPEAK_BODY=1` reads the message itself out. A message may be private, and the phone speaks to
  everyone around it.

Each message is announced once, also across restarts. After turning alerts on, run `start.sh` again: it adds
the missing `alerts` window to the running session.

## Your position

The phone's GPS reaches the station through the browser: the map's location button, and a find's device
location, which can make the find app-corroborated (Tier B). No script reads the GPS on its own.

## Scheduled backup

```bash
bash ~/aprscaching/deploy/pocket/extras/setup.sh --scheduled-backup
```

It registers `backup.sh` with Android's job scheduler: once a day, only while the phone charges and the battery is
above 50 %. Run `termux-setup-storage` once first. `status.sh` shows the last backup.
[Backups: Pocket](../day-to-day/backups.md#pocket) covers the archive and the restore.

`extras/setup.sh --remove` takes the shortcuts and the scheduled backup back.

## Next

- [Reach Pocket from outside](44net.md): Cloudflare or a 44Net address.
- [Before a trip: sync and your home hub](trips.md): fill the map before you lose signal.
