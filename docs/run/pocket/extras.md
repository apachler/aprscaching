# Pocket extras

Three optional add-ons, each from F-Droid (or each from GitHub). **Install every Termux app from the same
source as Termux itself:** the apps share a signing key, and apps from different sources refuse to talk to
each other. Open each app once after installing it, and grant the permissions it asks for (notifications
for Termux:API).

| Add-on | Gives the station |
|---|---|
| **Termux:API** (the app and `pkg install termux-api`) | a status notification, the battery saver, field alerts, the battery and Wi-Fi lines in `status.sh`, the scheduled backup, the setup questions as dialogs, a USB TNC, the Wi-Fi check before a sync |
| **Termux:Widget** | home-screen shortcuts |
| **Termux:Boot** | start at boot ([above](field-station.md#keep-it-running)) |

Without an add-on, the scripts print one line saying what to install and work as before.

Every extra at a glance; the ones started by `start.sh` run in their own tmux window:

| Extra | Script | Needs | Where |
|---|---|---|---|
| Setup questions | `wizard.sh` | Termux:API for dialogs, else the terminal | [Install](../install/pocket.md#install) |
| Status notification | `extras/notify.sh` (`start.sh` runs it) | Termux:API | below |
| Home-screen shortcuts | `extras/setup.sh --shortcuts` | Termux:Widget | below |
| Battery saver | `extras/battery.sh` (`start.sh` runs it) | Termux:API | below |
| Field alerts | `extras/alerts.sh` (`POCKET_ALERTS=1`) | Termux:API | below |
| Scheduled backup | `extras/setup.sh --scheduled-backup` | Termux:API | below |
| A USB KISS TNC | `extras/usb-kiss.sh` (`start.sh` runs it) | Termux:API, `python`, `libusb`, a CDC-ACM TNC | [A USB TNC on the phone](field-station.md#a-usb-tnc-on-the-phone) |
| Sync before a trip | `extras/sync-now.sh` | Termux:API to tell Wi-Fi from mobile data | [Before a trip: sync and your home hub](trips.md) |
| Your home instance as the hub | `wizard.sh` | the home instance's submit secret | [Your home instance as the hub](trips.md#your-home-instance-as-the-hub) |
| https on the ampr.org name | `extras/ampr-cert.sh` | `lego`, 44Net | [Pocket on 44Net](44net.md#pocket-on-44net) |
| An RTL-SDR | — | not supported | [An RTL-SDR on the phone](../install/pocket.md#an-rtl-sdr-on-the-phone-not-supported) |

- **Status notification.** With Termux:API, `start.sh` keeps one ongoing notification current every
  minute: running or stopped, the stations heard in the last hour, when the MeshCom node was last heard,
  whether APRS-IS delivers, and the battery. Its buttons are **Stop**, **Restart** and **Open map**; tapping
  it opens the map. It reads the gateway's `/api/admin/station-status` with the station's `OPERATOR_SECRET`.
  `stop.sh` removes it.
- **Shortcuts.** `bash ~/aprscaching/deploy/pocket/extras/setup.sh --shortcuts` puts **Status**, **Start**,
  **Stop**, **Open map**, **Backup** and **Sync before trip** into `~/.shortcuts/`; add the Termux:Widget widget to the home
  screen to tap them. Status opens a terminal with `status.sh`; the others run in the background and report
  with a short toast.
- **Battery saver.** With Termux:API, `start.sh` also watches the battery. Below `POCKET_BATTERY_LOW`
  percent (default 20) on battery, the station switches to a saver profile: APRS-IS narrowed to your own
  call's packets (the connection stays up, almost no data flows), the raw packet log kept 2 hours; MeshCom
  and every radio port stay on. It switches back when the phone charges or the battery is 10 points above
  the threshold, and says so in a notification each time. The profile is an overlay,
  `~/.aprscaching/battery-saver.env`, applied by restarting both processes; `POCKET_BATTERY_LOW=0` turns
  the saver off.
- **Field alerts** (off by default). With `POCKET_ALERTS=1` in the `.env`, a new direct message to your call
  (any SSID of `ADMIN_CALLSIGNS`, from MeshCom or APRS) makes the phone vibrate within 15 seconds;
  `POCKET_ALERTS_SPEAK=1` also says who it is from ("Message from O E 8 X Y Z"). The message itself is
  read out only with `POCKET_ALERTS_SPEAK_BODY=1`: it may be private, and the phone speaks to everyone
  around it. Each message is announced once, also across restarts.
- **Your position.** The phone's GPS reaches the station through the browser: the map's location button,
  and a find's device location, which is what can make it app-corroborated (Tier B). No script reads the
  GPS on its own.
- **Scheduled backup.** `extras/setup.sh --scheduled-backup` registers `backup.sh` with Android's job
  scheduler: once a day, only while the phone charges and the battery is above 50 %. `status.sh` shows the
  last backup. `extras/setup.sh --remove` takes both back.

## Next

- [Reach Pocket from outside](44net.md).
