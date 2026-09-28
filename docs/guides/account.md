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

## Verify your callsign

Signing in claims a callsign; **verifying** proves you actually control it. Verification unlocks your place
on the leaderboard, announcing finds on APRS-IS, and transmitting from the browser. Receiving never needs it.

1. Open **Settings → Account** and tap **verify** next to the callsign.
2. The instance sends an APRS message to that callsign: from `APRSCG`, text `aprscaching code 123456`.
3. Read the six-digit code on your radio. If no IGate near you passes APRS messages to RF, look up your
   callsign's messages on [aprs.fi](https://aprs.fi) instead.
4. Type the code into **Code sent to …** and tap **Confirm**. You see **… verified ✓**.

The code is valid for **15 minutes** and allows five tries; after that, tap **verify** again for a new code.
The APRS-IS passcode is not used for this — it proves nothing about who you are.

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
the top filters it.

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
data and anonymises your finds. Erasure also reaches instances that mirrored your records.
