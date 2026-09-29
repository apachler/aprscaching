# Your account

Your account is your callsign. There is no username and, if you use a passkey, no password.

## Sign in

1. Tap **Sign in** in the top bar, or **Sign in with your callsign** on the front page. The same step creates
   the account for a callsign that has none.
2. Type your **Callsign** and tap **Continue**.
3. Then either:
    - **Create account with a passkey** (first visit) or **Sign in with passkey** (returning). Your phone,
      computer or password manager stores the passkey; it works with a fingerprint, face or device PIN.
      Passkeys need an `https://` address — on a plain `http://` instance use the email link.
    - Or type your email and tap **Email me a link**, then open the link from your inbox and tap **Sign in**
      on the page it opens — opening the link alone signs nobody in. On a new account the email is optional
      and used for recovery. A returning user must use the email on their account: any other address is
      refused with *That email doesn't match …'s account*.

**← different callsign** takes you back to step 2.

## Sign out

**Settings → Account → Sign out** ends the session on this device. **Sign out everywhere** ends every
session of your account on every device — use it after losing a phone or signing in on a shared computer.
Changing your active callsign also signs your other devices out.

![The sign-in panel](../assets/shots/signin-desktop.webp){ width="720" loading=lazy }

## Verify your callsign

Signing in claims a callsign; **verifying** proves you actually control it. Verification unlocks your place
on the leaderboard, announcing finds on APRS-IS, and transmitting from the browser. Receiving never needs it.

Open **Settings → Account** and tap **verify** next to the callsign, then pick how to prove control:

| Method | What you need | What it proves |
|---|---|---|
| **On the air** (default) | An APRS radio, or a MeshCom node, within range of one of the instance's receiving stations | A station this instance runs heard your call transmit |
| **ampr.org DNS** | Your ARDC-delegated `<call>.ampr.org` name | ARDC reviewed your licence before delegating the name to you |
| **LoTW certificate** | Your ARRL Logbook of The World callsign certificate, saved from TQSL as a `.p12` file | ARRL checked your licence before issuing the certificate |

**On the air** needs a receiving station run by the instance. An instance without one says *This instance
has no receiving station yet — ask the operator, or use another method* and opens on **ampr.org DNS**
instead; where there are stations, the app names the calls that are listening. **LoTW certificate** shows
only where the operator has set it up.

If none of these is within reach, ask the instance's operator: a sysop can verify a call by hand after
checking your licence, and the verification lists who did it and how.

Every verification records its method and who vouched for it (the receiving station, the ampr.org name, the
LoTW certificate authority, or the sysop). Your data export lists it.

### On the air

1. Tap **Get a code**. The app shows the message to send: **To** the instance's service call (usually
   `APRSCG`), **Message** `VERIFY` and a six-digit code, for example `VERIFY 482913`, and the receiving
   stations listening for it (**Receiving stations:** `OE8XXX`). Nothing is sent to you.
2. Send that message from the callsign or any SSID of it (`-7`, `-9`, …): as an APRS message from your radio,
   or as a MeshCom direct message to the service call from your MeshCom node.
3. The app waits while it listens. Once one of the instance's own receiving stations hears the message on
   the air, it shows **… is verified** and your radio gets an ack.

The code is valid for **30 minutes**; tap **Get a new code** if it runs out. Five wrong codes heard on the air
lock the code, and a new one starts over.

Only a transmission heard directly by a receiving station this instance attests counts. A copy that reaches
the instance over APRS-IS, through an internet tunnel, or from the browser radio bridge does not verify the
call: those paths can carry any callsign, and APRS-IS is readable by anyone. The APRS-IS passcode is not used
either — it proves nothing about who you are. For MeshCom the same rule applies: the instance's own MeshCom
node must hear your node directly over LoRa. A copy relayed by other mesh nodes, or passed on by the MeshCom
server over the internet, does not count.

### ampr.org DNS

ARDC delegates `<call>.ampr.org` only to the licensed holder of the call, so a record only you can publish
proves control.

1. If you don't hold `<call>.ampr.org` yet, request it in the [ARDC portal](https://portal.ampr.org) under
   **DNS → My subdomains**. ARDC reviews your licence before it grants the name.
2. Tap **Get the record**. The app shows a TXT record, for example
   `_aprscaching.oe8apr.ampr.org TXT "v=acs1; verify=Q2x…"`.
3. In the portal, under **DNS → My subdomains**, add a **TXT** record named `_aprscaching` to
   `<call>.ampr.org`, with the value the app shows.
4. Wait until it is live in DNS. The portal publishes changes to the ampr.org zone periodically, so a new
   record can take hours to resolve; until then **Check** says the name is not published yet, and that
   costs nothing.
5. Tap **Check**. The instance looks the record up and verifies the call when it carries the current code.

The code is valid for **48 hours**. The answer has to be authentic, and the instance accepts it one of two
ways. A DNSSEC-validated answer settles it on its own. Without DNSSEC, which is the case while ampr.org is not
DNSSEC-signed, several independent public DNS resolvers (by default Cloudflare, Google and Quad9) must all return
the same record carrying the code; if any of them sees something else, **Check** refuses. Publish the TXT
record at that name itself, not as a CNAME: an answer through an alias does not count. An instance can
require DNSSEC; there, **Check** refuses while ampr.org is unsigned, and you verify another way.

### LoTW certificate

ARRL issues a Logbook of The World callsign certificate only after checking your licence.

1. In TQSL, on the **Callsign Certificates** tab, select your certificate and choose **Save a Callsign
   Certificate**; save it as a `.p12` file with a password.
2. Choose the file, type its password and tap **Verify**.

The file is opened in your browser. Its private key signs a one-time challenge from the instance, and only
the certificate and the signature are sent: the key and the password never leave your browser. The instance
checks that the certificate is current, chains to the LoTW certificate authority its operator trusts, and
names exactly this callsign. An instance whose operator has not set up LoTW verification says so.

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
