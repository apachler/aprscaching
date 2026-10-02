# Your account

Your account is your callsign. This page covers signing out, holding several callsigns, the licence badge, your
settings and your data.

## Sign out

**Settings → Account → Sign out** ends the session on this device. **Sign out everywhere** ends every
session of your account on every device — use it after losing a phone or signing in on a shared computer.
Changing your active callsign also signs your other devices out.

![The sign-in panel](../assets/shots/signin-desktop.webp){ width="720" loading=lazy }

## The licence badge

Beside each of your calls, **Settings → Account** shows whether a public licence register lists it:
**licence confirmed (FCC)**, **licence expired**, or **not found in public registers**. It checks that the
call is a real, current licence; it does not prove that you control it — only the verified tick does. Many
countries publish no register, so "not found" is normal and never stops you from using the call. See
[Licence registers](../reference/licence-sources.md).

## Several callsigns

One account can hold several licensed base calls — a club call, or a call from another country:

- **Settings → Account → Add a callsign**, type it, tap **Add**, then **verify** it like the first one.
- **Set active** chooses which call you are operating as. Past finds stay with the call they were logged
  under.
- SSIDs need no extra verification: `-7` (handheld), `-9` (mobile), `-10` ([IGate](../glossary.md#igate)) and so on inherit their
  base call's status.

## Settings at a glance

**Settings** (left rail on a computer, **You → Advanced → Settings** on a phone) is grouped; the search box at
the top filters it. Signed out you see **Account** (with the way to sign in), **Display**, **Locale & time**,
**Your data**, **Support the project** and **About & credits**; after signing in, the profile, station,
radio and notification groups appear as well.

![Settings while signed out](../assets/shots/set-account-desktop.webp){ width="720" loading=lazy }

| Group | What's in it |
|---|---|
| **Account** | Sign in/out, your callsigns, verification, email |
| **Display** | Appearance (Auto, Light, Dark — the default — or Phosphor, a green-screen terminal), units, the CRT effect in Phosphor |
| **Profile** | What others see on your profile |
| **Home weather station** | Feed your own weather station into the network |
| **My stations** | Your SSIDs and living caches |
| **My radio (browser)** | [Connect your radio from the browser](../shack/my-radio.md) |
| **Notifications** | Email digest, browser push, the watchlist |
| **Locale & time** | Language, time format |
| **Your data** | Export or erase everything about you |
| **Support the project** | Donating, and the public ledger of what donations pay for — recognition only, never a feature gate |
| **About & credits** | The manual, the source code, credits |

## Your data

**Settings → Your data → Export my data** downloads a complete copy (`aprscaching-<CALL>.json`).
**Erase my account** — after you confirm **Permanently erase …?** — removes your account, keys and personal
data and anonymises your finds. It covers the whole account — every callsign it holds, with their SSIDs —
and your passkeys stop working. Erasure also reaches instances that mirrored your records.

## Next

- [The Shack at a glance](../shack/index.md): when you want to operate.
- [Privacy by default](../about.md#privacy-by-default).
