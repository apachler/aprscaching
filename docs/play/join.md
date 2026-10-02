# Join

This page shows you how to sign in with your callsign and prove that the callsign is yours. At the end you
have an account, and a verified callsign that counts on the leaderboard.

Your account is your callsign. There is no username. With a [passkey](../glossary.md#passkey) there is no
password either.

## Before you start

- Your amateur radio callsign, for example `OE8APR`.
- A phone or computer with a browser.
- An email address, if you cannot use a passkey.

## Sign in

The same steps create an account for a callsign that has none.

1. Tap **Sign in** in the top bar, or **Sign in with your callsign** on the front page.
2. Type your **Callsign** and tap **Continue**. The panel shows your callsign. A new one says **new account**.
3. Pick one way in:
    - **Passkey.** Tap **Create account with a passkey** on your first visit, or **Sign in with passkey**
      after that. Your phone, computer or password manager keeps the passkey. You unlock it with a
      fingerprint, your face or the device PIN.
    - **Email link.** Type your email and tap **Email me a link**. Open the email and tap the link. On the
      page that opens, tap **Sign in**.

**← different callsign** takes you back to step 2.

Passkeys work only on a secure page: an address that starts with `https://`. On other pages the app says so
and offers the email link instead.

The email link works once and expires after 15 minutes. On a new account the email is optional; it lets you
sign in again if you lose your passkey. A returning player must use the email on their account. Any other
address gets *That email doesn't match …'s account*.

## Check that you are signed in

Your callsign shows in the top bar, and **You** shows your profile. The profile says **unverified** until you
verify the callsign.

## Verify your callsign

Signing in claims a callsign. Verifying proves that you control it. A verified callsign gets:

- a place on the leaderboard,
- announcements of your finds on [APRS-IS](../glossary.md#aprs-is), and
- transmitting from the browser.

You can receive, hunt and log without it.

Open **Settings → Account** and tap **verify** next to the callsign. Then pick a **Verification method**:

| Method | What you need |
|---|---|
| **On the air** | An [APRS](../glossary.md#aprs) radio or a [MeshCom](../glossary.md#meshcom) node in range of one of this instance's receiving stations |
| **ampr.org DNS** | The name `<call>.ampr.org`, which ARDC gives only to the licensed holder of the call |
| **LoTW certificate** | Your ARRL Logbook of The World callsign certificate ([LoTW](../glossary.md#lotw)) |
| Ask the sysop | Your licence document, shown to the instance's [sysop](../glossary.md#sysop) |

Some instances do not offer every method. Without a receiving station, the app says *This instance has no
receiving station yet* and opens on **ampr.org DNS**. Without LoTW, it says *This instance has not set up
LoTW certificate verification*.

One verification covers the callsign and every [SSID](../glossary.md#ssid) of it, such as `-7` or `-9`.

### On the air

1. Tap **Get a code**. The app shows the message to send:
    - **To**: the instance's service call, usually `APRSCG`.
    - **Message**: `VERIFY` and a six-digit code, for example `VERIFY 482913`.

    It also names the **Receiving stations** that listen for it.

2. Send that message from your callsign or any SSID of it. Use an APRS message on your radio, or a MeshCom
   direct message from your node. **Copy message** copies the text.
3. Wait while the app listens. When a receiving station hears your message, the app shows
   **OE8APR is verified**, and your radio gets an ack.

The code is valid for 30 minutes. If it runs out, tap **Get a new code** and send again. After five wrong
codes, get a new code.

Only a station this instance runs counts, and it must hear you directly over the air. A copy that arrives over
APRS-IS, the internet or other mesh nodes does not count. Anyone can put any callsign on those paths. Your
APRS-IS passcode proves nothing either.

### DNS at ampr.org

1. If you do not hold `<call>.ampr.org` yet, ask for it in the [ARDC portal](https://portal.ampr.org) under
   **DNS → My subdomains**. ARDC checks your licence first.
2. In the app, tap **Get the record**. It shows a **Name**, a **Type** (TXT) and a **Value**.
3. In the ARDC portal, under **DNS → My subdomains**, add a TXT record with that name and value. Do not use
   an alias (CNAME).
4. Wait until the record is live. This can take hours.
5. Tap **Check**. The app verifies the callsign when it finds the record. Until then, **Check** says the
   record is not published yet. You can try again as often as you like.

The code in the record is valid for 48 hours.

### LoTW certificate

1. In TQSL, open the **Callsign Certificates** tab. Select your certificate and choose **Save a Callsign
   Certificate**. Save it as a `.p12` file with a password.
2. In the app, choose the file under **Certificate file (.p12)**, type the **File password** and tap **Verify**.

The file and its password stay in your browser. Only the certificate and a signature go to the instance.

### Ask the sysop

If no method is in reach, ask the sysop. A sysop can verify your callsign by hand after checking your licence.

Every verification records how it was done and who vouched for it. Your [data export](account.md#your-data)
lists it. For how the instance checks each method, see
[Callsign verification](../run/day-to-day/callsign-verification.md).

## Next

- [Your first find](first-find.md): hunt and log a cache.
- [Your account](account.md): sign out, add callsigns, your data.
