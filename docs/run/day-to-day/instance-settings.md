# Instance settings

This page is for the sysop. It shows how to change the policy values of your instance in the app: the game
rules, the API limits, how long data is kept, imports and spots, the imprint, donation links and the update
check. At the end the new value applies at once, with no restart.

## Before you start

- A sysop session: your callsign is in `ADMIN_CALLSIGNS` and control-verified
  ([Who is a sysop](../../reference/secrets.md#who-is-a-sysop)). On an instance with an https address, you
  sign in on that address.
- Infrastructure and secrets are not here. Addresses, ports, paths, keys and `ADMIN_CALLSIGNS` stay in the
  environment ([Configuration](../../reference/configuration.md)).

## Which value applies

Each instance setting has exactly one source, and the page shows it as a badge:

| Badge | Where the value comes from | What you can do |
|---|---|---|
| **Default** | the built-in default | change it |
| **Changed here** | a value saved on this page | change it, or **Reset to default** |
| **Set by the environment** | the gateway's environment sets the key | nothing here: change it in the environment and restart the gateway |

The environment always wins. A value you saved here stays stored while the environment overrides it, and the
page says so; it applies again once the environment no longer sets the key. The full list of instance settings,
with what each accepts, is in [Configuration → Instance settings](../../reference/configuration.md#instance-settings).

## Steps

1. Open **Admin** in the navigation rail, then the **Instance settings** group.
2. Find the setting: open its group (**Game rules**, **Accounts & API**, **Privacy & retention**, **Imports &
   data sources**, **Imprint & contact**, **Support links**, **Updates**), or type a word into **Search admin
   sections**, such as `imprint` or `retention`. The search opens every group it matches.
3. Change the value:

    - A switch or a choice (**Look for new releases**, **Lowest verified tier**) saves as you change it.
    - A field saves with **Save**. A number shows its unit and its range; a list takes one row per entry, with
      **Add a contact** or **Add a link**, and **Remove**.

4. Read the result. A saved value shows **Changed here** with your callsign and the time, and a short message
   confirms it. A value outside the setting's range shows the reason under the field, and nothing is saved.

To go back to the default, select **Reset to default** under the setting and confirm.

## Check that it worked

- The setting shows **Changed here**, and the group's header counts it.
- **Admin → Audit log** lists the change with the old and the new value.
- For the imprint: open `/imprint` on your instance. It shows your name and address, and no warning.

## From a script

The page reads and writes `GET /api/admin/settings` and `PUT` / `DELETE /api/admin/settings/<KEY>`. A script
uses them with the operator secret:

```sh
curl -X PUT https://<your-host>/api/admin/settings/HIDE_DAILY_LIMIT \
  -H "x-operator-secret: $OPERATOR_SECRET" -H "content-type: application/json" \
  -d '{"value": "10"}'
```

A key the environment sets answers `409`. `deploy/aprscaching doctor` lists the settings changed here.

## Next

- [Moderation](moderation.md): the audit log and what else it records.
- [Backups and moving](backups.md): instance settings live in the database, so a backup carries them.
