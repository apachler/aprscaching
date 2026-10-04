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

An email you type when you create the account with a passkey waits for confirmation. The instance sends a
link to it; open it within 24 hours and tap **Sign in**. Until then **Settings → Account** shows the address
as **waiting for confirmation**, and it does not sign you in. **Resend** there mails the link again.

To add an email later, or change it, open **Settings → Account**, tap **Add email** or **Change**, type the
address and tap **Send confirmation**. The new address waits for confirmation the same way. Your old address
keeps signing you in until you open the link. An address that belongs to another account is refused.

Your passkey belongs to your account, not to one callsign. It signs you in from any callsign your account
holds, with or without an SSID, also after you switch your active callsign.

## Check that you are signed in

Your callsign shows in the top bar, and **You** shows your profile. The profile says **unverified** until you
verify the callsign.

## How a passkey keeps your account yours

A passkey is a pair of keys. The private key stays on your device, locked by your fingerprint, your face or
the device PIN. The instance keeps only the public key. To sign you in, the instance sends a random challenge,
your device signs it, and the instance checks the signature. There is no password to steal or guess.

- A passkey works only on the address it was made for, so a look-alike site cannot use it.
- A callsign that already has an account gets a new passkey only from a device signed in to that account.
  Someone who types your callsign elsewhere cannot add their own.
- A passkey proves that you are the person who opened the account. It does not prove that you hold the
  licence: that is what [verifying your callsign](#verify-your-callsign) does.

## Use more than one device

Each device signs in with a passkey of its own, or shares one through your password manager:

- **Apple and Google sync passkeys** between your own devices: an iPhone and a Mac on the same Apple Account,
  or an Android phone and Chrome on the same Google Account. Tap **Sign in with passkey** on the other device,
  and it works.
- **On any other device**, sign in once another way, then add a passkey for that device.

To add a passkey on a new device:

1. On the new device, tap **Sign in** and type your **Callsign**. Then sign in one of these ways:
    - Tap **Sign in with passkey** and, in the browser's window, pick the option to use a phone or tablet. It
      shows a QR code: scan it with the phone that holds your passkey, and confirm on the phone.
    - Tap **Email me a link**, if your account has a confirmed email.
2. Open **Settings → Account** and tap **Add a passkey on this device**.
3. Confirm with your fingerprint, your face or the device PIN.

**Check that it worked:** **Passkeys** under **Settings → Account** counts one more, and **Your passkeys** lists
it. Next time, this device signs in with **Sign in with passkey** directly.

**Lost a device?** On another device, open **Settings → Account → Your passkeys** and tap **Remove** next to its
passkey, then **Sign out everywhere**. The last passkey of an account without a confirmed email cannot be
removed: it is your only way in. Confirm your email or add another passkey first.

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
    - **To**: the instance's service call, your sysop's callsign with SSID 15, such as `OE8APR-15`.
    - **Message**: `VERIFY` and a six-digit code, for example `VERIFY 482913`.

    It also names the **Receiving stations** that listen for it.

2. Send that message from your callsign or any SSID of it. Use an APRS message on your radio, or a MeshCom
   direct message from your node. **Copy message** copies the text.
3. Wait while the app listens. When a receiving station hears your message, the app shows
   **OE8APR is verified**, and your radio gets an ack.

The code is valid for 30 minutes. If it runs out, tap **Get a new code** and send again. After five wrong
codes, get a new code.

Only a receiving station this instance trusts counts, and it must hear you directly over the air. A copy that arrives over
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
