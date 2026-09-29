# Your account

Your account is your callsign. There is no username and, if you use a passkey, no password.

## Sign in

1. Tap **Sign in** in the top bar.
2. Type your **Callsign** and tap **Continue**.
3. Then either:
    - **Create account with a passkey** (first visit) or **Sign in with passkey** (returning). Your phone,
      computer or password manager stores the passkey; it works with a fingerprint, face or device PIN.
      Passkeys need an `https://` address — on a plain `http://` instance use the email link.
    - Or type your email and tap **Email me a link**, then open the link from your inbox. On a new account the
      email is optional and used for recovery.

**← different callsign** takes you back to step 2.

![The sign-in panel](../assets/shots/signin-desktop.webp){ width="720" loading=lazy }

## Verify your callsign

Signing in claims a callsign; **verifying** proves you actually control it. Verification unlocks your place
on the leaderboard, announcing finds on APRS-IS, and transmitting from the browser. Receiving never needs it.

1. Open **Settings → Account** and tap **verify** next to the callsign.
2. The app shows the message to send: **To** the instance's service call (usually `APRSCG`), **Message**
   `VERIFY` and a six-digit code, for example `VERIFY 482913`. Nothing is sent to you.
3. Send that APRS message from your radio, from the callsign or any SSID of it (`-7`, `-9`, …).
4. The app waits while it listens. Once one of the instance's own receiving stations hears the message on
   the air, it shows **… is verified** and your radio gets an ack.

The code is valid for **30 minutes**; tap **Get a new code** if it runs out. Five wrong codes heard on the air
lock the code, and a new one starts over.

Only a transmission heard directly by a receiving station this instance attests counts. A copy that reaches
the instance over APRS-IS, through an internet tunnel, or from the browser radio bridge does not verify the
call: those paths can carry any callsign, and APRS-IS is readable by anyone. The APRS-IS passcode is not used
either — it proves nothing about who you are.

If you are out of range of every receiving station of the instance, ask its operator: a sysop can verify a
call by hand after checking your licence, and the verification lists who did it and how.

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
- SSIDs need no extra verification: `-7` (handheld), `-9` (mobile), `-10` (IGate) and so on inherit their
  base call's status.

## Your finds are signed

When you log a find, your browser signs it with a key that lives only on your device. You don't have to do
anything; the result shows **signed with your device key ✍**. The signature ties the find to your callsign
even if you later move to another instance.

## Settings at a glance

**Settings** (left rail on a computer, **You → Advanced → Settings** on a phone) is grouped; the search box at
the top filters it. Signed out you see only the general groups; after signing in, the account, profile,
station, radio and notification groups appear as well.

![Settings while signed out](../assets/shots/set-account-desktop.webp){ width="720" loading=lazy }

| Group | What's in it |
|---|---|
| **Account** | Sign in/out, your callsigns, verification, email |
| **Display** | Theme, units, CRT effect |
| **Profile** | What others see on your profile |
| **Home weather station** | Feed your own weather station into the network |
| **My stations** | Your SSIDs and living caches |
| **My radio (browser)** | [Connect your radio from the browser](my-radio.md) |
| **Notifications** | Email digest, browser push, the watchlist |
| **Locale & time** | Language, time format |
| **Your data** | Export or erase everything about you |
| **About & credits** | The manual, the source code, credits |

## Your data

**Settings → Your data → Export my data** downloads a complete copy (`aprscaching-<CALL>.json`).
**Erase my account** — after you confirm **Permanently erase …?** — removes your account, keys and personal
data and anonymises your finds. It covers the whole account — every callsign it holds, with their SSIDs —
and your passkeys stop working. Erasure also reaches instances that mirrored your records.
